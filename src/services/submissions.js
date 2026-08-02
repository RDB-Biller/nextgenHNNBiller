'use strict';

const store = require('../store');
const claimsService = require('./claims');

/**
 * SaaS administrator view over ALL submissions, across every developer/tenant.
 *
 * In the standard flow the PAYER authorises a claim. This module gives the SaaS
 * administrator an oversight/approval path: see every submission, and approve or
 * decline centrally. Approving reuses the same claim-authorisation logic, which
 * runs the Stanbic A2A transfer to the provider and posts the ledger entry — so
 * "admin approves" and "payer authorises" settle through exactly one code path.
 */

async function enrich(c) {
  const bill = await store.bills.get(c.billId);
  const payer = await store.payers.get(c.payerId);
  const tenant = await store.tenants.get(c.tenantId);
  return {
    claimId: c.id, status: c.status,
    amount: c.amount, settlementAmount: c.settlementAmount ?? c.amount, currency: c.currency,
    tenantId: c.tenantId, provider: tenant?.name || bill?.provider || null,
    payerId: c.payerId, payerName: payer?.name || null, payerKind: payer?.kind || null,
    memberId: c.memberId,
    patientName: bill?.patient?.name || null,
    lineItems: (bill?.lineItems || []).map((i) => ({ name: i.name, cost: i.cost })),
    nnest: c.nnest || null,
    transferReference: c.transferReference || null,
    serviceRequestId: c.serviceRequestId || null,
    createdAt: c.createdAt, authorizedAt: c.authorizedAt || null,
    rejectionReason: c.rejectionReason || null,
    approvedBy: c.approvedBy || null,
  };
}

/** All submissions, optionally filtered by status or tenant. */
async function list({ status, tenantId, limit = 200 } = {}) {
  let rows = status ? await store.claims.byStatus(status, limit) : await store.claims.all(limit);
  if (tenantId) rows = rows.filter((c) => c.tenantId === tenantId);
  return Promise.all(rows.map(enrich));
}

/** Counts + value by status, across everyone. */
async function summary() {
  const rows = await store.claims.all(2000);
  const val = (st) => rows.filter((c) => c.status === st).reduce((a, c) => a + (c.settlementAmount ?? c.amount), 0);
  return {
    total: rows.length,
    pending: rows.filter((c) => c.status === 'pending').length,
    pendingValue: Math.round(val('pending') * 100) / 100,
    settled: rows.filter((c) => c.status === 'settled').length,
    settledValue: Math.round(val('settled') * 100) / 100,
    authorized: rows.filter((c) => c.status === 'authorized').length,
    rejected: rows.filter((c) => c.status === 'rejected').length,
  };
}

const one = async (id) => {
  const c = await store.claims.get(id);
  if (!c) { const e = new Error('claim_not_found'); e.status = 404; throw e; }
  return c;
};

/**
 * Approve a submission → runs the A2A transfer to the provider (Stanbic) and
 * settles, via the same guarded, idempotent path the payer uses.
 */
async function approve(claimId, by = 'administrator') {
  const c = await one(claimId);
  await claimsService.authorize(c.id);           // executes the Stanbic A2A transfer
  const settled = await store.claims.get(c.id);
  settled.approvedBy = by;
  settled.approvedAt = new Date().toISOString();
  await store.claims.update(settled);
  return enrich(settled);
}

async function decline(claimId, reason, by = 'administrator') {
  const c = await one(claimId);
  await claimsService.reject(c.id, reason);
  const done = await store.claims.get(c.id);
  done.declinedBy = by;
  await store.claims.update(done);
  return enrich(done);
}

module.exports = { list, summary, approve, decline, enrich };
