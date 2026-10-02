'use strict';

const crypto = require('crypto');
const store = require('../store');
const { executePayerTransfer, transferStatus } = require('./settlement');
const { notifyClaimOutcome } = require('./notifications');
const verification = require('./verification');
const ledger = require('./ledger');
const payerSlots = require('./payerSlots');
const networks = require('./networks');
const fees = require('./fees');

/** Route a bill to a payer (insurer/employer): create a claim + secure token. */
const split = require('./split');
const priceList = require('./priceList');
const claimsAutomation = require('./claimsAutomation');

// Validate a payer is usable for this bill (exists, slot active if facility-scoped).
async function assertPayer(bill, payerId) {
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('unknown_payer'); e.status = 422; throw e; }
  if (payer.tenantId) {
    if (payer.tenantId !== bill.tenantId) { const e = new Error('payer_not_available'); e.status = 403; throw e; }
    if (!payerSlots.isActive(payer)) {
      const e = new Error(payerSlots.isExpired(payer) ? 'payer_slot_expired' : 'payer_slot_disabled');
      e.status = 422; throw e;
    }
  }
  return payer;
}

/**
 * Build (but don't persist) one itemised claim for `payer`, covering `coveredGhs`
 * of the bill. Each line shows the fraction THIS payer covers, and the lines sum
 * exactly to coveredGhs. Used for both single-payer and split routing.
 */
async function buildClaim(bill, payer, memberId, coveredGhs, meta = {}) {
  const netP = Math.round((bill.totals.net || 0) * 100);
  const coveredP = Math.round((coveredGhs || 0) * 100);
  const coverRatio = netP > 0 ? coveredP / netP : 0;
  const discountRatio = (bill.totals.subtotal || 0) > 0
    ? (bill.totals.discount || 0) / (bill.totals.subtotal || 1) : 0;

  // OPTIONAL repricing: if this payer's price list governs settlement, look up each
  // item's approved price (facility-specific first, then payer default). The payer
  // covers at most the approved amount; the patient absorbs any gap. Default: OFF —
  // the billed price governs and the list is reference-only.
  const reprice = payer.repriceClaims === true;

  let allocated = 0;
  const items = (bill.lineItems || []);
  const claimLines = [];
  let repricedTotalP = 0;
  let anyReprice = false;

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const lineP = Math.round((it.cost || 0) * 100);
    const afterDiscountP = Math.round(lineP * (1 - discountRatio));

    // Base payer-covered amount by the pro-rata cover ratio.
    let payerCoversP = Math.round(afterDiscountP * coverRatio);
    allocated += payerCoversP;
    if (idx === items.length - 1) payerCoversP += (coveredP - allocated);

    let approvedPrice = null;
    if (reprice) {
      const hit = await priceList.priceFor(payer.id, {
        code: it.code, name: it.name, provider: bill.tenantId || bill.provider,
      });
      if (hit && hit.price != null) {
        approvedPrice = hit.price;
        anyReprice = true;
        // Approved line value = approved unit price x qty, then the payer covers up to
        // that (never more than what the pro-rata cover would have been either).
        const approvedLineP = Math.round(hit.price * (it.qty || 1) * 100);
        payerCoversP = Math.min(payerCoversP, approvedLineP);
      }
    }
    repricedTotalP += payerCoversP;

    claimLines.push({
      code: it.code || null, name: it.name, category: it.category || null,
      qty: it.qty || 1, unitPrice: it.unitPrice != null ? it.unitPrice : it.cost,
      lineTotal: it.cost,
      payerCovers: Math.round(payerCoversP) / 100,
      patientPortion: Math.round((afterDiscountP - payerCoversP)) / 100,
      ...(approvedPrice != null ? { approvedPrice } : {}),
      ...(it.nhisTariffCode ? { nhisTariffCode: it.nhisTariffCode } : {}),
    });
  }

  // When repricing changed the total, the claim amount is the repriced sum.
  const finalAmountP = (reprice && anyReprice) ? repricedTotalP : coveredP;

  const claim = {
    id: `clm_${crypto.randomBytes(8).toString('hex')}`,
    billId: bill.id, tenantId: bill.tenantId,
    payerId: payer.id, payerKind: payer.kind, payerName: payer.name,
    memberId: memberId || bill.coverage.memberId,
    amount: Math.round(finalAmountP) / 100, currency: bill.currency,
    lineItems: claimLines,
    breakdown: {
      subtotal: bill.totals.subtotal, discount: bill.totals.discount,
      net: bill.totals.net, payerShare: bill.totals.payerShare,
      patientShare: Math.round(((bill.totals.net || 0) - (bill.totals.payerShare || 0)) * 100) / 100,
      thisPayerCovers: Math.round(finalAmountP) / 100,
      ...(reprice && anyReprice ? {
        repriced: true,
        billedCover: Math.round(coveredP) / 100,
        approvedCover: Math.round(repricedTotalP) / 100,
        patientAbsorbs: Math.round((coveredP - repricedTotalP)) / 100,
      } : {}),
    },
    repriced: reprice && anyReprice,
    split: meta.split || null,
    patient: { name: bill.patient?.name || null, memberId: memberId || bill.coverage.memberId,
      sponsor: bill.coverage?.sponsor?.name || null },
    clinical: bill.clinical || null,
    provider: bill.provider,
    status: 'pending', createdAt: new Date().toISOString(),
    token: crypto.randomBytes(24).toString('base64url'),
  };
  claim.link = `/claim/?token=${claim.token}`;
  return claim;
}

/**
 * After a claim is created, give claims automation a chance to auto-clear it
 * (skip the manual Submissions/payer-portal click) when the payer has opted
 * in and the claim qualifies -- see services/claimsAutomation.js#evaluate. A
 * failed/thrown authorize() (patient_verification_pending, out_of_network, a
 * transient transfer error, ...) just leaves the claim exactly where it would
 * have landed anyway -- pending, for a human to review. Auto-clear is purely
 * a fast path; it can never make a claim WORSE off than today's behaviour.
 */
async function maybeAutoClear(claim, bill) {
  let decision;
  try {
    decision = await claimsAutomation.evaluate(claim, bill);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[claims] auto-adjudication evaluation failed for ${claim.id}:`, e);
    return;
  }
  if (!decision.autoClear) return;
  try {
    await authorize(claim.id);
    const c = await store.claims.get(claim.id);
    if (c) {
      c.autoCleared = { method: decision.method, ruleId: decision.ruleId, clearedAt: new Date().toISOString() };
      await store.claims.update(c);
    }
  } catch (e) {
    // Swallow -- see header comment. Nothing to recover: the claim is still
    // sitting exactly as a non-automated submission would leave it.
  }
}

/** Route to a single payer (the whole payer share). */
async function routeToPayer(bill, payerId) {
  const payer = await assertPayer(bill, payerId);
  if (!bill.coverage.memberId) { const e = new Error('missing_member_id'); e.status = 422; throw e; }

  const claim = await buildClaim(bill, payer, bill.coverage.memberId, bill.totals.payerShare);
  await store.claims.insert(claim);

  bill.status = 'awaiting_payer';
  bill.settlementMethod = 'payer_a2a';
  await store.bills.update(bill);

  await notifyClaimOutcome(claim, bill, 'submitted');
  await maybeAutoClear(claim, bill);
  // Re-read: maybeAutoClear may have just taken this claim all the way to
  // 'settled' -- the caller (e.g. routes/bills.js's response) should see
  // that, not the 'pending' snapshot from before auto-clear ran.
  const finalClaim = (await store.claims.get(claim.id)) || claim;
  return { claim: finalClaim, token: claim.token };
}

/**
 * Route to MULTIPLE payers, splitting the payer share between them. One claim per
 * payer, each itemised and each authorised independently. The claims sum exactly to
 * the bill's payer share. Falls back to single-payer routing if no split is given.
 */
async function routeToPayers(bill, splitInput) {
  const splitSpec = splitInput || bill.coverage.split;
  const alloc = split.allocate(bill.totals.payerShare, splitSpec,
    { payerId: bill.coverage.payerId, memberId: bill.coverage.memberId });

  if (!alloc.valid) { const e = new Error(alloc.error || 'invalid_split'); e.status = 422; e.detail = alloc; throw e; }
  if (alloc.single) return { claims: [(await routeToPayer(bill, alloc.payers[0].payerId)).claim], split: alloc };

  // Validate every payer up front so we don't create a partial set.
  const payers = [];
  for (const part of alloc.payers) {
    const p = await assertPayer(bill, part.payerId);
    const memberId = part.memberId || bill.coverage.memberId;
    if (!memberId) { const e = new Error('missing_member_id'); e.status = 422; e.payerId = part.payerId; throw e; }
    payers.push({ payer: p, memberId, amount: part.amount, percent: part.percent });
  }

  const summary = alloc.payers.map((p) => ({ payerId: p.payerId, amount: p.amount, percent: p.percent }));
  const claims = [];
  for (const { payer, memberId, amount } of payers) {
    const claim = await buildClaim(bill, payer, memberId, amount, { split: summary });
    await store.claims.insert(claim);
    claims.push(claim);
    await notifyClaimOutcome(claim, bill, 'submitted');
  }

  bill.status = 'awaiting_payer';
  bill.settlementMethod = 'payer_a2a_split';
  await store.bills.update(bill);

  // Only attempt auto-clear once EVERY sibling claim in this split already
  // exists in the store. finalizeSettled()'s "mark the bill settled once
  // every sibling claim is settled" check reads siblings from the store at
  // that instant -- auto-clearing one claim before the others in its own
  // split are even inserted would let that check see an incomplete sibling
  // set (vacuously "all settled") and close the bill early, before the
  // remaining payers have been billed at all.
  for (const claim of claims) {
    await maybeAutoClear(claim, bill);
  }

  // Re-read each claim -- maybeAutoClear may have taken any of them straight
  // to 'settled'; the caller should see that, not each 'pending' snapshot.
  const finalClaims = await Promise.all(claims.map(async (c) => (await store.claims.get(c.id)) || c));
  return { claims: finalClaims, split: alloc };
}

const getByToken = (token) => store.claims.byToken(token);

/**
 * Insurer/employer authorises the A2A transfer.
 * Step 1 (tx + FOR UPDATE): atomically claim the work by flipping pending->authorizing,
 * so concurrent instances can't both fire the transfer. Step 2: do the SBG transfer
 * OUTSIDE the lock (never hold a row lock across a network call). Step 3: finalise.
 */
async function authorize(claimId) {
  // Opt-in gate (payer.requirePatientVerification, default off — mirrors repriceClaims):
  // when on, the patient must have verified their bill before this payer can
  // authorise the A2A transfer. A cheap read-mostly pre-check, outside the row lock —
  // this never moves money, so it doesn't need tx()/FOR UPDATE, just a check before we
  // ever enter it. A missing or disputed verification is treated the same as pending.
  const peek = await store.claims.get(claimId);
  if (!peek) { const e = new Error('claim_not_found'); e.status = 404; throw e; }
  const payerPeek = await store.payers.get(peek.payerId);
  if (payerPeek?.requirePatientVerification === true) {
    const v = await verification.forBill(peek.billId);
    if (!v || v.status !== 'verified') {
      const e = new Error('patient_verification_pending'); e.status = 409; throw e;
    }
  }

  const claim = await store.tx(async (t) => {
    const c = await t.claims.get(claimId, { forUpdate: true });
    if (!c) { const e = new Error('claim_not_found'); e.status = 404; throw e; }
    if (c.status !== 'pending') { const e = new Error(`claim_not_pending: ${c.status}`); e.status = 409; throw e; }
    c.status = 'authorizing';
    await t.claims.update(c);
    return c;
  });

  const bill = await store.bills.get(claim.billId);
  const payer = await store.payers.get(claim.payerId);
  const tenant = await store.tenants.get(claim.tenantId);

  // NNEST: does this payer settle this provider instantly, and on what terms?
  let decision;
  try {
    decision = await networks.resolve(payer, claim.tenantId, claim.amount);
  } catch (e) {
    claim.status = 'pending';
    await store.claims.update(claim);
    throw e;                       // out_of_network under a blocking narrow-network policy
  }
  claim.nnest = {
    inNetwork: decision.inNetwork, expedited: decision.expedited, reason: decision.reason,
    grossAmount: decision.grossAmount, promptPaymentDiscount: decision.promptPaymentDiscount,
    settlementAmount: decision.settlementAmount, terms: decision.terms || null,
  };
  claim.settlementAmount = decision.settlementAmount;

  // Settlement cycle: 'immediate' (the only option before this existed, and
  // still the default for any payer/terms that never set one) transfers
  // synchronously right here, exactly as always. A non-immediate cycle
  // ('daily'/'biweekly', see services/networks.js#resolveCycle) instead PARKS
  // the claim as 'authorized' -- decided/adjudicated, amount locked in, but
  // not yet paid -- for services/settlementBatches.js to sweep up and pay as
  // one consolidated transfer per tenant+payer on its cycle. Fees/ledger for
  // a parked claim are posted when the batch actually transfers the money,
  // not here (see settlementBatches.js), so nothing accrues on a claim that
  // hasn't actually been paid yet.
  const cycle = await networks.resolveCycle(payer, claim.tenantId);
  if (cycle !== 'immediate') {
    claim.status = 'authorized';
    claim.settlementCycle = cycle;
    claim.settlementQueuedAt = new Date().toISOString();
    claim.authorizedAt = new Date().toISOString();
    await store.claims.update(claim);
    return claim;
  }

  let transfer;
  try {
    transfer = await executePayerTransfer({ bill, payer, tenant, amount: decision.settlementAmount });
  } catch (e) {
    claim.status = 'pending'; // release for retry
    await store.claims.update(claim);
    throw e;
  }

  claim.serviceRequestId = transfer.serviceRequestId;
  claim.transferReference = transfer.reference;
  claim.beneficiaryName = transfer.beneficiaryName;
  claim.serviceCharge = transfer.serviceCharge;
  claim.funderId = transfer.funderId || null;       // set only when a TPA payer settled via a funder's own account (services/funders.js)
  claim.funderName = transfer.funderName || null;
  claim.status = transfer.status === 'SUCCESS' ? 'settled' : 'authorized';
  claim.authorizedAt = new Date().toISOString();
  await store.claims.update(claim);

  if (claim.status === 'settled') await finalizeSettled(claim, bill);
  return claim;
}

async function reject(claimId, reason) {
  const claim = await store.tx(async (t) => {
    const c = await t.claims.get(claimId, { forUpdate: true });
    if (!c) { const e = new Error('claim_not_found'); e.status = 404; throw e; }
    if (c.status !== 'pending') { const e = new Error(`claim_not_pending: ${c.status}`); e.status = 409; throw e; }
    c.status = 'rejected';
    c.rejectionReason = reason || null;
    c.rejectedAt = new Date().toISOString();
    await t.claims.update(c);
    return c;
  });
  const bill = await store.bills.get(claim.billId);
  bill.status = 'rejected';
  await store.bills.update(bill);
  await notifyClaimOutcome(claim, bill, 'rejected');
  return claim;
}

async function refresh(claim) {
  if (claim.status !== 'authorized') return claim;
  const payer = await store.payers.get(claim.payerId);
  if (await transferStatus(payer, claim.serviceRequestId) === 'SUCCESS') {
    claim.status = 'settled';
    await store.claims.update(claim);
    await finalizeSettled(claim, await store.bills.get(claim.billId));
  }
  return claim;
}

async function finalizeSettled(claim, bill) {
  claim.settledAt = new Date().toISOString();
  const payer = await store.payers.get(claim.payerId);
  await store.tx(async (t) => {
    await t.claims.update(claim);
    await t.ledger.insert(ledger.entry({
      tenantId: bill.tenantId, billId: bill.id, type: 'payer_settlement',
      source: { kind: payer?.kind || 'payer', id: claim.payerId, name: payer?.name },
      amount: claim.amount, currency: claim.currency, cashMovement: true,
      refs: { claimId: claim.id, serviceRequestId: claim.serviceRequestId, reference: claim.transferReference },
    }));

    // For a split bill, only mark the bill settled once EVERY sibling claim on it is
    // settled; otherwise the bill remains awaiting_payer until the others pay.
    const siblings = (await t.claims.listByBill(bill.id)) || [];
    const others = siblings.filter((s) => s.id !== claim.id);
    const allSettled = others.every((s) => s.status === 'settled');
    if (allSettled) {
      bill.status = 'settled';
      await t.bills.update(bill);
    }
  });
  // SaaS revenue: expedited-settlement fee (NNEST terms take precedence over the
  // facility default), the payer's own commission if it's commercial, plus a
  // discount fee if one applies.
  await fees.onClaimSettled(claim, bill);
  await fees.onPayerCommission(claim, bill, payer);
  if (bill.totals?.discount > 0) {
    await fees.onDiscountApplied(bill, bill.adjustments?.discountKind || 'standard');
  }
  await notifyClaimOutcome(claim, bill, 'settled');
}

// finalizeSettled is exported for services/settlementBatches.js, which calls it
// once per claim after a single consolidated bank transfer covers a whole
// batch -- so a batch-settled claim gets exactly the same ledger entry, SaaS
// fees, bill-settled check and notification an immediately-settled one does.
module.exports = { routeToPayer, routeToPayers, getByToken, authorize, reject, refresh, finalizeSettled };
