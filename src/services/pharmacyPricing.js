'use strict';

const store = require('../store');
const catalog = require('./catalog');
const pharmacyQuotes = require('./pharmacyQuotes');

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

/**
 * One medicine, every pharmacy, with BOTH kinds of price where they exist:
 *   billed  -- what HNN has seen on real bills (compareItem above)
 *   quoted  -- what the pharmacy submitted in an uploaded price list
 * `source` picks which one ranks the rows:
 *   claims | quotes | best_available (billed where HNN has seen it, else quoted)
 *   | side_by_side (ranked like best_available, both numbers always shown)
 * Each row says which kind its headline `price` is (priceSource), and when a
 * pharmacy has both, `variancePercent` is how far its quote sits from what it
 * actually billed (positive = billed more than quoted).
 */
async function compareUnified({ code, name, sinceDays = 90, source = 'best_available', basis = 'latest', minSamples = 1,
  quoteMaxAgeDays = 180, billLimit = 3000 } = {}) {
  if (!code && !name) { const e = new Error('code_or_name_required'); e.status = 422; throw e; }
  const useClaims = source !== 'quotes';
  const useQuotes = source !== 'claims';
  const claimRows = useClaims
    ? (await compareItem({ code, name, sinceDays, billLimit })).pharmacies.filter((r) => r.sampleCount >= minSamples) : [];
  const quoteRows = useQuotes ? await pharmacyQuotes.forItem({ code, name, maxAgeDays: quoteMaxAgeDays }) : [];

  const rows = new Map();
  const get = (key, tenantId, pharmacyName) => {
    if (!rows.has(key)) rows.set(key, { key, tenantId: tenantId || null, name: pharmacyName, billed: null, quoted: null });
    return rows.get(key);
  };
  for (const r of claimRows) {
    get(r.tenantId, r.tenantId, r.tenantName).billed = {
      price: basis === 'average' ? r.averagePrice : r.latestPrice, latest: r.latestPrice, average: r.averagePrice,
      lowest: r.lowestPrice, highest: r.highestPrice, observations: r.sampleCount, lastSeen: r.latestBilledAt };
  }
  for (const q of quoteRows) {
    get(q.key, q.tenantId, q.pharmacyName).quoted = { price: q.unitPrice, itemName: q.itemName, unit: q.unit,
      validFrom: q.validFrom, validUntil: q.validUntil, uploadedAt: q.createdAt, ageDays: q.ageDays };
  }
  const out = [];
  for (const r of rows.values()) {
    let price = null; let priceSource = null;
    if (source === 'quotes') { if (r.quoted) { price = r.quoted.price; priceSource = 'quoted'; } }
    else if (source === 'claims') { if (r.billed) { price = r.billed.price; priceSource = 'billed'; } }
    else if (r.billed) { price = r.billed.price; priceSource = 'billed'; }
    else if (r.quoted) { price = r.quoted.price; priceSource = 'quoted'; }
    if (price == null) continue;
    // variance: how much the REAL (billed) price differs from the QUOTE, as % of the quote.
    // Positive = the pharmacy has been billing more than it quoted.
    const variancePercent = r.billed && r.quoted && r.quoted.price > 0
      ? round2(((r.billed.price - r.quoted.price) / r.quoted.price) * 100) : null;
    out.push({ ...r, price: round2(price), priceSource, variancePercent });
  }
  out.sort((a, b) => a.price - b.price);
  return { code: code || null, name: name || null, reference: referenceFor(code, name), sinceDays, source, basis, rows: out };
}

/**
 * Quotation accuracy: for every current quote from a pharmacy that is linked to
 * a tenant HNN also sees bills for, compare the quote with what that pharmacy
 * actually charged. Answers "can we trust this pharmacy's submitted list?".
 */
async function quoteAccuracy({ sinceDays = 180, quoteMaxAgeDays = 0, billLimit = 5000 } = {}) {
  const pharmacies = await pharmacyTenants();
  const byTenant = new Map(pharmacies.map((t) => [t.id, t]));
  const cutoff = Date.now() - sinceDays * 86400000;
  const idx = new Map(); // `${tenantId}|${key}` -> prices[]
  for (const bill of await store.bills.all(billLimit)) {
    if (!byTenant.has(bill.tenantId) || new Date(bill.createdAt).getTime() < cutoff) continue;
    for (const item of bill.lineItems || []) {
      const unit = item.unitPrice != null ? Number(item.unitPrice) : Number(item.cost) / (item.qty || 1);
      if (!Number.isFinite(unit)) continue;
      for (const k of [norm(item.code), norm(item.name)]) if (k) {
        const key = `${bill.tenantId}|${k}`; if (!idx.has(key)) idx.set(key, []); idx.get(key).push(unit);
      }
    }
  }
  const quotes = await pharmacyQuotes.currentQuotes({ maxAgeDays: quoteMaxAgeDays });
  const per = new Map(); const pairs = [];
  let unmatched = 0;
  for (const q of quotes) {
    if (!q.tenantId) { unmatched++; continue; }
    const prices = idx.get(`${q.tenantId}|${norm(q.itemCode)}`) || idx.get(`${q.tenantId}|${norm(q.itemName)}`);
    if (!prices || !prices.length) { unmatched++; continue; }
    const billed = prices.reduce((s, p) => s + p, 0) / prices.length;
    const v = ((billed - q.unitPrice) / q.unitPrice) * 100;
    pairs.push({ tenantId: q.tenantId, pharmacyName: q.pharmacyName, item: q.itemName, quoted: q.unitPrice, billedAverage: round2(billed), samples: prices.length, variancePercent: round2(v) });
  }
  for (const p of pairs) {
    const e = per.get(p.tenantId) || { tenantId: p.tenantId, pharmacyName: p.pharmacyName, itemsCompared: 0, sum: 0, abs: 0, within10: 0 };
    e.itemsCompared++; e.sum += p.variancePercent; e.abs += Math.abs(p.variancePercent); if (Math.abs(p.variancePercent) <= 10) e.within10++;
    per.set(p.tenantId, e);
  }
  const fin = (e) => ({ tenantId: e.tenantId, pharmacyName: e.pharmacyName, itemsCompared: e.itemsCompared,
    meanVariancePercent: round2(e.sum / e.itemsCompared), meanAbsVariancePercent: round2(e.abs / e.itemsCompared),
    withinTenPercent: round2((e.within10 / e.itemsCompared) * 100) });
  const all = { sum: 0, abs: 0, within10: 0, n: pairs.length };
  for (const p of pairs) { all.sum += p.variancePercent; all.abs += Math.abs(p.variancePercent); if (Math.abs(p.variancePercent) <= 10) all.within10++; }
  return {
    sinceDays, pairs: pairs.length, quotesWithoutBilledComparison: unmatched,
    overall: all.n ? { meanVariancePercent: round2(all.sum / all.n), meanAbsVariancePercent: round2(all.abs / all.n), withinTenPercent: round2((all.within10 / all.n) * 100) } : null,
    pharmacies: [...per.values()].map(fin).sort((a, b) => a.meanAbsVariancePercent - b.meanAbsVariancePercent),
    detail: pairs.sort((a, b) => Math.abs(b.variancePercent) - Math.abs(a.variancePercent)).slice(0, 100),
  };
}

module.exports = { compareItem, compareUnified, quoteAccuracy, pharmacyOverview, pharmacyTenants };
