'use strict';

const crypto = require('crypto');
const store = require('../store');
const { notifyPatientVerification, notifyVerificationOutcome } = require('./notifications');

/**
 * Patient bill verification — a secure-link "portal" record, one per bill, in the
 * same shape as claims/reports. Created unconditionally the moment a bill exists so
 * the patient can confirm the charges are correct. This never blocks or delays bill
 * creation or routing; a payer that has opted into `requirePatientVerification`
 * (see services/claims.js authorize()) is the only place this record's status is
 * ever enforced, and only at the point of authorising the A2A transfer.
 */
async function createForBill(bill) {
  const v = {
    id: `vfy_${crypto.randomBytes(8).toString('hex')}`,
    billId: bill.id, tenantId: bill.tenantId,
    status: 'pending', // pending -> verified | disputed
    token: crypto.randomBytes(24).toString('base64url'),
    patientName: bill.patient?.name || null,
    provider: bill.provider,
    amount: bill.totals?.net ?? null, currency: bill.currency,
    createdAt: new Date().toISOString(),
    verifiedAt: null, disputedAt: null, disputeReason: null,
  };
  v.link = `/verify/?token=${v.token}`;
  await store.verifications.insert(v);
  await notifyPatientVerification(v, bill);
  return v;
}

const getByToken = (token) => store.verifications.byToken(token);
const forBill = (billId) => store.verifications.byBill(billId);

async function confirm(id) {
  const v = await store.verifications.get(id);
  if (!v) { const e = new Error('verification_not_found'); e.status = 404; throw e; }
  if (v.status !== 'pending') { const e = new Error(`verification_not_pending: ${v.status}`); e.status = 409; throw e; }
  v.status = 'verified';
  v.verifiedAt = new Date().toISOString();
  await store.verifications.update(v);
  return v;
}

async function dispute(id, reason) {
  const v = await store.verifications.get(id);
  if (!v) { const e = new Error('verification_not_found'); e.status = 404; throw e; }
  if (v.status !== 'pending') { const e = new Error(`verification_not_pending: ${v.status}`); e.status = 409; throw e; }
  v.status = 'disputed';
  v.disputedAt = new Date().toISOString();
  v.disputeReason = reason || null;
  await store.verifications.update(v);
  const bill = await store.bills.get(v.billId);
  if (bill) await notifyVerificationOutcome(v, bill, 'disputed');
  return v;
}

module.exports = { createForBill, getByToken, forBill, confirm, dispute };
