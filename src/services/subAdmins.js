'use strict';

const crypto = require('crypto');
const store = require('../store');
const messaging = require('./messaging');
const config = require('../config');

/**
 * Sub-admins: people the chief administrator (the PLATFORM_ADMIN_KEY holder) lets into parts of Master Control.
 * The chief invites someone, chooses what they may open (areas) and whether they may only look (readOnly). The person opens the
 * invite link and chooses their own password. There is no shared key and no default password. Sessions are signed 12 hour tokens.
 * A sub-admin can never reach admin management, user creation or the areas they were not given, whatever page they use:
 * the check is on the server (see access.js) against AREA_PATHS.
 *
 * Storage (settings store):  admin:acct:<id>   admin:login:<handle> -> { id }   admin:invite:<token> -> { id, exp }
 */
const TTL_MS = 12 * 3600 * 1000; const DEMO_TTL_MS = 3 * 3600 * 1000; const INVITE_MS = 7 * 86400 * 1000;
const err = (status, message) => { const e = new Error(message); e.status = status; return e; };
const now = () => new Date().toISOString();
const b64 = (b) => Buffer.from(b).toString('base64url');
const dial = (p) => messaging.toDialable(String(p || '').replace(/[\s().-]/g, ''));
const validPhone = (p) => /^\+\d{8,15}$/.test(p);
const base = () => String(config.messaging.publicBaseUrl || '').replace(/\/$/, '');

// What each area opens. Paths are the first segment under /api/platform. Anything not listed here is for the chief only.
const AREAS = {
  clients: { label: 'Clients, IT leads and targets', paths: ['clients', 'trial-registrations', 'targets', 'metrics-library'] },
  payers: { label: 'Payers, funders, EMR partners and InsureCredit', paths: ['payers', 'funders', 'emr-partners', 'insurecredit'] },
  messaging: { label: 'Messaging, campaigns, outreach and languages', paths: ['messaging', 'sms', 'campaigns', 'outreach', 'i18n'] },
  product_lab: { label: 'Product Lab and solutions', paths: ['products', 'solutions'] },
  claims: { label: 'Claims, pricing, reconciliation and savings', paths: ['submissions', 'claims-automation', 'claim-expiry', 'ai-adjudication', 'pharmacy-quotes', 'pharmacy-pricing', 'reconciliation', 'savings'] },
  finance: { label: 'Revenue, settlement and licences', paths: ['revenue', 'settlement-batches', 'licenses', 'licensing', 'currencies'] },
  operating_mode: { label: 'Switch sandbox and live', paths: ['operating-mode'] },
  partners: { label: 'ER HEAT partners, loans and sign-up rules', paths: ['partners', 'erheat', 'patient-auth'] },
  accounts: { label: 'Account directory (deactivate, approve sign-ups)', paths: ['accounts'] },
};
const ALWAYS = ['overview', 'me'];
// What a demo or evaluator login may look at. Product Lab, finance, switching sandbox/live, partner and account management are never part of the tour.
const DEMO_AREAS = ['clients', 'payers', 'messaging', 'claims'];
const DEMO = { handle: 'demo@hnn-demo.example', password: 'HNN-demo-2026', name: 'HNN Demo' };
const PRESETS = {
  partner_manager: { label: 'Partner manager', areas: ['partners', 'accounts'] },
  support: { label: 'Support', areas: ['clients', 'accounts'] },
  messaging_manager: { label: 'Messaging manager', areas: ['messaging'] },
  finance_officer: { label: 'Finance officer', areas: ['finance', 'payers'] },
  claims_officer: { label: 'Claims officer', areas: ['claims', 'payers'] },
  product_lead: { label: 'Product lead', areas: ['product_lab'] },
  evaluator: { label: 'Evaluator (demo experience)', areas: DEMO_AREAS, sandboxed: true },
  custom: { label: 'Custom', areas: [] },
};
const areaOfPath = (seg) => { if (ALWAYS.includes(seg)) return 'always'; for (const [k, a] of Object.entries(AREAS)) if (a.paths.includes(seg)) return k; return null; };

const keyOf = (id) => `admin:acct:${id}`; const loginKey = (h) => `admin:login:${h}`; const inviteKey = (t) => `admin:invite:${t}`;
function handleOf(raw) { const s = String(raw || '').trim(); if (s.includes('@')) { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw err(422, 'Enter a valid email address or phone number.'); return s.toLowerCase(); } const p = dial(s); if (!validPhone(p)) throw err(422, 'Enter a valid email address or phone number.'); return p; }
const byId = (id) => (id ? store.settings.get(keyOf(id)) : null);
const save = (a) => store.settings.set(keyOf(a._id), a);
async function byHandle(raw) { let h; try { h = handleOf(raw); } catch (_e) { return null; } const i = await store.settings.get(loginKey(h)); return i ? byId(i.id) : null; }
function hash(pw) { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`; }
function check(pw, stored) { const [alg, salt, h] = String(stored || '').split('$'); if (alg !== 'scrypt') return false; const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64); const want = Buffer.from(h, 'hex'); return got.length === want.length && crypto.timingSafeEqual(got, want); }
async function secret() {
  if (process.env.ADMIN_TOKEN_SECRET) return process.env.ADMIN_TOKEN_SECRET;
  let s = await store.settings.get('admin_secret'); if (!s) { s = { value: crypto.randomBytes(32).toString('hex'), at: now() }; await store.settings.set('admin_secret', s); } return s.value;
}
async function sign(p) { const body = b64(JSON.stringify(p)); return `${body}.${crypto.createHmac('sha256', await secret()).update(body).digest('base64url')}`; }
async function unsign(t) {
  const [body, mac] = String(t || '').split('.'); if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', await secret()).update(body).digest('base64url'); const a = Buffer.from(mac); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (_e) { return null; }
}

const view = (a) => ({ id: a._id, name: a.name, handle: a.handle, email: a.email || '', phone: a.phone || '', preset: a.preset, presetLabel: (PRESETS[a.preset] || {}).label || 'Custom', areas: a.areas, areaLabels: a.areas.map((k) => (AREAS[k] || {}).label || k), readOnly: !!a.readOnly, sandboxed: !!a.sandboxed, demo: !!a.demo, status: a.status, createdAt: a.createdAt, lastLoginAt: a.lastLoginAt || null });
function cleanAreas(list) { const out = []; for (const k of Array.isArray(list) ? list : []) { if (!AREAS[k]) throw err(422, `Unknown area: ${k}`); if (!out.includes(k)) out.push(k); } return out; }

// ---------------------------------------------------------------- chief
async function invite(b = {}, by = 'chief') {
  const name = String(b.name || '').trim().slice(0, 100); if (!name) throw err(422, 'Enter the person\'s name.');
  const email = b.email ? handleOf(b.email) : ''; const phone = b.phone ? handleOf(b.phone) : '';
  if ((email && !email.includes('@')) || (phone && phone.includes('@'))) throw err(422, 'Check the email address and phone number.');
  const handle = email || phone; if (!handle) throw err(422, 'Enter an email address or a mobile number to sign in with.');
  for (const h of [email, phone].filter(Boolean)) if (await store.settings.get(loginKey(h))) throw err(409, 'That email or phone number already has an admin login.');
  const preset = PRESETS[b.preset] ? b.preset : 'custom'; const areas = cleanAreas(b.areas && b.areas.length ? b.areas : PRESETS[preset].areas);
  if (!areas.length) throw err(422, 'Choose at least one area.');
  const a = { _id: `adm_${crypto.randomBytes(8).toString('hex')}`, name, handle, email, phone, preset, areas, readOnly: !!b.readOnly, sandboxed: !!(PRESETS[preset].sandboxed || b.sandboxed), status: 'invited', passwordHash: null, pv: 1, createdAt: now(), createdBy: by };
  for (const h of [email, phone].filter(Boolean)) await store.settings.set(loginKey(h), { id: a._id });
  await save(a); return issueInvite(a, !!b.sendSms);
}
async function issueInvite(a, sendSms) {
  const t = crypto.randomBytes(24).toString('base64url'); await store.settings.set(inviteKey(t), { id: a._id, exp: Date.now() + INVITE_MS });
  const link = `${base()}/app/platform.html#invite=${t}`; let sms = null;
  if (sendSms && a.phone) { try { sms = await messaging.send({ channel: 'sms', to: a.phone, body: `HNN Master Control: you have been given access. Open ${link} and choose your own password. The link works for 7 days.` }); } catch (_e) { sms = { ok: false }; } }
  return { account: view(a), inviteLink: link, expiresInDays: 7, sms: sms ? { ok: !!sms.ok, sandbox: !!sms.sandbox } : null };
}
async function list() { const out = []; for (const k of await store.settings.keys('admin:acct:')) { const a = await store.settings.get(k); if (a) out.push(view(a)); } return out.sort((x, y) => y.createdAt.localeCompare(x.createdAt)); }
async function must(id) { const a = await byId(id); if (!a) throw err(404, 'admin_not_found'); return a; }
async function update(id, b = {}) {
  const a = await must(id);
  if (b.name !== undefined) { a.name = String(b.name).trim().slice(0, 100); if (!a.name) throw err(422, 'Enter the person\'s name.'); }
  if (b.preset !== undefined) { if (!PRESETS[b.preset]) throw err(422, 'Unknown preset.'); a.preset = b.preset; if (b.areas === undefined && b.preset !== 'custom') a.areas = PRESETS[b.preset].areas.slice(); }
  if (b.areas !== undefined) { a.areas = cleanAreas(b.areas); if (!a.areas.length) throw err(422, 'Choose at least one area.'); }
  if (b.readOnly !== undefined) a.readOnly = !!b.readOnly;
  if (b.sandboxed !== undefined && !a.demo) a.sandboxed = !!b.sandboxed;
  if (b.status !== undefined) { if (!['active', 'suspended'].includes(b.status) || a.status === 'invited') throw err(422, a.status === 'invited' ? 'They have not accepted the invite yet.' : 'Status must be active or suspended.'); if (b.status !== a.status) a.pv += 1; a.status = b.status; }
  await save(a); return view(a);
}
async function reinvite(id, sendSms) { const a = await must(id); a.passwordHash = null; a.status = 'invited'; a.pv += 1; await save(a); return issueInvite(a, !!sendSms); }
async function remove(id) { const a = await must(id); for (const h of [a.email, a.phone, a.handle].filter(Boolean)) await store.settings.set(loginKey(h), null); a.status = 'removed'; a.pv += 1; a.handle = `removed:${a._id}`; await save(a); return { ok: true }; }

// ---------------------------------------------------------------- the person
async function acceptInvite({ token, password } = {}) {
  const inv = await store.settings.get(inviteKey(String(token || ''))); if (!inv || inv.exp < Date.now()) throw err(410, 'This invite link has expired. Ask the chief administrator for a new one.');
  if (String(password || '').length < 10) throw err(422, 'Choose a password of at least 10 characters.');
  const a = await byId(inv.id); if (!a || a.status === 'removed') throw err(410, 'This invite is no longer valid.');
  a.passwordHash = hash(password); a.status = 'active'; a.pv += 1; a.lastLoginAt = now(); await save(a); await store.settings.set(inviteKey(token), { id: a._id, exp: 0 });
  return { token: await sign({ sub: a._id, pv: a.pv, exp: Date.now() + TTL_MS }), account: view(a) };
}
const fails = new Map();
async function login({ handle, password } = {}) {
  const hk = String(handle || '').trim().toLowerCase(); const f = (fails.get(hk) || []).filter((t) => Date.now() - t < 15 * 60000);
  if (f.length >= 6) throw err(429, 'Too many tries. Wait 15 minutes, or ask the chief administrator for a new invite.');
  if (String(handle || '').trim().toLowerCase() === DEMO.handle) { if (!(await demoConfig()).enabled) throw err(403, 'The demo login is switched off.'); await ensureDemo(); }
  const a = await byHandle(handle);
  if (!a || !a.passwordHash || !check(password, a.passwordHash)) { f.push(Date.now()); fails.set(hk, f); throw err(401, 'Incorrect login or password.'); }
  if (a.status !== 'active' || (await require('./accountControl').isDisabled('subadmin', a._id))) throw err(403, 'This login is not active. Contact the chief administrator.');
  fails.delete(hk); a.lastLoginAt = now(); await save(a);
  return { token: await sign({ sub: a._id, pv: a.pv, exp: Date.now() + (a.demo ? DEMO_TTL_MS : TTL_MS) }), account: view(a) };
}
async function authenticate(header) {
  const m = /^Bearer\s+(.+)$/i.exec(header || ''); const p = m && await unsign(m[1]); const a = p && await byId(p.sub);
  if (!a || a.pv !== p.pv || a.status !== 'active' || (await require('./accountControl').isDisabled('subadmin', a._id))) throw err(401, 'Please sign in again.');
  if (a.demo && !(await demoConfig()).enabled) throw err(401, 'The demo login is switched off.');
  return a;
}
async function changePassword(a, { current, password } = {}) {
  if (!check(current, a.passwordHash)) throw err(401, 'Your current password is not right.');
  if (String(password || '').length < 10) throw err(422, 'Your new password needs at least 10 characters.');
  a.passwordHash = hash(password); a.pv += 1; await save(a);
  return { token: await sign({ sub: a._id, pv: a.pv, exp: Date.now() + TTL_MS }), account: view(a) };
}
// ---------------------------------------------------------------- the public demo login
// Anyone may use these dummy credentials. The account is sandboxed (see demoGuard.js): it saves nothing and sees no secrets or contact details.
async function demoConfig() { const c = await store.settings.get('admin:demo:cfg'); return { enabled: c ? c.enabled !== false : true }; }
async function setDemoEnabled(on) { await store.settings.set('admin:demo:cfg', { enabled: !!on, at: now() }); return demoConfig(); }
async function ensureDemo() {
  const have = await store.settings.get(loginKey(DEMO.handle)); const cur = have ? await byId(have.id) : null;
  if (cur && cur.status === 'active') return cur;
  const a = cur || { _id: 'adm_demo', name: DEMO.name, handle: DEMO.handle, email: DEMO.handle, phone: '', preset: 'evaluator', areas: DEMO_AREAS.slice(), readOnly: false, sandboxed: true, demo: true, pv: 1, createdAt: now(), createdBy: 'system' };
  a.areas = DEMO_AREAS.slice(); a.sandboxed = true; a.demo = true; a.status = 'active'; a.passwordHash = hash(DEMO.password);
  await store.settings.set(loginKey(DEMO.handle), { id: a._id }); await save(a); return a;
}

/** Can this admin make this call? Used by the platform auth middleware. */
function allows(a, segment, method) {
  const area = areaOfPath(segment); if (!area) return { ok: false, why: 'This part of Master Control is for the chief administrator only.' };
  if (a.sandboxed && area !== 'always' && !DEMO_AREAS.includes(area)) return { ok: false, why: 'This part is not included in the demo. Ask HNN for your own account.' };
  if (area === 'always') return { ok: true };
  if (!a.areas.includes(area)) return { ok: false, why: 'Your login has not been given this area.' };
  if (a.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method)) return { ok: false, why: 'Your login is read-only.' };
  return { ok: true };
}
module.exports = { DEMO, DEMO_AREAS, demoConfig, setDemoEnabled, ensureDemo, AREAS, PRESETS, invite, list, update, reinvite, remove, acceptInvite, login, authenticate, changePassword, allows, view };
