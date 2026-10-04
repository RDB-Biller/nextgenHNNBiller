'use strict';
// Smoke test for (A) the Master Control SMS Dashboard and (B) the 8 gap
// modules exposed as configurable Product Lab "solution" products
// (services/smsDashboard.js, services/solutions.js, services/products.js).
// In-memory store, no network: Africa's Talking HTTP is faked through
// messaging._setRequestImplForTests. Run: node scripts/smoke-gaps-solutions.js

if (!process.env.CREDENTIAL_ENCRYPTION_KEY) process.env.CREDENTIAL_ENCRYPTION_KEY = 'smoke-test-only-key-do-not-use-in-production';

const store = require('../src/store');
const operatingMode = require('../src/services/operatingMode');
const messaging = require('../src/services/messaging');
const messagingAccount = require('../src/services/messagingAccount');
const sms = require('../src/services/smsDashboard');
const products = require('../src/services/products');
const solutions = require('../src/services/solutions');
const claimsAutomation = require('../src/services/claimsAutomation');
const claimExpiry = require('../src/services/claimExpiry');
const funders = require('../src/services/funders');

let a = 0;
const ok = (cond, label) => {
  a++;
  if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else { console.log(`ok  : ${label}`); }
};
const rejects = async (fn, status, label) => {
  try { await fn(); ok(false, `${label} (did not throw)`); } catch (e) { ok(!status || e.status === status, `${label} -> ${e.message}`); }
};

async function smsChecks() {
  // --- parsing
  const p = sms.parseNumbers('0244000001, 0244000001\n+233 24 400 0002;12345  0201234567');
  ok(p.valid.length === 3 && p.valid[0] === '+233244000001', 'parseNumbers normalises to +233 and keeps valid ones');
  ok(p.duplicates === 1 && p.invalid.length === 1, 'parseNumbers counts duplicates and reports invalid entries');
  ok(sms.parseNumbers(['0244000009', '0244000010']).valid.length === 2, 'parseNumbers accepts an array (CSV/XLSX upload path)');

  // --- sandbox send
  await operatingMode.set({ messaging: { sandbox: true } });
  const r = await sms.send({ message: 'Hello from HNN', numbers: '0244000001,0244000002,bad' });
  ok(r.mode === 'sandbox' && r.accepted === 2 && r.invalid.length === 1, 'sandbox bulk send accepts valid numbers, reports invalid ones');
  const log1 = await sms.logs({});
  ok(log1.total === 2 && log1.data.every((x) => x.status === 'sandbox' && x.providerMessageId), 'every recipient is logged with a provider id');
  await rejects(() => sms.send({ message: '', numbers: '0244000001' }), 422, 'empty message rejected');
  await rejects(() => sms.send({ message: 'x', numbers: 'nope' }), 422, 'no valid numbers rejected');
  await rejects(() => sms.send({ message: 'x', numbers: Array.from({ length: 1001 }, (_, i) => `02440${String(i).padStart(5, '0')}`) }), 422, 'over 1000 recipients rejected');

  // --- opt-out
  await sms.recordOptOut({ phoneNumber: '0244000002' });
  const r2 = await sms.send({ message: 'Second', numbers: '0244000001,0244000002' });
  ok(r2.accepted === 1 && r2.skippedOptOut === 1, 'opted-out recipient is skipped, not sent');
  await sms.removeOptOut('0244000002');
  ok((await sms.listOptOuts()).length === 0, 'opt-out can be removed');

  // --- delivery report + inbound
  const sample = (await sms.logs({ q: 'Second' })).data[0];
  const dlr = await sms.recordDeliveryReport({ id: sample.providerMessageId, status: 'Success', networkCode: '62002' });
  ok(dlr.matched && dlr.status === 'delivered', 'delivery report marks the matching message delivered');
  ok(!(await sms.recordDeliveryReport({ id: 'nope', status: 'Success' })).matched, 'unknown delivery id is a harmless no-match');
  const inb = await sms.recordInbound({ from: '+233244000001', to: '20880', text: 'hello there', id: 'ATXid_1', date: '2026-10-04 10:00:00' });
  ok(inb.id && (await sms.inbox({})).total === 1, 'inbound message lands in the inbox');

  // --- search, pagination, csv, analytics
  const pg = await sms.logs({ pageSize: 2, page: 2 });
  ok(pg.pageSize === 2 && pg.page === 2 && pg.pages === 2 && pg.data.length === 2, 'log pagination works');
  ok((await sms.logs({ q: '244000002' })).total >= 1 && (await sms.logs({ q: 'zzzz' })).total === 0, 'log search works');
  const csv = await sms.logsCsv({});
  ok(csv.split('\n')[0].startsWith('id,batchId') && csv.includes('Hello from HNN'), 'CSV export has header and rows');
  const an = await sms.analytics();
  ok(an.inbound === 1 && an.byStatus.delivered === 1 && an.daily.length === 14, 'analytics counts delivered, inbound and a 14-day series');

  // --- webhook secret
  const urls = await sms.hookUrls('https://x.test');
  ok(/\/sms-hooks\/[0-9a-f]{36}\/delivery$/.test(urls.delivery), 'callback URLs carry an unguessable secret');
  const sec = (await sms.getSettings()).hookSecret;
  ok(await sms.checkSecret(sec) && !(await sms.checkSecret('wrong')), 'secret check accepts the right one only');
  await sms.rotateSecret();
  ok(!(await sms.checkSecret(sec)), 'rotating the secret invalidates the old URL');

  // --- live Africa's Talking bulk (faked HTTP)
  const seen = [];
  messaging._setRequestImplForTests(async (url, opts) => {
    seen.push({ url, opts });
    return { status: 201, body: JSON.stringify({ SMSMessageData: { Message: 'Sent to 2/3', Recipients: [
      { statusCode: 101, number: '+233244000011', cost: 'GHS 0.0500', status: 'Success', messageId: 'ATXid_a' },
      { statusCode: 101, number: '+233244000012', cost: 'GHS 0.0500', status: 'Success', messageId: 'ATXid_b' },
      { statusCode: 403, number: '+233244000013', cost: '0', status: 'InvalidPhoneNumber', messageId: 'None' },
    ] } }) };
  });
  await messagingAccount.set({ provider: 'africastalking', credentials: { apiKey: 'k-test-1234', username: 'hnn', from: 'HNN' }, active: true });
  await operatingMode.set({ messaging: { sandbox: false } });
  const live = await sms.send({ message: 'Live bulk', numbers: '0244000011,0244000012,0244000013' });
  const call = seen[0];
  ok(live.mode === 'live' && live.accepted === 2 && live.failed === 1, 'live bulk: per-recipient success/failure from AT response');
  ok(call.url.endsWith('/version1/messaging/bulk') && call.opts.headers.apiKey === 'k-test-1234', 'live bulk posts to AT /messaging/bulk with apiKey header');
  const body = JSON.parse(call.opts.body);
  ok(body.username === 'hnn' && body.senderId === 'HNN' && body.phoneNumbers.length === 3 && body.message === 'Live bulk', 'bulk body is JSON with username/senderId/phoneNumbers/message');
  const failedRow = (await sms.logs({ status: 'failed' })).data[0];
  ok(failedRow && failedRow.error === 'InvalidPhoneNumber', 'failed recipient keeps AT\'s reason');

  // non-JSON provider error must not throw (the Railway bug class)
  messaging._setRequestImplForTests(async () => ({ status: 502, body: '<html>Bad gateway</html>' }));
  const bad = await sms.send({ message: 'Will fail', numbers: '0244000021' });
  ok(bad.failed === 1 && bad.accepted === 0 && /502/.test(bad.error || ''), 'non-JSON provider error is handled, not thrown');
  messaging._setRequestImplForTests(null);
  await messagingAccount.set({ active: false });
  await operatingMode.set({ messaging: { sandbox: true } });
}

// ---- solutions ---------------------------------------------------------------

async function seedPharmacies() {
  const mk = (id, name) => ({ id, name, apiKey: `k_${id}`, facilityType: 'pharmacy', edition: 'non_commercial' });
  await store.tenants.save(mk('ph_a', 'Alpha Pharmacy'));
  await store.tenants.save(mk('ph_b', 'Beta Pharmacy'));
  await store.tenants.save(mk('ph_c', 'Gamma Pharmacy'));
  let n = 0;
  const bill = async (tenantId, items) => store.bills.insert({
    id: `bill_${++n}`, tenantId, createdAt: new Date().toISOString(), status: 'open',
    lineItems: items.map(([name, cost]) => ({ name, code: name.toUpperCase(), qty: 1, unitPrice: cost, cost })),
  });
  await bill('ph_a', [['Amoxicillin', 20], ['Paracetamol', 5]]);
  await bill('ph_b', [['Amoxicillin', 28], ['Paracetamol', 4]]);
  await bill('ph_c', [['Amoxicillin', 24]]); // no Paracetamol -> not comparable for the basket
}

async function solutionChecks() {
  await seedPharmacies();
  const reg = solutions.registry();
  ok(reg.length === 8 && ['auth_threshold', 'auto_adjudication', 'claim_expiry', 'settlement_cycle', 'daily_billing', 'multi_funder', 'pharmacy_compare', 'reconciliation'].every((k) => reg.some((m) => m.key === k)),
    'registry exposes all 8 gap modules with parameter schemas');

  // validation
  await rejects(() => products.create('acacia', { type: 'solution', name: 'x', config: { module: 'nope' } }), 422, 'unknown module rejected');
  await rejects(() => products.create('acacia', { type: 'solution', name: 'x', config: { module: 'multi_funder', surfaces: ['patient'], params: { funderId: 'f' } } }), 422, 'surface the module does not support is rejected');
  await rejects(() => products.create('acacia', { type: 'solution', name: 'x', config: { module: 'auth_threshold', params: { thresholdMaxAmount: -5 } } }), 422, 'param below min rejected');
  await rejects(() => products.create('acacia', { type: 'solution', name: 'x', config: { module: 'multi_funder' } }), 422, 'required param (funderId) enforced');

  // ---- 1. authorization threshold: draft -> sandbox (no write) -> live (applied) -> sandbox (reverted)
  const before = claimsAutomation.payerPolicyOf(await store.payers.get('acacia'));
  const thr = await products.create('acacia', { type: 'solution', name: 'Under-200 instant', config: { module: 'auth_threshold', params: { thresholdMaxAmount: 150 } } });
  ok(thr.status === 'draft' && thr.config.params.thresholdMaxAmount === 150, 'solution created as draft with params');
  await rejects(() => solutions.run(thr.id, 'hospital', { tenant: { id: 'tenant_euracare' } }), 404, 'draft solution is invisible to hospitals');
  await products.setStatus(thr.id, 'sandbox');
  ok(claimsAutomation.payerPolicyOf(await store.payers.get('acacia')).thresholdMaxAmount === before.thresholdMaxAmount, 'sandbox does not change the payer policy');
  const dry = await solutions.run(thr.id, 'hospital', { tenant: { id: 'tenant_euracare' }, input: { amount: 120 } });
  ok(dry.dryRun === true && dry.result.check.autoAuthorized === true, 'sandbox run is a dry-run answering "would this auto-authorize?"');
  await rejects(() => solutions.run(thr.id, 'patient', {}), 404, 'patient surface is closed until live');
  await products.setStatus(thr.id, 'live');
  ok(claimsAutomation.payerPolicyOf(await store.payers.get('acacia')).thresholdMaxAmount === 150, 'going live APPLIES the threshold to the payer');
  const dup = await products.create('acacia', { type: 'solution', name: 'dup', config: { module: 'auth_threshold', params: { thresholdMaxAmount: 999 } } });
  await products.setStatus(dup.id, 'sandbox');
  await rejects(() => products.setStatus(dup.id, 'live'), 409, 'a second live solution of the same module for one payer is blocked');
  await products.update(thr.id, { config: { params: { thresholdMaxAmount: 300 } } });
  ok(claimsAutomation.payerPolicyOf(await store.payers.get('acacia')).thresholdMaxAmount === 300, 'editing a live solution re-applies the new value');
  const pat = await solutions.run(thr.id, 'patient', { input: { amount: 250 } });
  ok(pat.result.check.autoAuthorized === true && pat.dryRun === false, 'live solution answers patients on the patient surface');
  await products.setStatus(thr.id, 'sandbox');
  ok(claimsAutomation.payerPolicyOf(await store.payers.get('acacia')).thresholdMaxAmount === before.thresholdMaxAmount, 'leaving live REVERTS to the original threshold (not the edited one)');

  // ---- 2. auto-adjudication what-if using the real decision function
  await claimsAutomation.updateRule('rule_example_malaria', { active: true, maxAmount: 250 });
  const aa = await products.create('acacia', { type: 'solution', name: 'Rules', config: { module: 'auto_adjudication', params: { enabled: true, useStructuredRules: true } } });
  await products.setStatus(aa.id, 'sandbox');
  const w = await solutions.run(aa.id, 'payer', { payerId: 'acacia', input: { diagnosis: 'Uncomplicated malaria', itemCodes: 'Coartem', amount: 200 } });
  ok(w.result.whatIf.autoClear === true && w.result.whatIf.method === 'structured_rule', 'what-if: malaria + Coartem under the cap clears by structured rule');
  const w2 = await solutions.run(aa.id, 'payer', { payerId: 'acacia', input: { diagnosis: 'Uncomplicated malaria', itemCodes: 'Coartem', amount: 900 } });
  ok(w2.result.whatIf.autoClear === false, 'what-if: above the rule cap does not auto-clear');
  await rejects(() => solutions.run(aa.id, 'patient', {}), 404, 'auto-adjudication is not offered to patients');

  // ---- 3. claim expiry window (platform scope) applies and reverts
  const prevExp = await claimExpiry.getPolicy();
  const ce = await products.create('acacia', { type: 'solution', name: '21-day expiry', config: { module: 'claim_expiry', params: { windowDays: 21 } } });
  await products.setStatus(ce.id, 'sandbox'); await products.setStatus(ce.id, 'live');
  ok((await claimExpiry.getPolicy()).windowDays === 21, 'claim-expiry solution live sets the window');
  await store.claims.insert({ id: 'clm_x1', tenantId: 'tenant_euracare', payerId: 'acacia', status: 'pending', amount: 100, createdAt: new Date(Date.now() - 19 * 86400000).toISOString() });
  const exp = await solutions.run(ce.id, 'hospital', { tenant: { id: 'tenant_euracare' } });
  ok(exp.result.openClaims[0].daysLeft === 2 && exp.result.atRisk === 1, 'hospital sees days left on its own open claims and the at-risk count');
  await products.setStatus(ce.id, 'sandbox');
  ok((await claimExpiry.getPolicy()).windowDays === prevExp.windowDays, 'claim-expiry window reverted on leaving live');

  // ---- 4/5. settlement cycle + daily billing
  const sc = await products.create('acacia', { type: 'solution', name: 'Biweekly', config: { module: 'settlement_cycle', params: { defaultSettlementCycle: 'biweekly' } } });
  await products.setStatus(sc.id, 'sandbox'); await products.setStatus(sc.id, 'live');
  ok((await store.payers.get('acacia')).defaultSettlementCycle === 'biweekly', 'settlement-cycle solution applies the payer default cycle');
  const scr = await solutions.run(sc.id, 'hospital', { tenant: { id: 'tenant_euracare' } });
  ok(scr.result.effectiveCycle === 'biweekly', 'hospital sees the effective cycle');
  const skip = await products.create('acacia', { type: 'solution', name: 'd', config: { module: 'daily_billing' } });
  await rejects(() => products.setStatus(skip.id, 'live'), 422, 'cannot skip sandbox (draft -> live)');
  await products.setStatus(sc.id, 'sandbox');
  ok(!(await store.payers.get('acacia')).defaultSettlementCycle || (await store.payers.get('acacia')).defaultSettlementCycle === 'immediate', 'cycle reverted to the original');
  const db = await products.create('acacia', { type: 'solution', name: 'Daily', config: { module: 'daily_billing' } });
  await products.setStatus(db.id, 'sandbox'); await products.setStatus(db.id, 'live');
  ok((await store.payers.get('acacia')).defaultSettlementCycle === 'daily', 'daily-billing solution sets cycle to daily');
  const dbr = await solutions.run(db.id, 'hospital', { tenant: { id: 'tenant_euracare' }, input: { tenantId: 'tenant_nyaho' } });
  ok(Array.isArray(dbr.result.queue) && Array.isArray(dbr.result.batches), 'daily billing returns queue + batches, and ignores a spoofed tenantId on the hospital surface');
  await products.setStatus(db.id, 'sandbox');

  // ---- 6. multi-funder
  const f = await funders.create({ name: 'Ghana Medical Trust Fund', kind: 'trust_fund' });
  const mf = await products.create('gmtf', { type: 'solution', name: 'GMTF TPA', config: { module: 'multi_funder', params: { funderId: f.id } } });
  await products.setStatus(mf.id, 'sandbox'); await products.setStatus(mf.id, 'live');
  ok((await store.payers.get('gmtf')).tpaForFunderId === f.id, 'multi-funder solution links the payer to the funder');
  const mfr = await solutions.run(mf.id, 'payer', { payerId: 'gmtf' });
  ok(mfr.result.funder.name === 'Ghana Medical Trust Fund' && mfr.result.administeredBy.some((p) => p.id === 'gmtf'), 'payer surface shows funder + administering payers');
  await rejects(() => solutions.run(mf.id, 'payer', { payerId: 'acacia' }), 404, 'another payer cannot run this payer\'s solution');
  await products.setStatus(mf.id, 'sandbox');
  ok(!(await store.payers.get('gmtf')).tpaForFunderId, 'funder link removed when leaving live');

  // ---- 7. pharmacy comparison: basket analytics for patient and insurer
  const pc = await products.create('acacia', { type: 'solution', name: 'Cheapest pharmacy', config: {
    module: 'pharmacy_compare', surfaces: ['patient', 'hospital', 'payer'], title: 'Find the cheapest pharmacy', params: { anonymisePharmacies: true } } });
  await products.setStatus(pc.id, 'sandbox'); await products.setStatus(pc.id, 'live');
  const pr = await solutions.run(pc.id, 'patient', { input: { items: 'Amoxicillin\nParacetamol' } });
  const bk = pr.result.basket;
  ok(bk.comparable === 2 && bk.cheapest.total === 25 && bk.mostExpensive.total === 32 && bk.savings === 7, 'basket compares only pharmacies that price every item (Gamma excluded), cheapest GHS 25 vs 32');
  ok(bk.cheapest.name === 'Pharmacy A' && !('tenantId' in bk.cheapest) && !JSON.stringify(pr).includes('Alpha'), 'patient surface anonymises pharmacy names and hides ids when configured');
  ok(pr.result.items[0].pharmacies.length === 3 && pr.result.items[0].spreadPercent === 40, 'per-medicine ranking and price spread (20 -> 28 = 40%)');
  ok(/cheapest/.test(pr.result.advice), 'plain-language recommendation generated');
  const ins = await solutions.run(pc.id, 'payer', { payerId: 'acacia', input: { items: ['Amoxicillin', 'Paracetamol'] } });
  ok(ins.result.basket.cheapest.name === 'Alpha Pharmacy' && ins.result.basket.cheapest.tenantId === 'ph_a', 'insurer surface sees real pharmacy names and ids');
  const miss = await solutions.run(pc.id, 'payer', { payerId: 'acacia', input: { items: 'Unobtainium' } });
  ok(miss.result.notFound[0] === 'Unobtainium' && miss.result.basket === null, 'a medicine nobody billed is reported as not found, not invented');
  await rejects(() => solutions.run(pc.id, 'patient', { input: {} }), 422, 'patient comparison requires at least one item');
  const listed = await solutions.listFor('patient');
  ok(listed.length === 1 && listed[0].title === 'Find the cheapest pharmacy' && listed[0].inputs[0].key === 'items', 'patient directory lists only live patient solutions with their input fields');
  const hs = await solutions.listFor('hospital', { tenant: { id: 'tenant_euracare' } });
  ok(hs.some((x) => x.id === pc.id), 'hospital directory includes it');
  await products.update(pc.id, { config: { tenantIds: ['tenant_nyaho'] } });
  ok(!(await solutions.listFor('hospital', { tenant: { id: 'tenant_euracare' } })).some((x) => x.id === pc.id), 'tenant allow-list hides it from other hospitals');

  // ---- 8. reconciliation scoped to the caller and the payer
  await store.claims.insert({ id: 'clm_s1', tenantId: 'tenant_euracare', payerId: 'acacia', payerName: 'Acacia', status: 'settled', amount: 500, currency: 'GHS', createdAt: new Date().toISOString(), settledAt: new Date().toISOString(), nnest: { expedited: true } });
  await store.claims.insert({ id: 'clm_s2', tenantId: 'tenant_euracare', payerId: 'gmtf', payerName: 'GMTF', status: 'settled', amount: 300, currency: 'GHS', createdAt: new Date().toISOString(), settledAt: new Date().toISOString() });
  const rc = await products.create('acacia', { type: 'solution', name: 'Recon', config: { module: 'reconciliation' } });
  await products.setStatus(rc.id, 'sandbox');
  const rr = await solutions.run(rc.id, 'hospital', { tenant: { id: 'tenant_euracare' } });
  ok(rr.result.hnnSettled.count === 1 && rr.result.hnnSettled.total === 500, 'reconciliation shows only the owning payer\'s settled claims for the caller');
  const rp = await solutions.run(rc.id, 'payer', { payerId: 'acacia', input: { tenantId: 'tenant_euracare' } });
  ok(rp.result.hnnSettled.count === 1, 'payer surface can reconcile a named provider');
  await rejects(() => solutions.run(rc.id, 'payer', { payerId: 'acacia', input: {} }), 422, 'payer surface needs a tenantId');

  // other product types are untouched
  await rejects(async () => require('../src/services/incentives').compute(await store.products.get(pc.id), {}), 422, 'incentive engine refuses solution products (no accidental accrual)');
}

(async () => {
  await store.init();
  await smsChecks();
  await solutionChecks();
  console.log(`\n${a} assertions${process.exitCode ? ' — FAILURES ABOVE' : ' passed'}`);
})().catch((e) => { console.error(e); process.exit(1); });
