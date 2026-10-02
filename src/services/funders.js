'use strict';

const crypto = require('crypto');
const store = require('../store');
const credentials = require('./credentials');

/**
 * TPA-style multi-funder disbursement -- the Ghana Medical Trust Fund example
 * from the call: a PAYER (acting as a third-party administrator) settles
 * claims on behalf of a FUNDER it doesn't otherwise own, and the funder needs
 * its own clean settlement record ("how much did you pay out of my fund this
 * period") separate from that payer's regular commercial book.
 *
 * A funder (store.funders) is deliberately simple: a name/kind/contact record
 * plus an OPTIONAL settlement account of its own -- same shape a payer's own
 * account already uses (settlementRail + encrypted settlementCredentials, see
 * services/settlement.js and services/credentials.js), so the exact same
 * rail-dispatch logic (including the always-simulated StubPayoutClient for
 * hubtel/momo) works unmodified for either one.
 *
 * Linking is one field on the payer: payer.tpaForFunderId. When set AND the
 * linked funder has its own settlementRail configured, services/settlement.js
 * disburses from the FUNDER's account instead of the payer's own, and tags
 * the result with funderId/funderName so claims.js and settlementBatches.js
 * can stamp it onto the claim for reconciliation (services/reconciliation.js).
 * When set but the funder has NO account of its own (the common case --
 * HNN has no real funder bank credentials today, same honesty as the
 * Hubtel/MoMo stub rails), the payer's own account still pays exactly as
 * before, and the only effect is attribution: every claim still gets tagged
 * with which fund it was settled on behalf of, for that fund's own report.
 * No link at all (the default for every existing payer) changes nothing.
 */

const KINDS = ['trust_fund', 'corporate', 'ngo', 'government', 'other'];

function defaultsFor(input = {}) {
  return {
    name: String(input.name || '').trim(),
    kind: KINDS.includes(input.kind) ? input.kind : 'trust_fund',
    contact: {
      name: input.contact?.name || null,
      email: input.contact?.email || null,
      phone: input.contact?.phone || null,
    },
    notes: input.notes ? String(input.notes).slice(0, 500) : null,
    active: input.active !== false,
  };
}

async function create(input = {}, by = 'HNN') {
  const clean = defaultsFor(input);
  if (!clean.name) { const e = new Error('name_required'); e.status = 422; throw e; }
  const funder = {
    id: `fnd_${crypto.randomBytes(6).toString('hex')}`,
    ...clean,
    settlementRail: null,            // no account of its own until setCredentials/setRail is called
    settlementCredentials: null,
    createdAt: new Date().toISOString(), createdBy: by,
    updatedAt: new Date().toISOString(), updatedBy: by,
  };
  await store.funders.save(funder);
  return mask(funder);
}

async function get(id) {
  return store.funders.get(id);
}

async function list() {
  const all = await store.funders.all();
  return all.map(mask);
}

async function update(id, patch = {}, by = 'HNN') {
  const funder = await store.funders.get(id);
  if (!funder) { const e = new Error('funder_not_found'); e.status = 404; throw e; }
  const clean = defaultsFor({ ...funder, ...patch, contact: { ...funder.contact, ...(patch.contact || {}) } });
  if (!clean.name) { const e = new Error('name_required'); e.status = 422; throw e; }
  Object.assign(funder, clean);
  funder.updatedAt = new Date().toISOString();
  funder.updatedBy = by;
  await store.funders.save(funder);
  return mask(funder);
}

/**
 * Give this funder its own disbursement account: same rail choices a payer
 * has (services/settlement.js#RAILS). Credentials are required only for the
 * 'stanbic' rail -- 'hubtel'/'momo' always simulate via StubPayoutClient and
 * need nothing stored. Passing rail: null clears the funder's own account
 * entirely, reverting any linked payer to attribution-only.
 */
async function setAccount(id, { rail, username, password } = {}, by = 'HNN') {
  const funder = await store.funders.get(id);
  if (!funder) { const e = new Error('funder_not_found'); e.status = 404; throw e; }
  const { RAILS } = require('./settlement');

  if (rail == null) {
    funder.settlementRail = null;
    funder.settlementCredentials = null;
  } else {
    if (!RAILS.includes(rail)) { const e = new Error(`invalid_rail (${RAILS.join(' | ')})`); e.status = 422; throw e; }
    funder.settlementRail = rail;
    if (rail === 'stanbic' && username && password) {
      funder.settlementCredentials = { encrypted: credentials.encrypt({ username, password }), hint: credentials.hint(password) };
    } else if (rail !== 'stanbic') {
      funder.settlementCredentials = null; // stub rails need no secret
    }
    // rail === 'stanbic' with no credentials supplied: keep whatever was saved before (editing the rail choice only).
  }
  funder.updatedAt = new Date().toISOString();
  funder.updatedBy = by;
  await store.funders.save(funder);
  return mask(funder);
}

/** Safe-to-return projection -- never includes the encrypted credential blob. */
function mask(funder) {
  return {
    id: funder.id, name: funder.name, kind: funder.kind, contact: funder.contact,
    notes: funder.notes, active: funder.active !== false,
    settlementRail: funder.settlementRail || null,
    hasOwnAccount: !!funder.settlementRail,
    credentialsConfigured: !!funder.settlementCredentials?.encrypted,
    credentialsHint: funder.settlementCredentials?.hint || null,
    createdAt: funder.createdAt, updatedAt: funder.updatedAt,
  };
}

/** Only funders with their own account configured and active -- see settlement.js#clientForPayer. */
async function ownAccountFunder(id) {
  if (!id) return null;
  const funder = await store.funders.get(id);
  if (!funder || funder.active === false || !funder.settlementRail) return null;
  return funder;
}

/** Link/unlink a payer to the funder it administers claims on behalf of. */
async function linkPayer(payerId, funderId, by = 'HNN') {
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('payer_not_found'); e.status = 404; throw e; }
  if (funderId) {
    const funder = await store.funders.get(funderId);
    if (!funder) { const e = new Error('funder_not_found'); e.status = 404; throw e; }
  }
  payer.tpaForFunderId = funderId || null;
  payer.tpaLinkedAt = funderId ? new Date().toISOString() : null;
  payer.tpaLinkedBy = funderId ? by : null;
  await store.payers.save(payer);
  return { payerId, tpaForFunderId: payer.tpaForFunderId };
}

/** Every payer currently administering claims on behalf of this funder. */
async function payersFor(funderId) {
  const all = await store.payers.all();
  return all.filter((p) => p.tpaForFunderId === funderId)
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
}

module.exports = { KINDS, create, get, list, update, setAccount, mask, ownAccountFunder, linkPayer, payersFor };
