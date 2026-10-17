'use strict';

const crypto = require('crypto');
const store = require('../store');
const config = require('../config');
const messaging = require('./messaging');
const i18n = require('./i18n');
const outreach = require('./outreach');
const accounts = require('./patientAccounts');
const operatingMode = require('./operatingMode');
const https = require('https');
const http = require('http');

/**
 * ERHEAT Shield: emergency micro-loans on six lines (Energy, Rent, Health, Education, Agriculture/food,
 * Transportation) running on ONE engine inside the Biller.
 *
 *  - The Biller never lends or holds funds. It builds a Verified-Need Packet, has the third party who knows the need
 *    (landlord, clinician, bursar, vendor, supplier, operator) confirm it, takes the borrower's consent and hands the
 *    packet to the lender (ConfirmU first). The lender decides credit and pays the verified PAYEE, never the borrower.
 *  - Lines that release value as a voucher (fuel, food, tickets) issue a code the vendor redeems with the borrower's
 *    one-time code.
 *  - Caps ladder with the borrower's Trust Passport (verified, repaid, defaulted) and never exceed HARD_CAP.
 *  - The lender contract (decision, paid, repayment callbacks, signed push) is HNN's own proposal, not confirmed
 *    with any lender.
 *
 * Borrower-facing surfaces (TrimesterSave app) hold no rules: they render what these functions return.
 */

const HARD_CAP = 2000;
const KEY_CFG = 'erheat:cfg'; const KEY_SECRET = 'erheat:secret'; const APP = 'erheat:app:'; const VER = 'erheat:ver:'; const VCH = 'erheat:vch:'; const REP = 'erheat:rep:';
const TEXT_VERSION = 'v1';
const CONSENT_TEXT = 'I agree that HNN Biller may share this request, the confirmations from the people I named and my phone number with the lender to assess my application, and that any approved amount is paid to the payee I named.';
const TERMINAL = ['declined', 'cancelled', 'expired', 'closed', 'defaulted'];

const err = (status, message, detail) => { const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e; };
const now = () => new Date().toISOString();
const rid = (p, n = 6) => `${p}_${crypto.randomBytes(n).toString('hex')}`;
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const base = () => String(config.messaging.publicBaseUrl || '').replace(/\/$/, '');
const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const mask = (p) => { const s = String(p || ''); return s.length <= 4 ? s : `${'•'.repeat(s.length - 4)}${s.slice(-4)}`; };
const dial = (raw) => messaging.toDialable(String(raw || '').replace(/[\s().-]/g, ''));
const validPhone = (p) => /^\+\d{8,15}$/.test(p);
const TOK = 'abcdefghjkmnpqrstuvwxyz23456789';
const token = (n = 18) => { let t = ''; for (let i = 0; i < n; i++) t += TOK[crypto.randomInt(TOK.length)]; return t; };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function nameMatch(a, b) {
  const x = new Set(norm(a).split(' ').filter(Boolean)); const y = norm(b).split(' ').filter(Boolean); if (!x.size || !y.length) return false;
  const hit = y.filter((w) => x.has(w)).length; return hit / Math.max(x.size, y.length) >= 0.5;
}

// ------------------------------------------------------------------ the six lines
const LINES = {
  rent: {
    label: 'Rent', short: 'Rent (home)', icon: 'home', verifierRole: 'landlord', verifierLabel: 'Landlord', coVerifierLabel: 'Co-tenant (optional)', payeeLabel: 'Landlord (mobile money or bank)',
    question: 'Does {first} rent from you, and is the amount below due to you?', voucher: false, defaultEnabled: true, trust: 'Your landlord confirms the tenancy by phone. The money goes to the landlord, never to you.',
    fields: [{ key: 'monthlyRent', label: 'Monthly rent (GHS)', type: 'number', required: true }, { key: 'dueDate', label: 'Rent due date', type: 'date', required: true }, { key: 'address', label: 'Property address', type: 'text' }],
    rules: [{ type: 'multipleOf', field: 'monthlyRent', times: 3, message: 'The loan cannot be more than three months of the rent you entered.' }],
  },
  health: {
    label: 'Health', short: 'Health (MedLoans)', icon: 'heart', verifierRole: 'clinician', verifierLabel: 'Clinic, hospital or pharmacy contact', payeeLabel: 'Hospital, clinic or pharmacy',
    question: 'Is {first} a patient of yours, and is the amount below for care or medicines you provide?', voucher: false, defaultEnabled: true, trust: 'The facility confirms your care and is paid directly. Add your InsureCredit reference if you have one.',
    fields: [{ key: 'facility', label: 'Facility name', type: 'text', required: true }, { key: 'insureCreditNo', label: 'InsureCredit reference (optional)', type: 'text' }, { key: 'note', label: 'What is the care for? (short)', type: 'text' }],
    rules: [],
  },
  education: {
    label: 'Education', short: 'Education (school fees)', icon: 'school', verifierRole: 'bursar', verifierLabel: 'School bursar or head', payeeLabel: 'School account',
    question: 'Is {first} (or the student named) enrolled, and is the fee below due?', voucher: false, defaultEnabled: false, trust: 'The school confirms the student and the fee. The loan can never be more than the fee.',
    fields: [{ key: 'school', label: 'School name', type: 'text', required: true }, { key: 'student', label: 'Student name', type: 'text', required: true }, { key: 'feeAmount', label: 'Fee due (GHS)', type: 'number', required: true }, { key: 'term', label: 'Term or year', type: 'text' }],
    rules: [{ type: 'atMostField', field: 'feeAmount', message: 'The loan cannot be more than the fee due.' }],
  },
  energy: {
    label: 'Energy', short: 'Energy (fuel, electricity, generator)', icon: 'bolt', verifierRole: 'vendor', verifierLabel: 'Vendor or station contact', payeeLabel: 'Vendor, station or utility agent',
    question: 'Is {first} buying from you, and is the amount below correct?', voucher: true, defaultEnabled: false, trust: 'You receive a voucher worth the amount, redeemed by the vendor with a one-time code. No cash.',
    fields: [{ key: 'kind', label: 'Type (electricity, fuel, generator)', type: 'text', required: true }, { key: 'reference', label: 'Meter number or vendor reference', type: 'text' }, { key: 'invoiceAmount', label: 'Invoice or quote (GHS)', type: 'number', required: true }],
    rules: [{ type: 'atMostField', field: 'invoiceAmount', message: 'The loan cannot be more than the invoice.' }],
  },
  agriculture: {
    label: 'Agriculture and food', short: 'Agriculture, food and goods', icon: 'leaf', verifierRole: 'supplier', verifierLabel: 'Supplier, dealer or trader', payeeLabel: 'Supplier or dealer',
    question: 'Is {first} buying from you, and is the quote below correct?', voucher: true, defaultEnabled: false, trust: 'You receive a voucher for food or inputs, redeemed by the supplier with a one-time code. No cash.',
    fields: [{ key: 'kind', label: 'Type (food, farm inputs, shop stock)', type: 'text', required: true }, { key: 'quoteRef', label: 'Quote reference', type: 'text' }, { key: 'quoteAmount', label: 'Quote (GHS)', type: 'number', required: true }],
    rules: [{ type: 'atMostField', field: 'quoteAmount', message: 'The loan cannot be more than the quote.' }],
  },
  transport: {
    label: 'Transportation', short: 'Transportation (tickets)', icon: 'bus', verifierRole: 'operator', verifierLabel: 'Operator or terminal agent', payeeLabel: 'Bus operator',
    question: 'Is {first} booked to travel with you, and is the fare below correct?', voucher: true, defaultEnabled: false, trust: 'You receive a ticket voucher, redeemed at the terminal with a one-time code.',
    fields: [{ key: 'route', label: 'Route (from, to)', type: 'text', required: true }, { key: 'travelDate', label: 'Travel date', type: 'date', required: true }, { key: 'quoteAmount', label: 'Fare quote (GHS)', type: 'number', required: true }],
    rules: [{ type: 'atMostField', field: 'quoteAmount', message: 'The loan cannot be more than the fare quote.' }],
  },
};

// ------------------------------------------------------------------ settings
const DEFAULTS = () => ({
  enabled: false, requireVerifiedPhone: true, hardCap: HARD_CAP, verifierTtlHours: 72, appTtlDays: 7, maxApps30d: 3,
  ladder: { new: 500, trusted: 1000, preferred: 2000 },
  lender: { name: 'ConfirmU', pushUrl: '' },
  lines: Object.fromEntries(Object.entries(LINES).map(([k, l]) => [k, { enabled: l.defaultEnabled, cap: HARD_CAP, min: 50 }])),
});
async function getConfig() {
  const s = (await store.settings.get(KEY_CFG)) || {}; const d = DEFAULTS();
  const lines = {}; for (const k of Object.keys(LINES)) lines[k] = { ...d.lines[k], ...((s.lines || {})[k] || {}) };
  return { ...d, ...s, ladder: { ...d.ladder, ...(s.ladder || {}) }, lender: { ...d.lender, ...(s.lender || {}) }, lines };
}
async function setConfig(p = {}) {
  const cur = await getConfig(); const next = { ...cur };
  if (p.enabled !== undefined) next.enabled = !!p.enabled;
  if (p.requireVerifiedPhone !== undefined) next.requireVerifiedPhone = !!p.requireVerifiedPhone;
  for (const k of ['verifierTtlHours', 'appTtlDays', 'maxApps30d']) if (p[k] !== undefined) { const v = Number(p[k]); if (!Number.isFinite(v) || v < 1 || v > 720) throw err(422, `${k} must be between 1 and 720`); next[k] = v; }
  if (p.ladder) for (const k of ['new', 'trusted', 'preferred']) if (p.ladder[k] !== undefined) { const v = Number(p.ladder[k]); if (!(v >= 50 && v <= HARD_CAP)) throw err(422, `ladder.${k} must be between 50 and ${HARD_CAP}`); next.ladder[k] = v; }
  if (p.lender) { if (p.lender.name !== undefined) next.lender.name = String(p.lender.name).slice(0, 60); if (p.lender.pushUrl !== undefined) { const u = String(p.lender.pushUrl).trim(); if (u && !/^https:\/\/[^\s]+$/i.test(u)) throw err(422, 'pushUrl must be an https URL'); next.lender.pushUrl = u; } }
  if (p.lines) for (const [k, v] of Object.entries(p.lines)) {
    if (!LINES[k]) throw err(422, `unknown line: ${k}`); const l = next.lines[k];
    if (v.enabled !== undefined) l.enabled = !!v.enabled;
    if (v.cap !== undefined) { const n = Number(v.cap); if (!(n >= 50 && n <= HARD_CAP)) throw err(422, `${k}.cap must be between 50 and ${HARD_CAP}`); l.cap = n; }
    if (v.min !== undefined) { const n = Number(v.min); if (!(n >= 1 && n <= HARD_CAP)) throw err(422, `${k}.min must be between 1 and ${HARD_CAP}`); l.min = n; }
    if (l.min > l.cap) throw err(422, `${k}: min cannot exceed cap`);
  }
  await store.settings.set(KEY_CFG, next); return next;
}
async function secret() { let s = await store.settings.get(KEY_SECRET); if (!s) { s = { value: crypto.randomBytes(24).toString('hex'), at: now() }; await store.settings.set(KEY_SECRET, s); } return s.value; }
async function rotateSecret() { const s = { value: crypto.randomBytes(24).toString('hex'), at: now() }; await store.settings.set(KEY_SECRET, s); return s.value; }
async function checkSecret(given) { const s = await secret(); const a = Buffer.from(String(given || '')); const b = Buffer.from(s); return a.length === b.length && crypto.timingSafeEqual(a, b); }
async function hookUrls(baseUrl) { const b = String(baseUrl || base()).replace(/\/$/, ''); const s = await secret(); return { decision: `${b}/erheat-hooks/${s}/decision`, paid: `${b}/erheat-hooks/${s}/paid`, repayment: `${b}/erheat-hooks/${s}/repayment`, application: `${b}/erheat-hooks/${s}/applications/{appNo}` }; }

// ------------------------------------------------------------------ passport
async function appsOfPhone(phone) { const out = []; for (const k of await store.settings.keys(APP)) { const a = await store.settings.get(k); if (a && a.borrower.phone === phone) out.push(a); } return out; }
function passportOf(apps, cfg) {
  const repaid = apps.filter((a) => a.status === 'closed').length; const defaults = apps.filter((a) => a.status === 'defaulted').length;
  const verified = apps.filter((a) => (a.history || []).some((h) => h.type === 'verified')).length;
  const level = defaults > 0 ? 'new' : repaid >= 3 ? 'preferred' : repaid >= 1 ? 'trusted' : 'new';
  const ceiling = Math.min(cfg.hardCap, cfg.ladder[level]);
  return { level, ceiling, verifiedRequests: verified, repaid, defaults, open: apps.filter((a) => !TERMINAL.includes(a.status)).length,
    next: level === 'new' ? 'Repay one loan on time to reach Trusted and a higher limit.' : level === 'trusted' ? 'Repay three loans to reach Preferred.' : 'You are at the highest level.' };
}
async function passport(phone) { const cfg = await getConfig(); return passportOf(await appsOfPhone(dial(phone)), cfg); }

// ------------------------------------------------------------------ messaging
async function sms(to, text, lang) {
  let body = text;
  if (lang && lang !== 'en' && i18n.isKnown(lang)) { try { const t = await i18n.translate(text, 'en', lang); if (t && t.ok) body = t.text; } catch (_e) { /* send English */ } }
  try { return await messaging.send({ channel: 'sms', to, body, tenant: null }); } catch (_e) { return { ok: false }; }
}
const addEvent = (app, type, detail) => { (app.history = app.history || []).push({ at: now(), type, ...(detail ? { detail } : {}) }); };
const saveApp = (app) => store.settings.set(APP + app.id, app);
async function tellBorrower(app, title, message) {
  await accounts.notifyPhone(app.borrower.phone, { title, message, kind: 'erheat', ref: app.appNo }).catch(() => {});
  await sms(app.borrower.phone, `${title}: ${message}`, app.borrower.lang);
}

// ------------------------------------------------------------------ catalogue
async function lines(phone) {
  const cfg = await getConfig(); const pass = phone ? await passport(phone) : null;
  return {
    enabled: cfg.enabled, requireVerifiedPhone: cfg.requireVerifiedPhone, hardCap: cfg.hardCap, passport: pass, consentText: CONSENT_TEXT,
    lines: Object.entries(LINES).map(([key, l]) => {
      const c = cfg.lines[key]; const cap = Math.min(c.cap, cfg.hardCap, pass ? pass.ceiling : cfg.ladder.new);
      return { key, label: l.label, short: l.short, icon: l.icon, enabled: cfg.enabled && c.enabled, comingSoon: !c.enabled, min: c.min, cap, lineCap: c.cap, verifierLabel: l.verifierLabel, coVerifierLabel: l.coVerifierLabel || '', payeeLabel: l.payeeLabel, trust: l.trust, voucher: l.voucher, fields: l.fields };
    }),
  };
}

// ------------------------------------------------------------------ apply
function checkEvidence(line, evidence, amount) {
  const ev = {};
  for (const f of line.fields) {
    let v = evidence && evidence[f.key]; if (v === undefined || v === null || v === '') { if (f.required) throw err(422, `${f.label} is required`); continue; }
    if (f.type === 'number') { v = Number(v); if (!(v > 0)) throw err(422, `${f.label} must be a number above zero`); }
    else if (f.type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw err(422, `${f.label} must be a date (YYYY-MM-DD)`); v = String(v); }
    else v = String(v).trim().slice(0, 200);
    ev[f.key] = v;
  }
  for (const r of line.rules) {
    if (r.type === 'multipleOf' && ev[r.field] && amount > ev[r.field] * r.times) throw err(422, r.message);
    if (r.type === 'atMostField' && ev[r.field] && amount > ev[r.field]) throw err(422, r.message);
  }
  return ev;
}
async function newAppNo() { for (let i = 0; i < 20; i++) { const n = `ERH-${crypto.randomInt(100000, 1000000)}`; if (!(await store.settings.get('erheat:no:' + n))) return n; } throw err(500, 'could_not_allocate_application_number'); }
async function contactable(phone) { if (await outreach.isSuppressed(phone)) throw err(409, 'That person has asked not to be contacted. Please use another contact.'); }

async function apply(account, b = {}) {
  const cfg = await getConfig(); if (!cfg.enabled) throw err(404, 'ERHEAT Shield is not open yet.');
  const line = LINES[b.line]; if (!line) throw err(422, 'Choose a loan type.');
  const lc = cfg.lines[b.line]; if (!lc.enabled) throw err(409, `${line.label} loans are coming soon.`);
  if (cfg.requireVerifiedPhone && !account.phoneVerified) throw err(403, 'Please verify your phone number first.');
  const borrowerPhone = dial(account.phone); if (!validPhone(borrowerPhone)) throw err(422, 'Your account needs a valid phone number.');
  const mine = await appsOfPhone(borrowerPhone); const pass = passportOf(mine, cfg);
  const amount = round2(b.amount); const cap = Math.min(lc.cap, cfg.hardCap, pass.ceiling);
  if (!(amount >= lc.min)) throw err(422, `The smallest amount is GHS ${lc.min}.`);
  if (amount > cap) throw err(422, `Your limit for ${line.label} is GHS ${cap}.${pass.level === 'new' ? ' It rises as you repay.' : ''}`);
  if (mine.some((a) => a.line === b.line && !TERMINAL.includes(a.status))) throw err(409, `You already have an open ${line.label} request.`);
  if (mine.filter((a) => Date.now() - Date.parse(a.createdAt) < 30 * 86400000).length >= cfg.maxApps30d) throw err(429, 'You have reached the number of requests allowed this month.');
  const evidence = checkEvidence(line, b.evidence || {}, amount);
  const payee = { name: String((b.payee || {}).name || '').trim().slice(0, 100), phone: dial((b.payee || {}).phone), type: line.verifierRole };
  if (!payee.name || !validPhone(payee.phone)) throw err(422, 'Give the payee name and a valid phone number.');
  if (payee.phone === borrowerPhone) throw err(422, 'The payee cannot be you.');
  const verifiers = [];
  const vIn = [{ role: line.verifierRole, label: line.verifierLabel, name: (b.verifier || {}).name, phone: (b.verifier || {}).phone, required: true }];
  if (line.coVerifierLabel && b.coVerifier && b.coVerifier.phone) vIn.push({ role: 'co-tenant', label: line.coVerifierLabel, name: b.coVerifier.name, phone: b.coVerifier.phone, required: true });
  for (const v of vIn) {
    const ph = dial(v.phone); if (!validPhone(ph)) throw err(422, `${v.label}: a valid phone number is needed.`);
    if (ph === borrowerPhone) throw err(422, `${v.label} cannot be your own number.`);
    if (verifiers.some((x) => x.phone === ph)) throw err(422, 'Each person must have a different phone number.');
    await contactable(ph);
    verifiers.push({ id: rid('v', 4), role: v.role, label: v.label, name: String(v.name || '').trim().slice(0, 100), phone: ph, required: v.required, token: token(), status: 'pending' });
  }
  const lang = b.lang && i18n.isKnown(b.lang) ? i18n.normalise(b.lang) : (account.language && i18n.isKnown(account.language) ? i18n.normalise(account.language) : 'en');
  const vlang = b.verifierLang && i18n.isKnown(b.verifierLang) ? i18n.normalise(b.verifierLang) : 'en';
  const flags = []; const day = Date.now() - 86400000; const open = []; for (const k of await store.settings.keys(APP)) { const a = await store.settings.get(k); if (a && Date.parse(a.createdAt) > day) open.push(a); }
  if (new Set(open.filter((a) => a.payee.phone === payee.phone).map((a) => a.borrower.phone)).size >= 3) flags.push('payee_concentration');
  for (const v of verifiers) if (new Set(open.filter((a) => a.verifiers.some((x) => x.phone === v.phone)).map((a) => a.borrower.phone)).size >= 3) flags.push('verifier_shared');
  const app = {
    id: rid('erh'), appNo: await newAppNo(), line: b.line, status: 'needs_verification', amount, verifiedAmount: null, purpose: String(b.purpose || '').trim().slice(0, 200),
    borrower: { id: account._id, phone: borrowerPhone, name: [account.first_name, account.last_name].filter(Boolean).join(' '), first: first(account.first_name), lang },
    payee, verifiers, vlang, evidence, flags: Array.from(new Set(flags)), consent: null, lender: null, voucher: null, payout: null, repayments: [], history: [],
    createdAt: now(), expiresAt: new Date(Date.now() + cfg.appTtlDays * 86400000).toISOString(),
  };
  addEvent(app, 'created', { line: b.line, amount }); await store.settings.set('erheat:no:' + app.appNo, { id: app.id }); await saveApp(app);
  for (const v of app.verifiers) { await store.settings.set(VER + v.token, { appId: app.id, verifierId: v.id }); await sendVerifierSms(app, v); }
  return borrowerView(app);
}
async function sendVerifierSms(app, v) {
  const l = LINES[app.line]; const link = `${base()}/erheat/v/${v.token}`;
  const text = `${app.borrower.first || 'Someone'} named you for ERHEAT Shield (${l.label.toLowerCase()}, GHS ${app.amount.toFixed(2)}). Please confirm or decline: ${link} Ref ${app.appNo}. If you do not know them, decline the request.`;
  return sms(v.phone, text, app.vlang);
}
async function resendVerifier(account, appId, verifierId) {
  const app = await ownApp(account, appId); if (app.status !== 'needs_verification') throw err(409, 'This request is not waiting for confirmation.');
  const v = app.verifiers.find((x) => x.id === verifierId && x.status === 'pending'); if (!v) throw err(404, 'verifier_not_found');
  const last = (app.history || []).filter((h) => h.type === 'resent' && h.detail === v.id).pop(); if (last && Date.now() - Date.parse(last.at) < 10 * 60000) throw err(429, 'Please wait a few minutes before sending it again.');
  addEvent(app, 'resent', v.id); await saveApp(app); await sendVerifierSms(app, v); return borrowerView(app);
}

// ------------------------------------------------------------------ views
function borrowerView(app) {
  const l = LINES[app.line];
  return {
    id: app.id, appNo: app.appNo, line: app.line, lineLabel: l.label, status: app.status, amount: app.amount, verifiedAmount: app.verifiedAmount, approvedAmount: (app.lender || {}).approvedAmount || null,
    payee: { name: app.payee.name, phone: mask(app.payee.phone) },
    verifiers: app.verifiers.map((v) => ({ id: v.id, label: v.label, name: v.name, phone: mask(v.phone), status: v.status })),
    nextStep: nextStep(app), voucher: app.voucher && !app.voucher.redeemedAt ? { code: app.voucher.code, expiresAt: app.voucher.expiresAt, note: 'Show this code at the vendor and give them the one-time code we texted you.' } : null,
    evidence: app.evidence, flagsCount: app.flags.length, createdAt: app.createdAt, expiresAt: app.expiresAt, history: (app.history || []).slice(-12).map((h) => ({ at: h.at, type: h.type })), repayments: app.repayments.map((r) => ({ at: r.at, amount: r.amount })),
  };
}
function nextStep(app) {
  switch (app.status) {
    case 'needs_verification': return `Waiting for ${app.verifiers.filter((v) => v.status === 'pending').map((v) => v.label.toLowerCase()).join(' and ')} to confirm.`;
    case 'verified': return 'Confirmed. Review and agree to submit your request.';
    case 'submitted': return 'With the lender. You will be told as soon as there is a decision.';
    case 'approved': return app.voucher ? 'Approved. Your voucher is ready.' : 'Approved. The lender is paying the payee.';
    case 'payee_paid': return 'The payee has been paid. Repayment follows the lender schedule.';
    case 'repaying': return 'Repaying. Thank you.';
    case 'closed': return 'Fully repaid. Your Trust Passport has grown.';
    case 'declined': return 'This request was not approved.';
    case 'expired': return 'This request expired.';
    case 'cancelled': return 'You cancelled this request.';
    case 'defaulted': return 'This loan is overdue. Please contact the lender.';
    default: return '';
  }
}
async function ownApp(account, id) {
  const app = await store.settings.get(APP + id);
  if (!app || app.borrower.id !== account._id) throw err(404, 'request_not_found');
  return app;
}
async function myApps(account) {
  const out = []; for (const k of await store.settings.keys(APP)) { const a = await store.settings.get(k); if (a && a.borrower.id === account._id) out.push(a); }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(borrowerView);
}
async function getMine(account, id) { return borrowerView(await ownApp(account, id)); }
async function cancel(account, id) {
  const app = await ownApp(account, id); if (!['needs_verification', 'verified'].includes(app.status)) throw err(409, 'This request can no longer be cancelled.');
  app.status = 'cancelled'; addEvent(app, 'cancelled'); await saveApp(app); return borrowerView(app);
}

// ------------------------------------------------------------------ verifier
async function verifierCtx(tok) {
  const ref = await store.settings.get(VER + String(tok || '')); if (!ref) throw err(404, 'This link is not valid.');
  const app = await store.settings.get(APP + ref.appId); if (!app) throw err(404, 'This link is not valid.');
  const v = app.verifiers.find((x) => x.id === ref.verifierId); if (!v) throw err(404, 'This link is not valid.');
  return { app, v };
}
async function verifierView(tok) {
  const { app, v } = await verifierCtx(tok); const l = LINES[app.line];
  const open = app.status === 'needs_verification' && v.status === 'pending' && Date.now() < Date.parse(app.expiresAt);
  return { appNo: app.appNo, line: app.line, lineLabel: l.label, role: v.role, label: v.label, question: l.question.replace('{first}', app.borrower.first || 'this person'), borrower: app.borrower.first, amount: app.amount, payeeName: app.payee.name,
    evidence: app.evidence, fields: l.fields.filter((f) => app.evidence[f.key] !== undefined).map((f) => ({ label: f.label, value: app.evidence[f.key] })), open, status: open ? 'open' : (v.status !== 'pending' ? v.status : app.status), askAccountName: v.role === app.payee.type, lang: app.vlang };
}
async function verifierRespond(tok, { decision, confirmedAmount, accountName, note, ip } = {}) {
  const { app, v } = await verifierCtx(tok);
  if (app.status !== 'needs_verification' || v.status !== 'pending') throw err(409, 'This request has already been answered or is no longer open.');
  if (Date.now() > Date.parse(app.expiresAt)) throw err(410, 'This request has expired.');
  if (!['confirm', 'decline'].includes(decision)) throw err(422, 'Choose confirm or decline.');
  const ipHash = crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 16);
  v.status = decision === 'confirm' ? 'confirmed' : 'declined'; v.at = now();
  addEvent(app, `verifier_${v.status}`, `${v.role}`); (app.confirmations = app.confirmations || []).push({ role: v.role, decision: v.status, at: v.at, channel: 'web', ipHash, note: String(note || '').slice(0, 200) });
  if (decision === 'confirm') {
    const ca = confirmedAmount !== undefined && confirmedAmount !== '' ? round2(confirmedAmount) : null;
    if (ca !== null) { if (!(ca > 0)) throw err(422, 'The confirmed amount must be above zero.'); if (ca < app.amount) { app.verifiedAmount = Math.min(app.verifiedAmount || ca, ca); app.flags.push('amount_lowered_by_verifier'); } }
    if (v.role === app.payee.type && accountName) { v.accountName = String(accountName).slice(0, 100); if (!nameMatch(accountName, app.payee.name)) app.flags.push('payee_name_mismatch'); }
  }
  app.flags = Array.from(new Set(app.flags));
  if (decision === 'decline') { app.status = 'declined'; app.declineReason = 'verifier_declined'; await saveApp(app); await tellBorrower(app, 'ERHEAT Shield', `${v.label} did not confirm request ${app.appNo}.`); return { ok: true, status: 'declined' }; }
  if (app.verifiers.filter((x) => x.required).every((x) => x.status === 'confirmed')) {
    app.status = 'verified'; if (!app.verifiedAmount) app.verifiedAmount = app.amount; addEvent(app, 'verified');
    await saveApp(app); await tellBorrower(app, 'ERHEAT Shield', `Request ${app.appNo} is confirmed. Open the app to agree and submit it.`); return { ok: true, status: 'verified' };
  }
  await saveApp(app); return { ok: true, status: 'confirmed' };
}

// ------------------------------------------------------------------ consent and lender
function packet(app, cfg) {
  const l = LINES[app.line];
  return {
    appNo: app.appNo, line: app.line, lineLabel: l.label, amountRequested: app.amount, amountVerified: app.verifiedAmount, currency: 'GHS',
    borrower: { name: app.borrower.name, phone: app.borrower.phone, language: app.borrower.lang },
    payee: { name: app.payee.name, phone: app.payee.phone, type: app.payee.type }, evidence: app.evidence,
    confirmations: (app.confirmations || []).map((c) => ({ role: c.role, decision: c.decision, at: c.at, channel: c.channel })),
    flags: app.flags, consent: app.consent, passport: null, paymentInstruction: app.voucher ? 'Pay the payee when the voucher is redeemed.' : 'Pay the payee directly; never the borrower.',
    lender: cfg.lender.name,
  };
}
let _post = (url, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(url); const lib = u.protocol === 'http:' ? http : https; const data = JSON.stringify(body);
  const req = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }, timeout: 15000 }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.write(data); req.end();
});
function _setPostImplForTests(fn) { _post = fn || _post; }
async function consent(account, id, { agree, ip } = {}) {
  const app = await ownApp(account, id); const cfg = await getConfig();
  if (app.status !== 'verified') throw err(409, 'This request is not ready to submit.');
  if (!agree || agree === 'false') throw err(422, 'Please agree to continue.');
  app.consent = { at: now(), textVersion: TEXT_VERSION, text: CONSENT_TEXT, ipHash: crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 16) };
  app.status = 'submitted'; app.passport = passportOf(await appsOfPhone(app.borrower.phone), cfg); addEvent(app, 'submitted');
  const pk = packet(app, cfg); pk.passport = { level: app.passport.level, repaid: app.passport.repaid, defaults: app.passport.defaults };
  app.lender = { pushed: false };
  if (cfg.lender.pushUrl) {
    const body = { event: 'application', packet: pk, callbacks: await hookUrls() }; const sig = crypto.createHmac('sha256', await secret()).update(JSON.stringify(body)).digest('hex');
    try { const r = await _post(cfg.lender.pushUrl, body, { 'x-erheat-signature': `sha256=${sig}` }); app.lender = { pushed: r.status >= 200 && r.status < 300, httpStatus: r.status, at: now() }; if (!app.lender.pushed) addEvent(app, 'push_failed', String(r.status)); }
    catch (e) { app.lender = { pushed: false, error: 'unreachable', at: now() }; addEvent(app, 'push_failed', 'unreachable'); }
  }
  await saveApp(app); return borrowerView(app);
}
async function packetByAppNo(appNo) { const id = await store.settings.get('erheat:no:' + String(appNo || '').toUpperCase()); const app = id && await store.settings.get(APP + id.id); if (!app) throw err(404, 'application_not_found'); const p = packet(app, await getConfig()); if (app.passport) p.passport = { level: app.passport.level, repaid: app.passport.repaid, defaults: app.passport.defaults }; return { status: app.status, packet: p }; }
async function byAppNo(appNo) { const id = await store.settings.get('erheat:no:' + String(appNo || '').toUpperCase()); const app = id && await store.settings.get(APP + id.id); if (!app) throw err(404, 'application_not_found'); return app; }
const seen = async (key) => { if (await store.settings.get(REP + key)) return true; await store.settings.set(REP + key, { at: now() }); return false; };

async function recordDecision({ applicationNo, decision, approvedAmount, reference, reason } = {}) {
  const app = await byAppNo(applicationNo);
  if (!['submitted', 'approved'].includes(app.status)) throw err(409, `Request is ${app.status}.`);
  if (!['approved', 'declined'].includes(decision)) throw err(422, 'decision must be approved or declined');
  if (decision === 'declined') { app.status = 'declined'; app.declineReason = String(reason || '').slice(0, 200); app.lender = { ...(app.lender || {}), decision, reference: reference || null, at: now() }; addEvent(app, 'declined'); await saveApp(app); await tellBorrower(app, 'ERHEAT Shield', `Request ${app.appNo} was not approved.`); return borrowerView(app); }
  const cap = Math.min(app.verifiedAmount || app.amount, HARD_CAP); const amt = approvedAmount === undefined ? cap : round2(approvedAmount);
  if (!(amt > 0) || amt > cap) throw err(422, `approvedAmount must be above zero and at most ${cap}`);
  if (app.status === 'approved') return borrowerView(app);
  app.status = 'approved'; app.lender = { ...(app.lender || {}), decision, approvedAmount: amt, reference: reference || null, at: now() }; addEvent(app, 'approved', String(amt));
  if (LINES[app.line].voucher) {
    const otp = String(crypto.randomInt(100000, 1000000)); const code = token(8).toUpperCase();
    app.voucher = { code, otpHash: crypto.createHash('sha256').update(otp + code).digest('hex'), amount: amt, payeePhone: app.payee.phone, expiresAt: new Date(Date.now() + 48 * 3600000).toISOString(), attempts: 0, redeemedAt: null };
    await store.settings.set(VCH + code, { appId: app.id }); await saveApp(app);
    await sms(app.borrower.phone, `ERHEAT Shield voucher ${code} for GHS ${amt.toFixed(2)} at ${app.payee.name}. One-time code: ${otp}. Valid 48 hours. Give the code to the vendor only when you collect.`, app.borrower.lang);
    await tellBorrower(app, 'ERHEAT Shield', `Request ${app.appNo} approved for GHS ${amt.toFixed(2)}. Your voucher is in the app.`); return borrowerView(app);
  }
  await saveApp(app); await tellBorrower(app, 'ERHEAT Shield', `Request ${app.appNo} approved for GHS ${amt.toFixed(2)}. The lender is paying ${app.payee.name}.`); return borrowerView(app);
}
async function recordPaid({ applicationNo, reference, paidAt } = {}) {
  const app = await byAppNo(applicationNo); if (app.status === 'payee_paid' || app.status === 'repaying') return borrowerView(app);
  if (app.status !== 'approved') throw err(409, `Request is ${app.status}.`);
  app.status = 'payee_paid'; app.payout = { reference: reference || null, at: paidAt || now(), method: 'lender' }; addEvent(app, 'payee_paid'); await saveApp(app);
  await tellBorrower(app, 'ERHEAT Shield', `${app.payee.name} has been paid for request ${app.appNo}.`); return borrowerView(app);
}
async function recordRepayment({ applicationNo, amount, reference, outstanding, event } = {}) {
  const app = await byAppNo(applicationNo);
  if (event === 'default') { if (app.status !== 'defaulted') { app.status = 'defaulted'; addEvent(app, 'defaulted'); await saveApp(app); } return borrowerView(app); }
  if (!['payee_paid', 'repaying'].includes(app.status)) throw err(409, `Request is ${app.status}.`);
  const amt = round2(amount); if (!(amt > 0)) throw err(422, 'amount must be above zero');
  const key = `${app.id}:${reference || ''}`; if (reference && await seen(key)) return borrowerView(app);
  app.repayments.push({ at: now(), amount: amt, reference: reference || null }); app.status = 'repaying';
  if (outstanding !== undefined && Number(outstanding) <= 0) { app.status = 'closed'; addEvent(app, 'closed'); await saveApp(app); await tellBorrower(app, 'ERHEAT Shield', `Request ${app.appNo} is fully repaid. Your limit may now be higher.`); return borrowerView(app); }
  addEvent(app, 'repayment', String(amt)); await saveApp(app); return borrowerView(app);
}

// ------------------------------------------------------------------ vouchers
const rate = new Map();
async function redeem({ code, otp, phone } = {}) {
  const k = String(code || '').toUpperCase(); const hits = (rate.get(k) || []).filter((t) => Date.now() - t < 600000); if (hits.length >= 8) throw err(429, 'Too many attempts. Please wait.'); hits.push(Date.now()); rate.set(k, hits);
  const ref = await store.settings.get(VCH + k); const app = ref && await store.settings.get(APP + ref.appId); const v = app && app.voucher;
  if (!v || v.redeemedAt) throw err(404, 'This voucher is not valid.');
  if (Date.now() > Date.parse(v.expiresAt)) throw err(410, 'This voucher has expired.');
  if (dial(phone) !== v.payeePhone) throw err(403, 'This voucher is for another vendor.');
  const good = crypto.createHash('sha256').update(String(otp || '') + k).digest('hex') === v.otpHash;
  if (!good) { v.attempts += 1; await saveApp(app); throw err(422, 'The one-time code is not correct.'); }
  v.redeemedAt = now(); app.status = 'payee_paid'; app.payout = { reference: `voucher:${k}`, at: v.redeemedAt, method: 'voucher' }; addEvent(app, 'voucher_redeemed'); await saveApp(app);
  await tellBorrower(app, 'ERHEAT Shield', `Voucher ${k} was used at ${app.payee.name}.`);
  return { ok: true, amount: v.amount, payee: app.payee.name, appNo: app.appNo, note: 'Release the goods or service. The lender settles with you on redemption.' };
}

// ------------------------------------------------------------------ operator
async function listAll({ status, line, limit = 100 } = {}) {
  const out = []; for (const k of await store.settings.keys(APP)) { const a = await store.settings.get(k); if (a && (!status || a.status === status) && (!line || a.line === line)) out.push(a); }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const by = {}; for (const a of out) by[a.status] = (by[a.status] || 0) + 1;
  return { total: out.length, byStatus: by, flagged: out.filter((a) => a.flags.length).length,
    rows: out.slice(0, Math.min(500, +limit || 100)).map((a) => ({ id: a.id, appNo: a.appNo, line: a.line, status: a.status, amount: a.amount, verifiedAmount: a.verifiedAmount, borrower: a.borrower.name, phone: mask(a.borrower.phone), payee: a.payee.name, flags: a.flags, createdAt: a.createdAt })) };
}
async function adminGet(id) { const a = await store.settings.get(APP + id); if (!a) throw err(404, 'request_not_found'); const { voucher, ...rest } = a; return { ...rest, voucher: voucher ? { code: voucher.code, amount: voucher.amount, redeemedAt: voucher.redeemedAt, expiresAt: voucher.expiresAt } : null }; }
/** Sandbox only: act as the lender so the flow can be rehearsed end to end. */
async function simulate(id, { action, amount } = {}) {
  if (!(await operatingMode.isSettlementSandbox())) throw err(403, 'Simulation is only available in sandbox mode.');
  const a = await store.settings.get(APP + id); if (!a) throw err(404, 'request_not_found');
  if (action === 'approve') return recordDecision({ applicationNo: a.appNo, decision: 'approved', approvedAmount: amount, reference: 'SIM' });
  if (action === 'decline') return recordDecision({ applicationNo: a.appNo, decision: 'declined', reason: 'simulated' });
  if (action === 'paid') return recordPaid({ applicationNo: a.appNo, reference: 'SIM' });
  if (action === 'repay') return recordRepayment({ applicationNo: a.appNo, amount: amount || a.verifiedAmount, reference: 'SIM-' + Date.now(), outstanding: 0 });
  throw err(422, 'action must be approve, decline, paid or repay');
}
async function sweep() {
  let n = 0; for (const k of await store.settings.keys(APP)) {
    const a = await store.settings.get(k); if (!a || !['needs_verification', 'verified'].includes(a.status) || Date.now() < Date.parse(a.expiresAt)) continue;
    a.status = 'expired'; addEvent(a, 'expired'); await saveApp(a); n++;
  }
  return { expired: n };
}

module.exports = {
  HARD_CAP, LINES, CONSENT_TEXT, getConfig, setConfig, rotateSecret, checkSecret, hookUrls, lines, passport, apply, resendVerifier, myApps, getMine, cancel,
  verifierView, verifierRespond, consent, packetByAppNo, recordDecision, recordPaid, recordRepayment, redeem, listAll, adminGet, simulate, sweep, _setPostImplForTests,
};
