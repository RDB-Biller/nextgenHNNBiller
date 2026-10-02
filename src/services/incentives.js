'use strict';

const crypto = require('crypto');
const store = require('../store');
const metricsLibrary = require('./metricsLibrary');

/**
 * Product Development Environment — the incentive/penalty/cashback engine.
 *
 * Takes a product (services/products.js) and a measurement period, reads the
 * clinical observations an EMR partner has fed in (services/observations.js)
 * for that payer, and works out what each participating provider and each
 * enrolled patient has earned (or lost). Per your answer when this was
 * scoped: this ACCRUES figures to review — like Revenue does for platform
 * fees — it never moves money on its own. compute() is a pure, repeatable
 * read (safe to call as often as you like, e.g. for a live preview while
 * building a product); accrue() is the one function that actually writes
 * ledger-style rows, and should be called once per product per period.
 *
 * VBC prices off a blended, weighted outcome score (the "formula" half of
 * the hybrid builder) because that's what value-based care actually is —
 * a provider's bonus/penalty reflects several indicators at once, each
 * provider scored only on its OWN patients. Campaigns and loyalty programs
 * price off a flat amount per completed action instead, because that's what
 * those actually are ("pay $X per completed screening", "$X per wellness
 * visit") — forcing them through a weighted score would be false precision.
 * All three still share this one engine, the same accrual ledger, and the
 * same metric library for reporting.
 */

function err(status, message, detail) {
  const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e;
}
function rand() { return crypto.randomBytes(6).toString('hex'); }

function inWindow(dateStr, period = {}) {
  const t = new Date(dateStr).getTime();
  if (period.from && t < new Date(period.from).getTime()) return false;
  if (period.to && t > new Date(period.to).getTime()) return false;
  return true;
}
const laterOf = (a, b) => (!a ? b : !b ? a : (new Date(a) > new Date(b) ? a : b));
const earlierOf = (a, b) => (!a ? b : !b ? a : (new Date(a) < new Date(b) ? a : b));

function groupBy(arr, keyFn) {
  const out = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (k == null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

/**
 * Combines a product's selected metrics into one 0..100 score. A metric that
 * returns null (no observations of that type at all — see metricsLibrary.js)
 * is EXCLUDED from the weighted average, not scored as 0, so a provider
 * isn't penalised for a metric nobody has reported data for yet. "Lower is
 * better" metrics (e.g. complication rate) are flipped to (1 - rate) first,
 * so every weight in the formula consistently means "more weight = pulls the
 * score up when the outcome is good" — a PM building the formula never has
 * to remember to use a negative weight for those.
 */
function weightedScore(metricWeights, ctx) {
  let weightedSum = 0, weightTotal = 0;
  const breakdown = [];
  for (const { metricId, weight } of metricWeights) {
    const def = metricsLibrary.getMetric(metricId);
    const rate = def.compute(ctx);
    if (rate == null) { breakdown.push({ metricId, label: def.label, rawRate: null, included: false }); continue; }
    const normalised = def.higherIsBetter ? rate : (1 - rate);
    weightedSum += normalised * weight;
    weightTotal += weight;
    breakdown.push({ metricId, label: def.label, rawRate: rate, normalised, weight, included: true });
  }
  if (weightTotal === 0) return { score: null, breakdown };
  return { score: Math.round((weightedSum / weightTotal) * 100), breakdown };
}

/** First matching tier wins. A tier's bounds are inclusive; either bound is optional. */
function tierFor(score, tiers = []) {
  return tiers.find((t) => (t.minScore == null || score >= t.minScore) && (t.maxScore == null || score <= t.maxScore)) || null;
}

async function computeVbc(product, period) {
  const all = await store.observations.listByPayerCondition(product.payerId, product.config.condition);
  const inPeriod = all.filter((o) => inWindow(o.recordedAt, period));
  const byProvider = groupBy(inPeriod.filter((o) => o.tenantId), (o) => o.tenantId);
  const params = product.config.metricParams;

  const providerIds = product.config.providers.length ? product.config.providers : [...byProvider.keys()];
  const providers = [];
  for (const tenantId of providerIds) {
    const obs = byProvider.get(tenantId) || [];
    const enrolledCount = metricsLibrary.distinctMemberCount(obs);
    const { score, breakdown } = weightedScore(product.config.metrics, { observations: obs, enrolledCount, params });
    const tier = score != null ? tierFor(score, product.config.providerTiers) : null;
    providers.push({
      tenantId, score, breakdown, enrolledCount,
      ...(tier ? { amount: tier.amount, currency: tier.currency, kind: tier.kind,
        reason: `${product.name}: outcome score ${score}/100` } : {}),
    });
  }

  // Patient cashback is judged on the member's OWN reading of the program's
  // first selected metric — kept to one clear, patient-facing target rather
  // than asking the PM to build a second formula just for patients.
  const patients = [];
  if (product.config.patientCashback && product.config.metrics[0]) {
    const def = metricsLibrary.getMetric(product.config.metrics[0].metricId);
    const byMember = groupBy(inPeriod, (o) => o.memberId);
    for (const [memberId, obs] of byMember) {
      const rate = def.compute({ observations: obs, enrolledCount: 1, params });
      if (rate == null) continue;
      const score = Math.round((def.higherIsBetter ? rate : (1 - rate)) * 100);
      if (score >= product.config.patientCashback.minScore) {
        patients.push({
          memberId, score,
          amount: product.config.patientCashback.amount, currency: product.config.patientCashback.currency,
          kind: 'cashback', reason: `${product.name}: personal target met (score ${score}/100)`,
        });
      }
    }
  }

  return { enrolledCount: metricsLibrary.distinctMemberCount(inPeriod), providers, patients };
}

async function computeCampaign(product, period) {
  const win = { from: laterOf(period.from, product.config.startDate), to: earlierOf(period.to, product.config.endDate) };
  const all = await store.observations.listByPayer(product.payerId);
  const completions = all.filter((o) => o.type === product.config.targetAction && inWindow(o.recordedAt, win));
  const byMember = groupBy(completions, (o) => o.memberId); // one reward per member, however many rows arrive
  const byProvider = groupBy(completions.filter((o) => o.tenantId), (o) => o.tenantId);

  const patients = product.config.patientReward
    ? [...byMember.keys()].map((memberId) => ({
      memberId, amount: product.config.patientReward.amount, currency: product.config.patientReward.currency,
      kind: 'bonus', reason: `${product.name}: completed`,
    }))
    : [];
  const providers = product.config.providerReward
    ? [...byProvider.entries()].map(([tenantId, obs]) => ({
      tenantId, completions: obs.length,
      amount: round2(obs.length * product.config.providerReward.amount), currency: product.config.providerReward.currency,
      kind: 'bonus', reason: `${product.name}: ${obs.length} completion(s)`,
    }))
    : [];
  return { enrolledCount: metricsLibrary.distinctMemberCount(completions), providers, patients, window: win };
}

async function computeLoyalty(product, period) {
  const all = await store.observations.listByPayer(product.payerId);
  const inPeriod = all.filter((o) => o.type === product.config.qualifyingAction && inWindow(o.recordedAt, period));
  const byMember = groupBy(inPeriod, (o) => o.memberId);

  const patients = [...byMember.entries()].map(([memberId, obs]) => {
    let amount = round2(obs.length * product.config.rewardPerAction.amount);
    const capped = product.config.capPerPeriod && amount > product.config.capPerPeriod.amount;
    if (capped) amount = product.config.capPerPeriod.amount;
    return {
      memberId, actionCount: obs.length, amount, currency: product.config.rewardPerAction.currency,
      kind: 'cashback', reason: `${product.name}: ${obs.length} qualifying visit(s)${capped ? ' (capped)' : ''}`,
    };
  });
  return { enrolledCount: metricsLibrary.distinctMemberCount(inPeriod), providers: [], patients };
}

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

/** Pure, repeatable — call as often as you like (e.g. a live preview while building a product). Never writes. */
async function compute(product, period = {}) {
  if (product.type === 'vbc') return computeVbc(product, period);
  if (product.type === 'campaign') return computeCampaign(product, period);
  if (product.type === 'loyalty') return computeLoyalty(product, period);
  throw err(422, 'unsupported_product_type', product.type);
}

/** Runs compute() and WRITES one accrual row per rewarded/penalised provider and patient. */
async function accrue(product, period, actorId) {
  const results = await compute(product, period);
  const written = [];
  for (const p of results.providers) {
    if (!p.amount) continue;
    const row = {
      id: `acc_${rand()}`, productId: product.id, productName: product.name, productType: product.type,
      payerId: product.payerId, beneficiaryType: 'provider', beneficiaryId: p.tenantId,
      amount: p.amount, currency: p.currency, kind: p.kind, reason: p.reason,
      score: p.score ?? null, period, computedAt: new Date().toISOString(), computedBy: actorId || null,
    };
    await store.accruals.insert(row);
    written.push(row);
  }
  for (const pt of results.patients) {
    if (!pt.amount) continue;
    const row = {
      id: `acc_${rand()}`, productId: product.id, productName: product.name, productType: product.type,
      payerId: product.payerId, beneficiaryType: 'patient', beneficiaryId: pt.memberId,
      amount: pt.amount, currency: pt.currency, kind: pt.kind, reason: pt.reason,
      score: pt.score ?? null, period, computedAt: new Date().toISOString(), computedBy: actorId || null,
    };
    await store.accruals.insert(row);
    written.push(row);
  }
  return { results, accrued: written };
}

const listAccrualsByProduct = (productId) => store.accruals.listByProduct(productId);
const listAccrualsByPayer = (payerId) => store.accruals.listByPayer(payerId);
const listAccrualsByBeneficiary = (type, id) => store.accruals.listByBeneficiary(type, id);

module.exports = {
  compute, accrue, weightedScore, tierFor,
  listAccrualsByProduct, listAccrualsByPayer, listAccrualsByBeneficiary,
};
