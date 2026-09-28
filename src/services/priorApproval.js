'use strict';

const crypto = require('crypto');
const store = require('../store');

/**
 * Payer-managed pre-authorization: an insurer/employer can approve a member for a
 * service in advance, so that when the matching claim later arrives, they can
 * authorise it by referencing this instead of waiting on the patient's own
 * verification. Deliberately simple — scoped to payer + memberId (not tied to a
 * specific provider/tenant, since the member may be seen at any facility), with an
 * optional amount cap and expiry. Tracks how many times it's been referenced for
 * visibility, but never hard-enforces the cap or auto-expires a claim over it —
 * that judgement call stays with the payer.
 */
async function create(payerId, { memberId, description, amountCap, expiresAt, patientName } = {}) {
  if (!memberId) { const e = new Error('member_id_required'); e.status = 422; throw e; }
  const pa = {
    id: `pra_${crypto.randomBytes(8).toString('hex')}`,
    payerId, memberId: String(memberId),
    patientName: patientName || null,
    description: description ? String(description).slice(0, 300) : null,
    amountCap: amountCap != null && amountCap !== '' ? Number(amountCap) : null,
    status: 'active', // active | revoked (expiry is computed, not stored as a status transition)
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    timesUsed: 0, lastUsedAt: null, lastUsedClaimId: null,
  };
  await store.priorApprovals.insert(pa);
  return pa;
}

const effectiveStatus = (pa) => (pa.status === 'revoked' ? 'revoked'
  : (pa.expiresAt && new Date(pa.expiresAt).getTime() < Date.now()) ? 'expired' : 'active');

async function listByPayer(payerId) {
  const rows = await store.priorApprovals.listByPayer(payerId);
  return rows.map((pa) => ({ ...pa, effectiveStatus: effectiveStatus(pa) }));
}

/** Active prior approvals for this payer that match a member — what a claim view offers to reference. */
async function activeForMember(payerId, memberId) {
  if (!memberId) return [];
  const rows = await store.priorApprovals.listByPayer(payerId);
  return rows.filter((pa) => pa.memberId === String(memberId) && effectiveStatus(pa) === 'active');
}

async function revoke(id, payerId) {
  const pa = await store.priorApprovals.get(id);
  if (!pa || pa.payerId !== payerId) { const e = new Error('prior_approval_not_found'); e.status = 404; throw e; }
  pa.status = 'revoked';
  await store.priorApprovals.update(pa);
  return pa;
}

/** Called when a claim is authorised by referencing this approval — usage trail only, not a hard limit. */
async function markUsed(id, claimId) {
  const pa = await store.priorApprovals.get(id);
  if (!pa) return null;
  pa.timesUsed = (pa.timesUsed || 0) + 1;
  pa.lastUsedAt = new Date().toISOString();
  pa.lastUsedClaimId = claimId || null;
  await store.priorApprovals.update(pa);
  return pa;
}

module.exports = { create, listByPayer, activeForMember, revoke, markUsed, effectiveStatus };
