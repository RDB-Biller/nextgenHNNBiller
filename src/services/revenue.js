'use strict';

const store = require('./../store');

/**
 * SaaS-wide revenue for the platform owner. Aggregates the append-only ledger's
 * platform_fee_* entries across every client. All platform fees are ACCRUED
 * receivables (cashMovement:false) — this is billable revenue, not cash moved.
 */

const LABELS = {
  platform_fee_expedited_settlement: 'Expedited settlement',
  platform_fee_discount_fee: 'Discount fee',
  platform_fee_claimit_margin: 'ClaimIt margin',
  platform_fee_report_fee_mini: 'Mini report fee',
  platform_fee_report_fee_standard: 'Standard report fee',
};
const label = (t) => LABELS[t] || String(t).replace(/^platform_fee_/, '').replace(/_/g, ' ');
const r2 = (n) => Math.round(Number(n) * 100) / 100;

async function summary() {
  const rows = await store.ledger.revenueAll();
  const tenants = await store.tenants.all();
  const nameOf = Object.fromEntries(tenants.map((t) => [t.id, t.name]));

  const byType = {};
  const byClient = {};
  let total = 0;
  let count = 0;

  for (const row of rows) {
    const amt = Number(row.total) || 0;
    const n = Number(row.n) || 0;
    total += amt; count += n;

    byType[row.type] = byType[row.type] || { type: row.type, label: label(row.type), total: 0, count: 0 };
    byType[row.type].total += amt; byType[row.type].count += n;

    const cid = row.tenant_id || 'unknown';
    byClient[cid] = byClient[cid] || { clientId: cid, name: nameOf[cid] || cid, total: 0, count: 0, byType: {} };
    byClient[cid].total += amt; byClient[cid].count += n;
    byClient[cid].byType[row.type] = r2((byClient[cid].byType[row.type] || 0) + amt);
  }

  return {
    currency: 'GHS',
    totalAccrued: r2(total),
    entries: count,
    clients: Object.keys(byClient).length,
    byType: Object.values(byType).map((t) => ({ ...t, total: r2(t.total) })).sort((a, b) => b.total - a.total),
    byClient: Object.values(byClient).map((c) => ({ ...c, total: r2(c.total) })).sort((a, b) => b.total - a.total),
    note: 'All figures are accrued platform fees (receivables), not cash held. The platform never custodies funds.',
  };
}

/** Recent fee entries across all clients, for an activity feed. */
async function recent(limit = 100) {
  const rows = await store.ledger.all(2000);
  const tenants = await store.tenants.all();
  const nameOf = Object.fromEntries(tenants.map((t) => [t.id, t.name]));
  return rows
    .filter((e) => String(e.type).startsWith('platform_fee_'))
    .slice(0, limit)
    .map((e) => ({
      client: nameOf[e.tenantId] || e.tenantId,
      type: label(e.type),
      amount: r2(e.amount),
      currency: e.currency || 'GHS',
      chargeTo: e.refs?.chargeTo || e.source?.kind || null,
      billing: e.refs?.billing || null,
      billId: e.billId || null,
      at: e.createdAt || null,
    }));
}

module.exports = { summary, recent, label };
