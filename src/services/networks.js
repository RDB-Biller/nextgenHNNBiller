'use strict';

const store = require('../store');

/**
 * NNEST — Narrow Network Expedited Settlement Terms.
 *
 * A feature of the expedited (instant) payment rail, operationalised by the PAYER.
 * An insurer or corporate payer designates a narrow network of providers and sets the
 * commercial terms on which those providers get paid instantly, instead of waiting on
 * the normal claims cycle.
 *
 * Terms are held per payer x provider pair:
 *   - settlement      : 'instant' (A2A on authorisation) or 'standard'
 *   - feeRate/chargeTo: the expedited-settlement fee for this pair (still capped at 15%
 *                       by the pricing engine) and who bears it
 *   - promptPaymentDiscountPercent : optional discount the provider grants in exchange
 *                       for instant cash. It reduces the amount transferred, and both the
 *                       gross claim and the net settled are recorded for audit.
 *   - maxClaimAmount  : optional per-claim ceiling for instant treatment
 *   - effectiveFrom / effectiveTo : term window
 *
 * A payer also has a network posture (held on the payer record):
 *   - networkMode: 'open' (default — anyone can be paid) or 'narrow' (terms drive behaviour)
 *   - outOfNetworkPolicy: 'standard' (settle, but not expedited) or 'block'
 */

const MAX_FEE_RATE = 0.15;          // mirrors the expedited_settlement cap
const MAX_PROMPT_DISCOUNT = 0.15;   // guard rail on provider-side discount

const round = (n) => Math.round(Number(n) * 100) / 100;
const pct = (v, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n > 1 ? n / 100 : n, max);
};

function withinWindow(t, now = Date.now()) {
  if (t.effectiveFrom && new Date(t.effectiveFrom).getTime() > now) return false;
  if (t.effectiveTo && new Date(t.effectiveTo).getTime() < now) return false;
  return true;
}

/** Are these terms live right now? */
function isActive(t) {
  return !!t && t.status === 'active' && withinWindow(t);
}

/** Payer-side: put a provider in the narrow network on agreed terms. */
async function setTerms(payerId, tenantId, input = {}) {
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('unknown_payer'); e.status = 404; throw e; }
  const tenant = await store.tenants.get(tenantId);
  if (!tenant) { const e = new Error('unknown_provider'); e.status = 404; throw e; }

  const existing = await store.networks.get(payerId, tenantId);
  const feeRate = pct(input.feeRate != null ? input.feeRate : existing?.feeRate, MAX_FEE_RATE);
  const discount = pct(
    input.promptPaymentDiscountPercent != null
      ? input.promptPaymentDiscountPercent : existing?.promptPaymentDiscountPercent,
    MAX_PROMPT_DISCOUNT);

  const chargeTo = input.chargeTo || existing?.chargeTo || 'insurer';
  if (!['insurer', 'provider', 'beneficiary'].includes(chargeTo)) {
    const e = new Error('invalid_chargeTo (insurer | provider | beneficiary)'); e.status = 422; throw e;
  }

  const terms = {
    payerId, tenantId,
    payerName: payer.name, providerName: tenant.name,
    status: input.status === 'suspended' ? 'suspended' : 'active',
    settlement: input.settlement === 'standard' ? 'standard' : 'instant',
    feeRate,
    feeRateCapped: feeRate === MAX_FEE_RATE,
    chargeTo,
    promptPaymentDiscountPercent: discount,
    maxClaimAmount: input.maxClaimAmount != null && input.maxClaimAmount !== ''
      ? Number(input.maxClaimAmount) : (existing?.maxClaimAmount ?? null),
    effectiveFrom: input.effectiveFrom || existing?.effectiveFrom || null,
    effectiveTo: input.effectiveTo || existing?.effectiveTo || null,
    note: input.note || existing?.note || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.networks.save(terms);
  return terms;
}

async function suspend(payerId, tenantId) {
  const t = await store.networks.get(payerId, tenantId);
  if (!t) { const e = new Error('terms_not_found'); e.status = 404; throw e; }
  t.status = 'suspended';
  t.updatedAt = new Date().toISOString();
  await store.networks.save(t);
  return t;
}

const listByPayer = (payerId) => store.networks.listByPayer(payerId);
const listByTenant = (tenantId) => store.networks.listByTenant(tenantId);

/**
 * Resolve how a claim should settle for this payer/provider pair.
 * Returns a decision the claim flow can act on and record.
 */
async function resolve(payer, tenantId, amount) {
  const mode = payer?.networkMode === 'narrow' ? 'narrow' : 'open';
  const policy = payer?.outOfNetworkPolicy === 'block' ? 'block' : 'standard';
  const terms = await store.networks.get(payer.id, tenantId);
  const active = isActive(terms);

  // In network, on live terms.
  if (active) {
    const overCap = terms.maxClaimAmount != null && Number(amount) > Number(terms.maxClaimAmount);
    if (terms.settlement === 'instant' && !overCap) {
      const discount = round(Number(amount) * terms.promptPaymentDiscountPercent);
      return {
        inNetwork: true, expedited: true, nnest: true,
        settlementAmount: round(Number(amount) - discount),
        grossAmount: round(Number(amount)),
        promptPaymentDiscount: discount,
        feeRate: terms.feeRate, chargeTo: terms.chargeTo,
        reason: 'nnest_terms',
        terms: { settlement: terms.settlement, feeRate: terms.feeRate, chargeTo: terms.chargeTo,
          promptPaymentDiscountPercent: terms.promptPaymentDiscountPercent, maxClaimAmount: terms.maxClaimAmount },
      };
    }
    return {
      inNetwork: true, expedited: false, nnest: true,
      settlementAmount: round(Number(amount)), grossAmount: round(Number(amount)), promptPaymentDiscount: 0,
      feeRate: null, chargeTo: null,
      reason: overCap ? 'above_nnest_claim_cap' : 'nnest_standard_terms',
    };
  }

  // Not in network (or terms suspended/expired).
  if (mode === 'narrow' && policy === 'block') {
    const e = new Error('out_of_network'); e.status = 403;
    e.detail = `${payer.name} settles only with providers in its narrow network.`;
    throw e;
  }
  return {
    inNetwork: false, expedited: mode !== 'narrow', nnest: false,
    settlementAmount: round(Number(amount)), grossAmount: round(Number(amount)), promptPaymentDiscount: 0,
    feeRate: null, chargeTo: null,
    reason: terms ? 'terms_inactive' : (mode === 'narrow' ? 'out_of_network' : 'open_network'),
  };
}

/** Payer posture (networkMode / outOfNetworkPolicy) lives on the payer record. */
async function setPosture(payerId, { networkMode, outOfNetworkPolicy } = {}) {
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('unknown_payer'); e.status = 404; throw e; }
  if (networkMode) payer.networkMode = networkMode === 'narrow' ? 'narrow' : 'open';
  if (outOfNetworkPolicy) payer.outOfNetworkPolicy = outOfNetworkPolicy === 'block' ? 'block' : 'standard';
  await store.payers.save(payer);
  return { payerId, networkMode: payer.networkMode || 'open', outOfNetworkPolicy: payer.outOfNetworkPolicy || 'standard' };
}

module.exports = {
  MAX_FEE_RATE, MAX_PROMPT_DISCOUNT,
  setTerms, suspend, listByPayer, listByTenant, resolve, setPosture, isActive,
};
