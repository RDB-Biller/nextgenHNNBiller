'use strict';

const crypto = require('crypto');
const store = require('../store');

/**
 * Console users — the IT leads we assign to each organisation, plus platform admins.
 *
 * Roles
 *   platform_admin     : master control board (all clients, licences, users)
 *   it_lead_facility   : configures one hospital/clinic/pharmacy (revenue rules, payer slots)
 *   it_lead_payer      : configures one insurer / corporate payer
 *   it_lead_emr        : an EMR/EHR vendor's technical lead (integration + their clinics)
 *
 * Each user gets a personal console key (`x-console-key`), scoped to their org — an
 * IT lead can only ever configure their own organisation.
 */

const ROLES = ['platform_admin', 'it_lead_facility', 'it_lead_payer', 'it_lead_emr'];
const ORG_TYPE_FOR_ROLE = {
  platform_admin: null,
  it_lead_facility: 'tenant',
  it_lead_payer: 'payer',
  it_lead_emr: 'emr',
};

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 20);

function newKey(role) {
  const tag = role === 'platform_admin' ? 'plat' : 'lead';
  return `${tag}_${crypto.randomBytes(12).toString('hex')}`;
}

async function create({ name, email, role, orgId = null, createdBy = null }) {
  if (!ROLES.includes(role)) { const e = new Error('unknown_role'); e.status = 422; throw e; }
  if (!name) { const e = new Error('name_required'); e.status = 422; throw e; }
  const orgType = ORG_TYPE_FOR_ROLE[role];
  if (orgType && !orgId) { const e = new Error('orgId_required_for_role'); e.status = 422; throw e; }

  const user = {
    id: `usr_${slug(name)}_${crypto.randomBytes(3).toString('hex')}`,
    name, email: email || null, role, orgType, orgId,
    apiKey: newKey(role),
    status: 'active',
    createdBy, createdAt: new Date().toISOString(),
  };
  await store.users.save(user);
  return user;
}

async function setStatus(id, status) {
  const u = await store.users.get(id);
  if (!u) { const e = new Error('user_not_found'); e.status = 404; throw e; }
  u.status = status === 'active' ? 'active' : 'suspended';
  u.updatedAt = new Date().toISOString();
  await store.users.save(u);
  return u;
}

async function rotateKey(id) {
  const u = await store.users.get(id);
  if (!u) { const e = new Error('user_not_found'); e.status = 404; throw e; }
  u.apiKey = newKey(u.role);
  u.keyRotatedAt = new Date().toISOString();
  await store.users.save(u);
  return u;
}

const publicView = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  orgType: u.orgType, orgId: u.orgId, status: u.status,
  apiKey: u.apiKey, createdAt: u.createdAt, keyRotatedAt: u.keyRotatedAt || null,
});

async function list() { return (await store.users.all()).map(publicView); }

module.exports = { ROLES, create, setStatus, rotateKey, list, publicView };
