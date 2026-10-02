'use strict';

const store = require('../store');
const metricsLibrary = require('./metricsLibrary');

/**
 * Product Development Environment — the "product" itself.
 *
 * A product is what a payer's product manager builds in Master Control: a
 * Value-Based-Care program, a promotional campaign, or a loyalty/discount
 * program. All three share this one entity (type, status lifecycle, the
 * participating providers, who it targets) and differ only in `config`,
 * whose shape depends on `type` — see validateConfig() below for exactly
 * what each type needs.
 *
 * Lifecycle (the "test environment" you asked for):
 *   draft -> sandbox -> live -> (back to sandbox any time, e.g. to pause)
 * A product computes and accrues identically in every status right now —
 * accrual is report-only in this phase (nothing disburses automatically; see
 * services/incentives.js) — so the status is about or
 * ganisational readiness ("is this a real, reviewed product yet"), not a
 * money gate. That's the obvious seam for later: when incentives start
 * actually paying out, gate real disbursement on status === 'live' the same
 * way services/operatingMode.js gates real settlement on the live rail.
 */

const TYPES = ['vbc', 'campaign', 'loyalty'];
const STATUSES = ['draft', 'sandbox', 'live'];

function err(status, message, detail) {
  const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e;
}

function rand() { return Math.random().toString(36).slice(2, 8); }

function normaliseMetrics(metrics, condition) {
  if (!Array.isArray(metrics) || !metrics.length) {
    throw err(422, 'at_least_one_metric_required');
  }
  return metrics.map((m) => {
    const def = metricsLibrary.getMetric(m.metricId);
    if (!def || def.domain !== 'vbc') throw err(422, 'unknown_metric', m.metricId);
    if (def.condition !== condition) {
      throw err(422, 'metric_condition_mismatch', `${m.metricId} is a ${def.condition} metric, not ${condition}`);
    }
    const weight = Number(m.weight);
    if (!Number.isFinite(weight) || weight <= 0) throw err(422, 'invalid_metric_weight', m.metricId);
    return { metricId: m.metricId, weight };
  });
}

function normaliseTiers(tiers, kindAllowed) {
  if (!Array.isArray(tiers)) return [];
  return tiers.map((t) => {
    const kind = t.kind === 'penalty' ? 'penalty' : 'bonus';
    const amount = Number(t.amount);
    if (!Number.isFinite(amount) || amount < 0) throw err(422, 'invalid_tier_amount');
    return {
      kind,
      minScore: t.minScore != null ? Number(t.minScore) : null,
      maxScore: t.maxScore != null ? Number(t.maxScore) : null,
      amount,
      currency: t.currency || 'GHS',
    };
  });
}

/** Validates + normalises the type-specific config. Throws 422 on anything malformed. */
function validateConfig(type, input = {}) {
  if (type === 'vbc') {
    const condition = input.condition;
    if (!metricsLibrary.CONDITIONS.some((c) => c.id === condition)) {
      throw err(422, 'invalid_condition', `must be one of ${metricsLibrary.CONDITIONS.map((c) => c.id).join(', ')}`);
    }
    return {
      condition,
      providers: Array.isArray(input.providers) ? input.providers : [],
      metrics: normaliseMetrics(input.metrics, condition),
      metricParams: input.metricParams || {},
      providerTiers: normaliseTiers(input.providerTiers),
      patientCashback: input.patientCashback && Number(input.patientCashback.amount) > 0
        ? {
          minScore: Number(input.patientCashback.minScore) || 0,
          amount: Number(input.patientCashback.amount),
          currency: input.patientCashback.currency || 'GHS',
        }
        : null,
    };
  }
  if (type === 'campaign') {
    if (!input.targetAction) throw err(422, 'targetAction_required');
    if (!input.startDate || !input.endDate) throw err(422, 'startDate_and_endDate_required');
    return {
      targetAction: String(input.targetAction),
      startDate: input.startDate,
      endDate: input.endDate,
      providers: Array.isArray(input.providers) ? input.providers : [],
      targetPopulationCount: input.targetPopulationCount != null ? Number(input.targetPopulationCount) : null,
      patientReward: input.patientReward && Number(input.patientReward.amount) > 0
        ? { amount: Number(input.patientReward.amount), currency: input.patientReward.currency || 'GHS' } : null,
      providerReward: input.providerReward && Number(input.providerReward.amount) > 0
        ? { amount: Number(input.providerReward.amount), currency: input.providerReward.currency || 'GHS' } : null,
    };
  }
  if (type === 'loyalty') {
    if (!input.qualifyingAction) throw err(422, 'qualifyingAction_required');
    if (!input.rewardPerAction || !(Number(input.rewardPerAction.amount) > 0)) {
      throw err(422, 'rewardPerAction_required');
    }
    return {
      qualifyingAction: String(input.qualifyingAction),
      partnerCategory: input.partnerCategory || 'wellness',
      providers: Array.isArray(input.providers) ? input.providers : [],
      rewardPerAction: { amount: Number(input.rewardPerAction.amount), currency: input.rewardPerAction.currency || 'GHS' },
      capPerPeriod: input.capPerPeriod && Number(input.capPerPeriod.amount) > 0
        ? { amount: Number(input.capPerPeriod.amount), periodDays: Number(input.capPerPeriod.periodDays) || 30 } : null,
    };
  }
  throw err(422, 'invalid_type', `must be one of ${TYPES.join(', ')}`);
}

async function create(payerId, input, actorId) {
  const payer = await store.payers.get(payerId);
  if (!payer) throw err(404, 'unknown_payer');
  if (!TYPES.includes(input.type)) throw err(422, 'invalid_type', `must be one of ${TYPES.join(', ')}`);
  if (!input.name || !input.name.trim()) throw err(422, 'name_required');

  const config = validateConfig(input.type, input.config || {});
  const now = new Date().toISOString();
  const product = {
    id: `prod_${input.type}_${rand()}`,
    type: input.type,
    name: input.name.trim(),
    description: input.description || '',
    payerId,
    payerName: payer.name,
    status: 'draft',
    config,
    createdAt: now, createdBy: actorId || null,
    updatedAt: now, updatedBy: actorId || null,
    publishedAt: null,
  };
  await store.products.save(product);
  return product;
}

async function update(id, input, actorId) {
  const product = await store.products.get(id);
  if (!product) throw err(404, 'unknown_product');
  if (input.name != null) product.name = String(input.name).trim() || product.name;
  if (input.description != null) product.description = String(input.description);
  if (input.config) product.config = validateConfig(product.type, { ...product.config, ...input.config });
  product.updatedAt = new Date().toISOString();
  product.updatedBy = actorId || null;
  await store.products.save(product);
  return product;
}

const VALID_TRANSITIONS = { draft: ['sandbox'], sandbox: ['draft', 'live'], live: ['sandbox'] };

async function setStatus(id, status, actorId) {
  const product = await store.products.get(id);
  if (!product) throw err(404, 'unknown_product');
  if (!STATUSES.includes(status)) throw err(422, 'invalid_status');
  if (status !== product.status && !(VALID_TRANSITIONS[product.status] || []).includes(status)) {
    throw err(422, 'invalid_transition', `cannot move from ${product.status} to ${status}`);
  }
  product.status = status;
  if (status === 'live' && !product.publishedAt) product.publishedAt = new Date().toISOString();
  product.updatedAt = new Date().toISOString();
  product.updatedBy = actorId || null;
  await store.products.save(product);
  return product;
}

async function get(id) {
  const p = await store.products.get(id);
  if (!p) throw err(404, 'unknown_product');
  return p;
}

// The products repo may be absent from the active store backend; degrade to an
// empty list rather than crashing read-only callers such as Master Control.
const all = async () => (store.products ? store.products.all() : []);
const listByPayer = async (payerId) => (store.products ? store.products.listByPayer(payerId) : []);

module.exports = {
  TYPES, STATUSES,
  create, update, setStatus, get, all, listByPayer,
  validateConfig, // exported for the smoke test
};
