'use strict';

const store = require('../store');

/**
 * SaaS revenue rules — programmable per tenant by an IT lead via the Admin console.
 *
 * IMPORTANT: the platform never custodies funds. Fees are therefore never skimmed
 * from a transfer. They are CALCULATED and ACCRUED against a named party
 * ("chargeTo") and posted to the append-only ledger as a receivable
 * (cashMovement: false). Collection happens separately — reverse-bill the insurer,
 * invoice the hospital, or bill the beneficiary entity (e.g. a pharmacy).
 *
 * Rule types
 *  - expedited_settlement : fee for instant A2A settlement. Basis = payer share.
 *  - discount_fee         : fee on the value of a discount granted to a patient.
 *  - claimit_margin       : margin on an NHIS/ClaimIt cashback refunded to a member.
 *  - report_fee_mini      : FLAT fee for a mini (micro) medical report.
 *  - report_fee_standard  : FLAT fee for a standard (detailed) medical report.
 *
 * Percentage rules use `rate` (capped); flat rules use `amount` in GHS.
 */

const RULE_TYPES = ['expedited_settlement', 'discount_fee', 'claimit_margin',
  'report_fee_mini', 'report_fee_standard'];

// Percentage rules vs flat-amount rules ("other charges").
const RULE_MODE = {
  expedited_settlement: 'percent', discount_fee: 'percent', claimit_margin: 'percent',
  report_fee_mini: 'flat', report_fee_standard: 'flat',
};

// Hard caps enforced server-side; the console cannot exceed these.
const CAPS = {
  expedited_settlement: 0.15, // up to 15%
  discount_fee: 0.15,         // up to 15%
  claimit_margin: 1.0,        // margin on the cashback amount (max 100% of cashback)
  report_fee_mini: null,      // flat fee — no percentage cap
  report_fee_standard: null,
};

// Who a fee may be charged to, per rule type.
const CHARGE_TARGETS = {
  expedited_settlement: ['insurer', 'provider', 'beneficiary'],
  discount_fee: ['insurer', 'provider', 'beneficiary'],
  claimit_margin: ['member', 'insurer', 'provider'],
  report_fee_mini: ['patient', 'provider', 'insurer', 'financier'],
  report_fee_standard: ['patient', 'provider', 'insurer', 'financier'],
};

const DEFAULTS = {
  expedited_settlement: { enabled: false, rate: 0, chargeTo: 'insurer', minFee: 0, maxFee: null },
  discount_fee: { enabled: false, rate: 0, chargeTo: 'provider', minFee: 0, maxFee: null,
    appliesTo: ['standard', 'referral', 'linked_payer'] },
  claimit_margin: { enabled: false, rate: 0, chargeTo: 'member', minFee: 0, maxFee: null },
  // Other charges — flat fees per medical report produced for a financing request.
  report_fee_mini: { enabled: false, mode: 'flat', amount: 0, chargeTo: 'patient' },
  report_fee_standard: { enabled: false, mode: 'flat', amount: 0, chargeTo: 'patient' },
};

/** Accept 0..1 or 0..100, clamp to the rule's cap. */
function normaliseRate(type, v) {
  const n = Number(v);
  if (Number.isNaN(n) || n < 0) return 0;
  const frac = n > 1 ? n / 100 : n;
  return Math.min(frac, CAPS[type]);
}

function validate(type, input = {}) {
  if (!RULE_TYPES.includes(type)) { const e = new Error('unknown_rule_type'); e.status = 422; throw e; }
  const targets = CHARGE_TARGETS[type];
  const chargeTo = input.chargeTo || DEFAULTS[type].chargeTo;
  if (!targets.includes(chargeTo)) {
    const e = new Error(`invalid_chargeTo (allowed: ${targets.join(', ')})`); e.status = 422; throw e;
  }
  if (RULE_MODE[type] === 'flat') {
    const amount = Math.max(0, Number(input.amount != null ? input.amount : DEFAULTS[type].amount) || 0);
    return {
      ...DEFAULTS[type], ...input, type, mode: 'flat', amount, chargeTo,
      enabled: input.enabled !== undefined ? !!input.enabled : DEFAULTS[type].enabled,
      updatedAt: new Date().toISOString(),
    };
  }
  const rate = normaliseRate(type, input.rate != null ? input.rate : DEFAULTS[type].rate);
  const rule = {
    ...DEFAULTS[type], ...input,
    type, mode: 'percent', rate, chargeTo,
    enabled: input.enabled !== undefined ? !!input.enabled : DEFAULTS[type].enabled,
    minFee: Number(input.minFee || 0),
    maxFee: input.maxFee == null || input.maxFee === '' ? null : Number(input.maxFee),
    capApplied: rate === CAPS[type],
    cap: CAPS[type],
    updatedAt: new Date().toISOString(),
  };
  return rule;
}

async function setRule(tenantId, type, input) {
  const rule = validate(type, input);
  rule.tenantId = tenantId;
  await store.pricing.save(rule);
  return rule;
}

async function getRule(tenantId, type) {
  const r = await store.pricing.get(tenantId, type);
  if (r) return r;
  return { ...DEFAULTS[type], type, tenantId, cap: CAPS[type], capApplied: false }; // effective default
}

async function listRules(tenantId) {
  const saved = await store.pricing.listByTenant(tenantId);
  const byType = Object.fromEntries(saved.map((r) => [r.type, r]));
  return RULE_TYPES.map((t) => byType[t] || { ...DEFAULTS[t], type: t, tenantId, cap: CAPS[t], capApplied: false });
}

/** Apply min/max bounds and round to 2dp. */
function bound(rule, amount) {
  let fee = amount;
  if (rule.minFee) fee = Math.max(fee, Number(rule.minFee));
  if (rule.maxFee != null) fee = Math.min(fee, Number(rule.maxFee));
  return Math.round(fee * 100) / 100;
}

/**
 * Compute a fee for a basis amount. Returns null when the rule is off or the
 * fee rounds to zero.
 */
function compute(rule, basis, meta = {}) {
  if (!rule || !rule.enabled) return null;
  if (RULE_MODE[rule.type] === 'flat') {
    const amt = Math.round((Number(rule.amount) || 0) * 100) / 100;
    if (amt <= 0) return null;
    return { type: rule.type, mode: 'flat', amount: amt, basis: null, chargeTo: rule.chargeTo, ...meta };
  }
  const b = Number(basis) || 0;
  if (b <= 0) return null;
  const fee = bound(rule, b * Number(rule.rate || 0));
  if (fee <= 0) return null;
  return {
    type: rule.type,
    rate: rule.rate,
    basis: Math.round(b * 100) / 100,
    amount: fee,
    chargeTo: rule.chargeTo,
    ...meta,
  };
}

module.exports = {
  RULE_TYPES, RULE_MODE, CAPS, CHARGE_TARGETS, DEFAULTS,
  setRule, getRule, listRules, compute, validate, normaliseRate,
};
