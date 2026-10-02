'use strict';

const store = require('../store');

/**
 * HNN-settlement reconciliation. The explicit ask from the call: a provider's
 * finance team needs to be able to tell, within their regular claims/RX
 * report, which items were ALREADY settled through HNN's expedited A2A rail
 * -- so they don't chase or double-count them through the payer's normal
 * claims cycle. See the Phase 1 rxhealthinfosystems.com integration plan for
 * why this can't yet be written directly INTO a payer's own claims report:
 * HNN Biller has no write-back API into Rx Claim (or any other payer system)
 * today. Until that exists (Phase 3), this is HNN's OWN reconciliation
 * report/export, built to sit ALONGSIDE a provider's regular report and be
 * matched up by billId/claimId -- never a replacement for it.
 *
 * "HNN-settled" covers every path this codebase can actually settle a claim
 * through: immediate A2A (claims.js#authorize), a consolidated settlement
 * batch (settlementBatches.js), and auto-cleared claims (claimsAutomation.js)
 * -- all of them end at claim.status === 'settled' with settledAt set, so
 * that one boundary is all this report needs to key off.
 *
 * Read-only: no new write path, nothing here can change a claim or a bill.
 */

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function methodOf(claim) {
  if (claim.autoCleared) return `auto_${claim.autoCleared.method}`;
  if (claim.settlementBatchId) return `batch_${claim.settlementCycle || 'cycle'}`;
  return 'immediate';
}

/**
 * Settled claims for one tenant within [since, until), each flagged as
 * HNN-settled with enough reference detail (serviceRequestId/reference, or
 * the settlement batch id) to match against the payer's own claims report --
 * plus the counterpart list: claims from the same window that are still
 * open, i.e. still genuinely belong in the provider's normal RX queue.
 */
async function settledReport(tenantId, { since, until } = {}) {
  if (!tenantId) { const e = new Error('tenantId_required'); e.status = 422; throw e; }
  const sinceMs = since ? new Date(since).getTime() : 0;
  const untilMs = until ? new Date(until).getTime() : Date.now();

  const settled = await store.claims.byStatus('settled', 10000);
  const rows = [];
  for (const claim of settled) {
    if (claim.tenantId !== tenantId) continue;
    const settledMs = claim.settledAt ? new Date(claim.settledAt).getTime() : null;
    if (settledMs == null || settledMs < sinceMs || settledMs > untilMs) continue;
    rows.push({
      claimId: claim.id, billId: claim.billId,
      payerId: claim.payerId, payerName: claim.payerName,
      memberId: claim.memberId,
      amount: round2(claim.amount), currency: claim.currency,
      settledAt: claim.settledAt,
      settlementMethod: methodOf(claim),
      settlementBatchId: claim.settlementBatchId || null,
      serviceRequestId: claim.serviceRequestId || null,
      transferReference: claim.transferReference || null,
      funderId: claim.funderId || null, funderName: claim.funderName || null,
      expedited: !!claim.nnest?.expedited,
    });
  }
  rows.sort((a, b) => new Date(a.settledAt) - new Date(b.settledAt));

  // The counterpart: claims from the same window that have NOT been paid by
  // HNN -- what a provider's normal RX/claims queue should still expect.
  const openStatuses = ['pending', 'authorizing', 'authorized', 'expired_to_standard', 'rejected'];
  const open = [];
  for (const status of openStatuses) {
    const claims = await store.claims.byStatus(status, 5000);
    for (const claim of claims) {
      if (claim.tenantId !== tenantId) continue;
      const createdMs = new Date(claim.createdAt).getTime();
      if (createdMs < sinceMs || createdMs > untilMs) continue;
      open.push({
        claimId: claim.id, billId: claim.billId, payerId: claim.payerId, payerName: claim.payerName,
        amount: round2(claim.amount), currency: claim.currency, status: claim.status, createdAt: claim.createdAt,
      });
    }
  }
  open.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return {
    tenantId, since: since || null, until: until || new Date(untilMs).toISOString(),
    hnnSettled: { count: rows.length, total: round2(rows.reduce((s, r) => s + r.amount, 0)), rows },
    stillInRxQueue: { count: open.length, total: round2(open.reduce((s, r) => s + r.amount, 0)), rows: open },
  };
}

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => c.label).join(',');
  const lines = rows.map((r) => columns.map((c) => esc(r[c.key])).join(','));
  return [header, ...lines].join('\n');
}

const HNN_SETTLED_COLUMNS = [
  { key: 'claimId', label: 'Claim ID' }, { key: 'billId', label: 'Bill ID' },
  { key: 'payerName', label: 'Payer' }, { key: 'memberId', label: 'Member ID' },
  { key: 'amount', label: 'Amount' }, { key: 'currency', label: 'Currency' },
  { key: 'settledAt', label: 'Settled At' }, { key: 'settlementMethod', label: 'Settlement Method' },
  { key: 'serviceRequestId', label: 'Service Request ID' }, { key: 'transferReference', label: 'Transfer Reference' },
  { key: 'funderName', label: 'Funder' }, { key: 'expedited', label: 'HNN Expedited' },
];

/** CSV export of the HNN-settled side only -- the file meant to sit next to a provider's own RX report. */
async function settledCsv(tenantId, range) {
  const report = await settledReport(tenantId, range);
  const rows = report.hnnSettled.rows.map((r) => ({ ...r, expedited: r.expedited ? 'yes' : 'no' }));
  return toCsv(rows, HNN_SETTLED_COLUMNS);
}

module.exports = { settledReport, settledCsv };
