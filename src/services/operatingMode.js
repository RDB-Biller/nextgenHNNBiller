'use strict';

const store = require('../store');
const config = require('../config');

/**
 * Runtime sandbox/live control for the platform's two money/communication
 * rails — Settlement (Stanbic/SBG disbursements) and Messaging (SMS/WhatsApp)
 * — settable independently from Master Control, with NO redeploy needed.
 * Same store.settings singleton pattern as licensing.js/messagingAccount.js.
 *
 * This supersedes SBG_SANDBOX/MESSAGING_SANDBOX as the live, authoritative
 * switch: those env vars now only seed the STARTING default the first time
 * this is read with nothing saved yet (see get() below) — once Master Control
 * saves anything here, the DB record governs, independent of the env vars,
 * until the process restarts with no DB record (e.g. a fresh deploy/DB).
 * That's a deliberate change from how messaging's sandbox gate worked before
 * this file existed (env var as an absolute, un-overridable ceiling) — see
 * README "Operating mode" for why: a Master Control toggle that can't
 * actually flip sandbox/live at runtime isn't a toggle, and hybrid
 * combinations (e.g. Messaging live while Settlement stays sandboxed for
 * further testing) need the two rails independently switchable.
 *
 * Settlement is real bank money (Stanbic A2A disbursements) — switching it to
 * live requires the caller to pass confirm:'LIVE' in the same call (see
 * set() below); there's no equivalent friction for Messaging, which only
 * costs SMS/WhatsApp send fees.
 */

const KEY = 'operating_mode';

function envDefaults() {
  return { settlement: { sandbox: config.sandbox }, messaging: { sandbox: config.messaging.sandbox } };
}

async function get() {
  const saved = await store.settings.get(KEY);
  const defaults = envDefaults();
  if (!saved) return { ...defaults, updatedAt: null, updatedBy: null, seededFromEnv: true };
  return {
    settlement: { sandbox: saved.settlement?.sandbox !== undefined ? saved.settlement.sandbox : defaults.settlement.sandbox },
    messaging: { sandbox: saved.messaging?.sandbox !== undefined ? saved.messaging.sandbox : defaults.messaging.sandbox },
    updatedAt: saved.updatedAt || null, updatedBy: saved.updatedBy || null, seededFromEnv: false,
  };
}

/**
 * patch: { settlement?: { sandbox }, messaging?: { sandbox }, confirm? }.
 * Only the rail(s) actually included are changed; the other keeps whatever
 * it currently resolves to (saved value, or the env-var default if nothing
 * saved yet — see get()). Switching settlement.sandbox to false (live) must
 * be accompanied by confirm === 'LIVE', exactly, case-sensitive — this is
 * the one deliberate bit of friction on the one rail that moves real money.
 */
async function set(patch = {}, by = 'HNN') {
  const current = await get();
  const next = {
    settlement: { sandbox: current.settlement.sandbox },
    messaging: { sandbox: current.messaging.sandbox },
    updatedAt: new Date().toISOString(), updatedBy: by,
  };
  if (patch.settlement && 'sandbox' in patch.settlement) {
    const goingLive = patch.settlement.sandbox === false;
    if (goingLive && patch.confirm !== 'LIVE') {
      const e = new Error('confirmation_required');
      e.status = 422;
      e.detail = 'Switching Settlement to live moves real money through Stanbic. Resend with confirm:"LIVE" to proceed.';
      throw e;
    }
    next.settlement.sandbox = patch.settlement.sandbox === true;
  }
  if (patch.messaging && 'sandbox' in patch.messaging) {
    next.messaging.sandbox = patch.messaging.sandbox === true;
  }
  await store.settings.set(KEY, next);
  return { ...next, seededFromEnv: false };
}

async function isSettlementSandbox() { return (await get()).settlement.sandbox; }
async function isMessagingSandbox() { return (await get()).messaging.sandbox; }

module.exports = { get, set, isSettlementSandbox, isMessagingSandbox, envDefaults, KEY };
