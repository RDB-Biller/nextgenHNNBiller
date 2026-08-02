'use strict';

const crypto = require('crypto');
const store = require('../store');
const { executePayerTransfer, transferStatus } = require('./settlement');
const { notifyClaimOutcome } = require('./notifications');
const ledger = require('./ledger');
const payerSlots = require('./payerSlots');
const networks = require('./networks');
const fees = require('./fees');

/** Route a bill to a payer (insurer/employer): create a claim + secure token. */
const split = require('./split');
const priceList = require('./priceList');

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
  return { claim, token: claim.token };
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

  return { claims, split: alloc };
}

const getByToken = (token) => store.claims.byToken(token);

/**
 * Insurer/employer authorises the A2A transfer.
 * Step 1 (tx + FOR UPDATE): atomically claim the work by flipping pending->authorizing,
 * so concurrent instances can't both fire the transfer. Step 2: do the SBG transfer
 * OUTSIDE the lock (never hold a row lock across a network call). Step 3: finalise.
 */
async function authorize(claimId) {
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
  // facility default), plus a discount fee if one applies.
  await fees.onClaimSettled(claim, bill);
  if (bill.totals?.discount > 0) {
    await fees.onDiscountApplied(bill, bill.adjustments?.discountKind || 'standard');
  }
  await notifyClaimOutcome(claim, bill, 'settled');
}

module.exports = { routeToPayer, routeToPayers, getByToken, authorize, reject, refresh };
