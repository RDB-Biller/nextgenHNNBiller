'use strict';

const crypto = require('crypto');
const https = require('https');
const store = require('../store');
const claimsAutomation = require('./claimsAutomation');
const verification = require('./verification');
const priorApproval = require('./priorApproval');
const priceList = require('./priceList');
const catalog = require('./catalog');
const networks = require('./networks');

/**
 * AI adjudication -- the "~80% AI-assisted" phase that claimsAutomation.js
 * deliberately left for later. A claim is scored by three layers, cheapest and
 * most auditable first:
 *
 *   1. Deterministic checks  -- duplicates, tariff deviation, quantity anomalies,
 *                               exclusions, disputed bills, missing data. A HARD
 *                               flag means the AI may never approve on its own.
 *   2. A trainable scorer    -- logistic regression over explainable features
 *                               (amount vs the payer's norm, diagnosis/treatment
 *                               affinity, provider and member history, tariff
 *                               deviation, ...). It learns from every human
 *                               decision (online) and can be retrained in batch
 *                               from the payer's history or an imported file.
 *   3. Claude Fable 5.1      -- reads the de-identified claim packet, the payer's
 *                               own guidelines and the two layers above, and
 *                               returns a structured verdict with reasons.
 *
 * The three are blended into one recommendation (approve / review / decline)
 * with a confidence. What the platform DOES with it depends on the product's
 * mode AND a benchmark gate the licenser controls:
 *
 *   shadow  -- score silently; nothing shown, nothing changed. Builds the benchmark.
 *   assist  -- reviewers see the recommendation and reasons; humans still decide.
 *   auto    -- approve on its own, but ONLY while the measured accuracy on
 *              human-reviewed claims is at or above the required level, the
 *              false-approve rate is within bounds, enough claims have been
 *              benchmarked, the claim is under the auto amount cap, carries no
 *              hard flag and (by default) the patient has verified the bill.
 *              A share of qualifying claims is still routed to humans as an
 *              audit sample, so the benchmark keeps being measured once the AI
 *              is acting. If accuracy drifts below the bar the product trips
 *              back to assist on its own (fallbackOnDrift).
 *
 * Every human decision (payer console, secure link, Master Control approvals)
 * is recorded against the AI's prediction. That one stream is both the
 * benchmark and the training signal, so "raise the required accuracy" and
 * "retrain" are things the licenser does from Product Lab, not from code.
 *
 * Like claimsAutomation, this module only DECIDES. claims.js binds the
 * approve/decline actions (bindActions) so there is no circular require and
 * a single code path moves money.
 *
 * Privacy: the packet sent to the model carries no patient name, phone or
 * member id -- diagnosis, items, amounts, provider, and the check results only.
 */

const MODULE = 'ai_adjudication';
const DEFAULT_NAME = 'AI Adjudication (default)';
const MODEL_KEY = (productId) => `ai_model:${productId}`;
const LLM_SWITCH_KEY = 'ai_llm';
const MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['shadow', 'assist', 'auto'];
const DECIDED = ['authorizing', 'authorized', 'settled', 'rejected'];

const err = (status, message, detail) => { const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e; };
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;
const now = () => new Date().toISOString();
const rid = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;
const norm = (s) => String(s || '').trim().toLowerCase();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// ---- Product Lab parameters ----------------------------------------------------

const PARAMS = [
  { key: 'mode', label: 'Mode', type: 'select', options: MODES, default: 'assist',
    help: 'shadow = score silently; assist = recommend, humans decide; auto = approve on its own once the benchmark gate below is met.' },
  { key: 'requiredAccuracy', label: 'Required benchmark accuracy (0-1)', type: 'number', min: 0.5, max: 1, default: 0.95,
    help: 'Accuracy on human-reviewed claims the AI must reach before it may act on its own. Raise it to demand more before trusting it.' },
  { key: 'maxFalseApproveRate', label: 'Max false-approve rate (0-1)', type: 'number', min: 0, max: 0.5, default: 0.02,
    help: 'Of the claims the AI recommended approving, the share a human then declined. Money at risk, so keep it small.' },
  { key: 'minBenchmarkSample', label: 'Minimum benchmarked claims', type: 'number', min: 10, max: 100000, default: 200,
    help: 'Definite AI recommendations that a human has reviewed, before auto mode can act.' },
  { key: 'benchmarkWindowDays', label: 'Benchmark window (days)', type: 'number', min: 7, max: 730, default: 90 },
  { key: 'confidenceThreshold', label: 'Confidence needed to recommend (0.5-0.99)', type: 'number', min: 0.5, max: 0.99, default: 0.9 },
  { key: 'maxAutoAmount', label: 'Auto-approve up to (GHS)', type: 'number', min: 1, default: 500 },
  { key: 'highAmountReview', label: 'Always send to a reviewer above (GHS)', type: 'number', min: 1, default: 2000 },
  { key: 'autoDecline', label: 'Allow the AI to decline on its own', type: 'boolean', default: false,
    help: 'Off by default: a decline recommendation always goes to a reviewer.' },
  { key: 'auditSamplePercent', label: 'Audit sample in auto mode (%)', type: 'number', min: 0, max: 100, default: 10,
    help: 'Share of auto-approvable claims still routed to a human so the benchmark keeps being measured.' },
  { key: 'requireVerifiedBill', label: 'Auto-approve only when the patient has verified the bill', type: 'boolean', default: true },
  { key: 'fallbackOnDrift', label: 'Drop back to assist if accuracy falls below the bar', type: 'boolean', default: true },
  { key: 'llmEnabled', label: 'Use Claude (LLM layer) for this product', type: 'boolean', default: false,
    help: 'Off by default. Also needs the platform-wide Claude switch in Master Control and ANTHROPIC_API_KEY. Claude is never load-bearing: auto mode must pass the gate on checks + scorer alone.' },
  { key: 'llmModel', label: 'Claude model', type: 'select', options: MODELS, default: 'claude-fable-5-1' },
  { key: 'llmEffort', label: 'Claude effort', type: 'select', options: EFFORTS, default: 'max',
    help: 'max = deepest reasoning (most tokens). high is the model default and cheaper.' },
  { key: 'llmMaxTokens', label: 'Claude max output tokens', type: 'number', min: 2000, max: 64000, default: 16000,
    help: 'Thinking counts towards this at high effort and above.' },
  { key: 'llmTimeoutSeconds', label: 'Claude timeout (seconds)', type: 'number', min: 10, max: 300, default: 90 },
  { key: 'llmDailyCap', label: 'Max Claude calls per day (cost guard)', type: 'number', min: 0, max: 100000, default: 1000 },
  { key: 'blendWeightLlm', label: 'Weight of Claude vs the trained scorer (0-1)', type: 'number', min: 0, max: 1, default: 0.6 },
  { key: 'mlEnabled', label: 'Use the trainable scorer (ML layer)', type: 'boolean', default: true },
  { key: 'mlLearningRate', label: 'Scorer learning rate', type: 'number', min: 0.001, max: 1, default: 0.05 },
  { key: 'guidelines', label: 'Payer guidelines for the AI (plain text)', type: 'textarea', default: '',
    help: 'Treatment guidelines, cover rules, caps, what needs pre-authorisation. Sent to Claude with every claim.' },
  { key: 'exclusions', label: 'Excluded items / keywords (one per line)', type: 'textarea', default: '',
    help: 'Any billed item matching one of these is flagged and never auto-approved.' },
  { key: 'tariffTolerancePercent', label: 'Tariff tolerance (%)', type: 'number', min: 0, max: 500, default: 25,
    help: 'Billed unit price may exceed the reference price (price list, NHIS tariff or the payer\'s own history) by this much.' },
  { key: 'duplicateWindowDays', label: 'Duplicate-claim window (days)', type: 'number', min: 1, max: 365, default: 7 },
  { key: 'maxQtyPerItem', label: 'Max quantity per line', type: 'number', min: 1, max: 1000, default: 30 },
];

function check(p) {
  if (p.mode === 'auto' && p.auditSamplePercent >= 100) throw err(422, 'param_invalid', 'auditSamplePercent must be below 100 in auto mode (nothing would be automated)');
}

function defaults() {
  const out = {};
  for (const d of PARAMS) out[d.key] = d.default;
  return out;
}
const paramsOf = (product) => ({ ...defaults(), ...(product?.config?.params || {}) });

// ---- product resolution ------------------------------------------------------

async function allProducts() {
  return (await store.products.all()).filter((p) => p.type === 'solution' && p.config?.module === MODULE);
}
const isDefault = (p) => p.name === DEFAULT_NAME;

/** The product that governs this payer: its own live one first, else the platform default (if live). */
async function productFor(payerId) {
  const all = await allProducts();
  const own = all.filter((p) => p.status === 'live' && p.payerId === payerId && !isDefault(p))
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))[0];
  if (own) return own;
  const def = all.find((p) => isDefault(p));
  return def && def.status === 'live' ? def : null;
}

async function defaultProduct() { return (await allProducts()).find(isDefault) || null; }

/** Ships one live default (assist mode) so every payer gets AI recommendations from day one. Created once, never revived. */
async function ensureDefaultProduct() {
  const found = await defaultProduct();
  if (found) {
    // The default shipped with Claude on; it now ships off (no external dependency). Move an untouched default over.
    if (found.config?.params?.llmEnabled === true && !found.config.params.guidelines) {
      const products = require('./products');
      return products.update(found.id, { config: { ...found.config, params: { ...found.config.params, llmEnabled: false } } }, 'system');
    }
    return found;
  }
  const products = require('./products');
  const payers = await store.payers.all();
  const sponsor = payers.find((x) => x.id === 'cosmopolitan') || payers[0];
  if (!sponsor) return null;
  const created = await products.create(sponsor.id, { type: 'solution', name: DEFAULT_NAME,
    description: 'Default AI adjudication: Claude Fable 5.1 recommendations on every claim for payers without their own configuration. Assist mode until a benchmark is met.',
    config: { module: MODULE, params: {}, surfaces: ['hospital', 'payer'] } }, 'system');
  await products.setStatus(created.id, 'sandbox', 'system');
  return products.setStatus(created.id, 'live', 'system');
}

// ---- payer statistics (learned norms) ----------------------------------------------

const statsCache = new Map(); // scope -> { at, stats }
const STATS_TTL_MS = 120000;

function outcomeOfClaim(c) {
  if (['authorizing', 'authorized', 'settled'].includes(c.status)) return 'approved';
  if (c.status === 'rejected') return 'declined';
  return null;
}
function itemKey(it) { return norm(it.code || it.name); }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Norms learned from the payer's own decided claims (or every payer's, for the default). */
async function payerStats(scopeId, { payerId } = {}) {
  const hit = statsCache.get(scopeId);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.stats;
  const claims = payerId ? await store.claims.listByPayer(payerId) : await store.claims.all(5000);
  const providers = {}; const prices = {}; const dx = {}; const amounts = [];
  for (const c of claims) {
    const o = outcomeOfClaim(c);
    if (!o) continue;
    const prov = providers[c.tenantId] || (providers[c.tenantId] = { approved: 0, declined: 0 });
    prov[o]++;
    amounts.push(Number(c.amount) || 0);
    if (o !== 'approved') continue;
    const d = norm(c.clinical?.diagnosis || c.clinical?.icdCode);
    const entry = d ? (dx[d] || (dx[d] = { n: 0, items: {} })) : null;
    if (entry) entry.n++;
    for (const it of c.lineItems || []) {
      const k = itemKey(it); if (!k) continue;
      const unit = Number(it.unitPrice != null ? it.unitPrice : (it.lineTotal / (it.qty || 1)));
      if (Number.isFinite(unit) && unit > 0) (prices[k] || (prices[k] = [])).push(unit);
      if (entry) entry.items[k] = (entry.items[k] || 0) + 1;
    }
  }
  const stats = { providers, prices, dx, amountMedian: median(amounts), decided: amounts.length, claims };
  statsCache.set(scopeId, { at: Date.now(), stats });
  return stats;
}
function invalidateStats() { statsCache.clear(); }

// ---- deterministic checks + features ---------------------------------------------------

const FEATURE_NAMES = ['bias', 'logAmount', 'amountVsMedian', 'itemCount', 'hasDiagnosis', 'dxItemAffinity', 'tariffOverRatio',
  'duplicateRecent', 'providerApprovalRate', 'providerDeclines', 'memberClaims30d', 'verified', 'priorApproval', 'ruleMatch',
  'qtyAnomaly', 'exclusionHit', 'highAmount', 'repriced', 'weekendNight', 'inNetwork'];
// Hand-set prior: sensible before a single human decision has been seen; training moves it from here.
const PRIOR_WEIGHTS = [1.2, -0.6, -0.8, -0.2, 0.4, 1.0, -1.5, -2.0, 1.0, -0.6, -0.5, 0.8, 1.0, 1.0, -1.5, -2.0, -1.0, -0.2, -0.3, 0.3];

async function referencePrice(payerId, it, provider, stats) {
  const hit = await priceList.priceFor(payerId, { code: it.code, name: it.name, provider }).catch(() => null);
  if (hit && hit.price != null) return { price: Number(hit.price), source: 'price_list' };
  const cat = catalog.findItem(it.code) || catalog.findItem(it.name);
  if (cat && cat.price != null) return { price: Number(cat.price), source: 'nhis_tariff' };
  const hist = stats.prices[itemKey(it)];
  if (hist && hist.length >= 3) return { price: median(hist), source: 'payer_history' };
  return null;
}

/**
 * Pure-ish feature extraction + deterministic checks. Returns { features (array),
 * named (object), flags [{code, severity:'hard'|'soft', detail}], facts } with nothing
 * identifying in `facts` -- it is what the model gets to see.
 */
async function analyse(claim, bill, p, { payerId, stats }) {
  const flags = [];
  const amount = Number(claim.amount) || 0;
  const items = claim.lineItems && claim.lineItems.length ? claim.lineItems : (bill?.lineItems || []).map((i) => ({ ...i, lineTotal: i.cost }));
  const diagnosis = claim.clinical?.diagnosis || bill?.clinical?.diagnosis || '';
  const dxKey = norm(diagnosis || claim.clinical?.icdCode || bill?.clinical?.icdCode);
  const createdAt = new Date(claim.createdAt || Date.now());

  // tariff deviation
  let worstRatio = 0; const priced = [];
  for (const it of items) {
    const unit = Number(it.unitPrice != null ? it.unitPrice : ((it.lineTotal != null ? it.lineTotal : it.cost) / (it.qty || 1)));
    const ref = await referencePrice(payerId, it, claim.tenantId || bill?.tenantId, stats);
    if (ref && ref.price > 0 && Number.isFinite(unit)) {
      const ratio = unit / ref.price - 1;
      priced.push({ item: it.name, code: it.code || null, billedUnit: round2(unit), referenceUnit: round2(ref.price), source: ref.source, deviationPercent: Math.round(ratio * 100) });
      if (ratio > worstRatio) worstRatio = ratio;
    }
  }
  const tol = (Number(p.tariffTolerancePercent) || 0) / 100;
  if (worstRatio > tol) flags.push({ code: 'over_tariff', severity: 'hard', detail: `billed up to ${Math.round(worstRatio * 100)}% above the reference price (tolerance ${p.tariffTolerancePercent}%)` });

  // quantities, exclusions
  const maxQty = Number(p.maxQtyPerItem) || 30;
  const qtyBad = items.filter((it) => Number(it.qty || 1) > maxQty || Number(it.qty || 1) <= 0);
  if (qtyBad.length) flags.push({ code: 'qty_anomaly', severity: 'hard', detail: `${qtyBad.map((i) => `${i.name} x${i.qty}`).join(', ')} (max ${maxQty})` });
  const exclusions = String(p.exclusions || '').split(/\r?\n|,/).map(norm).filter(Boolean);
  const excluded = exclusions.length ? items.filter((it) => exclusions.some((x) => itemKey(it).includes(x) || norm(it.name).includes(x))) : [];
  if (excluded.length) flags.push({ code: 'excluded_item', severity: 'hard', detail: excluded.map((i) => i.name).join(', ') });

  // duplicates: same member + provider, overlapping items, within the window, not declined.
  // Always against a FRESH list (the cached stats are for aggregates; a duplicate may be seconds old).
  const windowMs = (Number(p.duplicateWindowDays) || 7) * 86400000;
  const mine = new Set(items.map(itemKey).filter(Boolean));
  const recentClaims = await store.claims.listByPayer(claim.payerId);
  let duplicate = null;
  for (const c of recentClaims) {
    if (c.id === claim.id || c.status === 'rejected' || c.memberId !== claim.memberId || c.tenantId !== claim.tenantId) continue;
    if (Math.abs(new Date(c.createdAt) - createdAt) > windowMs) continue;
    const theirs = new Set((c.lineItems || []).map(itemKey).filter(Boolean));
    if (!theirs.size || !mine.size) continue;
    let common = 0; for (const k of mine) if (theirs.has(k)) common++;
    if (common / Math.max(mine.size, theirs.size) >= 0.8) { duplicate = c; break; }
  }
  if (duplicate) flags.push({ code: 'duplicate_claim', severity: 'hard', detail: `matches claim ${duplicate.id} from ${String(duplicate.createdAt).slice(0, 10)}` });

  // history
  const prov = stats.providers[claim.tenantId] || { approved: 0, declined: 0 };
  const provDecided = prov.approved + prov.declined;
  const providerApprovalRate = (prov.approved + 1) / (provDecided + 2);
  if (provDecided >= 5 && prov.declined / provDecided > 0.3) flags.push({ code: 'provider_watch', severity: 'soft', detail: `${Math.round(100 * prov.declined / provDecided)}% of this provider's claims were declined` });
  const since30 = createdAt.getTime() - 30 * 86400000;
  const memberClaims30d = recentClaims.filter((c) => c.id !== claim.id && c.memberId === claim.memberId && new Date(c.createdAt).getTime() >= since30 && new Date(c.createdAt) <= createdAt).length;
  if (memberClaims30d >= 3) flags.push({ code: 'member_velocity', severity: 'soft', detail: `${memberClaims30d} other claims for this member in 30 days` });

  // diagnosis / treatment affinity
  let affinity = 0.5; const dxEntry = dxKey ? stats.dx[dxKey] : null;
  if (dxEntry && dxEntry.n >= 3 && mine.size) {
    let sum = 0; for (const k of mine) sum += Math.min(1, (dxEntry.items[k] || 0) / dxEntry.n);
    affinity = sum / mine.size;
    if (affinity < 0.1) flags.push({ code: 'unusual_treatment_for_diagnosis', severity: 'soft', detail: `these items rarely appear with "${diagnosis}" in approved claims` });
  }
  if (!dxKey) flags.push({ code: 'no_diagnosis', severity: 'soft', detail: 'no diagnosis recorded on the bill' });

  // verification, prior approval, rules, network, sanity
  const v = await verification.forBill(claim.billId).catch(() => null);
  const vStatus = v?.status || 'not_sent';
  if (vStatus === 'disputed') flags.push({ code: 'patient_disputed', severity: 'hard', detail: v.disputeReason || 'the patient disputed this bill' });
  const pas = claim.memberId ? await priorApproval.activeForMember(claim.payerId, claim.memberId).catch(() => []) : [];
  const policy = await claimsAutomation.getPolicy();
  const payer = await store.payers.get(claim.payerId);
  const rule = payer ? claimsAutomation.decide(policy, { ...claimsAutomation.payerPolicyOf(payer), enabled: true, useStructuredRules: true }, claim, bill || { clinical: claim.clinical, lineItems: items }) : { autoClear: false };
  let inNetwork = 0.5; let networkReason = null;
  if (payer) {
    try { const d = await networks.resolve(payer, claim.tenantId, amount); inNetwork = d.inNetwork ? 1 : 0; networkReason = d.reason; } catch (e) { inNetwork = 0; networkReason = e.message; flags.push({ code: 'out_of_network', severity: 'soft', detail: e.detail || e.message }); }
  }
  if (!claim.memberId) flags.push({ code: 'missing_member_id', severity: 'hard', detail: 'no member / policy id' });
  if (bill && amount > round2(bill.totals?.payerShare || 0) + 0.005 && !claim.split) flags.push({ code: 'amount_exceeds_payer_share', severity: 'hard', detail: `claim ${round2(amount)} > payer share ${round2(bill.totals?.payerShare || 0)}` });
  if (amount > Number(p.highAmountReview)) flags.push({ code: 'high_amount', severity: 'hard', detail: `above the GHS ${p.highAmountReview} always-review line` });
  const day = createdAt.getUTCDay(); const hour = createdAt.getUTCHours();
  const weekendNight = (day === 0 || day === 6 || hour >= 22 || hour < 5) ? 1 : 0;

  const named = {
    bias: 1,
    logAmount: Math.log10(1 + amount) / 4,
    amountVsMedian: stats.amountMedian ? clamp(Math.log2((amount + 1) / (stats.amountMedian + 1)) / 3, -1, 1) : 0,
    itemCount: Math.min(items.length, 10) / 10,
    hasDiagnosis: dxKey ? 1 : 0,
    dxItemAffinity: affinity,
    tariffOverRatio: clamp(worstRatio, -1, 2) / 2,
    duplicateRecent: duplicate ? 1 : 0,
    providerApprovalRate: (providerApprovalRate - 0.5) * 2,
    providerDeclines: Math.min(prov.declined, 5) / 5,
    memberClaims30d: Math.min(memberClaims30d, 5) / 5,
    verified: vStatus === 'verified' ? 1 : vStatus === 'disputed' ? -1 : 0,
    priorApproval: pas.length ? 1 : 0,
    ruleMatch: rule.autoClear ? 1 : 0,
    qtyAnomaly: qtyBad.length ? 1 : 0,
    exclusionHit: excluded.length ? 1 : 0,
    highAmount: amount > Number(p.highAmountReview) ? 1 : 0,
    repriced: claim.repriced ? 1 : 0,
    weekendNight,
    inNetwork,
  };
  const features = FEATURE_NAMES.map((k) => round4(named[k]));
  const facts = {
    amount: round2(amount), currency: claim.currency || 'GHS', payerKind: payer?.kind || null, provider: claim.provider || bill?.provider || null,
    items: items.map((it) => ({ name: it.name, code: it.code || null, qty: it.qty || 1, unitPrice: round2(it.unitPrice != null ? it.unitPrice : ((it.lineTotal != null ? it.lineTotal : it.cost) / (it.qty || 1))), lineTotal: round2(it.lineTotal != null ? it.lineTotal : it.cost) })),
    diagnosis: diagnosis || null, icdCode: claim.clinical?.icdCode || bill?.clinical?.icdCode || null,
    complaint: claim.clinical?.complaint || bill?.clinical?.complaint || null,
    differentialDiagnosis: claim.clinical?.differentialDiagnosis || bill?.clinical?.differentialDiagnosis || null,
    pricing: priced, patientVerification: vStatus, priorApprovalOnFile: pas.length > 0,
    priorApprovals: pas.slice(0, 3).map((pa) => ({ description: pa.description, amountCap: pa.amountCap })),
    structuredRuleMatch: rule.autoClear ? (rule.method || true) : false,
    network: networkReason, providerHistory: { decided: provDecided, approvalRate: round4(providerApprovalRate) },
    memberClaimsLast30Days: memberClaims30d, submittedAt: createdAt.toISOString(),
  };
  return { features, named, flags, facts };
}

// ---- the trainable scorer (online logistic regression) --------------------------------

async function loadModel(productId) {
  const saved = await store.settings.get(MODEL_KEY(productId));
  if (saved && Array.isArray(saved.weights) && saved.weights.length === FEATURE_NAMES.length) return saved;
  return { weights: [...PRIOR_WEIGHTS], names: FEATURE_NAMES, version: 0, trainedAt: null, samples: 0, onlineUpdates: 0, holdout: null, history: [] };
}
async function saveModel(productId, m) { await store.settings.set(MODEL_KEY(productId), m); return m; }
function predict(weights, x) { let z = 0; for (let i = 0; i < weights.length; i++) z += weights[i] * x[i]; return sigmoid(z); }
function sgdStep(weights, x, y, lr, l2 = 0.001) {
  const pr = predict(weights, x); const g = pr - y;
  for (let i = 0; i < weights.length; i++) weights[i] -= lr * (g * x[i] + (i ? l2 * weights[i] : 0));
  return pr;
}
function evalSet(weights, rows, thr) {
  let correct = 0; let decisive = 0; let logloss = 0;
  for (const r of rows) {
    const pr = predict(weights, r.x); const y = r.y;
    logloss += -(y * Math.log(Math.max(pr, 1e-9)) + (1 - y) * Math.log(Math.max(1 - pr, 1e-9)));
    if (pr >= thr || pr <= 1 - thr) { decisive++; if ((pr >= thr ? 1 : 0) === y) correct++; }
  }
  return { n: rows.length, decisive, accuracy: decisive ? round4(correct / decisive) : null, logloss: rows.length ? round4(logloss / rows.length) : null,
    coverage: rows.length ? round4(decisive / rows.length) : 0 };
}

// ---- Claude (Messages API, structured output) ---------------------------------------

function httpRequest(url, { method = 'POST', headers = {}, body, timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { reject(e); return; }
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search || ''}`, method, headers }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request_timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
let _request = httpRequest;
function _setRequestImplForTests(fn) { _request = fn || httpRequest; }

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['approve', 'review', 'decline'] },
    confidence: { type: 'number', description: 'How sure you are of the decision, from 0 to 1.' },
    guideline_compliance: { type: 'string', enum: ['compliant', 'unclear', 'non_compliant'] },
    fraud_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasons: { type: 'array', items: { type: 'string' }, description: 'Up to five short reasons a reviewer can check, grounded in the packet.' },
    concerns: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, detail: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['code', 'detail', 'severity'], additionalProperties: false } },
    suggested_approved_amount: { type: ['number', 'null'], description: 'If only part of the claim should be paid, the amount in GHS; otherwise null.' },
    reviewer_note: { type: 'string', description: 'One or two sentences for the human reviewer.' },
  },
  required: ['decision', 'confidence', 'guideline_compliance', 'fraud_risk', 'reasons', 'concerns', 'suggested_approved_amount', 'reviewer_note'],
  additionalProperties: false,
};

function systemPrompt(p, payer) {
  return [
    'You are the adjudication assistant of HNN Biller, a hospital billing and settlement platform in Ghana. You help an insurer or employer decide whether a claim for a hospital bill should be paid.',
    'You never see patient identities. You judge the claim on its medical and financial coherence: does the billed treatment fit the diagnosis, are prices in line with the reference tariff, are quantities plausible, is there any sign of duplication or abuse, and does the claim follow the payer\'s guidelines below.',
    'Rules: (1) A human reviewer makes the final decision; you recommend. (2) If any HARD flag is present in the packet, do not answer "approve" - answer "review" or "decline". (3) "approve" only when everything is coherent and within the guidelines; when in doubt answer "review". (4) Confidence is your probability that the decision is right; be calibrated, not optimistic. (5) Reasons must point at concrete facts in the packet. (6) Never mention or guess who the patient is.',
    `Payer: ${payer?.name || 'unknown'} (${payer?.kind || 'payer'}). Currency: GHS.`,
    p.guidelines ? `Payer guidelines:\n${String(p.guidelines).slice(0, 12000)}` : 'Payer guidelines: none provided; apply general clinical and billing plausibility.',
    p.exclusions ? `Excluded items (never payable): ${String(p.exclusions).split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean).join('; ')}` : '',
  ].filter(Boolean).join('\n\n');
}

const llmDaily = new Map(); // productId -> { day, n }
function llmCallsToday(productId) { const d = llmDaily.get(productId); const day = new Date().toISOString().slice(0, 10); return d && d.day === day ? d.n : 0; }
function bumpLlm(productId) { const day = new Date().toISOString().slice(0, 10); const d = llmDaily.get(productId); llmDaily.set(productId, { day, n: d && d.day === day ? d.n + 1 : 1 }); }

function llmConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

/**
 * Platform-wide Claude switch (Master Control). OFF by default: the platform never
 * depends on a paid external model to operate. AI_LLM_ENABLED=true only seeds the
 * starting value on an empty database; once saved from Master Control that wins.
 * A product additionally needs its own llmEnabled and ANTHROPIC_API_KEY.
 */
async function getLlmSwitch() {
  const saved = await store.settings.get(LLM_SWITCH_KEY);
  if (saved && typeof saved.enabled === 'boolean') return { enabled: saved.enabled, updatedAt: saved.updatedAt || null, updatedBy: saved.updatedBy || null, seededFromEnv: false };
  return { enabled: process.env.AI_LLM_ENABLED === 'true', updatedAt: null, updatedBy: null, seededFromEnv: true };
}
async function setLlmSwitch(enabled, by = 'HNN') {
  const v = { enabled: enabled === true, updatedAt: now(), updatedBy: by };
  await store.settings.set(LLM_SWITCH_KEY, v);
  return { ...v, seededFromEnv: false };
}
/** Is Claude actually in play for this product right now? (switch + product + key) */
async function llmActive(p) { return !!(p.llmEnabled && (await getLlmSwitch()).enabled && llmConfigured()); }

async function askClaude(p, payer, packet, productId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (require('../store').inScratch()) return { status: 'not_configured', error: 'Demo mode: Claude adjudication is not run in the demo.' };
  if (!apiKey) return { status: 'not_configured', error: 'ANTHROPIC_API_KEY is not set' };
  if (llmCallsToday(productId) >= Number(p.llmDailyCap)) return { status: 'capped', error: `daily cap of ${p.llmDailyCap} Claude calls reached` };
  const model = MODELS.includes(p.llmModel) ? p.llmModel : 'claude-fable-5-1';
  const body = JSON.stringify({
    model, max_tokens: Number(p.llmMaxTokens) || 16000,
    system: [{ type: 'text', text: systemPrompt(p, payer), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Adjudicate this claim. The packet is JSON; "checks" are deterministic results from the platform and "scorer" is a statistical score learned from this payer's past decisions (probability the claim is approvable).\n\n${JSON.stringify(packet)}` }],
    output_config: { effort: EFFORTS.includes(p.llmEffort) ? p.llmEffort : 'max', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
  });
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const started = Date.now();
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      bumpLlm(productId);
      res = await _request(`${base}/v1/messages`, { method: 'POST', timeoutMs: (Number(p.llmTimeoutSeconds) || 90) * 1000,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, body });
      if (![429, 500, 502, 503, 529].includes(res.status)) break;
    } catch (e) { res = { status: 0, body: '', error: e.message }; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const latencyMs = Date.now() - started;
  if (!res || res.status === 0) return { status: 'error', error: res?.error || 'no_response', latencyMs, model };
  let parsed = {}; try { parsed = JSON.parse(res.body || '{}'); } catch (_e) { /* non-JSON */ }
  if (res.status !== 200) return { status: 'error', error: parsed?.error?.message || `anthropic_http_${res.status}`, httpStatus: res.status, latencyMs, model };
  const usage = parsed.usage ? { input: parsed.usage.input_tokens, output: parsed.usage.output_tokens, cacheRead: parsed.usage.cache_read_input_tokens || 0 } : null;
  if (parsed.stop_reason === 'refusal') return { status: 'refused', error: 'model refused', usage, latencyMs, model };
  const text = (parsed.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let v; try { v = JSON.parse(text); } catch (_e) { return { status: parsed.stop_reason === 'max_tokens' ? 'truncated' : 'unparseable', error: 'could not parse the verdict', usage, latencyMs, model }; }
  const decision = ['approve', 'review', 'decline'].includes(String(v.decision).toLowerCase()) ? String(v.decision).toLowerCase() : 'review';
  return {
    status: 'ok', model, effort: p.llmEffort, latencyMs, usage, stopReason: parsed.stop_reason,
    decision, confidence: clamp(Number(v.confidence) || 0, 0, 1),
    guidelineCompliance: v.guideline_compliance || 'unclear', fraudRisk: v.fraud_risk || 'medium',
    reasons: Array.isArray(v.reasons) ? v.reasons.slice(0, 5).map(String) : [],
    concerns: Array.isArray(v.concerns) ? v.concerns.slice(0, 8) : [],
    suggestedApprovedAmount: v.suggested_approved_amount != null ? round2(v.suggested_approved_amount) : null,
    reviewerNote: v.reviewer_note ? String(v.reviewer_note).slice(0, 600) : '',
  };
}

// ---- evaluation ----------------------------------------------------------------------

function auditPick(claimId, percent) {
  if (!(percent > 0)) return false;
  const h = crypto.createHash('sha256').update(String(claimId)).digest();
  return (h.readUInt16BE(0) % 100) < percent;
}

/** Score one claim. Pure read; persists nothing. */
async function evaluate(claim, bill, { product, useLlm = true } = {}) {
  const p = paramsOf(product);
  const payer = await store.payers.get(claim.payerId);
  const scopeId = isDefault(product) ? 'default' : product.id;
  const stats = await payerStats(scopeId, isDefault(product) ? {} : { payerId: product.payerId });
  const { features, named, flags, facts } = await analyse(claim, bill, p, { payerId: claim.payerId, stats });
  const hard = flags.filter((f) => f.severity === 'hard');

  const model = await loadModel(product.id);
  const ml = p.mlEnabled ? { enabled: true, probability: round4(predict(model.weights, features)), version: model.version, samples: model.samples, onlineUpdates: model.onlineUpdates } : { enabled: false, probability: null };

  let llm = { enabled: false, status: 'skipped' };
  if (p.llmEnabled && useLlm && !(await getLlmSwitch()).enabled) llm = { enabled: false, status: 'platform_off' };
  else if (p.llmEnabled && useLlm) {
    const packet = { claim: facts, checks: flags, scorer: ml.enabled ? { probabilityApprovable: ml.probability, trainedOn: model.samples } : null };
    llm = { enabled: true, ...(await askClaude(p, payer, packet, product.id)) };
  }

  const thr = Number(p.confidenceThreshold) || 0.9;
  const llmP = llm.status === 'ok' ? (llm.decision === 'approve' ? 0.5 + 0.5 * llm.confidence : llm.decision === 'decline' ? 0.5 - 0.5 * llm.confidence : 0.5) : null;
  const mlP = ml.enabled ? ml.probability : null;
  const wL = clamp(Number(p.blendWeightLlm), 0, 1);
  let score = llmP != null && mlP != null ? wL * llmP + (1 - wL) * mlP : (llmP != null ? llmP : (mlP != null ? mlP : 0.5));
  score = round4(score);
  let recommendation;
  if (hard.length) recommendation = (llm.status === 'ok' && llm.decision === 'decline' && llm.confidence >= thr) || score <= 1 - thr ? 'decline' : 'review';
  else recommendation = score >= thr ? 'approve' : score <= 1 - thr ? 'decline' : 'review';
  const confidence = round4(recommendation === 'approve' ? score : recommendation === 'decline' ? 1 - score : 1 - 2 * Math.abs(score - 0.5));

  const reasons = [];
  for (const f of hard) reasons.push(`${f.code}: ${f.detail}`);
  if (llm.status === 'ok') reasons.push(...llm.reasons);
  else if (llm.enabled && llm.status !== 'skipped') reasons.push(`Claude unavailable (${llm.status}${llm.error ? ': ' + llm.error : ''}); decision from checks and the trained scorer only`);
  if (ml.enabled) reasons.push(`scorer: ${Math.round(ml.probability * 100)}% approvable (trained on ${model.samples} decisions)`);
  for (const f of flags.filter((x) => x.severity === 'soft')) reasons.push(`${f.code}: ${f.detail}`);

  return {
    id: rid('aij'), claimId: claim.id, billId: claim.billId, payerId: claim.payerId, tenantId: claim.tenantId, productId: product.id, productName: product.name,
    productStatus: product.status, mode: p.mode, at: now(), amount: round2(claim.amount), thresholds: { confidence: thr, maxAutoAmount: p.maxAutoAmount },
    flags, features: named, ml, llm, score, recommendation, confidence, reasons: reasons.slice(0, 8),
    suggestedApprovedAmount: llm.status === 'ok' ? llm.suggestedApprovedAmount : null,
    hardFlags: hard.map((f) => f.code),
  };
}

// ---- benchmark + gate ----------------------------------------------------------------

function isBenchmarkRow(r) { return r.outcome && r.decidedBy === 'human' && !r.retro && !r.dryRunOnly; }

async function benchmark(product, { windowDays } = {}) {
  const p = paramsOf(product);
  const days = Number(windowDays) || Number(p.benchmarkWindowDays) || 90;
  const since = Date.now() - days * 86400000;
  const rows = (await store.aiAdjudications.listByProduct(product.id, 10000)).filter((r) => isBenchmarkRow(r) && new Date(r.decidedAt || r.createdAt).getTime() >= since);
  const thr = Number(p.confidenceThreshold) || 0.9;
  let decisive = 0; let correct = 0; let approveRecs = 0; let falseApprove = 0; let declineRecs = 0; let falseDecline = 0; let autoCand = 0; let autoCandCorrect = 0;
  let mlDec = 0; let mlOk = 0; let llmDec = 0; let llmOk = 0; let reviews = 0; let mlApprove = 0; let mlFalseApprove = 0;
  const recent = { n: 0, correct: 0 }; const since30 = Date.now() - 30 * 86400000;
  for (const r of rows) {
    const human = r.outcome; const rec = r.recommendation;
    if (rec === 'review') { reviews++; } else {
      decisive++;
      const ok = (rec === 'approve' && human === 'approved') || (rec === 'decline' && human === 'declined');
      if (ok) correct++;
      if (new Date(r.decidedAt || r.createdAt).getTime() >= since30) { recent.n++; if (ok) recent.correct++; }
      if (rec === 'approve') { approveRecs++; if (human === 'declined') falseApprove++;
        if (!(r.hardFlags || []).length && r.amount <= Number(p.maxAutoAmount)) { autoCand++; if (ok) autoCandCorrect++; } }
      if (rec === 'decline') { declineRecs++; if (human === 'approved') falseDecline++; }
    }
    if (r.ml?.probability != null) {
      // Scorer-only view: what the checks + scorer would have said without Claude (hard flags block approval).
      const pr = r.ml.probability; const hard = (r.hardFlags || []).length > 0;
      const mlRec = hard ? (pr <= 1 - thr ? 'declined' : null) : (pr >= thr ? 'approved' : pr <= 1 - thr ? 'declined' : null);
      if (mlRec) { mlDec++; if (mlRec === human) mlOk++; if (mlRec === 'approved') { mlApprove++; if (human === 'declined') mlFalseApprove++; } }
    }
    if (r.llm?.status === 'ok' && r.llm.decision !== 'review') { llmDec++; if ((r.llm.decision === 'approve' ? 'approved' : 'declined') === human) llmOk++; }
  }
  const accuracy = decisive ? round4(correct / decisive) : null;
  const falseApproveRate = approveRecs ? round4(falseApprove / approveRecs) : null;
  const scorerAccuracy = mlDec ? round4(mlOk / mlDec) : null;
  const scorerFalseApproveRate = mlApprove ? round4(mlFalseApprove / mlApprove) : null;
  const claudeOn = await llmActive(p);
  const gateReasons = [];
  if (decisive < Number(p.minBenchmarkSample)) gateReasons.push(`benchmark_sample_too_small (${decisive} of ${p.minBenchmarkSample} definite recommendations reviewed)`);
  if (accuracy == null || accuracy < Number(p.requiredAccuracy)) gateReasons.push(`accuracy_below_required (${accuracy == null ? 'n/a' : Math.round(accuracy * 100) + '%'} vs ${Math.round(p.requiredAccuracy * 100)}% required)`);
  if (falseApproveRate != null && falseApproveRate > Number(p.maxFalseApproveRate)) gateReasons.push(`false_approve_rate_too_high (${Math.round(falseApproveRate * 1000) / 10}% vs ${Math.round(p.maxFalseApproveRate * 1000) / 10}% allowed)`);
  // Claude is never load-bearing: when it is in play, the checks + scorer ALONE must also clear the bar,
  // so switching Claude off (key, cap, outage, cost) can never leave auto mode running on an unproven base.
  if (claudeOn) {
    if (mlDec < Number(p.minBenchmarkSample)) gateReasons.push(`scorer_alone_sample_too_small (${mlDec} of ${p.minBenchmarkSample})`);
    if (scorerAccuracy == null || scorerAccuracy < Number(p.requiredAccuracy)) gateReasons.push(`scorer_alone_below_required (${scorerAccuracy == null ? 'n/a' : Math.round(scorerAccuracy * 100) + '%'} vs ${Math.round(p.requiredAccuracy * 100)}%)`);
    if (scorerFalseApproveRate != null && scorerFalseApproveRate > Number(p.maxFalseApproveRate)) gateReasons.push(`scorer_alone_false_approve_rate_too_high (${Math.round(scorerFalseApproveRate * 1000) / 10}%)`);
  }
  const model = await loadModel(product.id);
  return {
    productId: product.id, productName: product.name, mode: p.mode, productStatus: product.status, windowDays: days,
    reviewed: rows.length, decisive, reviewRate: rows.length ? round4(reviews / rows.length) : 0,
    accuracy, correct, falseApproveRate, falseApproves: falseApprove, approveRecommendations: approveRecs,
    falseDeclineRate: declineRecs ? round4(falseDecline / declineRecs) : null, declineRecommendations: declineRecs,
    recentAccuracy30d: recent.n ? round4(recent.correct / recent.n) : null, recentN30d: recent.n,
    components: { scorer: { decisive: mlDec, accuracy: scorerAccuracy, falseApproveRate: scorerFalseApproveRate, version: model.version, trainedOn: model.samples, onlineUpdates: model.onlineUpdates },
      claude: { decisive: llmDec, accuracy: llmDec ? round4(llmOk / llmDec) : null, configured: llmConfigured(), active: claudeOn, platformSwitch: (await getLlmSwitch()).enabled, productEnabled: !!p.llmEnabled } },
    projection: { autoApproveCandidates: autoCand, autoApproveCandidatesCorrect: autoCandCorrect,
      automationRate: rows.length ? round4(autoCand / rows.length) : 0,
      humanReviewsSavedPerHundred: rows.length ? Math.round(100 * autoCand * (1 - Number(p.auditSamplePercent) / 100) / rows.length) : 0 },
    requirements: { requiredAccuracy: p.requiredAccuracy, maxFalseApproveRate: p.maxFalseApproveRate, minBenchmarkSample: p.minBenchmarkSample, confidenceThreshold: thr, maxAutoAmount: p.maxAutoAmount },
    gate: { passed: gateReasons.length === 0, reasons: gateReasons, autonomous: p.mode === 'auto' && product.status === 'live' && gateReasons.length === 0 },
  };
}

/** What the platform will do with a verdict, given mode, gate, amount, verification and audit sampling. */
async function decideAction(product, verdict, claim) {
  const p = paramsOf(product);
  if (product.status !== 'live') return { action: 'dry_run', reasons: ['product is not live'] };
  if (p.mode === 'shadow') return { action: 'shadow', reasons: [] };
  if (p.mode === 'assist') return { action: 'recommend', reasons: [] };
  // auto
  const bm = await benchmark(product);
  const reasons = [...bm.gate.reasons];
  if (verdict.recommendation === 'review') reasons.push('recommendation_is_review');
  if (verdict.recommendation === 'decline' && !p.autoDecline) reasons.push('auto_decline_disabled');
  if (verdict.hardFlags.length) reasons.push(`hard_flags: ${verdict.hardFlags.join(', ')}`);
  if (verdict.confidence < Number(p.confidenceThreshold)) reasons.push('confidence_below_threshold');
  if (Number(claim.amount) > Number(p.maxAutoAmount)) reasons.push('above_max_auto_amount');
  if (p.requireVerifiedBill && verdict.recommendation === 'approve') {
    const v = await verification.forBill(claim.billId).catch(() => null);
    if (!v || v.status !== 'verified') reasons.push('bill_not_verified_by_patient');
  }
  // Drift breaker: the gate failed on accuracy (not on sample size) -> back to assist, automatically.
  if (p.fallbackOnDrift && bm.decisive >= Number(p.minBenchmarkSample) && bm.gate.reasons.some((r) => r.startsWith('accuracy_below') || r.startsWith('false_approve'))) {
    try {
      const products = require('./products');
      await products.update(product.id, { config: { ...product.config, params: { ...product.config.params, mode: 'assist' } } }, 'ai_adjudication:drift');
      await store.settings.set(`ai_drift:${product.id}`, { at: now(), accuracy: bm.accuracy, falseApproveRate: bm.falseApproveRate, reasons: bm.gate.reasons });
      reasons.push('drift_tripped_back_to_assist');
    } catch (e) { reasons.push(`drift_breaker_failed: ${e.message}`); }
  }
  if (reasons.length) return { action: 'recommend', reasons, benchmark: { accuracy: bm.accuracy, decisive: bm.decisive, falseApproveRate: bm.falseApproveRate } };
  if (auditPick(claim.id, Number(p.auditSamplePercent))) return { action: 'audit_sample', reasons: ['selected for the human audit sample'], benchmark: { accuracy: bm.accuracy, decisive: bm.decisive } };
  return { action: verdict.recommendation === 'approve' ? 'auto_approve' : 'auto_decline', reasons: [], benchmark: { accuracy: bm.accuracy, decisive: bm.decisive, falseApproveRate: bm.falseApproveRate } };
}

// ---- persistence + the act/record cycle ------------------------------------------------

function compact(v, act) {
  return { verdictId: v.id, recommendation: v.recommendation, confidence: v.confidence, score: v.score, action: act?.action || null, mode: v.mode,
    reasons: v.reasons.slice(0, 4), hardFlags: v.hardFlags, llm: { status: v.llm.status, model: v.llm.model || null }, at: v.at, retro: !!v.retro, productId: v.productId };
}

function decidedByOf(claim) {
  if (claim.ai?.action === 'auto_approved' || claim.ai?.action === 'auto_declined') return 'ai';
  if (claim.autoCleared && claim.autoCleared.method && claim.autoCleared.method !== 'ai_adjudication') return 'rules';
  return 'human';
}

async function persist(verdict, claim, act, { decidedBefore } = {}) {
  const row = { ...verdict, action: act?.action || null, actionReasons: act?.reasons || [], gateSnapshot: act?.benchmark || null, createdAt: verdict.at, retro: !!verdict.retro, outcome: null, decidedBy: null, decidedAt: null, agreed: null };
  if (decidedBefore) { // the human (or rules) got there first: usable for training, not a fair benchmark prediction
    row.retro = true;
    const o = outcomeOfClaim(claim);
    if (o) { row.outcome = o; row.decidedBy = decidedByOf(claim); row.decidedAt = claim.rejectedAt || claim.authorizedAt || now(); row.agreed = agreement(row); }
  }
  await store.aiAdjudications.insert(row);
  return row;
}
function agreement(row) {
  if (!row.outcome || row.recommendation === 'review') return null;
  return (row.recommendation === 'approve' && row.outcome === 'approved') || (row.recommendation === 'decline' && row.outcome === 'declined');
}

let actions = { approve: null, decline: null };
/** claims.js binds the real authorize/reject so this module never requires it (same pattern as claimsAutomation). */
function bindActions(a) { actions = { ...actions, ...a }; }

const inflight = new Set();
/** Score, persist, act. Never throws; a failure leaves the claim exactly where it was (pending for a human). */
async function evaluateAndAct(claim, bill, { useLlm = true } = {}) {
  const fresh = (await store.claims.get(claim.id)) || claim;
  const product = await productFor(fresh.payerId);
  if (!product) return null;
  const decidedBefore = DECIDED.includes(fresh.status);
  let verdict;
  try { verdict = await evaluate(fresh, bill || await store.bills.get(fresh.billId), { product, useLlm }); } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[aiAdjudication] evaluation failed for ${fresh.id}:`, e.message);
    return null;
  }
  const act = decidedBefore ? { action: 'none', reasons: ['claim already decided'] } : await decideAction(product, verdict, fresh);
  const row = await persist(verdict, fresh, act, { decidedBefore });
  const again = (await store.claims.get(fresh.id)) || fresh;
  again.ai = compact(verdict, act);
  await store.claims.update(again);
  if (!decidedBefore && again.status === 'pending' && (act.action === 'auto_approve' || act.action === 'auto_decline')) {
    try {
      if (act.action === 'auto_approve') await actions.approve(again.id, { verdictId: verdict.id });
      else await actions.decline(again.id, `AI adjudication: ${verdict.reasons[0] || 'declined'}`, { verdictId: verdict.id });
      const done = await store.claims.get(again.id);
      if (done) {
        done.ai = { ...done.ai, action: act.action === 'auto_approve' ? 'auto_approved' : 'auto_declined', actedAt: now() };
        done.autoCleared = done.autoCleared || { method: 'ai_adjudication', verdictId: verdict.id, clearedAt: now() };
        await store.claims.update(done);
      }
      row.action = done?.ai?.action || row.action; row.outcome = act.action === 'auto_approve' ? 'approved' : 'declined'; row.decidedBy = 'ai'; row.decidedAt = now();
      await store.aiAdjudications.update(row);
    } catch (e) {
      // Authorise can legitimately refuse (patient_verification_pending, out_of_network, transfer error): the claim stays pending.
      row.action = 'auto_approve_failed'; row.actionReasons = [...row.actionReasons, e.message];
      await store.aiAdjudications.update(row);
      const back = await store.claims.get(again.id);
      if (back) { back.ai = { ...back.ai, action: 'recommend', actionError: e.message }; await store.claims.update(back); }
    }
  }
  return row;
}

/** Fire-and-forget from the claim-routing path; flush() waits for everything in flight (tests, admin). */
function enqueue(claim, bill, opts) {
  const task = Promise.resolve().then(() => evaluateAndAct(claim, bill, opts)).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[aiAdjudication] background evaluation failed:', e.message);
    return null;
  }).finally(() => inflight.delete(task));
  inflight.add(task);
  return task;
}
async function flush() { await Promise.all([...inflight]); }
/** Track any background promise (e.g. an outcome record) so flush() waits for it. */
function track(promise) {
  const t = Promise.resolve(promise).catch(() => null).finally(() => inflight.delete(t));
  inflight.add(t);
  return t;
}

/** Pending claims never scored (older than a couple of minutes): score them now. Safe to call often. */
async function runPendingPass({ limit = 50, olderThanMs = 120000 } = {}) {
  const pend = await store.claims.byStatus('pending', 2000);
  const cutoff = Date.now() - olderThanMs;
  const todo = pend.filter((c) => !c.ai && new Date(c.createdAt).getTime() < cutoff).slice(0, limit);
  let n = 0;
  for (const c of todo) { await evaluateAndAct(c, null); n++; }
  return { evaluated: n, pendingUnscored: Math.max(0, pend.filter((c) => !c.ai).length - n) };
}

/**
 * A decision was made on a claim (authorise / reject). Called by claims.js for EVERY
 * decision; `by` says whose it was: 'human' (payer console, secure link, Master
 * Control), 'rules' (claimsAutomation) or 'ai' (this module). Human decisions feed
 * the benchmark and train the scorer; the others are only recorded.
 */
async function recordOutcome(claim, outcome, { by = 'human', actor = null } = {}) {
  invalidateStats();
  const row = await store.aiAdjudications.byClaim(claim.id);
  const product = row ? await store.products.get(row.productId) : await productFor(claim.payerId);
  if (!product) return null;
  let target = row;
  if (!target) {
    // Decided before any score existed (feature just switched on, or the queue was behind): keep it as a training example only.
    let v;
    try { v = await evaluate(claim, await store.bills.get(claim.billId), { product, useLlm: false }); } catch (_e) { return null; }
    v.retro = true;
    target = await persist(v, claim, { action: 'none', reasons: ['decided before scoring'] }, {});
  }
  if (target.outcome && target.decidedBy === 'human') return target; // first human decision stands
  target.outcome = outcome; target.decidedBy = by; target.decidedAt = now(); target.decidedActor = actor || null; target.agreed = agreement(target);
  await store.aiAdjudications.update(target);
  if (by === 'human') await learnOnline(product, target);
  return target;
}

async function learnOnline(product, row) {
  const p = paramsOf(product);
  if (!p.mlEnabled || !row.features) return;
  const model = await loadModel(product.id);
  const x = FEATURE_NAMES.map((k) => Number(row.features[k]) || 0);
  sgdStep(model.weights, x, row.outcome === 'approved' ? 1 : 0, Number(p.mlLearningRate) / 2);
  model.weights = model.weights.map(round4);
  model.onlineUpdates = (model.onlineUpdates || 0) + 1; model.samples = (model.samples || 0) + 1; model.updatedAt = now();
  await saveModel(product.id, model);
}

// ---- training ------------------------------------------------------------------------

/** Build a labelled row from an imported example ({ amount, items, diagnosis, provider?, outcome }) without a stored claim. */
async function rowFromExample(product, ex) {
  const outcome = String(ex.outcome || '').toLowerCase().startsWith('appr') ? 'approved' : String(ex.outcome || '').toLowerCase().startsWith('dec') || String(ex.outcome || '').toLowerCase().startsWith('rej') ? 'declined' : null;
  if (!outcome) throw err(422, 'example_outcome_invalid', 'outcome must be approved or declined');
  const items = (Array.isArray(ex.items) ? ex.items : []).map((it) => ({ name: it.name, code: it.code || null, qty: Number(it.qty) || 1, unitPrice: it.unitPrice != null ? Number(it.unitPrice) : (Number(it.cost) || 0) / (Number(it.qty) || 1), lineTotal: it.lineTotal != null ? Number(it.lineTotal) : Number(it.cost) || 0 }));
  const claim = { id: rid('ex'), billId: null, payerId: product.payerId, tenantId: ex.tenantId || ex.provider || null, provider: ex.provider || null,
    memberId: ex.memberId || 'imported', amount: Number(ex.amount) || items.reduce((s, i) => s + i.lineTotal, 0), currency: 'GHS', lineItems: items,
    clinical: { diagnosis: ex.diagnosis || null, icdCode: ex.icdCode || null }, createdAt: ex.date || now(), status: outcome === 'approved' ? 'settled' : 'rejected' };
  const v = await evaluate(claim, null, { product, useLlm: false });
  v.retro = true; v.source = 'import';
  const row = await persist(v, claim, { action: 'none', reasons: ['imported example'] }, {});
  row.outcome = outcome; row.decidedBy = 'human'; row.decidedAt = claim.createdAt; row.agreed = agreement(row);
  await store.aiAdjudications.update(row);
  return row;
}

/**
 * Batch retraining. Labelled rows = every human-decided verdict for this product
 * (+ backfill: the payer's decided claims that were never scored, + examples: an
 * imported history). Chronological 80/20 split; the new weights are kept only if
 * they do at least as well as the current ones on the held-out 20%.
 */
async function train(product, { epochs = 5, backfill = true, examples = [] } = {}) {
  const p = paramsOf(product);
  const imported = [];
  for (const ex of Array.isArray(examples) ? examples.slice(0, 5000) : []) imported.push(await rowFromExample(product, ex));
  let backfilled = 0;
  if (backfill) {
    const claims = isDefault(product) ? await store.claims.all(5000) : await store.claims.listByPayer(product.payerId);
    const scored = new Set((await store.aiAdjudications.listByProduct(product.id, 10000)).map((r) => r.claimId));
    for (const c of claims) {
      const o = outcomeOfClaim(c); if (!o || scored.has(c.id)) continue;
      if (decidedByOf(c) !== 'human') continue;
      try {
        const v = await evaluate(c, await store.bills.get(c.billId), { product, useLlm: false }); v.retro = true; v.source = 'backfill';
        const row = await persist(v, c, { action: 'none', reasons: ['backfilled from history'] }, {});
        row.outcome = o; row.decidedBy = 'human'; row.decidedAt = c.rejectedAt || c.authorizedAt || c.createdAt; row.agreed = agreement(row);
        await store.aiAdjudications.update(row); backfilled++;
      } catch (_e) { /* skip unscoreable history */ }
    }
  }
  const rows = (await store.aiAdjudications.listByProduct(product.id, 10000))
    .filter((r) => r.outcome && r.decidedBy === 'human' && r.features)
    .sort((a, b) => String(a.decidedAt || a.createdAt).localeCompare(String(b.decidedAt || b.createdAt)))
    .map((r) => ({ x: FEATURE_NAMES.map((k) => Number(r.features[k]) || 0), y: r.outcome === 'approved' ? 1 : 0 }));
  if (rows.length < 10) throw err(422, 'not_enough_labelled_claims', `${rows.length} human-decided claims; need at least 10`);
  const thr = Number(p.confidenceThreshold) || 0.9;
  const cut = Math.max(1, Math.floor(rows.length * 0.8));
  const trainRows = rows.slice(0, cut); const holdRows = rows.slice(cut);
  const model = await loadModel(product.id);
  const before = evalSet(model.weights, holdRows, thr);
  const w = [...model.weights];
  const lr = Number(p.mlLearningRate) || 0.05;
  for (let e = 0; e < Math.max(1, Math.min(50, Number(epochs) || 5)); e++) {
    for (const r of trainRows) sgdStep(w, r.x, r.y, lr / (1 + e * 0.5));
  }
  const after = evalSet(w, holdRows, thr);
  const better = after.logloss == null || before.logloss == null || after.logloss <= before.logloss + 1e-6;
  const entry = { at: now(), samples: rows.length, backfilled, imported: imported.length, epochs, holdout: { n: holdRows.length, before, after }, adopted: better };
  if (better) { model.weights = w.map(round4); model.version = (model.version || 0) + 1; model.trainedAt = now(); model.samples = rows.length; }
  model.history = [...(model.history || []), entry].slice(-20); model.holdout = entry.holdout;
  await saveModel(product.id, model);
  return { ...entry, version: model.version, weights: Object.fromEntries(FEATURE_NAMES.map((k, i) => [k, model.weights[i]])) };
}

async function modelInfo(product) {
  const m = await loadModel(product.id);
  return { version: m.version, trainedAt: m.trainedAt, samples: m.samples, onlineUpdates: m.onlineUpdates, holdout: m.holdout, history: (m.history || []).slice(-5),
    weights: Object.fromEntries(FEATURE_NAMES.map((k, i) => [k, m.weights[i]])) };
}

// ---- licenser actions ----------------------------------------------------------------

async function setMode(product, mode, by = 'HNN') {
  if (!MODES.includes(mode)) throw err(422, 'invalid_mode', MODES.join('|'));
  if (mode === 'auto') {
    const bm = await benchmark(product);
    if (!bm.gate.passed) throw err(422, 'benchmark_gate_not_met', bm.gate.reasons.join('; '));
  }
  const products = require('./products');
  return products.update(product.id, { config: { ...product.config, params: { ...product.config.params, mode } } }, by);
}

async function overview() {
  const prods = await allProducts();
  const items = [];
  for (const pr of prods) {
    const bm = await benchmark(pr);
    const drift = await store.settings.get(`ai_drift:${pr.id}`);
    items.push({ id: pr.id, name: pr.name, payerId: pr.payerId, payerName: pr.payerName, isDefault: isDefault(pr), status: pr.status, mode: paramsOf(pr).mode,
      llm: { model: paramsOf(pr).llmModel, effort: paramsOf(pr).llmEffort, enabled: paramsOf(pr).llmEnabled, active: await llmActive(paramsOf(pr)), callsToday: llmCallsToday(pr.id), dailyCap: paramsOf(pr).llmDailyCap },
      benchmark: bm, drift: drift || null, model: await modelInfo(pr) });
  }
  const pend = await store.claims.byStatus('pending', 2000);
  return { llmConfigured: llmConfigured(), llmSwitch: await getLlmSwitch(), products: items, queue: { inflight: inflight.size, pendingUnscored: pend.filter((c) => !c.ai).length } };
}

async function recentVerdicts({ productId, payerId, limit = 50 } = {}) {
  let rows = productId ? await store.aiAdjudications.listByProduct(productId, limit) : await store.aiAdjudications.all(limit);
  if (payerId) rows = rows.filter((r) => r.payerId === payerId);
  return rows.map((r) => ({ id: r.id, claimId: r.claimId, payerId: r.payerId, amount: r.amount, recommendation: r.recommendation, confidence: r.confidence, action: r.action,
    outcome: r.outcome, decidedBy: r.decidedBy, agreed: r.agreed, hardFlags: r.hardFlags, llm: r.llm?.status, createdAt: r.createdAt, reasons: r.reasons, retro: !!r.retro }));
}

/** What a reviewer (payer console, secure link, Master Control) is shown for a claim. */
async function forClaim(claim) {
  if (!claim?.ai) return null;
  const row = await store.aiAdjudications.get(claim.ai.verdictId);
  if (!row) return claim.ai;
  const product = await store.products.get(row.productId);
  const mode = product ? paramsOf(product).mode : row.mode;
  if (mode === 'shadow' && row.decidedBy !== 'ai') return { recommendation: null, mode: 'shadow', note: 'AI adjudication is running in shadow mode for this payer; recommendations are not shown yet.' };
  return { recommendation: row.recommendation, confidence: row.confidence, score: row.score, mode, action: row.action, reasons: row.reasons, flags: row.flags,
    reviewerNote: row.llm?.reviewerNote || null, suggestedApprovedAmount: row.suggestedApprovedAmount, guidelineCompliance: row.llm?.guidelineCompliance || null, fraudRisk: row.llm?.fraudRisk || null,
    llm: { status: row.llm?.status, model: row.llm?.model || null }, scorer: row.ml?.enabled ? { probability: row.ml.probability, trainedOn: row.ml.samples } : null,
    outcome: row.outcome, decidedBy: row.decidedBy, agreed: row.agreed, at: row.createdAt, productName: row.productName };
}

// ---- Product Lab module run() --------------------------------------------------------

async function run(ctx, p, input = {}) {
  const product = ctx.product;
  const action = String(input.action || 'benchmark');
  if (action === 'benchmark') return { ...(await benchmark(product)), model: await modelInfo(product) };
  if (action === 'recent') return { rows: await recentVerdicts({ productId: product.id, limit: 50 }) };
  if (action === 'train') {
    if (ctx.surface !== 'master' && ctx.surface !== 'payer') throw err(403, 'training_is_for_the_licenser_or_payer');
    return train(product, { epochs: Number(input.epochs) || 5, backfill: input.backfill !== 'false' && input.backfill !== false });
  }
  if (action === 'evaluate') {
    const claim = input.claimId ? await store.claims.get(String(input.claimId)) : null;
    if (!claim) throw err(404, 'claim_not_found');
    if (ctx.surface === 'hospital' && claim.tenantId !== ctx.tenant?.id) throw err(404, 'claim_not_found');
    if (ctx.surface === 'payer' && claim.payerId !== ctx.payerId) throw err(404, 'claim_not_found');
    const useLlm = input.useLlm === true || input.useLlm === 'true' || input.useLlm === 'yes';
    const v = await evaluate(claim, await store.bills.get(claim.billId), { product, useLlm });
    const act = await decideAction(product, v, claim);
    return { dryRun: true, verdict: { recommendation: v.recommendation, confidence: v.confidence, score: v.score, reasons: v.reasons, flags: v.flags, llm: v.llm, scorer: v.ml, features: v.features }, wouldDo: act };
  }
  throw err(422, 'unknown_action', 'use benchmark | evaluate | train | recent');
}

module.exports = {
  MODULE, DEFAULT_NAME, PARAMS, MODES, MODELS, EFFORTS, FEATURE_NAMES, VERDICT_SCHEMA, check, paramsOf,
  productFor, defaultProduct, ensureDefaultProduct,
  evaluate, evaluateAndAct, enqueue, flush, runPendingPass, decideAction, recordOutcome,
  benchmark, train, modelInfo, setMode, overview, recentVerdicts, forClaim, run,
  bindActions, track, llmConfigured, getLlmSwitch, setLlmSwitch, llmActive, invalidateStats, systemPrompt, _setRequestImplForTests,
};
