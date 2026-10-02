'use strict';

const crypto = require('crypto');
const store = require('../store');

/**
 * "Agnostic" payer slots — reserved, facility-programmable tabs.
 *
 * A facility's IT lead can stand up a new insurer or corporate payer themselves
 * (e.g. the hospital lands a new scheme) without us shipping a backend change.
 * Slots are SCOPED TO THAT FACILITY: a slot programmed by Euracare never appears
 * for Nyaho. They can be time-boxed with `expiresAt` for trials/pilots.
 *
 * Slot ids are deterministic: slot_<tenantId>_ins1 / slot_<tenantId>_corp2 …
 * Each programmed slot gets its own payer API key, so the new payer can integrate
 * immediately or just use the secure claim link.
 */

const SLOT_COUNTS = { insurer: 3, corporate: 3 };
const KINDS = Object.keys(SLOT_COUNTS);
const PREFIX = { insurer: 'ins', corporate: 'corp' };
// A corporate payer behaves as an employer on the settlement rail.
const PAYER_KIND = { insurer: 'insurer', corporate: 'employer' };

const slotId = (tenantId, kind, index) => `slot_${tenantId}_${PREFIX[kind]}${index}`;

function assertSlot(kind, index) {
  const i = Number(index);
  if (!KINDS.includes(kind)) { const e = new Error('unknown_slot_kind'); e.status = 422; throw e; }
  if (!Number.isInteger(i) || i < 1 || i > SLOT_COUNTS[kind]) {
    const e = new Error(`slot_index_out_of_range (1..${SLOT_COUNTS[kind]})`); e.status = 422; throw e;
  }
  return i;
}

function isExpired(p) {
  return !!(p?.expiresAt && new Date(p.expiresAt).getTime() < Date.now());
}

/** True when a slot payer is usable for routing right now. */
function isActive(p) {
  return !!p && p.enabled !== false && !isExpired(p);
}

/** All slots for a facility, programmed or empty, for the admin console. */
async function list(tenantId) {
  const existing = await store.payers.listSlots(tenantId);
  const byId = Object.fromEntries(existing.map((p) => [p.id, p]));
  const out = [];
  for (const kind of KINDS) {
    for (let i = 1; i <= SLOT_COUNTS[kind]; i++) {
      const id = slotId(tenantId, kind, i);
      const p = byId[id];
      out.push(p ? {
        id, kind, index: i, programmed: true,
        name: p.name, payerKind: p.kind, sourceAccount: p.sbg?.sourceAccount || null,
        contactEmail: p.contact?.email || null, apiKey: p.apiKey,
        enabled: p.enabled !== false, expiresAt: p.expiresAt || null,
        expired: isExpired(p), active: isActive(p), updatedAt: p.updatedAt || null,
      } : { id, kind, index: i, programmed: false, name: null, active: false });
    }
  }
  return out;
}

/** Program (or update) a slot. */
async function program(tenantId, kind, index, input = {}) {
  const i = assertSlot(kind, index);
  const name = String(input.name || '').trim();
  if (!name) { const e = new Error('name_required'); e.status = 422; throw e; }

  const id = slotId(tenantId, kind, i);
  const existing = await store.payers.get(id);
  const payer = {
    id,
    tenantId,                       // facility-scoped — this is what keeps slots private
    slot: { kind, index: i },
    provisional: true,              // programmed by a facility, not by the SaaS backend
    name,
    kind: PAYER_KIND[kind],
    apiKey: existing?.apiKey || `payer_${PREFIX[kind]}${i}_${crypto.randomBytes(5).toString('hex')}`,
    contact: { email: input.contactEmail || existing?.contact?.email || null },
    sbg: { sourceAccount: input.sourceAccount || existing?.sbg?.sourceAccount || null },
    enabled: input.enabled !== undefined ? !!input.enabled : true,
    expiresAt: input.expiresAt || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.payers.save(payer);
  return payer;
}

/** Release a slot so it can be reused (keeps history on past claims intact). */
async function release(tenantId, kind, index) {
  const i = assertSlot(kind, index);
  const id = slotId(tenantId, kind, i);
  const existing = await store.payers.get(id);
  if (!existing) return { id, released: true };
  existing.enabled = false;
  existing.releasedAt = new Date().toISOString();
  existing.updatedAt = existing.releasedAt;
  await store.payers.save(existing);
  return { id, released: true };
}

/** Payers a facility may route to: global ones plus its own active slots. */
async function routableFor(tenantId) {
  const all = await store.payers.listForTenant(tenantId);
  return all
    .filter((p) => (p.tenantId ? isActive(p) : p.enabled !== false))
    .map((p) => ({
      id: p.id, name: p.name, kind: p.kind,
      group: p.kind === 'employer' ? 'employer' : 'insurer',
      tracker: p.tracker || null,
      provisional: !!p.provisional,
      expiresAt: p.expiresAt || null,
    }))
    .sort((a, b) => Number(a.provisional) - Number(b.provisional) || a.name.localeCompare(b.name));
}

module.exports = { SLOT_COUNTS, KINDS, list, program, release, routableFor, isActive, isExpired, slotId };
