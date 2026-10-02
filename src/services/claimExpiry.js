'use strict';

const store = require('../store');
const verification = require('./verification');
const { notify } = require('./notifications');

/**
 * Claim expiry / revert-to-RX. An expedited claim HNN's A2A rail hasn't been
 * able to close -- still sitting unresolved, or whose patient verification
 * was disputed -- falls back out of the fast lane after a configurable
 * window (14 days, as named on the call) so it stops looking like a live
 * expedited claim and the provider knows to pursue it through the payer's
 * own normal/standard claims channel instead.
 *
 * Important limitation: HNN Biller has no API access into Rx Claim (or any
 * other payer's own claims system) yet -- see the Phase 1 integration plan --
 * so this can only MARK the claim and notify the provider that it needs
 * standard handling. It cannot actually resubmit the claim into a payer's RX
 * queue; that becomes possible once the Phase 3 write-back API exists.
 *
 * Unlike claimsAutomation.js, this never moves money and never changes an
 * already-settled claim, so it's safe to default ON at the window named on
 * the call -- the worst case of a wrong default is an extra status label and
 * an in-app notification, not a financial error.
 */

const KEY = 'claim_expiry_policy';
const OPEN_STATUSES = ['pending', 'authorizing', 'authorized'];

function defaultPolicy() {
  return { enabled: true, windowDays: 14, updatedAt: null, updatedBy: null };
}

async function getPolicy() {
  const saved = await store.settings.get(KEY);
  if (!saved) return defaultPolicy();
  const windowDays = Number(saved.windowDays);
  return { enabled: saved.enabled !== false, windowDays: Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 14,
    updatedAt: saved.updatedAt || null, updatedBy: saved.updatedBy || null };
}

async function setPolicy(patch = {}, by = 'HNN') {
  const current = await getPolicy();
  const next = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  if (patch.windowDays !== undefined) {
    const n = Number(patch.windowDays);
    if (!Number.isFinite(n) || n <= 0) { const e = new Error('windowDays_must_be_a_positive_number'); e.status = 422; throw e; }
    next.windowDays = n;
  }
  next.updatedAt = new Date().toISOString();
  next.updatedBy = by;
  await store.settings.set(KEY, next);
  return next;
}

/** Age of a claim in days, from when it was created (the expedited clock starts at submission). */
function ageDays(claim, now) {
  return (now - new Date(claim.createdAt).getTime()) / 86400000;
}

async function expireClaim(claim, reason) {
  claim.status = 'expired_to_standard';
  claim.expiredAt = new Date().toISOString();
  claim.expiredReason = reason;
  await store.claims.update(claim);

  const bill = await store.bills.get(claim.billId);
  const tenant = bill ? await store.tenants.get(bill.tenantId) : null;
  await notify({
    party: 'provider', to: tenant?.contact?.email,
    subject: `Claim ${claim.id} reverted to standard processing`,
    body: `This claim (${claim.currency} ${Number(claim.amount).toFixed(2)}${bill?.patient?.name ? ` for ${bill.patient.name}` : ''}) `
      + `could not be closed through HNN's expedited settlement within the configured window and has been marked for `
      + `standard processing through ${claim.payerName || 'the payer'}'s normal claims channel. Reason: ${reason === 'verification_disputed' ? 'the patient disputed this bill' : 'unresolved within the window'}.`,
    claimId: claim.id, billId: claim.billId,
  });
  return claim;
}

/**
 * Sweep open claims and expire anything stale. Returns a summary rather than
 * the full claim list, since this is meant to run unattended on an interval
 * (see server.js) as well as on demand from Master Control.
 */
async function runExpiryPass(now = Date.now()) {
  const policy = await getPolicy();
  if (!policy.enabled) return { enabled: false, checked: 0, expired: 0, expiredClaimIds: [] };

  let checked = 0;
  const expiredClaimIds = [];
  for (const status of OPEN_STATUSES) {
    const claims = await store.claims.byStatus(status, 2000);
    for (const claim of claims) {
      checked++;
      let reason = null;
      if (ageDays(claim, now) > policy.windowDays) {
        reason = 'unresolved_after_window';
      } else {
        const v = await verification.forBill(claim.billId).catch(() => null);
        if (v && v.status === 'disputed' && v.disputedAt && (now - new Date(v.disputedAt).getTime()) / 86400000 > policy.windowDays) {
          reason = 'verification_disputed';
        }
      }
      if (reason) {
        await expireClaim(claim, reason);
        expiredClaimIds.push(claim.id);
      }
    }
  }
  return { enabled: true, windowDays: policy.windowDays, checked, expired: expiredClaimIds.length, expiredClaimIds };
}

/** Manual override: expire one claim right now regardless of its age. */
async function expireNow(claimId, by = 'HNN') {
  const claim = await store.claims.get(claimId);
  if (!claim) { const e = new Error('claim_not_found'); e.status = 404; throw e; }
  if (!OPEN_STATUSES.includes(claim.status)) { const e = new Error(`claim_not_open: ${claim.status}`); e.status = 409; throw e; }
  await expireClaim(claim, 'manual_override');
  claim.expiredBy = by;
  await store.claims.update(claim);
  return claim;
}

async function listExpired(limit = 200) {
  return store.claims.byStatus('expired_to_standard', limit);
}

module.exports = { KEY, getPolicy, setPolicy, runExpiryPass, expireNow, listExpired };
