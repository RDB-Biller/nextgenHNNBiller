'use strict';

const store = require('./../store');
const editions = require('./editions');

/**
 * Platform-wide licensing policy, controlled by HNN (the SaaS owner).
 *
 * Two modes:
 *   free_non_commercial (default) : the platform is non-commercial and fee-free.
 *                                   Licences are issued/renewed at no charge, on a
 *                                   6-month term, purely to keep entitlement current.
 *   licensed                      : a licence is REQUIRED. HNN sets a licence fee per
 *                                   term; a client whose licence has lapsed is treated
 *                                   as non-commercial until renewed. This is the switch
 *                                   that turns licensing into revenue.
 *
 * Note this is the LICENCE fee (charged to the client organisation for using the
 * platform), separate from the per-transaction pricing rules — which are all set to
 * zero in this build.
 */

const KEY = 'licensing_policy';

const DEFAULT_POLICY = {
  mode: 'free_non_commercial',        // 'free_non_commercial' | 'licensed'
  requireLicense: false,              // when true, a live licence is required
  termMonths: editions.DEFAULT_TERM_MONTHS, // 6
  graceDays: 30,                      // window for unlicensed clients after switching to licensed
  licenseFee: 0,                      // fee per term when mode = 'licensed'
  currency: 'GHS',
  activatedAt: null,                  // when 'licensed' was switched on (grace clock start)
  updatedAt: null,
  updatedBy: null,
};

async function get() {
  const saved = await store.settings.get(KEY);
  return { ...DEFAULT_POLICY, ...(saved || {}) };
}

async function set(patch = {}, by = 'HNN') {
  const current = await get();
  const next = {
    ...current,
    ...('mode' in patch ? { mode: patch.mode === 'licensed' ? 'licensed' : 'free_non_commercial' } : {}),
    ...('termMonths' in patch ? { termMonths: Math.max(1, parseInt(patch.termMonths, 10) || current.termMonths) } : {}),
    ...('licenseFee' in patch ? { licenseFee: Math.max(0, Number(patch.licenseFee) || 0) } : {}),
    ...('currency' in patch ? { currency: patch.currency || current.currency } : {}),
    ...('graceDays' in patch ? { graceDays: Math.max(0, parseInt(patch.graceDays, 10) || 0) } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  };
  next.requireLicense = next.mode === 'licensed';
  if (next.mode === 'free_non_commercial') {
    next.licenseFee = 0;
    next.activatedAt = null;              // clear the grace clock when returning to free
  } else {
    // Start (or preserve) the grace window: unlicensed clients have graceDays from here.
    next.activatedAt = current.mode === 'licensed' && current.activatedAt
      ? current.activatedAt : new Date().toISOString();
  }
  await store.settings.set(KEY, next);
  return next;
}

/** When does the grace window for unlicensed clients end? null if not applicable. */
function graceEndsAt(policy) {
  if (policy.mode !== 'licensed' || !policy.activatedAt) return null;
  const d = new Date(policy.activatedAt);
  d.setDate(d.getDate() + (policy.graceDays ?? 30));
  return d.toISOString();
}

/**
 * Is a client allowed to operate right now under the current policy?
 * In free mode: always yes. In licensed mode: yes with a live licence, OR during the
 * one-off grace window for a client that has never held a licence (so switching on
 * licensing never cuts anyone off overnight).
 */
async function clientAllowed(tenant) {
  const policy = await get();
  if (!policy.requireLicense) return { allowed: true, policy };

  const state = editions.licenceState(tenant);
  if (state.active && state.expiresAt) return { allowed: true, policy, licence: state };

  // No licence yet (never redeemed): allow until the grace window closes.
  if (!state.expiresAt) {
    const graceEnd = graceEndsAt(policy);
    const inGrace = graceEnd ? Date.now() < new Date(graceEnd).getTime() : false;
    return { allowed: inGrace, policy, licence: state, grace: { endsAt: graceEnd, inGrace } };
  }

  // Had a licence, but it lapsed.
  return { allowed: false, policy, licence: state };
}

module.exports = { get, set, clientAllowed, graceEndsAt, DEFAULT_POLICY };
