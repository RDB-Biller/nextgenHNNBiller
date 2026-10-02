'use strict';

const store = require('../store');
const credentials = require('./credentials');

/**
 * The platform's own shared SMS/WhatsApp provider account — one set of real
 * credentials HNN can turn on for live testing and off again when done,
 * without touching any client's own setup. Exact same singleton-settings
 * pattern as services/licensing.js (store.settings, one row, zero schema
 * migration): there's nothing tenant-specific here, so it doesn't belong on
 * a tenant record.
 *
 * This is deliberately separate from a client's own "bring your own
 * credentials" setup (tenant.messagingCredentials, set the same way but per
 * tenant — see routes/platform.js). Resolution order lives in
 * messaging.js#resolveSender: a tenant's own credentials first, then this
 * account if `active`, then sandbox. Flipping `active` off here immediately
 * reverts every tenant that hasn't configured its own provider back to
 * sandbox (log-only) — the "deactivate when testing is over" switch — with
 * no redeploy and no env var change.
 */

const KEY = 'messaging_test_account';

const DEFAULT = {
  provider: null,       // 'twilio' | 'africastalking' | 'hubtel' | null
  encrypted: null,       // credentials.encrypt({...}) blob, or null if never configured
  hint: null,            // last-4 display hint — see credentials.hint()
  active: false,         // the activate/deactivate switch
  updatedAt: null,
  updatedBy: null,
};

async function get() {
  const saved = await store.settings.get(KEY);
  return { ...DEFAULT, ...(saved || {}) };
}

/** Safe-to-return projection — never includes the encrypted blob or decrypted secret. */
function mask(rec) {
  return {
    provider: rec.provider || null,
    configured: !!rec.encrypted,
    hint: rec.hint || null,
    active: !!rec.active,
    updatedAt: rec.updatedAt || null,
  };
}

/**
 * patch: { provider?, credentials?: {...raw provider fields...}, active? }.
 * Passing `credentials` re-encrypts and replaces whatever was stored before.
 * Omit it to change only `active` (e.g. the deactivate-when-done toggle)
 * without having to resupply the secret.
 */
async function set(patch = {}, by = 'HNN') {
  const current = await get();
  const next = { ...current, updatedAt: new Date().toISOString(), updatedBy: by };
  if ('provider' in patch) next.provider = patch.provider || null;
  // Switching to a different provider without supplying its credentials in
  // the same call would otherwise leave the OLD provider's encrypted blob in
  // place under the NEW provider's name — safe (the adapter would just see
  // the wrong shape and fail cleanly) but misleading in the UI, which would
  // show "configured" with a hint for a secret that isn't this provider's.
  // Clear it so re-entry is required instead.
  if ('provider' in patch && patch.provider !== current.provider && !patch.credentials) {
    next.encrypted = null;
    next.hint = null;
  }
  if (patch.credentials && Object.keys(patch.credentials).length) {
    next.encrypted = credentials.encrypt(patch.credentials);
    const secretField = patch.credentials.authToken || patch.credentials.apiKey
      || patch.credentials.clientSecret || '';
    next.hint = credentials.hint(secretField);
  }
  if ('active' in patch) next.active = patch.active === true;
  if (next.active && (!next.encrypted || !next.provider)) {
    const e = new Error('no_credentials_configured');
    e.status = 422;
    throw e;
  }
  await store.settings.set(KEY, next);
  return next;
}

/** Decrypted { provider, creds } for messaging.js to send with, or null if not usable right now. */
async function resolve() {
  const rec = await get();
  if (!rec.active || !rec.encrypted || !rec.provider) return null;
  return { provider: rec.provider, creds: credentials.decrypt(rec.encrypted) };
}

module.exports = { get, set, mask, resolve, KEY };
