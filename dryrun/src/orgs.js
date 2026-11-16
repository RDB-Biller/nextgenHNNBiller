'use strict';
const reg = require('./registry');
const plans = require('./plans');
const store = require('./store');
const { err, iso, id, sha, newKey } = require('./util');

const ROLES = ['admin', 'builder', 'approver', 'viewer'];
const CAN = {
  admin:    new Set(['read', 'write', 'run', 'promote', 'approve', 'team', 'settings']),
  builder:  new Set(['read', 'write', 'run', 'promote']),
  approver: new Set(['read', 'run', 'promote', 'approve']),
  viewer:   new Set(['read']),
};
const can = (role, action) => !!(CAN[role] && CAN[role].has(action));

const raw = (orgId) => { const o = reg.load().orgs[orgId]; if (!o) throw err(404, 'Unknown organisation.'); return o; };
function publicOrg(o) {
  const { members, salt, ...rest } = o;
  return { ...rest, storage: store.describe(o.storage), memberCount: Object.keys(members).length, status: plans.statusOf(o), daysLeft: plans.daysLeft(o), limits: plans.limitsFor(o), planLabel: plans.PLANS[o.plan].label };
}
const publicMember = (m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, phone: m.phone ? require('./messaging').mask(m.phone) : '', addedBy: m.addedBy || null, createdAt: m.createdAt, lastSeenAt: m.lastSeenAt || null });
const freeCount = () => Object.values(reg.load().orgs).filter((o) => plans.isFree(o) && !o.suspended).length;
function assertFreeRoom() { const cap = reg.load().config.caps.maxFreeOrgs; if (cap !== null && cap !== undefined && freeCount() >= cap) throw err(402, `The platform is capped at ${cap} free organisations. Raise the cap or switch one to paid first.`); }

function create({ name, sector = 'insurer', pack, pace = 'weeks', plan = 'free_trial', adminName, adminEmail, adminPhone, trialDays, storage } = {}, packs) {
  if (!name || !adminEmail) throw err(422, 'name and adminEmail are required.');
  if (adminPhone && !require('./messaging').validPhone(adminPhone)) throw err(422, 'The admin phone number does not look right. Use 024… or +233….');
  if (!plans.PLANS[plan]) throw err(422, `plan must be one of ${Object.keys(plans.PLANS).join(', ')}.`);
  if (!['days', 'weeks', 'months'].includes(pace)) throw err(422, 'pace must be days, weeks or months.');
  const packKey = pack || sector; if (!packs.get(packKey)) throw err(422, `Unknown pack "${packKey}".`);
  const r = reg.load();
  if (plan !== 'paid') assertFreeRoom();
  const orgId = id('org'), adminId = id('mem'), key = newKey('dr');
  const d = reg.load().config.defaults;
  const o = { id: orgId, name, sector, pack: packKey, pace, plan, createdAt: iso(), graceDays: d.graceDays, trialEndsAt: plan === 'paid' ? null : new Date(Date.now() + (trialDays || d.trialDays) * plans.DAY).toISOString(),
    suspended: false, storage: storage ? store.toConfig(storage) : { kind: 'platform' }, limitOverrides: {}, checklist: {}, salt: newKey('salt'),
    members: { [adminId]: { id: adminId, name: adminName || 'Admin', email: adminEmail, phone: adminPhone || '', role: 'admin', addedBy: 'platform owner', keyHash: sha(key), createdAt: iso() } } };
  r.orgs[orgId] = o; reg.save();
  return { org: publicOrg(o), admin: { ...publicMember(o.members[adminId]), apiKey: key, note: 'Shown once. Store it safely.' } };
}
function list() { return Object.values(reg.load().orgs).map(publicOrg); }
const get = (orgId) => publicOrg(raw(orgId));

/** Resolve a request's credentials. Returns {platform:true} or {org, member}. */
function authenticate(req) {
  const pk = req.get('x-platform-key');
  if (pk) { if (pk === (process.env.PLATFORM_ADMIN_KEY || 'platform_demo_key_123')) return { platform: true }; throw err(401, 'Invalid platform key.'); }
  const k = req.get('x-api-key'); if (!k) throw err(401, 'Send your key in x-api-key.');
  const h = sha(k);
  for (const o of Object.values(reg.load().orgs)) for (const m of Object.values(o.members)) if (m.keyHash === h) { if (!m.lastSeenAt || Date.now() - Date.parse(m.lastSeenAt) > 600000) { m.lastSeenAt = iso(); reg.save(); } return { org: o, member: m }; }
  throw err(401, 'Invalid key.');
}

// ---- team ----------------------------------------------------------------------------------------------------------------
function addMember(orgId, { name, email, phone, role = 'builder' } = {}, addedBy) {
  const o = raw(orgId); plans.assertWritable(o);
  if (!ROLES.includes(role)) throw err(422, `role must be one of ${ROLES.join(', ')}.`);
  if (!name || !email) throw err(422, 'name and email are required.');
  if (phone && !require('./messaging').validPhone(phone)) throw err(422, 'That phone number does not look right. Use 024… or +233….');
  if (Object.values(o.members).some((m) => m.email.toLowerCase() === String(email).toLowerCase())) throw err(409, 'That email is already on the team.');
  plans.assertRoom(o, 'members', Object.keys(o.members).length);
  const mid = id('mem'), key = newKey('dr');
  o.members[mid] = { id: mid, name, email, phone: phone || '', role, addedBy: addedBy || 'platform owner', keyHash: sha(key), createdAt: iso() }; reg.save();
  return { ...publicMember(o.members[mid]), apiKey: key, note: 'Shown once. Store it safely.' };
}
const memberRaw = (orgId, memberId) => { const m = raw(orgId).members[memberId]; if (!m) throw err(404, 'Unknown member.'); return m; };
function directory() { return Object.values(reg.load().orgs).map((o) => ({ id: o.id, name: o.name, pack: o.pack, plan: o.plan, status: plans.statusOf(o), members: Object.values(o.members).map(publicMember) })); }
function members(orgId) { return Object.values(raw(orgId).members).map(publicMember); }
function setRole(orgId, memberId, role) {
  const o = raw(orgId); plans.assertWritable(o); const m = o.members[memberId]; if (!m) throw err(404, 'Unknown member.');
  if (!ROLES.includes(role)) throw err(422, `role must be one of ${ROLES.join(', ')}.`);
  if (m.role === 'admin' && role !== 'admin' && Object.values(o.members).filter((x) => x.role === 'admin').length === 1) throw err(422, 'An organisation needs at least one admin.');
  m.role = role; reg.save(); return publicMember(m);
}
function removeMember(orgId, memberId) {
  const o = raw(orgId); plans.assertWritable(o); const m = o.members[memberId]; if (!m) throw err(404, 'Unknown member.');
  if (m.role === 'admin' && Object.values(o.members).filter((x) => x.role === 'admin').length === 1) throw err(422, 'An organisation needs at least one admin.');
  delete o.members[memberId]; reg.save(); return { removed: true };
}
function rotateKey(orgId, memberId) { const o = raw(orgId); const m = o.members[memberId]; if (!m) throw err(404, 'Unknown member.'); const key = newKey('dr'); m.keyHash = sha(key); reg.save(); return { id: m.id, apiKey: key, note: 'Shown once. The old key no longer works.' }; }

// ---- settings and plan -----------------------------------------------------------------------------------------------------
function settings(orgId, { name, pace } = {}) {
  const o = raw(orgId); plans.assertWritable(o);
  if (name) o.name = String(name);
  if (pace) { if (!['days', 'weeks', 'months'].includes(pace)) throw err(422, 'pace must be days, weeks or months.'); o.pace = pace; }
  reg.save(); return publicOrg(o);
}
function setRegulatoryRules(orgId, { maxDiscountPct, levels } = {}) {
  const o = raw(orgId); plans.assertWritable(o); const cur = o.regulatoryRules || {}; const L = require('./regulatory').DEFAULTS.levels;
  if (levels) for (const [k, v] of Object.entries(levels)) { if (!(k in L)) throw err(422, `Unknown rule "${k}".`); if (!['none', 'notify', 'regulator'].includes(v)) throw err(422, 'Each rule must be none, notify or regulator.'); }
  o.regulatoryRules = { maxDiscountPct: maxDiscountPct != null ? Number(maxDiscountPct) : cur.maxDiscountPct, levels: { ...(cur.levels || {}), ...(levels || {}) } }; reg.save(); return require('./regulatory').merge(o.regulatoryRules);
}
function setPlan(orgId, { plan, trialDays, extendDays, limitOverrides, suspended, graceDays } = {}) {
  const o = raw(orgId);
  if (plan) {
    if (!plans.PLANS[plan]) throw err(422, `plan must be one of ${Object.keys(plans.PLANS).join(', ')}.`);
    if (plan !== 'paid' && o.plan === 'paid') assertFreeRoom();
    o.plan = plan;
    if (plan === 'paid') o.trialEndsAt = null; else if (!o.trialEndsAt) o.trialEndsAt = new Date(Date.now() + (trialDays || reg.load().config.defaults.trialDays) * plans.DAY).toISOString();
  }
  if (extendDays) { if (o.plan === 'paid') throw err(422, 'A paid organisation has no trial to extend.'); const base = Math.max(Date.parse(o.trialEndsAt), Date.now()); o.trialEndsAt = new Date(base + Number(extendDays) * plans.DAY).toISOString(); if (o.plan === 'free_trial') o.plan = 'extended_trial'; }
  if (limitOverrides) o.limitOverrides = { ...o.limitOverrides, ...limitOverrides };
  if (graceDays !== undefined) o.graceDays = Number(graceDays);
  if (suspended !== undefined) o.suspended = !!suspended;
  reg.save(); return publicOrg(o);
}
const platformConfig = () => reg.load().config;
function setPlatformConfig({ maxFreeOrgs, trialDays, graceDays, partnerPlatformSharePct } = {}) {
  const c = reg.load().config;
  if (maxFreeOrgs !== undefined) c.caps.maxFreeOrgs = maxFreeOrgs === null ? null : Number(maxFreeOrgs);
  if (trialDays) c.defaults.trialDays = Number(trialDays);
  if (graceDays !== undefined) c.defaults.graceDays = Number(graceDays);
  if (partnerPlatformSharePct !== undefined) c.partnerPlatformSharePct = Number(partnerPlatformSharePct);
  reg.save(); return c;
}

/** Move the organisation's working data to a new location (our system, a client folder, a client Postgres). Can be done any time. */
async function setStorage(orgId, input) {
  const o = raw(orgId); plans.assertWritable(o);
  const toCfg = store.toConfig(input);
  const m = await store.migrate(orgId, o.storage, toCfg);
  const from = store.describe(o.storage);
  o.storage = toCfg; reg.save();
  await m.done();
  return { from, to: store.describe(toCfg), copied: m.report };
}
function tickChecklist(orgId, scenario, step, done) { const o = raw(orgId); o.checklist[scenario] = o.checklist[scenario] || {}; o.checklist[scenario][step] = !!done; reg.save(); return o.checklist[scenario]; }
const raws = raw;
module.exports = { setRegulatoryRules, memberRaw, directory, ROLES, can, create, list, get, raw: raws, authenticate, addMember, members, setRole, removeMember, rotateKey, settings, setPlan, platformConfig, setPlatformConfig, setStorage, tickChecklist };
