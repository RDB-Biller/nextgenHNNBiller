'use strict';

const crypto = require('crypto');
const store = require('../store');
const { executePayerTransfer, transferStatus } = require('./settlement');
const { notifyClaimOutcome } = require('./notifications');
const ledger = require('./ledger');

/** Route a bill to a payer (insurer/employer): create a claim + secure token. */
async function routeToPayer(bill, payerId) {
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('unknown_payer'); e.status = 422; throw e; }
  if (!bill.coverage.memberId) { const e = new Error('missing_member_id'); e.status = 422; throw e; }

  const claim = {
    id: `clm_${crypto.randomBytes(8).toString('hex')}`,
    billId: bill.id, tenantId: bill.tenantId,
    payerId, payerKind: payer.kind, memberId: bill.coverage.memberId,
    amount: bill.totals.payerShare, currency: bill.currency,
    status: 'pending', createdAt: new Date().toISOString(),
    token: crypto.randomBytes(24).toString('base64url'),
  };
  claim.link = `/claim/?token=${claim.token}`;
  await store.claims.insert(claim);

  bill.status = 'awaiting_payer';
  bill.settlementMethod = 'payer_a2a';
  await store.bills.update(bill);

  await notifyClaimOutcome(claim, bill, 'submitted');
  return { claim, token: claim.token };
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

  let transfer;
  try {
    transfer = await executePayerTransfer({ bill, payer, tenant, amount: claim.amount });
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
    bill.status = 'settled';
    await t.bills.update(bill);
    await t.claims.update(claim);
    await t.ledger.insert(ledger.entry({
      tenantId: bill.tenantId, billId: bill.id, type: 'payer_settlement',
      source: { kind: payer?.kind || 'payer', id: claim.payerId, name: payer?.name },
      amount: claim.amount, currency: claim.currency, cashMovement: true,
      refs: { claimId: claim.id, serviceRequestId: claim.serviceRequestId, reference: claim.transferReference },
    }));
  });
  await notifyClaimOutcome(claim, bill, 'settled');
}

module.exports = { routeToPayer, getByToken, authorize, reject, refresh };
