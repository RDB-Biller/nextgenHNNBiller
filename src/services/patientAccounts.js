'use strict';

const crypto = require('crypto');
const store = require('../store');
const messaging = require('./messaging');
const savings = require('./savingsPlans');

/**
 * Patient accounts for the Afriyie / TrimesterSave app, hosted by the Biller so the whole product runs on
 * one backend (Railway) and every SMS goes through the Biller's Africa's Talking configuration.
 *
 * Storage uses the Biller's settings store (works in memory and in Postgres, no schema change):
 *   pacct:<id>            the account document, with its budgets and vitals
 *   pacct:phone:<e164>    phone -> account id
 *   pacct:reset:<code>    password-reset code -> { id, expiresAt }
 * Sessions are stateless signed tokens (HMAC-SHA256), 30 days. Passwords are scrypt-hashed.
 */
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;

const err = (status, code) => { const e = new Error(code); e.status = status; e.code = code; return e; };
const iso = () => new Date().toISOString();
const b64 = (b) => Buffer.from(b).toString('base64url');

async function secret() {
  if (process.env.PATIENT_TOKEN_SECRET) return process.env.PATIENT_TOKEN_SECRET;
  let s = await store.settings.get('pacct_secret');
  if (!s || !s.value) { s = { value: crypto.randomBytes(32).toString('hex'), createdAt: iso() }; await store.settings.set('pacct_secret', s); }
  return s.value;
}
async function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}
async function verifyToken(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', await secret()).update(body).digest('base64url');
  const a = Buffer.from(mac); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const keyOf = (id) => `pacct:${id}`;
const phoneKey = (phone) => `pacct:phone:${phone}`;
const dial = (p) => messaging.toDialable(p || '');
const validPhone = (p) => /^\+\d{8,15}$/.test(p);

async function byId(id) { return id ? store.settings.get(keyOf(id)) : null; }
async function byPhone(phoneRaw) {
  const idx = await store.settings.get(phoneKey(dial(phoneRaw)));
  return idx ? byId(idx.id) : null;
}
const save = (acct) => store.settings.set(keyOf(acct._id), acct);

/** What the app sees: never the hash, budgets or vitals arrays. */
function publicUser(a, extra = {}) {
  const { passwordHash, budgets, vitals, appointments, notifications, files, ...rest } = a;
  return { ...rest, ...extra };
}
async function session(a) {
  const token = await sign({ sub: a._id, exp: Date.now() + TOKEN_TTL_MS });
  return publicUser(a, { tokens: [{ token }] });
}

async function register({ first_name, last_name, phone, password } = {}) {
  const p = dial(phone);
  if (!validPhone(p)) throw err(422, 'Please enter a valid phone number');
  if (!String(first_name || '').trim() || !String(last_name || '').trim()) throw err(422, 'Please enter your first and last name');
  if (String(password || '').length < 6) throw err(422, 'Your password must be at least 6 characters');
  if (await byPhone(p)) throw err(409, 'An account with this phone number already exists. Sign in instead.');
  const a = {
    _id: `pt_${crypto.randomBytes(9).toString('hex')}`, first_name: String(first_name).trim(), last_name: String(last_name).trim(),
    phone: p, passwordHash: hashPassword(password), phoneVerified: false, createdAt: iso(), budgets: [], vitals: [],
  };
  await notify(a, { title: 'Welcome to TrimesterSave', message: 'Your account is ready. Verify your phone, then start a savings plan, keep your records and book your visits.', kind: 'welcome' });
  await store.settings.set(phoneKey(p), { id: a._id });
  await save(a);
  return publicUser(a);
}

async function login({ phone, password } = {}) {
  const a = await byPhone(phone);
  if (!a || !checkPassword(password, a.passwordHash)) throw err(401, 'Incorrect phone number or password');
  return session(a);
}

async function authenticate(authHeader) {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader || '');
  const p = m && (await verifyToken(m[1]));
  const a = p && (await byId(p.sub));
  if (!a) throw err(401, 'Please sign in again');
  return a;
}

const PROFILE_FIELDS = ['first_name', 'last_name', 'spouse_name', 'spouse_phone', 'country', 'city', 'town', 'address', 'email', 'ghana_card'];
async function updateProfile(a, body = {}) {
  for (const f of PROFILE_FIELDS) if (body[f] !== undefined) a[f] = typeof body[f] === 'string' ? body[f].trim().slice(0, 200) : body[f];
  if (!a.first_name || !a.last_name) throw err(422, 'First and last name are required');
  a.updatedAt = iso();
  await save(a);
  return publicUser(a);
}

async function changePassword(a, { old_password, current_password, password, new_password } = {}) {
  const cur = old_password ?? current_password;
  const next = password ?? new_password;
  if (!checkPassword(cur, a.passwordHash)) throw err(401, 'Your current password is not right');
  if (String(next || '').length < 6) throw err(422, 'Your new password must be at least 6 characters');
  a.passwordHash = hashPassword(next); a.updatedAt = iso();
  await save(a);
  return { changed: true };
}

/** Texts a reset code through the Biller's SMS provider. Never reveals whether the phone has an account. */
async function forgotPassword({ phone } = {}) {
  const p = dial(phone);
  if (!validPhone(p)) throw err(422, 'Please enter a valid phone number');
  const a = await byPhone(p);
  const out = { sent: true, to: p.replace(/\d(?=\d{3})/g, '•') };
  if (!a) return out;
  let code; let tries = 0;
  do { code = messaging.genOtp(); tries++; } while (tries < 20 && (await store.settings.get(`pacct:reset:${code}`)) && new Date((await store.settings.get(`pacct:reset:${code}`)).expiresAt) > new Date());
  await store.settings.set(`pacct:reset:${code}`, { id: a._id, expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString() });
  const r = await messaging.send({ channel: 'sms', to: p, body: `Your TrimesterSave password reset code is ${code}. It expires in 30 minutes. Ignore this if you did not ask for it.`, tenant: null });
  if (r.sandbox) out.codeSandbox = code;
  return out;
}
async function resetPassword(code, { password } = {}) {
  const k = `pacct:reset:${String(code || '').trim()}`;
  const rec = await store.settings.get(k);
  if (!rec || new Date(rec.expiresAt) < new Date()) throw err(401, 'That reset code is not valid or has expired');
  if (String(password || '').length < 6) throw err(422, 'Your password must be at least 6 characters');
  const a = await byId(rec.id);
  if (!a) throw err(401, 'That reset code is not valid or has expired');
  a.passwordHash = hashPassword(password); a.updatedAt = iso();
  await save(a);
  await store.settings.set(k, { ...rec, expiresAt: new Date(0).toISOString() });
  return { reset: true };
}

/** The app verifies the code with POST /savings/api/verify/check first, then presents the signed receipt here. */
async function verifyPhone({ phone, verifiedAt, receipt } = {}) {
  const a = await byPhone(phone);
  if (!a) throw err(404, 'No account for that phone number');
  const fresh = verifiedAt && Date.now() - new Date(verifiedAt).getTime() < 15 * 60000;
  if (!fresh || !(await savings.checkReceipt({ phone: a.phone, verifiedAt, receipt }))) throw err(401, 'Phone verification could not be confirmed');
  a.phoneVerified = true; a.phoneVerifiedAt = iso();
  await save(a);
  return session(a);
}

// ---- budgets and vitals ----
const BUDGET_TYPES_MAX = 80;
async function addBudget(a, { budget_type, budget_date, description, amount } = {}) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw err(422, 'Please enter an amount greater than zero');
  const d = new Date(budget_date);
  if (!budget_date || Number.isNaN(d.getTime())) throw err(422, 'Please choose a date');
  const rec = { _id: `bg_${crypto.randomBytes(6).toString('hex')}`, budget_type: String(budget_type || 'Other').slice(0, BUDGET_TYPES_MAX), budget_date: d.toISOString(), description: String(description || '').slice(0, 300), amount: n, createdAt: iso() };
  a.budgets = [...(a.budgets || []), rec];
  await save(a);
  return rec;
}
const listBudgets = (a) => [...(a.budgets || [])].sort((x, y) => new Date(x.budget_date) - new Date(y.budget_date));

const VITAL_TYPES = new Set(['BP', 'GL', 'WE', 'GE']);
async function addVital(a, body = {}) {
  const vital_type = String(body.vital_type || '').toUpperCase();
  if (!VITAL_TYPES.has(vital_type)) throw err(422, 'Please choose what you are recording');
  const rec = { _id: `vt_${crypto.randomBytes(6).toString('hex')}`, vital_type, value: String(body.value ?? '').slice(0, 60), interpretation: body.interpretation || null, description: String(body.description || '').slice(0, 300), createdAt: iso() };
  if (vital_type === 'GE') {
    const lmp = new Date(body.first_day_of_last_circle);
    if (Number.isNaN(lmp.getTime()) || lmp.getFullYear() < 2000) throw err(422, 'Please enter the first day of your last period');
    const edd = new Date(lmp.getTime() + 280 * 86400000);
    rec.first_day_of_last_circle = lmp.toISOString();
    rec.full_term_date = edd.toISOString();
    rec.due_in_days = Math.round((edd.getTime() - Date.now()) / 86400000);
    if (!rec.value) rec.value = `${Math.max(0, Math.floor((Date.now() - lmp.getTime()) / 86400000 / 7))} weeks`;
  } else {
    if (!rec.value) throw err(422, 'Please enter a value');
    rec.first_day_of_last_circle = rec.createdAt; // the Report page prints this column as the entry date
  }
  a.vitals = [...(a.vitals || []), rec];
  await save(a);
  return rec;
}
const listVitals = (a) => [...(a.vitals || [])].sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt));


// ---- notifications ----
const MAX_NOTES = 100;
async function notify(a, { title, message, kind = 'info', ref = null }) {
  a.notifications = [{ _id: `nt_${crypto.randomBytes(6).toString('hex')}`, title, message, kind, ref, read: false, createdAt: iso() }, ...(a.notifications || [])].slice(0, MAX_NOTES);
}
async function listNotifications(a) {
  await dueSoon(a);
  return a.notifications || [];
}
async function readNotification(a, id) {
  const n = (a.notifications || []).find((x) => x._id === id);
  if (id === 'all') (a.notifications || []).forEach((x) => { x.read = true; });
  else if (!n) throw err(404, 'Notification not found');
  else n.read = true;
  await save(a);
  return a.notifications || [];
}

// ---- appointments ----
const APPT_STATUS = new Set(['upcoming', 'completed', 'cancelled']);
const apptWhen = (x) => new Date(`${String(x.date).slice(0, 10)}T${/^\d{2}:\d{2}$/.test(x.time || '') ? x.time : '09:00'}:00Z`);
function cleanAppt(body = {}, prev = {}) {
  const date = body.date !== undefined ? body.date : prev.date;
  const d = new Date(date);
  if (!date || Number.isNaN(d.getTime())) throw err(422, 'Please choose the appointment date');
  const title = String(body.title !== undefined ? body.title : prev.title || '').trim();
  if (!title) throw err(422, 'Please say what the appointment is for');
  const time = body.time !== undefined ? String(body.time) : prev.time || '';
  if (time && !/^\d{2}:\d{2}$/.test(time)) throw err(422, 'Time should look like 14:30');
  const status = body.status !== undefined ? String(body.status) : prev.status || 'upcoming';
  if (!APPT_STATUS.has(status)) throw err(422, 'Unknown appointment status');
  return {
    title: title.slice(0, 120), date: d.toISOString().slice(0, 10), time,
    hospital: String(body.hospital !== undefined ? body.hospital : prev.hospital || '').slice(0, 120),
    doctor: String(body.doctor !== undefined ? body.doctor : prev.doctor || '').slice(0, 120),
    notes: String(body.notes !== undefined ? body.notes : prev.notes || '').slice(0, 500),
    remind_sms: body.remind_sms !== undefined ? body.remind_sms !== false && body.remind_sms !== 'false' : prev.remind_sms !== false,
    status,
  };
}
async function addAppointment(a, body) {
  if ((a.appointments || []).length >= 200) throw err(422, 'Too many appointments saved. Delete some first.');
  const rec = { _id: `ap_${crypto.randomBytes(6).toString('hex')}`, ...cleanAppt(body), reminded: false, createdAt: iso() };
  a.appointments = [...(a.appointments || []), rec];
  await notify(a, { title: 'Appointment saved', message: `${rec.title} on ${rec.date}${rec.time ? ' at ' + rec.time : ''}${rec.hospital ? ' - ' + rec.hospital : ''}.`, kind: 'appointment', ref: rec._id });
  await save(a);
  return rec;
}
async function updateAppointment(a, id, body) {
  const i = (a.appointments || []).findIndex((x) => x._id === id);
  if (i < 0) throw err(404, 'Appointment not found');
  const prev = a.appointments[i];
  const next = { ...prev, ...cleanAppt(body, prev), updatedAt: iso() };
  if (next.date !== prev.date || next.time !== prev.time) next.reminded = false;
  a.appointments[i] = next;
  await save(a);
  return next;
}
async function deleteAppointment(a, id) {
  const n = (a.appointments || []).length;
  a.appointments = (a.appointments || []).filter((x) => x._id !== id);
  if (a.appointments.length === n) throw err(404, 'Appointment not found');
  await save(a);
  return { deleted: id };
}
const listAppointments = (a) => [...(a.appointments || [])].sort((x, y) => apptWhen(x) - apptWhen(y));
const getAppointment = (a, id) => { const r = (a.appointments || []).find((x) => x._id === id); if (!r) throw err(404, 'Appointment not found'); return r; };

/** Adds an in-app notice (once) for appointments in the next 48 hours. */
async function dueSoon(a) {
  let changed = false;
  for (const x of a.appointments || []) {
    if (x.status !== 'upcoming' || x.noticed) continue;
    const ms = apptWhen(x) - Date.now();
    if (ms > 0 && ms < 48 * 3600000) {
      await notify(a, { title: 'Appointment coming up', message: `${x.title} on ${x.date}${x.time ? ' at ' + x.time : ''}${x.hospital ? ' - ' + x.hospital : ''}.`, kind: 'reminder', ref: x._id });
      x.noticed = true; changed = true;
    }
  }
  if (changed) await save(a);
}
/** Texts a reminder (once) for appointments in the next 24 hours to accounts with a verified phone. Run on the server's timer. */
async function runAppointmentReminders() {
  const keys = typeof store.settings.keys === 'function' ? await store.settings.keys('pacct:pt_') : null;
  if (!keys) return { sent: 0, skipped: 'store cannot list accounts' };
  let sent = 0;
  for (const k of keys) {
    const a = await store.settings.get(k);
    if (!a || !a.phoneVerified) continue;
    let changed = false;
    for (const x of a.appointments || []) {
      const ms = apptWhen(x) - Date.now();
      if (x.status === 'upcoming' && x.remind_sms !== false && !x.reminded && ms > 0 && ms < 24 * 3600000) {
        const r = await messaging.send({ channel: 'sms', to: a.phone, body: `Reminder: ${x.title} on ${x.date}${x.time ? ' at ' + x.time : ''}${x.hospital ? ' at ' + x.hospital : ''}. - TrimesterSave`, tenant: null }).catch(() => ({ ok: false }));
        if (r.ok) { x.reminded = true; changed = true; sent++; }
      }
    }
    if (changed) await save(a);
  }
  return { sent };
}

// ---- document vault (small files kept as base64 in their own records) ----
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 25;
const FILE_TYPES = /^(application\/pdf|image\/(png|jpe?g|webp|gif)|text\/plain)$/;
const fileKey = (id) => `pacct:file:${id}`;
async function addFile(a, body = {}) {
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) throw err(422, 'Please name the file');
  const type = String(body.type || '');
  if (!FILE_TYPES.test(type)) throw err(422, 'Only PDF, image (PNG, JPG, WEBP, GIF) and text files can be stored');
  const data = String(body.data || '').replace(/^data:[^,]*,/, '');
  if (!data || !/^[A-Za-z0-9+/=\r\n]+$/.test(data)) throw err(422, 'The file could not be read');
  const size = Math.floor((data.length * 3) / 4);
  if (size > MAX_FILE_BYTES) throw err(413, 'Files can be at most 1 MB');
  if ((a.files || []).length >= MAX_FILES) throw err(422, `You can keep up to ${MAX_FILES} files. Delete one first.`);
  const meta = { _id: `fl_${crypto.randomBytes(6).toString('hex')}`, name, type, size, category: String(body.category || 'Other').slice(0, 40), note: String(body.note || '').slice(0, 300), createdAt: iso() };
  await store.settings.set(fileKey(meta._id), { owner: a._id, data });
  a.files = [...(a.files || []), meta];
  await save(a);
  return meta;
}
const listFiles = (a) => [...(a.files || [])].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
async function getFile(a, id) {
  const meta = (a.files || []).find((x) => x._id === id);
  const blob = meta && (await store.settings.get(fileKey(id)));
  if (!meta || !blob || blob.owner !== a._id) throw err(404, 'File not found');
  return { ...meta, data: blob.data };
}
async function updateFile(a, id, body = {}) {
  const meta = (a.files || []).find((x) => x._id === id);
  if (!meta) throw err(404, 'File not found');
  if (body.name !== undefined) { const n = String(body.name).trim().slice(0, 120); if (!n) throw err(422, 'Please name the file'); meta.name = n; }
  if (body.category !== undefined) meta.category = String(body.category).slice(0, 40);
  if (body.note !== undefined) meta.note = String(body.note).slice(0, 300);
  await save(a);
  return meta;
}
async function deleteFile(a, id) {
  const n = (a.files || []).length;
  a.files = (a.files || []).filter((x) => x._id !== id);
  if (a.files.length === n) throw err(404, 'File not found');
  await store.settings.set(fileKey(id), { owner: a._id, data: '', deleted: true });
  await save(a);
  return { deleted: id };
}

module.exports = { register, login, authenticate, publicUser, updateProfile, changePassword, forgotPassword, resetPassword, verifyPhone, addBudget, listBudgets, addVital, listVitals, byPhone, verifyToken,
  notify, listNotifications, readNotification, addAppointment, updateAppointment, deleteAppointment, listAppointments, getAppointment, runAppointmentReminders,
  addFile, listFiles, getFile, updateFile, deleteFile };
