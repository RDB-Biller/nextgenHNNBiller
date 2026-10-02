'use strict';

const crypto = require('crypto');
const store = require('../store');
const { executePayerTransfer } = require('./settlement');
const claimsService = require('./claims');

/**
 * Settlement batches — the consolidation engine behind two gaps from the call
 * at once:
 *
 *   - Configurable settlement cycles ("staggered/biweekly" beyond immediate):
 *     services/networks.js#resolveCycle decides WHICH cycle a claim gets, at
 *     authorize() time; this module decides WHEN a cycle's queued claims
 *     actually get paid.
 *   - Daily consolidated billing (Benson's question — "one settlement per
 *     provider per day/period instead of per-claim"): every claim queued for
 *     the same tenant+payer+cycle is paid with ONE disbursement call for
 *     their summed amount, not one bank transfer per claim.
 *
 * A claim only lands here via services/claims.js#authorize(): when
 * networks.resolveCycle() returns anything other than 'immediate', authorize()
 * stops short of calling the settlement rail and instead parks the claim as
 * status:'authorized' with settlementCycle/settlementQueuedAt set. This module
 * never adjudicates anything — it only moves money for claims authorize()
 * already decided, grouped up and paid together.
 *
 * Grouping key is tenantId+payerId+settlementCycle (not just tenant+payer): a
 * claim's cycle is locked in at the moment authorize() parked it, so if a
 * payer's posture or per-provider terms change later, already-queued claims
 * still settle on the cycle they were promised, while new claims pick up
 * whatever the new terms say going forward.
 *
 * "Due" means: no earlier SETTLED batch exists yet for this exact group (so
 * the first sweep that finds queued claims pays them, establishing the anchor
 * time), or the cycle's full interval has elapsed since the last settled
 * batch's createdAt. A FAILED batch does not push the anchor out — it's
 * retried on the next sweep rather than waiting a full cycle again.
 *
 * Money-safety posture, matching the rest of this codebase: a batch that
 * fails (the rail throws, or returns anything other than SUCCESS) leaves
 * every one of its claims completely untouched — still status:'authorized',
 * still eligible for the next sweep. Nothing is ever half-settled. Per-claim
 * bookkeeping on success (ledger entry, SaaS fees, the "all siblings settled"
 * bill check, notification) reuses claims.js#finalizeSettled exactly as the
 * immediate path uses it — a batch changes WHO calls it and HOW MANY bank
 * transfers back it, never what "settled" means for a claim or a bill.
 */

const CYCLE_MS = { daily: 24 * 3600 * 1000, biweekly: 14 * 24 * 3600 * 1000 };

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const groupKey = (tenantId, payerId, cycle) => `${tenantId}:${payerId}:${cycle}`;

/** Claims parked by authorize() for batch settlement, not yet swept into a batch. */
async function listQueued(limit = 5000) {
  const claims = await store.claims.byStatus('authorized', limit);
  return claims.filter((c) => c.settlementCycle && c.settlementCycle !== 'immediate' && !c.settlementBatchId);
}

function groupsOf(queued) {
  const groups = new Map();
  for (const claim of queued) {
    const key = groupKey(claim.tenantId, claim.payerId, claim.settlementCycle);
    if (!groups.has(key)) {
      groups.set(key, { tenantId: claim.tenantId, payerId: claim.payerId, cycle: claim.settlementCycle, claims: [] });
    }
    groups.get(key).claims.push(claim);
  }
  return groups;
}

/** Most recent SETTLED batch for this exact tenant+payer+cycle, or null. */
async function lastSettledBatch(tenantId, payerId, cycle) {
  const all = await store.settlementBatches.listByTenant(tenantId);
  const matches = all.filter((b) => b.payerId === payerId && b.cycle === cycle && b.status === 'settled');
  if (!matches.length) return null;
  return matches.reduce((latest, b) => (new Date(b.createdAt) > new Date(latest.createdAt) ? b : latest));
}

async function isDue(tenantId, payerId, cycle, now) {
  const last = await lastSettledBatch(tenantId, payerId, cycle);
  if (!last) return true;
  const ms = CYCLE_MS[cycle] || CYCLE_MS.daily;
  return (now - new Date(last.createdAt).getTime()) >= ms;
}

/**
 * Pay one group's queued claims as a single consolidated transfer. Always
 * returns the batch record, whether it settled or failed. Claims are mutated
 * only on the success path; a dropped/orphaned claim (no bill found) is
 * excluded from the transferred sum entirely rather than left stranded after
 * money has already moved for it.
 */
async function settleGroup({ tenantId, payerId, cycle, claims: candidateClaims }, { force = false, by = 'HNN' } = {}) {
  const tenant = await store.tenants.get(tenantId);
  const payer = await store.payers.get(payerId);

  const withBills = [];
  for (const claim of candidateClaims) {
    const bill = await store.bills.get(claim.billId);
    if (bill) withBills.push({ claim, bill });
  }

  const batch = {
    id: `batch_${crypto.randomBytes(8).toString('hex')}`,
    tenantId, payerId, cycle,
    status: 'pending',
    claimIds: withBills.map(({ claim }) => claim.id),
    claimCount: withBills.length,
    amount: round2(withBills.reduce((sum, { claim }) => sum + (Number(claim.settlementAmount ?? claim.amount) || 0), 0)),
    currency: candidateClaims[0]?.currency || 'GHS',
    forced: force === true,
    createdAt: new Date().toISOString(),
    createdBy: by,
  };

  if (!tenant || !payer || !withBills.length) {
    batch.status = 'failed';
    batch.error = !tenant ? 'unknown_provider' : !payer ? 'unknown_payer' : 'no_settleable_claims';
    await store.settlementBatches.insert(batch);
    return batch;
  }

  let transfer;
  try {
    transfer = await executePayerTransfer({
      bill: { id: batch.id }, // settlement.js only reads bill.id, for its default narration/extraDetails -- both are overridden below
      payer, tenant, amount: batch.amount,
      narration: `Consolidated ${cycle} settlement - ${withBills.length} claim(s) - ${tenant.name} via ${payer.name}`.slice(0, 100),
      extraDetails: batch.id,
    });
  } catch (e) {
    batch.status = 'failed';
    batch.error = e.message || 'transfer_failed';
    await store.settlementBatches.insert(batch);
    return batch;
  }

  if (transfer.status !== 'SUCCESS') {
    batch.status = 'failed';
    batch.error = `rail_returned_${transfer.status || 'unknown'}`;
    await store.settlementBatches.insert(batch);
    return batch;
  }

  batch.status = 'settled';
  batch.settledAt = new Date().toISOString();
  batch.serviceRequestId = transfer.serviceRequestId;
  batch.transferReference = transfer.reference;
  batch.beneficiaryName = transfer.beneficiaryName;
  batch.serviceCharge = transfer.serviceCharge;
  batch.rail = transfer.rail;
  batch.stub = transfer.stub;
  batch.funderId = transfer.funderId || null;       // set only when this payer is a TPA settling via a funder's own account
  batch.funderName = transfer.funderName || null;
  await store.settlementBatches.insert(batch);

  // Close out each claim exactly as the immediate path would have -- same
  // ledger entry, SaaS fees, bill-settled check and notification -- just
  // stamped with which batch actually moved the money, and all sharing that
  // ONE transfer's reference (and funder attribution, if any) rather than
  // minting one per claim.
  for (const { claim, bill } of withBills) {
    claim.settlementBatchId = batch.id;
    claim.serviceRequestId = transfer.serviceRequestId;
    claim.transferReference = transfer.reference;
    claim.beneficiaryName = transfer.beneficiaryName;
    claim.funderId = transfer.funderId || null;
    claim.funderName = transfer.funderName || null;
    claim.status = 'settled';
    claim.authorizedAt = claim.authorizedAt || new Date().toISOString();
    await store.claims.update(claim);
    await claimsService.finalizeSettled(claim, bill);
  }

  return batch;
}

/**
 * The scheduled sweep (see server.js): find every due group among queued
 * claims and settle it. Safe to call as often as you like -- a group that
 * isn't due yet is simply skipped, not retried early, and a group with no
 * queued claims never appears at all.
 */
async function runDue(now = Date.now()) {
  const queued = await listQueued();
  const groups = groupsOf(queued);
  const result = { checked: queued.length, groups: groups.size, batched: [], skipped: [], failed: [] };

  for (const group of groups.values()) {
    const due = await isDue(group.tenantId, group.payerId, group.cycle, now);
    if (!due) {
      result.skipped.push({ tenantId: group.tenantId, payerId: group.payerId, cycle: group.cycle, claimCount: group.claims.length });
      continue;
    }
    const batch = await settleGroup(group);
    const summary = { id: batch.id, tenantId: batch.tenantId, payerId: batch.payerId, cycle: batch.cycle,
      status: batch.status, claimCount: batch.claimCount, amount: batch.amount, error: batch.error || null };
    (batch.status === 'settled' ? result.batched : result.failed).push(summary);
  }
  return result;
}

/** Manual "run now" override for Master Control: one tenant+payer+cycle, ignoring due-ness. */
async function runGroupNow(tenantId, payerId, cycle, by = 'HNN') {
  const queued = (await listQueued())
    .filter((c) => c.tenantId === tenantId && c.payerId === payerId && c.settlementCycle === cycle);
  if (!queued.length) { const e = new Error('no_queued_claims_for_group'); e.status = 404; throw e; }
  return settleGroup({ tenantId, payerId, cycle, claims: queued }, { force: true, by });
}

async function listBatches(tenantId, limit = 200) {
  return tenantId ? store.settlementBatches.listByTenant(tenantId) : store.settlementBatches.all(limit);
}

async function getBatch(id) {
  return store.settlementBatches.get(id);
}

/** Preview for Master Control: queued-but-unpaid claims grouped, with amount and due-ness, before any money moves. */
async function previewQueue(now = Date.now()) {
  const queued = await listQueued();
  const groups = groupsOf(queued);
  const out = [];
  for (const group of groups.values()) {
    const [due, tenant, payer] = await Promise.all([
      isDue(group.tenantId, group.payerId, group.cycle, now),
      store.tenants.get(group.tenantId),
      store.payers.get(group.payerId),
    ]);
    out.push({
      tenantId: group.tenantId, tenantName: tenant?.name || group.tenantId,
      payerId: group.payerId, payerName: payer?.name || group.payerId,
      cycle: group.cycle, claimCount: group.claims.length,
      amount: round2(group.claims.reduce((s, c) => s + (Number(c.settlementAmount ?? c.amount) || 0), 0)),
      due,
    });
  }
  return out;
}

module.exports = { CYCLE_MS, listQueued, runDue, runGroupNow, listBatches, getBatch, previewQueue };
