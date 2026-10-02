'use strict';

/**
 * Public trial sign-ups — the landing page a campaign's "YES" reply links to
 * (register.html / routes/registerPortal.js), also reachable directly. Pure
 * lead capture: submitting here never creates a tenant/API key by itself —
 * an HNN admin reviews the queue in Master Control and, if it's a good fit,
 * creates the client the normal way (Master Control's existing "Add a
 * client" form). Keeping those two steps separate means a fully public,
 * unauthenticated form can never hand out platform access on its own.
 */
const crypto = require('crypto');
const store = require('../store');
const messaging = require('./messaging');

const ORG_TYPES = ['hospital', 'pharmacy', 'other'];
const STATUSES = ['new', 'contacted', 'approved', 'declined'];

const rand = () => crypto.randomBytes(5).toString('hex');

function err(status, message) { const e = new Error(message); e.status = status; return e; }

/** Body: { orgName, orgType, contactName, phone, email?, region?, notes?, source? }. */
async function submit(body = {}) {
  const orgName = String(body.orgName || '').trim();
  const orgType = ORG_TYPES.includes(body.orgType) ? body.orgType : null;
  const contactName = String(body.contactName || '').trim();
  const phone = String(body.phone || '').trim();
  if (!orgName) throw err(422, 'org_name_required');
  if (!orgType) throw err(422, 'org_type_must_be_hospital_pharmacy_or_other');
  if (!contactName) throw err(422, 'contact_name_required');
  if (!phone) throw err(422, 'phone_required');

  const reg = {
    id: `reg_${rand()}`,
    orgName, orgType, contactName,
    phone, phoneNormalized: messaging.normalizePhone(phone),
    email: String(body.email || '').trim() || null,
    region: String(body.region || '').trim() || null,
    notes: String(body.notes || '').trim() || null,
    source: body.source === 'campaign' ? 'campaign' : 'direct',
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  await store.trialRegistrations.insert(reg);
  return reg;
}

async function list() { return store.trialRegistrations.all(); }
async function get(id) { return store.trialRegistrations.get(id); }

async function setStatus(id, status, by) {
  if (!STATUSES.includes(status)) throw err(422, 'invalid_status');
  const reg = await store.trialRegistrations.get(id);
  if (!reg) throw err(404, 'registration_not_found');
  reg.status = status;
  reg.statusUpdatedAt = new Date().toISOString();
  reg.statusUpdatedBy = by || 'HNN';
  await store.trialRegistrations.update(reg);
  return reg;
}

module.exports = { ORG_TYPES, STATUSES, submit, list, get, setStatus };
