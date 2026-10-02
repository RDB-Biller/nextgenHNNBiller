'use strict';

const store = require('../store');
const catalog = require('./catalog');

/**
 * Cross-pharmacy price comparison. HNN Biller already sees real, itemised
 * bills from every connected facility -- this surfaces what DIFFERENT
 * pharmacies have actually charged for the same medicine recently, so a
 * patient (or a provider helping one shop around) can compare real, observed
 * prices rather than a single official tariff. Built entirely from HNN's own
 * billing history: a medicine nobody has billed here recently simply has no
 * comparison yet, rather than an invented price filling the gap.
 *
 * Scope is "pharmacy" tenants only (tenant.facilityType === 'pharmacy', set
 * from Master Control's Clients tab -- see routes/platform.js). A clinic's
 * bundled price for the same drug code isn't a comparable dispensing price,
 * so an unclassified tenant (every tenant created before this field existed,
 * and the default for every new one) is excluded rather than silently lumped
 * in with real pharmacies. Classifying tenants is additive and opt-in: until
 * an admin sets facilityType, this returns an empty comparison, never a
 * wrong one.
 *
 * Read-only: this adds no new write path and never changes a bill, claim, or
 * price list. It reuses the shared NHIS catalog (services/catalog.js) only
 * for an official reference price alongside the real observed ones.
 */

const norm = (s) => String(s || '').trim().toLowerCase();
const round2 = (n) => Math.round(Number(n) * 100) / 100;

async function pharmacyTenants() {
  const all = await store.tenants.all();
  return all.filter((t) => t.facilityType === 'pharmacy');
}

function referenceFor(code, name) {
  const item = catalog.findItem(code || name);
  return item ? { code: item.code, name: item.name, price: item.price, source: item.source || 'catalog' } : null;
}

/**
 * What every classified pharmacy has actually charged for one medicine (by
 * code or name), cheapest average first. `sinceDays` bounds how recent a
 * sample counts -- default 90 days, since a price from a year ago isn't a
 * useful comparison for shopping today. `billLimit` bounds the scan (most
 * recent bills first) so this stays cheap as billing history grows.
 */
async function compareItem({ code, name, sinceDays = 90, billLimit = 3000 } = {}) {
  if (!code && !name) { const e = new Error('code_or_name_required'); e.status = 422; throw e; }
  const c = norm(code);
  const n = norm(name);
  const cutoff = Date.now() - sinceDays * 86400000;

  const pharmacies = await pharmacyTenants();
  const byTenant = new Map(pharmacies.map((t) => [t.id, t]));
  const reference = referenceFor(code, name);
  if (!byTenant.size) {
    return { code: code || null, name: name || null, reference, sinceDays, pharmacies: [], note: 'no_pharmacy_tenants_classified' };
  }

  const bills = await store.bills.all(billLimit);
  const samples = new Map(); // tenantId -> [{price, billedAt}]
  for (const bill of bills) {
    if (!byTenant.has(bill.tenantId)) continue;
    if (new Date(bill.createdAt).getTime() < cutoff) continue;
    for (const item of bill.lineItems || []) {
      const matches = (c && norm(item.code) === c) || (n && norm(item.name) === n);
      if (!matches) continue;
      const unitPrice = item.unitPrice != null ? Number(item.unitPrice) : Number(item.cost) / (item.qty || 1);
      if (!Number.isFinite(unitPrice)) continue;
      if (!samples.has(bill.tenantId)) samples.set(bill.tenantId, []);
      samples.get(bill.tenantId).push({ price: unitPrice, billedAt: bill.createdAt });
    }
  }

  const rows = [];
  for (const [tenantId, points] of samples) {
    const tenant = byTenant.get(tenantId);
    const prices = points.map((p) => p.price);
    const latest = points.reduce((a, b) => (new Date(b.billedAt) > new Date(a.billedAt) ? b : a));
    rows.push({
      tenantId, tenantName: tenant.name,
      sampleCount: points.length,
      latestPrice: round2(latest.price), latestBilledAt: latest.billedAt,
      averagePrice: round2(prices.reduce((s, p) => s + p, 0) / prices.length),
      lowestPrice: round2(Math.min(...prices)), highestPrice: round2(Math.max(...prices)),
    });
  }
  rows.sort((a, b) => a.latestPrice - b.latestPrice);

  return { code: code || null, name: name || null, reference, sinceDays, pharmacies: rows };
}

/** Coverage overview for Master Control: every classified pharmacy, how many bills/distinct items it has recently. */
async function pharmacyOverview({ sinceDays = 90, billLimit = 3000 } = {}) {
  const pharmacies = await pharmacyTenants();
  const byTenant = new Map(pharmacies.map((t) => [t.id, t]));
  const cutoff = Date.now() - sinceDays * 86400000;
  const bills = await store.bills.all(billLimit);
  const counts = new Map();
  for (const bill of bills) {
    if (!byTenant.has(bill.tenantId)) continue;
    if (new Date(bill.createdAt).getTime() < cutoff) continue;
    const seen = counts.get(bill.tenantId) || { billCount: 0, items: new Set() };
    seen.billCount++;
    for (const item of bill.lineItems || []) { if (item.code || item.name) seen.items.add(norm(item.code || item.name)); }
    counts.set(bill.tenantId, seen);
  }
  return pharmacies.map((t) => {
    const c = counts.get(t.id);
    return { tenantId: t.id, tenantName: t.name, billCount: c?.billCount || 0, distinctItems: c ? c.items.size : 0 };
  });
}

module.exports = { compareItem, pharmacyOverview, pharmacyTenants };
