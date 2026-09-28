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
  v.verifiedBy = 'patient';
  await store.verifications.update(v);
  return v;
}

/**
 * Re-send the SAME verification link — for the hospital ("resend to patient" on the
 * billing screen) or the payer (when their dashboard shows it's still pending). A
 * disputed record gets reset to pending first, so the patient gets a fresh look —
 * useful once the hospital has corrected whatever they flagged.
 */
async function reissue(id) {
  const v = await store.verifications.get(id);
  if (!v) { const e = new Error('verification_not_found'); e.status = 404; throw e; }
  if (v.status === 'verified') { const e = new Error('verification_not_pending: verified'); e.status = 409; throw e; }
  if (v.status === 'disputed') { v.status = 'pending'; v.disputedAt = null; v.disputeReason = null; }
  v.remindersSent = (v.remindersSent || 0) + 1;
  v.lastRemindedAt = new Date().toISOString();
  await store.verifications.update(v);
  const bill = await store.bills.get(v.billId);
  if (bill) await notifyPatientVerification(v, bill);
  return v;
}

/**
 * The PAYER marks a bill verified without the patient having used their own link —
 * they looked at the claim themselves, called the hospital, or the member already
 * had a prior approval on file (pass priorApprovalId; the caller is responsible for
 * validating it belongs to them and matches the member before calling this). Kept
 * to a single verification record per bill, same as everywhere else in this feature —
 * on a split bill routed to more than one payer, one payer's override (like the
 * patient's own confirm) satisfies the shared bill-level record for all of them.
 */
async function overrideVerify(id, { by, reason, priorApprovalId } = {}) {
  const v = await store.verifications.get(id);
  if (!v) { const e = new Error('verification_not_found'); e.status = 404; throw e; }
  if (v.status === 'verified') { const e = new Error('verification_not_pending: verified'); e.status = 409; throw e; }
  v.status = 'verified';
  v.verifiedAt = new Date().toISOString();
  v.verifiedBy = priorApprovalId ? 'prior_approval' : 'payer_override';
  v.overrideReason = reason ? String(reason).slice(0, 300) : null;
  v.overridePriorApprovalId = priorApprovalId || null;
  v.overrideByPayerId = by || null;
  v.disputedAt = null; v.disputeReason = null;
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

module.exports = { createForBill, getByToken, forBill, confirm, dispute, reissue, overrideVerify };
