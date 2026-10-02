'use strict';

const crypto = require('crypto');
const store = require('../store');

/**
 * Claims automation — lets a low-risk claim clear WITHOUT a human clicking
 * "approve" (the SaaS-admin Submissions queue, services/submissions.js, or
 * the payer's own claimPortal.js) for every single one. Two independent,
 * per-payer opt-in triggers:
 *
 *   - amount threshold : claim.amount <= payer.autoAdjudication.thresholdMaxAmount
 *   - structured rule   : the bill's diagnosis + billed items match one of the
 *                         GLOBAL rules below (e.g. "uncomplicated malaria" +
 *                         Coartem), AND the claim is under THAT rule's own cap.
 *                         This is deliberately the ~25-30% "known, standard
 *                         combo" slice from the call -- NOT the ~80%
 *                         AI-assisted adjudication that was explicitly floated
 *                         as a later phase. There is no ML/confidence model
 *                         here, only an exact, auditable rule match.
 *
 * Both default OFF per payer, and the rule library starts with a single
 * INACTIVE example seeded from the call (malaria + Coartem) rather than a
 * real tariff this code invented -- HNN's own claims staff review the amount
 * and activate it (or add their own) once it matches their actual pricing.
 * A master switch (claims_automation.masterEnabled, default true) is an
 * emergency stop that overrides every payer's opt-in at once.
 *
 * This module only DECIDES; it never calls claims.authorize() itself (that
 * would be a circular require, since claims.js is this module's caller) --
 * see evaluate()'s doc comment for the shape callers act on.
 */

const KEY = 'claims_automation';

const EXAMPLE_RULE = {
  id: 'rule_example_malaria',
  diagnosisKeyword: 'malaria',
  requiredItemCodes: ['Coartem'],
  maxAmount: 250,
  active: false, // reviewable example, not a live rule -- see header comment
  note: 'Example from the product call (uncomplicated malaria). Review the amount against your own tariff, then activate.',
  createdAt: new Date(0).toISOString(),
};

function defaultPolicy() {
  return { masterEnabled: true, rules: [EXAMPLE_RULE], updatedAt: null, updatedBy: null };
}

async function getPolicy() {
  const saved = await store.settings.get(KEY);
  if (!saved) return defaultPolicy();
  return { masterEnabled: saved.masterEnabled !== false, rules: Array.isArray(saved.rules) ? saved.rules : [EXAMPLE_RULE],
    updatedAt: saved.updatedAt || null, updatedBy: saved.updatedBy || null };
}

async function setMasterEnabled(enabled, by = 'HNN') {
  const policy = await getPolicy();
  policy.masterEnabled = enabled !== false;
  policy.updatedAt = new Date().toISOString();
  policy.updatedBy = by;
  await store.settings.set(KEY, policy);
  return policy;
}

async function listRules() {
  return (await getPolicy()).rules;
}

function validateRuleInput(input = {}) {
  const diagnosisKeyword = String(input.diagnosisKeyword || '').trim();
  if (!diagnosisKeyword) { const e = new Error('diagnosisKeyword_required'); e.status = 422; throw e; }
  const maxAmount = input.maxAmount != null && input.maxAmount !== '' ? Number(input.maxAmount) : null;
  if (maxAmount != null && (!Number.isFinite(maxAmount) || maxAmount <= 0)) {
    const e = new Error('maxAmount_must_be_a_positive_number'); e.status = 422; throw e;
  }
  const requiredItemCodes = Array.isArray(input.requiredItemCodes)
    ? input.requiredItemCodes.map((s) => String(s).trim()).filter(Boolean)
    : String(input.requiredItemCodes || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { diagnosisKeyword, requiredItemCodes, maxAmount, note: input.note ? String(input.note).slice(0, 300) : null };
}

async function addRule(input, by = 'HNN') {
  const clean = validateRuleInput(input);
  const policy = await getPolicy();
  const rule = { id: `rule_${crypto.randomBytes(6).toString('hex')}`, ...clean, active: input.active === true,
    createdAt: new Date().toISOString(), createdBy: by };
  policy.rules = [...policy.rules, rule];
  policy.updatedAt = new Date().toISOString();
  policy.updatedBy = by;
  await store.settings.set(KEY, policy);
  return rule;
}

async function updateRule(id, patch = {}, by = 'HNN') {
  const policy = await getPolicy();
  const idx = policy.rules.findIndex((r) => r.id === id);
  if (idx === -1) { const e = new Error('rule_not_found'); e.status = 404; throw e; }
  const existing = policy.rules[idx];
  const next = { ...existing };
  if (patch.diagnosisKeyword !== undefined || patch.requiredItemCodes !== undefined || patch.maxAmount !== undefined) {
    const clean = validateRuleInput({ ...existing, ...patch });
    Object.assign(next, clean);
  }
  if (patch.active !== undefined) next.active = patch.active === true;
  if (patch.note !== undefined) next.note = patch.note ? String(patch.note).slice(0, 300) : null;
  next.updatedAt = new Date().toISOString();
  next.updatedBy = by;
  policy.rules = [...policy.rules.slice(0, idx), next, ...policy.rules.slice(idx + 1)];
  policy.updatedAt = new Date().toISOString();
  policy.updatedBy = by;
  await store.settings.set(KEY, policy);
  return next;
}

async function removeRule(id, by = 'HNN') {
  const policy = await getPolicy();
  const next = policy.rules.filter((r) => r.id !== id);
  if (next.length === policy.rules.length) { const e = new Error('rule_not_found'); e.status = 404; throw e; }
  policy.rules = next;
  policy.updatedAt = new Date().toISOString();
  policy.updatedBy = by;
  await store.settings.set(KEY, policy);
  return { removed: id };
}

const DEFAULT_PAYER_POLICY = { enabled: false, thresholdMaxAmount: null, useStructuredRules: false };

function payerPolicyOf(payer) {
  return { ...DEFAULT_PAYER_POLICY, ...(payer?.autoAdjudication || {}) };
}

async function setPayerPolicy(payerId, patch = {}, by = 'HNN') {
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('payer_not_found'); e.status = 404; throw e; }
  const current = payerPolicyOf(payer);
  const next = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  if (patch.useStructuredRules !== undefined) next.useStructuredRules = patch.useStructuredRules === true;
  if (patch.thresholdMaxAmount !== undefined) {
    const n = patch.thresholdMaxAmount === null || patch.thresholdMaxAmount === '' ? null : Number(patch.thresholdMaxAmount);
    if (n != null && (!Number.isFinite(n) || n <= 0)) { const e = new Error('thresholdMaxAmount_must_be_a_positive_number'); e.status = 422; throw e; }
    next.thresholdMaxAmount = n;
  }
  next.updatedAt = new Date().toISOString();
  next.updatedBy = by;
  payer.autoAdjudication = next;
  await store.payers.save(payer);
  return next;
}

function norm(s) { return String(s || '').trim().toLowerCase(); }

/** Does this bill's recorded diagnosis match the rule's keyword (substring, case-insensitive)? */
function diagnosisMatches(rule, bill) {
  const kw = norm(rule.diagnosisKeyword);
  if (!kw) return false;
  const hay = [bill?.clinical?.diagnosis, bill?.clinical?.diagnosisCode, bill?.clinical?.icdCode, bill?.clinical?.differentialDiagnosis]
    .filter(Boolean).map(norm).join(' ');
  return hay.includes(kw);
}

/** Are all of the rule's required item codes/names present among the bill's line items? */
function treatmentMatches(rule, bill) {
  const required = (rule.requiredItemCodes || []).map(norm).filter(Boolean);
  if (!required.length) return true;
  const present = (bill?.lineItems || []).flatMap((it) => [it.code, it.name].filter(Boolean).map(norm));
  return required.every((r) => present.some((p) => p === r || p.includes(r)));
}

/**
 * Pure decision function -- no side effects, never calls authorize(). Returns
 * { autoClear, method: 'amount_threshold'|'structured_rule'|null, ruleId }.
 * Callers (claims.js) are responsible for actually invoking authorize() and
 * tagging the claim when autoClear is true; a thrown/failed authorize() just
 * leaves the claim exactly where it would have landed without this module
 * (pending manual review) -- auto-clear is a fast path, never a new gate.
 */
async function evaluate(claim, bill) {
  const none = { autoClear: false, method: null, ruleId: null };
  const policy = await getPolicy();
  if (!policy.masterEnabled) return none;

  const payer = await store.payers.get(claim.payerId);
  if (!payer) return none;
  const payerPolicy = payerPolicyOf(payer);
  if (!payerPolicy.enabled) return none;

  const amount = Number(claim.amount) || 0;

  if (payerPolicy.thresholdMaxAmount != null && amount <= payerPolicy.thresholdMaxAmount) {
    return { autoClear: true, method: 'amount_threshold', ruleId: null };
  }

  if (payerPolicy.useStructuredRules) {
    for (const rule of policy.rules) {
      if (!rule.active) continue;
      if (rule.maxAmount != null && amount > rule.maxAmount) continue;
      if (diagnosisMatches(rule, bill) && treatmentMatches(rule, bill)) {
        return { autoClear: true, method: 'structured_rule', ruleId: rule.id };
      }
    }
  }
  return none;
}

module.exports = {
  KEY, getPolicy, setMasterEnabled, listRules, addRule, updateRule, removeRule,
  payerPolicyOf, setPayerPolicy, evaluate,
};
