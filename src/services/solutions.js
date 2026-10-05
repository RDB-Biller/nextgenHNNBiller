'use strict';

const store = require('../store');
const claimsAutomation = require('./claimsAutomation');
const claimExpiry = require('./claimExpiry');
const settlementBatches = require('./settlementBatches');
const networks = require('./networks');
const funders = require('./funders');
const pharmacyPricing = require('./pharmacyPricing');
const reconciliation = require('./reconciliation');

/**
 * Solutions -- the 8 "gaps from the call" turned into Product Lab products.
 *
 * A solution is a product (type 'solution') that binds ONE module from the
 * registry below to a payer, with parameters the product manager sets in
 * Master Control and the surfaces it is exposed on (patient / hospital /
 * payer). It rides the normal Product Lab lifecycle:
 *   draft    -- editable, nothing runs for anyone but Master Control
 *   sandbox  -- runs as a dry-run for hospital/payer testers; patients can't see it
 *   live     -- policy-type modules are APPLIED to the payer (snapshot kept so
 *               leaving live reverts exactly what was changed); patient surface opens
 * Modules that only read data (pharmacy comparison, reconciliation) apply
 * nothing -- "live" simply means the surfaces are open.
 *
 * Each module declares its own parameter schema, so the Master Control form and
 * the validation are generated from the registry: adding a module here is the
 * only step needed for it to become configurable in Product Lab.
 */

const SURFACES = ['patient', 'hospital', 'payer'];
const err = (status, message, detail) => { const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e; };
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => (v === '' || v == null ? null : Number(v));

// ---- helpers ---------------------------------------------------------------

async function payerOf(id) {
  const p = await store.payers.get(id);
  if (!p) throw err(404, 'unknown_payer');
  return p;
}
function requireTenant(ctx, input) {
  const tenantId = ctx.tenant?.id || input?.tenantId;
  if (!tenantId) throw err(422, 'tenantId_required');
  return tenantId;
}

// ---- module registry -------------------------------------------------------

const MODULES = {
  auth_threshold: {
    label: 'Authorization threshold',
    description: 'Claims at or under an amount are authorized automatically; larger ones wait for manual review.',
    scope: 'payer',
    surfaces: ['patient', 'hospital', 'payer'],
    params: [
      { key: 'enabled', label: 'Auto-authorize enabled', type: 'boolean', default: true },
      { key: 'thresholdMaxAmount', label: 'Auto-authorize up to (GHS)', type: 'number', min: 1, required: true, default: 200,
        help: 'Claims at or below this amount are cleared instantly.' },
    ],
    async apply(payerId, p) {
      const before = claimsAutomation.payerPolicyOf(await payerOf(payerId));
      await claimsAutomation.setPayerPolicy(payerId, { enabled: p.enabled, thresholdMaxAmount: p.thresholdMaxAmount }, 'solution');
      return { enabled: before.enabled, thresholdMaxAmount: before.thresholdMaxAmount };
    },
    async revert(payerId, snap) { await claimsAutomation.setPayerPolicy(payerId, snap || {}, 'solution:revert'); },
    async run(ctx, p, input) {
      const amount = num(input?.amount);
      const out = { enabled: p.enabled, thresholdMaxAmount: p.thresholdMaxAmount };
      if (amount != null) out.check = { amount, autoAuthorized: p.enabled && amount <= p.thresholdMaxAmount };
      return out;
    },
  },

  auto_adjudication: {
    label: 'Structured auto-adjudication',
    description: 'Rule-based clearing (diagnosis + required treatment + cap). Only the structured share is automated; the rest stays with reviewers.',
    scope: 'payer',
    surfaces: ['hospital', 'payer'],
    params: [
      { key: 'enabled', label: 'Auto-adjudication enabled', type: 'boolean', default: true },
      { key: 'useStructuredRules', label: 'Use structured rules', type: 'boolean', default: true },
    ],
    async apply(payerId, p) {
      const before = claimsAutomation.payerPolicyOf(await payerOf(payerId));
      await claimsAutomation.setPayerPolicy(payerId, { enabled: p.enabled, useStructuredRules: p.useStructuredRules }, 'solution');
      return { enabled: before.enabled, useStructuredRules: before.useStructuredRules };
    },
    async revert(payerId, snap) { await claimsAutomation.setPayerPolicy(payerId, snap || {}, 'solution:revert'); },
    async run(ctx, p, input) {
      const policy = await claimsAutomation.getPolicy();
      const activeRules = policy.rules.filter((r) => r.active)
        .map((r) => ({ id: r.id, diagnosisKeyword: r.diagnosisKeyword, requiredItemCodes: r.requiredItemCodes, maxAmount: r.maxAmount, note: r.note }));
      const out = { masterEnabled: policy.masterEnabled, enabled: p.enabled, useStructuredRules: p.useStructuredRules, activeRules };
      if (input?.diagnosis || input?.itemCodes) {
        const items = (Array.isArray(input.itemCodes) ? input.itemCodes : String(input.itemCodes || '').split(','))
          .map((s) => String(s).trim()).filter(Boolean);
        // Dry-run what-if against the payer's CURRENT stored policy plus this solution's params.
        const payer = { ...(await payerOf(ctx.payerId)) };
        payer.autoAdjudication = { ...(payer.autoAdjudication || {}), enabled: p.enabled, useStructuredRules: p.useStructuredRules };
        out.whatIf = simulate(payer, policy, { amount: num(input.amount) || 0, diagnosis: input.diagnosis, items });
      }
      return out;
    },
  },

  claim_expiry: {
    label: 'Claim expiry / revert to RX',
    description: 'Expedited claims left unactioned for N days revert to the provider\'s standard RX queue.',
    scope: 'platform',
    surfaces: ['hospital', 'payer'],
    params: [
      { key: 'enabled', label: 'Expiry enabled', type: 'boolean', default: true },
      { key: 'windowDays', label: 'Window (days)', type: 'number', min: 1, max: 90, required: true, default: 14 },
    ],
    async apply(payerId, p) {
      const before = await claimExpiry.getPolicy();
      await claimExpiry.setPolicy({ enabled: p.enabled, windowDays: p.windowDays }, 'solution');
      return { enabled: before.enabled, windowDays: before.windowDays };
    },
    async revert(payerId, snap) { if (snap) await claimExpiry.setPolicy(snap, 'solution:revert'); },
    async run(ctx, p) {
      const pol = await claimExpiry.getPolicy();
      const open = [];
      for (const st of ['pending', 'authorizing', 'authorized']) {
        for (const c of await store.claims.byStatus(st, 2000)) {
          if (ctx.tenant && c.tenantId !== ctx.tenant.id) continue;
          if (c.payerId !== ctx.payerId) continue;
          const ageDays = (Date.now() - new Date(c.createdAt).getTime()) / 86400000;
          open.push({ claimId: c.id, amount: round2(c.amount), status: c.status, ageDays: Math.floor(ageDays),
            daysLeft: Math.max(0, Math.ceil(pol.windowDays - ageDays)) });
        }
      }
      open.sort((a, b) => a.daysLeft - b.daysLeft);
      return { enabled: pol.enabled, windowDays: pol.windowDays, requestedWindowDays: p.windowDays, openClaims: open.slice(0, 100),
        atRisk: open.filter((c) => c.daysLeft <= 3).length };
    },
  },

  settlement_cycle: {
    label: 'Settlement cycle',
    description: 'How often this payer settles providers: immediately, daily or every two weeks.',
    scope: 'payer',
    surfaces: ['hospital', 'payer'],
    params: [
      { key: 'defaultSettlementCycle', label: 'Cycle', type: 'select', options: networks.SETTLEMENT_CYCLES, required: true, default: 'biweekly' },
    ],
    async apply(payerId, p) {
      const before = (await payerOf(payerId)).defaultSettlementCycle || 'immediate';
      await networks.setPosture(payerId, { defaultSettlementCycle: p.defaultSettlementCycle });
      return { defaultSettlementCycle: before };
    },
    async revert(payerId, snap) { await networks.setPosture(payerId, { defaultSettlementCycle: snap?.defaultSettlementCycle || 'immediate' }); },
    async run(ctx, p, input) {
      const payer = await payerOf(ctx.payerId);
      const tenantId = ctx.tenant?.id || input?.tenantId || null;
      const effective = tenantId ? await networks.resolveCycle(payer, tenantId) : (payer.defaultSettlementCycle || 'immediate');
      const queue = (await settlementBatches.previewQueue()).filter((g) => g.payerId === ctx.payerId && (!tenantId || g.tenantId === tenantId));
      return { configuredCycle: p.defaultSettlementCycle, effectiveCycle: effective, queue };
    },
  },

  daily_billing: {
    label: 'Daily consolidated billing',
    description: 'One consolidated settlement per provider per day instead of one per claim.',
    scope: 'payer',
    surfaces: ['hospital', 'payer'],
    params: [
      { key: 'recentBatches', label: 'Recent batches to show', type: 'number', min: 1, max: 50, default: 10 },
    ],
    async apply(payerId) {
      const before = (await payerOf(payerId)).defaultSettlementCycle || 'immediate';
      await networks.setPosture(payerId, { defaultSettlementCycle: 'daily' });
      return { defaultSettlementCycle: before };
    },
    async revert(payerId, snap) { await networks.setPosture(payerId, { defaultSettlementCycle: snap?.defaultSettlementCycle || 'immediate' }); },
    async run(ctx, p, input) {
      const tenantId = requireTenant(ctx, input);
      const queue = (await settlementBatches.previewQueue()).filter((g) => g.payerId === ctx.payerId && g.tenantId === tenantId);
      const batches = (await settlementBatches.listBatches(tenantId)).filter((b) => b.payerId === ctx.payerId).slice(0, p.recentBatches);
      return { queue, batches };
    },
  },

  multi_funder: {
    label: 'TPA / multi-funder disbursement',
    description: 'This payer settles claims on behalf of a funder (e.g. a trust fund) and tags every claim for that fund\'s own report.',
    scope: 'payer',
    surfaces: ['payer'],
    params: [
      { key: 'funderId', label: 'Funder', type: 'select', optionsFrom: 'funders', required: true },
    ],
    async apply(payerId, p) {
      const before = (await payerOf(payerId)).tpaForFunderId || null;
      await funders.linkPayer(payerId, p.funderId, 'solution');
      return { tpaForFunderId: before };
    },
    async revert(payerId, snap) { await funders.linkPayer(payerId, snap?.tpaForFunderId || null, 'solution:revert'); },
    async run(ctx, p) {
      const f = await store.funders.get(p.funderId);
      if (!f) throw err(404, 'funder_not_found');
      return { funder: funders.mask(f), administeredBy: await funders.payersFor(p.funderId) };
    },
  },

  pharmacy_compare: {
    label: 'Pharmacy price comparison',
    description: 'Prices for the same medicines across pharmacies — what they quoted (uploaded price lists) and what they have actually billed — with a basket total so a patient (or an insurer advising one) can pick the cheapest complete option.',
    scope: 'none',
    surfaces: ['patient', 'hospital', 'payer'],
    params: [
      { key: 'priceSource', label: 'Price source', type: 'select', options: ['best_available', 'claims', 'quotes', 'side_by_side'], default: 'best_available',
        help: 'claims = real billed prices only; quotes = uploaded price lists only; best_available = billed where seen, else quoted; side_by_side = best_available plus both numbers and the variance.' },
      { key: 'sinceDays', label: 'Billed prices seen in the last (days)', type: 'number', min: 7, max: 365, default: 90 },
      { key: 'quoteMaxAgeDays', label: 'Ignore quotes older than (days)', type: 'number', min: 7, max: 730, default: 180 },
      { key: 'minSamples', label: 'Min. billed observations per pharmacy', type: 'number', min: 1, max: 20, default: 1 },
      { key: 'maxPharmacies', label: 'Pharmacies shown per medicine', type: 'number', min: 1, max: 20, default: 5 },
      { key: 'priceBasis', label: 'Billed price basis', type: 'select', options: ['latest', 'average'], default: 'latest' },
      { key: 'showReference', label: 'Show official NHIS reference price', type: 'boolean', default: true },
      { key: 'advise', label: 'Show plain-language recommendation', type: 'boolean', default: true },
      { key: 'anonymisePharmacies', label: 'Hide pharmacy names from patients', type: 'boolean', default: false,
        help: 'When on, patient-facing results say "Pharmacy A/B/C"; hospital and payer surfaces still see names.' },
    ],
    async apply() { return null; },
    async revert() {},
    async run(ctx, p, input) {
      const raw = Array.isArray(input?.items) ? input.items : String(input?.items ?? input?.q ?? '').split(/[\n,;]+/);
      const queries = raw.map((s) => String(s || '').trim().slice(0, 80)).filter(Boolean).slice(0, 10);
      if (!queries.length) throw err(422, 'items_required');
      const items = [];
      for (const q of queries) {
        const cmp = await pharmacyPricing.compareUnified({ code: q, name: q, sinceDays: p.sinceDays, source: p.priceSource, basis: p.priceBasis,
          minSamples: p.minSamples, quoteMaxAgeDays: p.quoteMaxAgeDays });
        const rows = cmp.rows;
        const lo = rows[0]?.price; const hi = rows[rows.length - 1]?.price;
        items.push({ query: q, reference: p.showReference ? cmp.reference : null, observed: rows.length,
          spreadPercent: rows.length > 1 && lo > 0 ? round2(((hi - lo) / lo) * 100) : null, _rows: rows });
      }
      // Basket: only pharmacies with a price for EVERY requested medicine are comparable like-for-like.
      const baskets = new Map();
      for (const it of items) for (const r of it._rows) {
        if (!baskets.has(r.key)) baskets.set(r.key, { key: r.key, tenantId: r.tenantId, name: r.name, total: 0, count: 0, quotedItems: 0 });
        const b = baskets.get(r.key); b.total += r.price; b.count++; if (r.priceSource === 'quoted') b.quotedItems++;
      }
      const complete = [...baskets.values()].filter((b) => b.count === items.length)
        .map((b) => ({ ...b, total: round2(b.total) })).sort((a, b) => a.total - b.total);
      const names = new Map();
      const label = (key, name) => {
        if (!(p.anonymisePharmacies && ctx.surface === 'patient')) return name;
        if (!names.has(key)) names.set(key, `Pharmacy ${String.fromCharCode(65 + names.size)}`);
        return names.get(key);
      };
      const showId = ctx.surface !== 'patient';
      const idOf = (x) => (showId ? { tenantId: x.tenantId, pharmacyKey: x.key } : {});
      const outItems = items.map((it) => ({
        query: it.query, reference: it.reference, observed: it.observed, spreadPercent: it.spreadPercent,
        pharmacies: it._rows.slice(0, p.maxPharmacies).map((r) => ({
          ...idOf(r), name: label(r.key, r.name), price: r.price, priceSource: r.priceSource,
          ...(p.priceSource === 'side_by_side' ? {
            billedPrice: r.billed ? r.billed.price : null, quotedPrice: r.quoted ? r.quoted.price : null,
            ...(showId ? { variancePercent: r.variancePercent } : {}) } : {}),
          lowest: r.billed ? r.billed.lowest : null, highest: r.billed ? r.billed.highest : null,
          observations: r.billed ? r.billed.observations : 0, lastSeen: r.billed ? r.billed.lastSeen : (r.quoted ? r.quoted.uploadedAt : null),
        })),
      }));
      const last = complete[complete.length - 1];
      const basket = complete.length ? {
        comparable: complete.length,
        cheapest: { ...idOf(complete[0]), name: label(complete[0].key, complete[0].name), total: complete[0].total, quotedItems: complete[0].quotedItems },
        mostExpensive: { name: label(last.key, last.name), total: last.total },
        savings: round2(last.total - complete[0].total),
        savingsPercent: last.total > 0 ? round2(((last.total - complete[0].total) / last.total) * 100) : 0,
        all: complete.slice(0, p.maxPharmacies).map((b) => ({ ...idOf(b), name: label(b.key, b.name), total: b.total, quotedItems: b.quotedItems })),
      } : null;
      const missing = items.filter((i) => !i.observed).map((i) => i.query);
      const priced = items.flatMap((i) => i._rows);
      const quotedShare = priced.length ? round2((priced.filter((r) => r.priceSource === 'quoted').length / priced.length) * 100) : 0;
      let advice = null;
      if (p.advise) {
        const basisNote = basket && basket.cheapest.quotedItems
          ? ' Some prices are pharmacy quotations, not yet confirmed by real bills.' : '';
        if (basket && basket.comparable > 1) advice = `For this list, ${basket.cheapest.name} has been the cheapest at GHS ${basket.cheapest.total.toFixed(2)} — about GHS ${basket.savings.toFixed(2)} (${basket.savingsPercent}%) less than the dearest comparable pharmacy.${basisNote} Prices can change; confirm before paying.`;
        else if (basket) advice = `Only one pharmacy has a price for every item on this list (${basket.cheapest.name}, GHS ${basket.cheapest.total.toFixed(2)}), so there is nothing to compare it with yet.${basisNote}`;
        else advice = 'No single pharmacy has a price for every item, so a complete basket can\'t be compared. Per-medicine prices are shown below.';
      }
      const both = priced.filter((r) => r.variancePercent != null);
      const analytics = { medicines: items.length, withPrices: items.length - missing.length,
        widestSpreadPercent: Math.max(0, ...items.map((i) => i.spreadPercent || 0)), quotedSharePercent: quotedShare };
      if (ctx.surface !== 'patient') {
        analytics.quoteVsBilled = both.length ? { pairs: both.length,
          meanVariancePercent: round2(both.reduce((s, r) => s + r.variancePercent, 0) / both.length),
          meanAbsVariancePercent: round2(both.reduce((s, r) => s + Math.abs(r.variancePercent), 0) / both.length) } : null;
      }
      return { priceSource: p.priceSource, sinceDays: p.sinceDays, priceBasis: p.priceBasis, items: outItems, basket, notFound: missing, advice, analytics };
    },
  },

  reconciliation: {
    label: 'HNN-settled reconciliation',
    description: 'Which claims HNN settled (vs still in the standard RX queue) for a period, with CSV export for the provider\'s books.',
    scope: 'none',
    surfaces: ['hospital', 'payer'],
    params: [
      { key: 'defaultDays', label: 'Default period (days)', type: 'number', min: 1, max: 365, default: 30 },
      { key: 'maxRows', label: 'Max rows returned', type: 'number', min: 10, max: 2000, default: 200 },
    ],
    async apply() { return null; },
    async revert() {},
    async run(ctx, p, input) {
      const tenantId = requireTenant(ctx, input);
      const since = input?.since || new Date(Date.now() - p.defaultDays * 86400000).toISOString();
      const r = await reconciliation.settledReport(tenantId, { since, until: input?.until });
      const own = (rows) => rows.filter((x) => x.payerId === ctx.payerId);
      const hn = own(r.hnnSettled.rows); const open = own(r.stillInRxQueue.rows);
      return {
        tenantId, since: r.since, until: r.until,
        hnnSettled: { count: hn.length, total: round2(hn.reduce((s, x) => s + x.amount, 0)), rows: hn.slice(0, p.maxRows) },
        stillInRxQueue: { count: open.length, total: round2(open.reduce((s, x) => s + x.amount, 0)), rows: open.slice(0, p.maxRows) },
      };
    },
  },
};

/** Same decision function claims use in production, fed a hypothetical payer policy and a synthetic bill. */
function simulate(payer, policy, { amount, diagnosis, items }) {
  const claim = { payerId: payer.id, amount };
  const bill = { clinical: { diagnosis: diagnosis || '' }, lineItems: items.map((c) => ({ code: c, name: c })) };
  return claimsAutomation.decide(policy, claimsAutomation.payerPolicyOf(payer), claim, bill);
}

// ---- validation / lifecycle ------------------------------------------------

function coerceParams(mod, input = {}) {
  const out = {};
  for (const d of mod.params) {
    let v = input[d.key];
    if (v === undefined || v === '' || v === null) v = d.default;
    if (v === undefined || v === null || v === '') {
      if (d.required) throw err(422, 'param_required', d.key);
      continue;
    }
    if (d.type === 'boolean') v = v === true || v === 'true';
    else if (d.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) throw err(422, 'param_not_a_number', d.key);
      if (d.min != null && v < d.min) throw err(422, 'param_below_min', `${d.key} >= ${d.min}`);
      if (d.max != null && v > d.max) throw err(422, 'param_above_max', `${d.key} <= ${d.max}`);
    } else if (d.type === 'select') {
      if (d.options && !d.options.includes(v)) throw err(422, 'param_invalid_option', `${d.key}: ${d.options.join('|')}`);
      v = String(v);
    } else v = String(v);
    out[d.key] = v;
  }
  return out;
}

/** Product Lab calls this from products.validateConfig for type 'solution'. */
function validateConfig(input = {}, existing = {}) {
  const key = input.module || existing.module;
  const mod = MODULES[key];
  if (!mod) throw err(422, 'unknown_module', `must be one of ${Object.keys(MODULES).join(', ')}`);
  const surfaces = (input.surfaces || existing.surfaces || mod.surfaces);
  if (!Array.isArray(surfaces) || !surfaces.length) throw err(422, 'at_least_one_surface_required');
  for (const s of surfaces) {
    if (!SURFACES.includes(s)) throw err(422, 'invalid_surface', s);
    if (!mod.surfaces.includes(s)) throw err(422, 'surface_not_supported_by_module', `${key} supports ${mod.surfaces.join(', ')}`);
  }
  const sameModule = key === existing.module;
  const params = coerceParams(mod, input.params !== undefined ? input.params : (sameModule ? existing.params : {}));
  const tenantIds = input.tenantIds !== undefined ? input.tenantIds : existing.tenantIds;
  return {
    module: key, surfaces: [...new Set(surfaces)], params,
    title: String(input.title ?? existing.title ?? mod.label).slice(0, 120),
    intro: String(input.intro ?? existing.intro ?? '').slice(0, 500),
    tenantIds: Array.isArray(tenantIds) ? tenantIds.map(String).filter(Boolean) : [],
    applied: existing.applied || null,
  };
}

function registry() {
  return Object.entries(MODULES).map(([key, m]) => ({
    key, label: m.label, description: m.description, scope: m.scope, surfaces: m.surfaces, params: m.params,
  }));
}

async function liveConflict(product) {
  const mine = await store.products.listByPayer(product.payerId);
  return mine.find((o) => o.id !== product.id && o.type === 'solution' && o.status === 'live'
    && o.config.module === product.config.module && MODULES[o.config.module].scope !== 'none');
}

/** Called by products.setStatus before it saves; throws to veto the transition. */
async function onStatusChange(product, from, to) {
  const mod = MODULES[product.config.module];
  if (to === 'live' && from !== 'live') {
    if (await liveConflict(product)) throw err(409, 'module_already_live_for_payer', 'move the other solution out of live first');
    product.config.applied = { at: new Date().toISOString(), snapshot: await mod.apply(product.payerId, product.config.params) };
  } else if (from === 'live' && to !== 'live') {
    if (product.config.applied) await mod.revert(product.payerId, product.config.applied.snapshot);
    product.config.applied = null;
  }
}

/** A live solution being edited: put back what it changed, apply the new params, keep the ORIGINAL snapshot. */
async function onLiveUpdate(product, newConfig) {
  const mod = MODULES[newConfig.module];
  if (newConfig.module !== product.config.module) throw err(409, 'cannot_change_module_while_live');
  const original = product.config.applied?.snapshot;
  if (mod.scope !== 'none') {
    await mod.apply(product.payerId, newConfig.params); // throws before anything is saved if invalid
  }
  newConfig.applied = { at: new Date().toISOString(), snapshot: original ?? null };
}

// ---- surfaces --------------------------------------------------------------

async function productFor(productId, surface, ctx) {
  const product = await store.products.get(productId);
  if (!product || product.type !== 'solution') throw err(404, 'solution_not_found');
  if (!product.config.surfaces.includes(surface)) throw err(404, 'solution_not_found');
  if (surface === 'patient' && product.status !== 'live') throw err(404, 'solution_not_found');
  if (product.status === 'draft' && surface !== 'master') throw err(404, 'solution_not_found');
  if (surface === 'payer' && product.payerId !== ctx.payerId) throw err(404, 'solution_not_found');
  if (surface === 'hospital' && product.config.tenantIds.length && !product.config.tenantIds.includes(ctx.tenant?.id)) {
    throw err(404, 'solution_not_found');
  }
  return product;
}

async function run(productId, surface, { tenant, payerId, input } = {}) {
  const product = surface === 'master'
    ? await store.products.get(productId)
    : await productFor(productId, surface, { tenant, payerId });
  if (!product || product.type !== 'solution') throw err(404, 'solution_not_found');
  const mod = MODULES[product.config.module];
  const data = await mod.run({ surface, tenant, payerId: product.payerId, product }, product.config.params, input || {});
  return {
    solutionId: product.id, module: product.config.module, title: product.config.title, status: product.status,
    dryRun: product.status !== 'live', surface, result: data,
  };
}

function publicView(product) {
  const mod = MODULES[product.config.module];
  return {
    id: product.id, title: product.config.title, intro: product.config.intro, module: product.config.module,
    status: product.status, surfaces: product.config.surfaces, payerName: product.payerName,
    inputs: INPUTS[product.config.module] || [], moduleLabel: mod.label,
  };
}

// What a surface asks the user for, per module (drives the generic runner UI).
const INPUTS = {
  auth_threshold: [{ key: 'amount', label: 'Claim amount (GHS)', type: 'number' }],
  auto_adjudication: [{ key: 'diagnosis', label: 'Diagnosis', type: 'text' }, { key: 'itemCodes', label: 'Item codes (comma-separated)', type: 'text' }, { key: 'amount', label: 'Amount (GHS)', type: 'number' }],
  claim_expiry: [],
  settlement_cycle: [{ key: 'tenantId', label: 'Provider id', type: 'text', surface: 'payer' }],
  daily_billing: [{ key: 'tenantId', label: 'Provider id', type: 'text', surface: 'payer' }],
  multi_funder: [],
  pharmacy_compare: [{ key: 'items', label: 'Medicines (one per line)', type: 'textarea', required: true }],
  reconciliation: [{ key: 'tenantId', label: 'Provider id', type: 'text', surface: 'payer' }, { key: 'since', label: 'From (YYYY-MM-DD)', type: 'text' }],
};

async function listFor(surface, { tenant, payerId } = {}) {
  const all = (await store.products.all()).filter((p) => p.type === 'solution' && p.config.surfaces.includes(surface) && p.status !== 'draft');
  return all.filter((p) => {
    if (surface === 'payer') return p.payerId === payerId;
    if (surface === 'hospital') return !p.config.tenantIds.length || p.config.tenantIds.includes(tenant?.id);
    return p.status === 'live';
  }).map(publicView);
}

module.exports = { MODULES, SURFACES, registry, validateConfig, onStatusChange, onLiveUpdate, run, listFor, publicView, coerceParams };
