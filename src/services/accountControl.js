'use strict';

const store = require('../store');

/**
 * One place for Master Control to see every kind of account and to switch it off or change what it may do.
 * The accounts themselves stay where they are (patients, partners, facilities, insurers, EMR/EHR providers, console users);
 * this adds a small control record beside each one:  acctctl:<kind>:<id> -> { disabled, reason, grants, note, updatedAt, updatedBy }.
 *
 * Disabled accounts are refused at sign-in and on every authenticated call (see the isDisabled checks in the auth code).
 * Grants are clearances Master Control can give or take back:
 *   productLab  may use Product Lab (briefs, products, solutions)
 *   goLive      may switch a rail from sandbox to live
 * Today both are enforced for console staff (platform_admin users); for other kinds they are recorded and ready to enforce.
 * Console staff keep both by default so nothing changes until Master Control narrows it. The env superkey is never restricted.
 */
const KINDS = {
  patient: { label: 'Patients and savers', grants: [] },
  partner: { label: 'ER HEAT partners', grants: [] },
  facility: { label: 'Hospitals and clinics (EMR/EHR clients)', grants: ['productLab', 'goLive'] },
  insurer: { label: 'Insurers and payers', grants: ['productLab', 'goLive'] },
  emr_provider: { label: 'EMR/EHR providers', grants: ['productLab', 'goLive'] },
  staff: { label: 'Console users and staff', grants: ['productLab', 'goLive'] },
};
const GRANTS = { productLab: 'Use Product Lab', goLive: 'Switch from sandbox to live' };
const keyOf = (kind, id) => `acctctl:${kind}:${id}`;
const err = (status, message) => { const e = new Error(message); e.status = status; return e; };
const now = () => new Date().toISOString();
const defaults = (kind) => ({ disabled: false, reason: '', grants: Object.fromEntries(KINDS[kind].grants.map((g) => [g, true])), note: '', updatedAt: null, updatedBy: null });

async function get(kind, id) { const s = await store.settings.get(keyOf(kind, id)); const d = defaults(kind); return s ? { ...d, ...s, grants: { ...d.grants, ...(s.grants || {}) } } : d; }
async function isDisabled(kind, id) { const s = await store.settings.get(keyOf(kind, id)); return !!(s && s.disabled); }
async function can(kind, id, grant) { return !!(await get(kind, id)).grants[grant]; }
async function set(kind, id, patch = {}, by = 'master') {
  if (!KINDS[kind]) throw err(422, `kind must be one of: ${Object.keys(KINDS).join(', ')}`);
  const cur = await get(kind, id); const next = { ...cur, grants: { ...cur.grants } };
  if (patch.disabled !== undefined) next.disabled = !!patch.disabled;
  if (patch.reason !== undefined) next.reason = String(patch.reason || '').slice(0, 200);
  if (!next.disabled) next.reason = patch.disabled === false ? '' : next.reason;
  if (patch.note !== undefined) next.note = String(patch.note || '').slice(0, 300);
  for (const [g, v] of Object.entries(patch.grants || {})) { if (!KINDS[kind].grants.includes(g)) throw err(422, `${KINDS[kind].label} do not have a "${g}" clearance.`); next.grants[g] = !!v; }
  next.updatedAt = now(); next.updatedBy = by; await store.settings.set(keyOf(kind, id), next); return next;
}

const fullName = (a) => [a.first_name, a.last_name].filter(Boolean).join(' ') || a.name || '';
async function all(kind) {
  const out = [];
  if (!kind || kind === 'patient') for (const k of await store.settings.keys('pacct:pt_')) { const a = await store.settings.get(k); if (a && a._id) out.push({ kind: 'patient', id: a._id, name: fullName(a), org: '', phone: a.phone || '', email: a.email || '', status: 'active', verified: !!a.phoneVerified || !!a.emailVerified, createdAt: a.createdAt || '', lastLoginAt: a.lastLoginAt || '' }); }
  if (!kind || kind === 'partner') for (const k of await store.settings.keys('partner:acct:')) { const a = await store.settings.get(k); if (a) out.push({ kind: 'partner', id: a._id, name: a.name, org: a.org || '', phone: a.contactPhone || '', email: String(a.handle || '').includes('@') ? a.handle : (a.email || ''), status: a.status, role: a.roleLabel || a.role || '', sector: a.sector, createdAt: a.createdAt || '', lastLoginAt: a.lastLoginAt || '' }); }
  if (!kind || kind === 'facility') for (const t of await store.tenants.all()) out.push({ kind: 'facility', id: t.id, name: t.name, org: '', phone: (t.contact || {}).phone || '', email: (t.contact || {}).email || '', status: 'active', edition: t.edition || '', createdAt: t.createdAt || '' });
  if (!kind || kind === 'insurer') for (const p of await store.payers.all()) out.push({ kind: 'insurer', id: p.id, name: p.name, org: p.kind || '', phone: (p.contact || {}).phone || '', email: (p.contact || {}).email || '', status: 'active', createdAt: p.createdAt || '' });
  if (!kind || kind === 'emr_provider') for (const p of await store.emrPartners.all()) out.push({ kind: 'emr_provider', id: p.id, name: p.name || p.id, org: '', phone: '', email: (p.contact || {}).email || p.email || '', status: 'active', createdAt: p.createdAt || '' });
  if (!kind || kind === 'staff') for (const u of await store.users.all()) out.push({ kind: 'staff', id: u.id, name: u.name || u.email || u.id, org: [u.orgType, u.orgId].filter(Boolean).join(': '), phone: u.phone || '', email: u.email || '', status: u.status || 'active', role: u.role || '', createdAt: u.createdAt || '' });
  return out;
}

/** The directory: every account, its state and its control record, filterable, newest first. */
async function directory({ kind, q, status, limit = 300 } = {}) {
  if (kind && !KINDS[kind]) throw err(422, 'Unknown account kind.');
  let rows = await all(kind);
  const counts = {}; for (const r of rows) { counts[r.kind] = counts[r.kind] || { total: 0, disabled: 0, pending: 0 }; counts[r.kind].total++; }
  for (const r of rows) { const c = await get(r.kind, r.id); r.disabled = c.disabled; r.reason = c.reason; r.grants = c.grants; r.note = c.note; if (c.disabled) counts[r.kind].disabled++; if (r.status === 'pending') counts[r.kind].pending++; r.state = c.disabled ? 'disabled' : r.status; }
  const needle = String(q || '').trim().toLowerCase();
  if (needle) rows = rows.filter((r) => [r.name, r.org, r.phone, r.email, r.id, r.role].some((v) => String(v || '').toLowerCase().includes(needle)));
  if (status) rows = rows.filter((r) => r.state === status);
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { kinds: Object.entries(KINDS).map(([key, k]) => ({ key, label: k.label, grants: k.grants, ...(counts[key] || { total: 0, disabled: 0, pending: 0 }) })), grants: GRANTS, total: rows.length, rows: rows.slice(0, Math.min(Number(limit) || 300, 1000)) };
}

async function exists(kind, id) {
  if (kind === 'patient') return !!(await store.settings.get(`pacct:${id}`));
  if (kind === 'partner') return !!(await store.settings.get(`partner:acct:${id}`));
  if (kind === 'facility') return !!(await store.tenants.get(id));
  if (kind === 'insurer') return !!(await store.payers.get(id));
  if (kind === 'emr_provider') return !!(await store.emrPartners.get(id));
  if (kind === 'staff') return !!(await store.users.get(id));
  return false;
}
async function update(kind, id, patch, by) { if (!KINDS[kind]) throw err(422, 'Unknown account kind.'); if (!(await exists(kind, id))) throw err(404, 'account_not_found'); return set(kind, id, patch, by); }

module.exports = { KINDS, GRANTS, get, set, update, isDisabled, can, directory };
