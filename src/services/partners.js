'use strict';

const crypto = require('crypto');
const store = require('../store');
const messaging = require('./messaging');
const config = require('../config');
const erheat = require('./erheat');

/**
 * Partner accounts: the people who work ERHEAT Shield from the other side (landlords and property managers, clinics,
 * bus operators, schools, fuel and food suppliers). Master Control issues every login. Each account belongs to one sector, so
 * its console only shows that sector's lines and wording. A universal account sees every line; a partner can ask for it,
 * only Master Control can approve it.
 *
 * Storage (settings store, works in memory and Postgres):  partner:acct:<id>   partner:login:<handle> -> { id }
 * Sessions are signed 12 hour tokens; a password change, reset or suspension bumps `pv` and ends every session.
 */
const TTL_MS = 12 * 3600 * 1000;
const err = (status, message) => { const e = new Error(message); e.status = status; return e; };
const now = () => new Date().toISOString();
const b64 = (b) => Buffer.from(b).toString('base64url');
const dial = (p) => messaging.toDialable(String(p || '').replace(/[\s().-]/g, ''));
const validPhone = (p) => /^\+\d{8,15}$/.test(p);
const base = () => String(config.messaging.publicBaseUrl || '').replace(/\/$/, '');

const SECTORS = {
  real_estate: { label: 'Real estate', lines: ['rent'], who: 'Landlords and property managers', unit: 'tenancies', verify: 'Confirm that a tenant lives at your property and the rent is due.', tools: ['requests'] },
  health: { label: 'Health', lines: ['health'], who: 'Hospitals, clinics and pharmacies', unit: 'patients', verify: 'Confirm that a patient is under your care and the bill is correct.', tools: ['requests'] },
  education: { label: 'Education', lines: ['education'], who: 'Schools and colleges', unit: 'students', verify: 'Confirm that a student is enrolled and the fee is due.', tools: ['requests'] },
  energy: { label: 'Energy', lines: ['energy'], who: 'Fuel stations, utility agents and generator rental', unit: 'orders', verify: 'Confirm the order, then redeem the voucher when the customer collects.', tools: ['requests', 'redeem'] },
  agriculture: { label: 'Agriculture and food', lines: ['agriculture'], who: 'Suppliers, dealers and traders', unit: 'orders', verify: 'Confirm the order, then redeem the voucher when the customer collects.', tools: ['requests', 'redeem'] },
  transport: { label: 'Transport', lines: ['transport'], who: 'Bus operators and terminal agents', unit: 'bookings', verify: 'Confirm the booking, then redeem the ticket voucher at the terminal.', tools: ['requests', 'redeem'] },
  finance: { label: 'Banking and lending', lines: Object.keys(erheat.LINES), who: 'Bankers, credit officers and lenders', unit: 'requests', verify: 'Review requests across every line. You do not confirm on behalf of a payee.', tools: ['requests'] },
  universal: { label: 'Universal', lines: Object.keys(erheat.LINES), who: 'Approved by Master Control for every line', unit: 'requests', verify: 'Work any line.', tools: ['requests', 'redeem'] },
};

// Who people are. Each role works one sector; Master Control can change either when it approves a sign-up.
const ROLES = {
  landlord: { label: 'Landlord', sector: 'real_estate' }, property_manager: { label: 'Property manager', sector: 'real_estate' },
  hospital_admin: { label: 'Hospital administrator', sector: 'health' }, doctor: { label: 'Doctor', sector: 'health' }, nurse: { label: 'Nurse', sector: 'health' },
  pharmacist: { label: 'Pharmacist', sector: 'health' }, clinic_owner: { label: 'Clinic or pharmacy owner', sector: 'health' },
  school_head: { label: 'School head or bursar', sector: 'education' },
  fuel_agent: { label: 'Fuel, utility or generator agent', sector: 'energy' },
  supplier: { label: 'Farm input, food or shop supplier', sector: 'agriculture' },
  transport_operator: { label: 'Transport operator or terminal agent', sector: 'transport' },
  banker: { label: 'Banker', sector: 'finance' }, credit_officer: { label: 'Credit or loan officer', sector: 'finance' }, lender_admin: { label: 'Lender administrator', sector: 'finance' },
  other: { label: 'Other (tell us in your organisation name)', sector: null },
};
const keyOf = (id) => `partner:acct:${id}`; const loginKey = (h) => `partner:login:${h}`;
function handleOf(raw) { const s = String(raw || '').trim(); if (s.includes('@')) { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw err(422, 'Enter a valid email address or phone number.'); return s.toLowerCase(); } const p = dial(s); if (!validPhone(p)) throw err(422, 'Enter a valid email address or phone number.'); return p; }
const byId = (id) => (id ? store.settings.get(keyOf(id)) : null);
async function byHandle(raw) { let h; try { h = handleOf(raw); } catch (_e) { return null; } const i = await store.settings.get(loginKey(h)); return i ? byId(i.id) : null; }
const save = (a) => store.settings.set(keyOf(a._id), a);

function hash(pw) { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`; }
function check(pw, stored) { const [alg, salt, h] = String(stored || '').split('$'); if (alg !== 'scrypt') return false; const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64); const want = Buffer.from(h, 'hex'); return got.length === want.length && crypto.timingSafeEqual(got, want); }
const ALPHA = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const tempPassword = () => Array.from({ length: 10 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');
async function secret() {
  if (process.env.PARTNER_TOKEN_SECRET) return process.env.PARTNER_TOKEN_SECRET;
  let s = await store.settings.get('partner_secret'); if (!s) { s = { value: crypto.randomBytes(32).toString('hex'), at: now() }; await store.settings.set('partner_secret', s); } return s.value;
}
async function sign(p) { const body = b64(JSON.stringify(p)); return `${body}.${crypto.createHmac('sha256', await secret()).update(body).digest('base64url')}`; }
async function unsign(t) {
  const [body, mac] = String(t || '').split('.'); if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', await secret()).update(body).digest('base64url'); const a = Buffer.from(mac); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (_e) { return null; }
}

const effective = (a) => (a.universal ? 'universal' : a.sector);
const linesOf = (a) => SECTORS[effective(a)].lines;
/** What the account is, as the console and Master Control see it. Never the password hash. */
function view(a) {
  const e = effective(a); const s = SECTORS[e];
  return { id: a._id, name: a.name, org: a.org, handle: a.handle, email: a.email || '', role: a.role || '', roleLabel: (ROLES[a.role] || {}).label || '', requestedSector: a.requestedSector || '', signup: !!a.signup, decisionNote: a.decisionNote || '', contactPhone: a.contactPhone || '', sector: a.sector, effectiveSector: e, sectorLabel: s.label, universal: !!a.universal, universalRequested: !!a.universalRequested,
    phones: a.phones, view: a.view, status: a.status, mustChange: !!a.mustChange, lines: s.lines, tools: s.tools, unit: s.unit, verifyHelp: s.verify, createdAt: a.createdAt, createdBy: a.createdBy, lastLoginAt: a.lastLoginAt || null };
}
function cleanPhones(list) { const out = []; for (const p of Array.isArray(list) ? list : String(list || '').split(/[,\n;]+/)) { const t = String(p).trim(); if (!t) continue; const d = dial(t); if (!validPhone(d)) throw err(422, `Not a valid phone number: ${t}`); if (!out.includes(d)) out.push(d); } return out; }

// ---------------------------------------------------------------- Master Control
async function create(b = {}, by = 'master') {
  const name = String(b.name || '').trim().slice(0, 100); const org = String(b.org || '').trim().slice(0, 120);
  if (!name) throw err(422, 'Enter the person\'s name.');
  const role = ROLES[b.role] ? b.role : ''; const sector = b.universal ? 'universal' : (b.sector || (ROLES[role] || {}).sector); if (!SECTORS[sector]) throw err(422, `Choose a sector: ${Object.keys(SECTORS).join(', ')}.`);
  const handle = handleOf(b.handle); if (await store.settings.get(loginKey(handle))) throw err(409, 'That email or phone number already has a login.');
  const phones = cleanPhones(b.phones); const pw = String(b.password || '') || tempPassword(); if (pw.length < 8) throw err(422, 'A password needs at least 8 characters.');
  const a = { _id: `pt_${crypto.randomBytes(8).toString('hex')}`, role, name, org, handle, contactPhone: b.contactPhone ? dial(b.contactPhone) : (handle.startsWith('+') ? handle : ''), sector: sector === 'universal' ? 'real_estate' : sector,
    universal: sector === 'universal', universalRequested: false, phones, view: b.view === 'all' ? 'all' : 'mine', status: 'active', passwordHash: hash(pw), pv: 1, mustChange: true, createdAt: now(), createdBy: by };
  await store.settings.set(loginKey(handle), { id: a._id }); await save(a);
  let sms = null;
  if (b.sendSms && a.contactPhone) { try { sms = await messaging.send({ channel: 'sms', to: a.contactPhone, body: `ER HEAT partner login for ${org || name}: ${base()}/app/partner.html  User: ${handle}  Temporary password: ${pw}  You will be asked to change it.`, tenant: null }); } catch (_e) { sms = { ok: false }; } }
  return { account: view(a), temporaryPassword: pw, sms: sms ? { ok: !!sms.ok, sandbox: !!sms.sandbox } : null };
}
async function list() { const out = []; for (const k of await store.settings.keys('partner:acct:')) { const a = await store.settings.get(k); if (a) out.push(view(a)); } return out.sort((x, y) => y.createdAt.localeCompare(x.createdAt)); }
async function must(id) { const a = await byId(id); if (!a) throw err(404, 'partner_not_found'); return a; }
async function update(id, b = {}) {
  const a = await must(id);
  if (b.name !== undefined) { a.name = String(b.name).trim().slice(0, 100); if (!a.name) throw err(422, 'Enter the person\'s name.'); }
  if (b.org !== undefined) a.org = String(b.org).trim().slice(0, 120);
  if (b.role !== undefined) { if (b.role && !ROLES[b.role]) throw err(422, 'Unknown role.'); a.role = b.role; }
  if (b.sector !== undefined) { if (!SECTORS[b.sector] || b.sector === 'universal') throw err(422, 'Choose a sector (use approve for universal).'); a.sector = b.sector; }
  if (b.phones !== undefined) a.phones = cleanPhones(b.phones);
  if (b.view !== undefined) a.view = b.view === 'all' ? 'all' : 'mine';
  if (b.contactPhone !== undefined) a.contactPhone = b.contactPhone ? dial(b.contactPhone) : '';
  if (b.status !== undefined) { if (!['active', 'suspended'].includes(b.status) || (b.status === 'active' && a.status === 'pending')) throw err(422, a.status === 'pending' ? 'Use approve or reject for a sign-up request.' : 'Status must be active or suspended.'); if (b.status !== a.status) a.pv += 1; a.status = b.status; }
  await save(a); return view(a);
}
async function resetPassword(id, b = {}) { const a = await must(id); const pw = String(b.password || '') || tempPassword(); if (pw.length < 8) throw err(422, 'A password needs at least 8 characters.'); a.passwordHash = hash(pw); a.pv += 1; a.mustChange = true; await save(a); return { account: view(a), temporaryPassword: pw }; }
async function setUniversal(id, on) { const a = await must(id); a.universal = !!on; a.universalRequested = false; await save(a); return view(a); }

// ---------------------------------------------------------------- public sign-up (needs approval)
const signupHits = new Map();
async function signup(b = {}, ip = '') {
  const k = String(ip || 'x'); const h = (signupHits.get(k) || []).filter((t) => Date.now() - t < 3600000); if (h.length >= 5) throw err(429, 'Too many sign-up requests from this connection. Try again later.'); h.push(Date.now()); signupHits.set(k, h);
  const name = String(b.name || '').trim().slice(0, 100); const org = String(b.org || '').trim().slice(0, 120);
  if (!name) throw err(422, 'Enter your name.'); if (!org) throw err(422, 'Enter your organisation, for example the hospital, bank or school.');
  const role = String(b.role || ''); if (!ROLES[role]) throw err(422, 'Choose your role.');
  const sector = ROLES[role].sector || b.sector; if (!SECTORS[sector] || sector === 'universal') throw err(422, 'Choose the sector you work in.');
  const requirePhone = !!(await require('./patientAccounts').authConfig()).requirePhone;
  const emailRaw = String(b.email || '').trim().toLowerCase(); const phoneRaw = String(b.phone || '').trim();
  if (!emailRaw && !phoneRaw) throw err(422, 'Enter an email address or a mobile number.');
  if (requirePhone && !phoneRaw) throw err(422, 'A mobile number is needed to sign up.');
  const email = emailRaw ? handleOf(emailRaw) : ''; const phone = phoneRaw ? handleOf(phoneRaw) : '';
  if (email && !email.includes('@')) throw err(422, 'Enter a valid email address.'); if (phone && phone.includes('@')) throw err(422, 'Enter a valid mobile number.');
  for (const h2 of [email, phone].filter(Boolean)) if (await store.settings.get(loginKey(h2))) throw err(409, 'That email or phone number already has a login or a pending request.');
  const pw = String(b.password || ''); if (pw.length < 8) throw err(422, 'Choose a password of at least 8 characters.');
  const handle = email || phone;
  const a = { _id: `pt_${crypto.randomBytes(8).toString('hex')}`, role, name, org, handle, email, contactPhone: phone, sector, requestedSector: sector, signup: true, universal: false, universalRequested: false,
    phones: phone ? [phone] : [], view: 'mine', status: 'pending', passwordHash: hash(pw), pv: 1, mustChange: false, createdAt: now(), createdBy: 'self_signup' };
  for (const h2 of [email, phone].filter(Boolean)) await store.settings.set(loginKey(h2), { id: a._id });
  await save(a); return { ok: true, status: 'pending', message: 'Thank you. HNN will review your request. You can sign in once it is approved.' };
}
async function approve(id, b = {}) {
  const a = await must(id); if (a.status !== 'pending') throw err(409, 'This request is not waiting for approval.');
  if (b.sector !== undefined) { if (!SECTORS[b.sector] || b.sector === 'universal') throw err(422, 'Choose a sector.'); a.sector = b.sector; }
  if (b.phones !== undefined) a.phones = cleanPhones(b.phones);
  if (b.view !== undefined) a.view = b.view === 'all' ? 'all' : 'mine';
  if (b.universal) { a.universal = true; a.universalRequested = false; }
  a.status = 'active'; a.pv += 1; a.decisionNote = ''; a.approvedAt = now(); await save(a); return view(a);
}
async function reject(id, b = {}) { const a = await must(id); if (a.status !== 'pending') throw err(409, 'This request is not waiting for approval.'); a.status = 'rejected'; a.pv += 1; a.decisionNote = String(b.reason || '').slice(0, 200); await save(a); return view(a); }

// ---------------------------------------------------------------- partner sessions
const fails = new Map();
async function login({ handle, password } = {}) {
  const hk = String(handle || '').trim().toLowerCase(); const f = (fails.get(hk) || []).filter((t) => Date.now() - t < 15 * 60000);
  if (f.length >= 8) throw err(429, 'Too many tries. Wait 15 minutes, or ask Master Control to reset your password.');
  const a = await byHandle(handle);
  if (!a || !check(password, a.passwordHash)) { f.push(Date.now()); fails.set(hk, f); throw err(401, 'Incorrect login or password.'); }
  if (a.status === 'pending') throw err(403, 'Your request is waiting for approval by HNN. You will be able to sign in once it is approved.');
  if (a.status === 'rejected') throw err(403, 'This request was not approved.' + (a.decisionNote ? ' ' + a.decisionNote : ''));
  if (a.status !== 'active' || (await require('./accountControl').isDisabled('partner', a._id))) throw err(403, 'This login is suspended. Contact Master Control.');
  fails.delete(hk); a.lastLoginAt = now(); await save(a);
  return { token: await sign({ sub: a._id, pv: a.pv, exp: Date.now() + TTL_MS }), account: view(a) };
}
async function authenticate(header) {
  const m = /^Bearer\s+(.+)$/i.exec(header || ''); const p = m && await unsign(m[1]); const a = p && await byId(p.sub);
  if (!a || a.pv !== p.pv || a.status !== 'active' || (await require('./accountControl').isDisabled('partner', a._id))) throw err(401, 'Please sign in again.');
  return a;
}
async function changePassword(a, { current, password } = {}) {
  if (!check(current, a.passwordHash)) throw err(401, 'Your current password is not right.');
  if (String(password || '').length < 8) throw err(422, 'Your new password needs at least 8 characters.');
  a.passwordHash = hash(password); a.pv += 1; a.mustChange = false; await save(a);
  return { token: await sign({ sub: a._id, pv: a.pv, exp: Date.now() + TTL_MS }), account: view(a) };
}
async function requestUniversal(a) { if (a.universal) throw err(409, 'You already have universal access.'); a.universalRequested = true; await save(a); return view(a); }

// ---------------------------------------------------------------- what a partner sees and does
async function requests(a, { status } = {}) {
  const r = await erheat.partnerList({ lines: linesOf(a), phones: a.phones, all: a.view === 'all', status });
  const cfg = await erheat.getConfig();
  return { ...r, scope: a.view, lines: linesOf(a).map((k) => ({ key: k, label: erheat.LINES[k].label, enabled: cfg.enabled && cfg.lines[k].enabled, min: cfg.lines[k].min, cap: cfg.lines[k].cap })) };
}
async function redeem(a, { code, otp, phone } = {}) {
  if (!SECTORS[effective(a)].tools.includes('redeem')) throw err(403, 'Voucher redemption is not part of your sector.');
  const p = dial(phone || a.phones[0]); if (!a.phones.map(dial).includes(p)) throw err(403, 'Use one of the phone numbers registered to your account.');
  return erheat.redeem({ code, otp, phone: p });
}
module.exports = { ROLES, signup, approve, reject, SECTORS, create, list, update, resetPassword, setUniversal, login, authenticate, changePassword, requestUniversal, requests, redeem, view };
