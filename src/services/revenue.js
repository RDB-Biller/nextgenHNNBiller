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
  platform_fee_payer_commission: 'Payer commission',
};
const label = (t) => LABELS[t] || String(t).replace(/^platform_fee_/, '').replace(/_/g, ' ');
const r2 = (n) => Math.round(Number(n) * 100) / 100;

async function summary() {
  const rows = await store.ledger.revenueAll();
  const tenants = await store.tenants.all();
  const nameOf = Object.fromEntries(tenants.map((t) => [t.id, t.name]));
  const payers = await store.payers.all();
  const payerNameOf = Object.fromEntries(payers.map((p) => [p.id, p.name]));

  const byType = {};
  const byClient = {};
  const byPayer = {};
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

    // Only fee types that name a specific payer in their refs (expedited
    // settlement, payer commission) show up here — e.g. a report fee charged
    // to the patient has no payer to attribute, so it's left out rather than
    // dumped under a meaningless "unknown" bucket.
    if (row.payer_id) {
      const pid = row.payer_id;
      byPayer[pid] = byPayer[pid] || { payerId: pid, name: payerNameOf[pid] || pid, total: 0, count: 0, byType: {} };
      byPayer[pid].total += amt; byPayer[pid].count += n;
      byPayer[pid].byType[row.type] = r2((byPayer[pid].byType[row.type] || 0) + amt);
    }
  }

  return {
    currency: 'GHS',
    totalAccrued: r2(total),
    entries: count,
    clients: Object.keys(byClient).length,
    byType: Object.values(byType).map((t) => ({ ...t, total: r2(t.total) })).sort((a, b) => b.total - a.total),
    byClient: Object.values(byClient).map((c) => ({ ...c, total: r2(c.total) })).sort((a, b) => b.total - a.total),
    byPayer: Object.values(byPayer).map((p) => ({ ...p, total: r2(p.total) })).sort((a, b) => b.total - a.total),
    note: 'All figures are accrued platform fees (receivables), not cash held. The platform never custodies funds.',
  };
}

/** Recent fee entries across all clients, for an activity feed. */
async function recent(limit = 100) {
  const rows = await store.ledger.all(2000);
  const tenants = await store.tenants.all();
  const nameOf = Object.fromEntries(tenants.map((t) => [t.id, t.name]));
  const payers = await store.payers.all();
  const payerNameOf = Object.fromEntries(payers.map((p) => [p.id, p.name]));
  return rows
    .filter((e) => String(e.type).startsWith('platform_fee_'))
    .slice(0, limit)
    .map((e) => ({
      client: nameOf[e.tenantId] || e.tenantId,
      payer: e.refs?.payerId ? (payerNameOf[e.refs.payerId] || e.refs.payerId) : null,
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
