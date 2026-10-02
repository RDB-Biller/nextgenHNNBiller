'use strict';
// Smoke coverage for Master Control's payer commercial edition + per-claim
// commission (src/services/payerEditions.js, fees.js#onPayerCommission) and the
// revenue "by payer" breakdown (services/revenue.js, store.js#revenueAll()).
//
// payerEditions.js deliberately mirrors editions.js's licence-key machinery
// (redeem/renew/setEdition) for payers rather than generalizing editions.js,
// since editionOf/licenceState/has/featureList already work unchanged on any
// object with .edition/.licenseExpiresAt fields -- only the tenant-scoped
// redeem/renew/setEdition needed payer-scoped duplicates. Commercial edition
// does NOT gate a payer's own features (NNEST, price lists, prior approvals,
// ...) -- only this new commission -- so there's nothing to assert about
// has()/featureList() here; what matters is that the commission is gated
// strictly, and nothing else is gated at all.
//
// Exercises fees.js#onPayerCommission directly rather than the full
// claims.js#authorize() -> finalizeSettled() integration path, to avoid needing
// NNEST/payerSlots/networks fixtures that are orthogonal to what this file is
// about; claims.js's one-line call site (finalizeSettled: "await
// fees.onPayerCommission(claim, bill, payer)") is a simple, visually-verified
// wire-up, not logic worth re-deriving a heavy fixture for here.

const store = require('../src/store');
const payerEditions = require('../src/services/payerEditions');
const fees = require('../src/services/fees');
const revenue = require('../src/services/revenue');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exit(1); } console.log(`ok  : ${label}`); };

async function editionAndLicenceChecks() {
  const payer = { id: 'pay_test_acacia', kind: 'insurer', name: 'Acacia Health' };
  await store.payers.save(payer);

  ok(payerEditions.editionOf(payer) === 'non_commercial', 'a fresh payer defaults to non_commercial');

  const up = await payerEditions.setEdition(payer.id, 'commercial', 'platform_admin');
  ok(up.from === 'non_commercial' && up.to === 'commercial', 'setEdition() reports the from/to transition');
  let saved = await store.payers.get(payer.id);
  ok(payerEditions.editionOf(saved) === 'commercial', 'setEdition() persists the new edition');

  let threw = false;
  try { await payerEditions.setEdition(payer.id, 'bogus'); } catch (e) { threw = true; }
  ok(threw, 'setEdition() rejects an unknown edition name');

  // License-key path, mirroring editions.js's redeem() exactly.
  const lic = await payerEditions.issueLicense({ edition: 'commercial', orgId: 'pay_test_metro', feeAmount: 500, termMonths: 6 });
  const otherPayer = { id: 'pay_test_metro', kind: 'insurer', name: 'Metro Mutual' };
  await store.payers.save(otherPayer);

  let code = null;
  try { await payerEditions.redeem(lic.key, 'pay_test_wrong'); } catch (e) { code = e.status; }
  ok(code === 403, 'a license bound to one payer (orgId) is refused for a different payer (403)');

  const redeemed = await payerEditions.redeem(lic.key, 'pay_test_metro');
  ok(redeemed.to === 'commercial' && redeemed.from === 'non_commercial', 'redeem() upgrades the intended payer');
  saved = await store.payers.get('pay_test_metro');
  ok(payerEditions.editionOf(saved) === 'commercial' && saved.licenseKey === lic.key,
    'redeem() persists edition + licenseKey on the payer');

  code = null;
  try { await payerEditions.redeem(lic.key, 'pay_test_wrong2'); } catch (e) { code = e.status; }
  ok(code === 409, 'redeeming an already-redeemed key against a DIFFERENT payer is refused (409)');

  // Redeeming again for the SAME payer who already holds it is idempotent, not an error.
  const again = await payerEditions.redeem(lic.key, 'pay_test_metro');
  ok(again.to === 'commercial', 'redeeming the same key again for the SAME payer it was redeemed to is idempotent');

  const revoked = await payerEditions.issueLicense({ edition: 'commercial', feeAmount: 0 });
  await payerEditions.revoke(revoked.key);
  code = null;
  try { await payerEditions.redeem(revoked.key, 'pay_test_metro'); } catch (e) { code = e.status; }
  ok(code === 409, 'a revoked license is refused (409)');

  const expired = await payerEditions.issueLicense({ edition: 'commercial', feeAmount: 0,
    expiresAt: new Date(Date.now() - 86400000).toISOString() });
  code = null;
  try { await payerEditions.redeem(expired.key, 'pay_test_metro'); } catch (e) { code = e.status; }
  ok(code === 409, 'an expired license is refused (409)');

  // renew(): extends from the LATER of now or the current expiry. Snapshot the
  // expiry as a primitive string BEFORE calling renew() -- the in-memory store
  // returns the SAME live object on get(), not a copy, so holding onto the
  // object itself (rather than reading the field off it now) would silently
  // observe renew()'s own mutation and always compare equal to itself.
  const beforeExpiry = (await store.payers.get('pay_test_metro')).licenseExpiresAt;
  const ren = await payerEditions.renew('pay_test_metro', { termMonths: 3, feeAmount: 250, by: 'HNN' });
  ok(new Date(ren.expiresAt).getTime() > new Date(beforeExpiry).getTime(),
    'renew() extends the licence further into the future');
  ok(ren.feeAmount === 250, 'renew() reports the fee charged for this term');
  const licRec = await store.licenses.get(ren.key);
  ok(licRec.status === 'renewed' && licRec.redeemedBy === 'pay_test_metro',
    'renew() issues + redeems a fresh license record for the audit trail');
}

async function commissionAccrualChecks() {
  const tenant = { id: 'ten_test_hosp', name: 'Test Hospital' };
  await store.tenants.save(tenant);
  const bill = { id: 'bill_test1', tenantId: tenant.id, currency: 'GHS' };

  // Capped-rate unit checks, independent of any fixture -- both representations
  // (a fraction above the cap, and a "percentage" above 100x the cap) land on
  // the same ceiling.
  ok(fees.normalisePayerCommissionRate(0.5) === fees.MAX_PAYER_COMMISSION_RATE,
    'a fractional rate above the cap is clamped to it (0.5 -> 0.15)');
  ok(fees.normalisePayerCommissionRate(60) === fees.MAX_PAYER_COMMISSION_RATE,
    'a percentage-style rate above the cap is clamped to it (60 -> 0.15)');
  ok(fees.normalisePayerCommissionRate(5) === 0.05, 'a percentage-style rate under the cap converts correctly (5 -> 0.05)');
  ok(fees.normalisePayerCommissionRate(-1) === 0, 'a negative rate normalises to 0, not a negative fee');

  // Commercial payer, commission enabled, 5% -- the baseline "it works" case.
  const payerCommercial = { id: 'pay_commission_1', kind: 'insurer', name: 'Acacia Health',
    edition: 'commercial', commission: { enabled: true, rate: 0.05, updatedAt: new Date().toISOString(), updatedBy: 'ops@hnn' } };
  await store.payers.save(payerCommercial);
  const claim1 = { id: 'clm_c1', payerId: payerCommercial.id, amount: 800, settlementAmount: 800 };
  const entry1 = await fees.onPayerCommission(claim1, bill, payerCommercial);
  ok(!!entry1 && entry1.amount === 40, '5% commission on an 800 GHS settlement accrues exactly 40 GHS');
  ok(entry1.type === 'platform_fee_payer_commission' && entry1.refs.payerId === payerCommercial.id,
    'the ledger entry is typed platform_fee_payer_commission and tagged with the payer it belongs to');
  ok(entry1.source.kind === 'insurer', 'charged to the insurer (the payer itself), not the hospital or patient');

  // Non-commercial payer with a rate configured -- must accrue NOTHING, silently.
  const payerNonCommercial = { id: 'pay_commission_2', kind: 'insurer', name: 'Metro Mutual',
    edition: 'non_commercial', commission: { enabled: true, rate: 0.05 } };
  await store.payers.save(payerNonCommercial);
  const claim2 = { id: 'clm_c2', payerId: payerNonCommercial.id, amount: 800, settlementAmount: 800 };
  const entry2 = await fees.onPayerCommission(claim2, bill, payerNonCommercial);
  ok(entry2 === null, 'a non-commercial payer accrues no commission even with a rate configured');

  // Commercial, but commission disabled -- must accrue nothing.
  const payerDisabled = { id: 'pay_commission_3', kind: 'insurer', name: 'Donewell',
    edition: 'commercial', commission: { enabled: false, rate: 0.1 } };
  await store.payers.save(payerDisabled);
  const entry3 = await fees.onPayerCommission(
    { id: 'clm_c3', payerId: payerDisabled.id, amount: 800, settlementAmount: 800 }, bill, payerDisabled);
  ok(entry3 === null, 'a commercial payer with commission.enabled=false accrues nothing');

  // Commercial, enabled, but rate 0 -- must accrue nothing.
  const payerZeroRate = { id: 'pay_commission_4', kind: 'insurer', name: 'Zero Rate Co',
    edition: 'commercial', commission: { enabled: true, rate: 0 } };
  await store.payers.save(payerZeroRate);
  const entry4 = await fees.onPayerCommission(
    { id: 'clm_c4', payerId: payerZeroRate.id, amount: 800, settlementAmount: 800 }, bill, payerZeroRate);
  ok(entry4 === null, 'a commercial, enabled payer with rate 0 accrues nothing');

  // Commercial, enabled, rate set far above the cap -- accrues at the CAPPED rate, not the raw one.
  const payerHighRate = { id: 'pay_commission_5', kind: 'insurer', name: 'Greedy Mutual',
    edition: 'commercial', commission: { enabled: true, rate: 60 } };
  await store.payers.save(payerHighRate);
  const entry5 = await fees.onPayerCommission(
    { id: 'clm_c5', payerId: payerHighRate.id, amount: 800, settlementAmount: 800 }, bill, payerHighRate);
  ok(!!entry5 && entry5.amount === 120, 'a rate configured above the 15% cap accrues at 15% (120 GHS on 800), not the raw rate');

  // A payer whose commercial edition has lapsed (expired licence) reverts to non_commercial automatically.
  const payerLapsed = { id: 'pay_commission_6', kind: 'insurer', name: 'Lapsed Co',
    edition: 'commercial', licenseExpiresAt: new Date(Date.now() - 86400000).toISOString(),
    commission: { enabled: true, rate: 0.1 } };
  await store.payers.save(payerLapsed);
  const entry6 = await fees.onPayerCommission(
    { id: 'clm_c6', payerId: payerLapsed.id, amount: 800, settlementAmount: 800 }, bill, payerLapsed);
  ok(entry6 === null, 'a payer whose commercial licence has expired accrues no commission (editionOf() falls back to non_commercial)');

  // No payer at all (defensive) -- must not throw.
  const entry7 = await fees.onPayerCommission({ id: 'clm_c7', amount: 800 }, bill, null);
  ok(entry7 === null, 'onPayerCommission(..., null) returns null rather than throwing when there is no payer');

  return { tenant, bill, payerCommercial, payerHighRate };
}

async function revenueByPayerChecks({ bill, payerCommercial, payerHighRate }) {
  // A second commission for the SAME payer, on a different claim -- byPayer must SUM, not just list.
  const claim1b = { id: 'clm_c1b', payerId: payerCommercial.id, amount: 200, settlementAmount: 200 };
  await fees.onPayerCommission(claim1b, bill, payerCommercial); // 5% of 200 = 10

  // A fee type with NO payer in its refs (e.g. a patient-charged report fee) --
  // must show up in byType/byClient but be LEFT OUT of byPayer entirely.
  await fees.accrue({ type: 'report_fee_mini', chargeTo: 'patient', amount: 15 },
    { bill, currency: bill.currency, refs: { reportId: 'rep_test1' } });

  const summary = await revenue.summary();
  const byPayerMap = Object.fromEntries(summary.byPayer.map((p) => [p.payerId, p]));

  ok(byPayerMap[payerCommercial.id] && byPayerMap[payerCommercial.id].total === 50,
    'byPayer sums ACROSS claims for the same payer (40 + 10 = 50), not just the last one');
  ok(byPayerMap[payerHighRate.id] && byPayerMap[payerHighRate.id].total === 120,
    'a second payer gets its own correct, separate byPayer total');
  ok(byPayerMap[payerCommercial.id].name === payerCommercial.name, 'byPayer resolves the payer id to its display name');
  ok(byPayerMap[payerCommercial.id].byType.platform_fee_payer_commission === 50,
    'byPayer also breaks its own total down by fee type');

  const reportFeeRow = summary.byType.find((t) => t.type === 'platform_fee_report_fee_mini');
  ok(!!reportFeeRow && reportFeeRow.total >= 15, 'a fee with no payer in its refs still shows up in byType');
  ok(summary.byPayer.every((p, i) => i === 0 || summary.byPayer[i - 1].total >= p.total),
    'byPayer is sorted descending by total, same convention as byType/byClient');

  // recent() also attributes a payer-tagged entry to that payer by name, and
  // leaves a payer-less entry's `payer` field null rather than guessing.
  const recent = await revenue.recent(50);
  const commissionRecent = recent.find((r) => r.billId === bill.id && r.type === 'Payer commission' && r.amount === 10);
  ok(!!commissionRecent && commissionRecent.payer === payerCommercial.name,
    "recent() shows the payer's name alongside a payer-attributed fee entry");
  const reportRecent = recent.find((r) => r.billId === bill.id && r.type === 'Mini report fee');
  ok(!!reportRecent && reportRecent.payer === null, 'recent() leaves payer null for a fee with no payer in its refs');
}

async function main() {
  await editionAndLicenceChecks();
  const ctx = await commissionAccrualChecks();
  await revenueByPayerChecks(ctx);
  console.log('\nPAYER COMMERCIAL EDITION + COMMISSION CHECK: ALL PASSED');
}

main().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(1); });
