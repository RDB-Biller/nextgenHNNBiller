'use strict';

/**
 * Outreach -- Master Control's B2B prospecting engine for banks, insurers, core-banking vendors, EHR/EMR vendors,
 * claims-adjudication vendors and hospitals. Goal: get decision makers (CEO, CTO, CMO, product, sales, claims) to
 * open the sandbox, try it and say what they want added.
 *
 * It is deliberately "aggressive about persistence, strict about consent":
 *   - Business contacts only. Every contact needs a public SOURCE (URL / note) and a work address: free-mail
 *     addresses (gmail, yahoo ...) are refused for cold email.
 *   - Every message carries who we are and a one-click opt-out; SMS says "Reply STOP". STOP, an unsubscribe click or a
 *     delete request puts the address/number on a permanent suppression list (stored hashed) that blocks every
 *     channel, every sequence, every future import.
 *   - LinkedIn is never automated (it forbids it and bans accounts): sequences create a task with the personalised
 *     text and the profile link for a person to send by hand.
 *   - WhatsApp cold-messaging breaches WhatsApp's business policy and gets numbers banned, so a WhatsApp step only
 *     runs for contacts flagged `waOptIn` (they replied, or agreed). Otherwise it is skipped.
 *   - Nothing is sent until the module is switched ON, a sender identity + postal address is set, and the channel's
 *     provider is live. Daily caps, quiet hours and pacing apply. Dry-run shows exactly what would go out.
 *   - Messages are translated into the contact's language through LibreTranslate when it is configured (cached);
 *     otherwise they go in English.
 */

const crypto = require('crypto');
const store = require('../store');
const messaging = require('./messaging');
const email = require('./email');
const i18n = require('./i18n');
const seed = require('../data/outreachSeed');

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const rid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = ['bank', 'insurer', 'reinsurer', 'core_banking', 'ehr', 'adjudication', 'hospital', 'other'];
const PERSONAS = ['ceo', 'cto', 'cmo', 'product', 'sales', 'claims', 'ops', 'other'];
const ORG_STATUS = ['new', 'contacting', 'engaged', 'sandbox', 'meeting', 'partner', 'declined'];
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com']);
const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

// ----------------------------------------------------------------- settings
const CFG = 'out:cfg';
const DEFAULTS = {
  enabled: false, senderName: '', senderRole: '', senderOrg: 'HNN Biller / TrimesterSave', postalAddress: '', replyTo: '',
  sandboxUrl: 'https://hnnbiller.xchangeinsure.com', patientAppUrl: 'https://tmsapp.trimestersave.com', publicBaseUrl: '',
  caps: { email: 50, sms: 30, whatsapp: 30 }, hours: { from: 8, to: 16 }, paceMs: 400,
};
async function getConfig() {
  const s = (await store.settings.get(CFG)) || {};
  return { ...DEFAULTS, ...s, caps: { ...DEFAULTS.caps, ...(s.caps || {}) }, hours: { ...DEFAULTS.hours, ...(s.hours || {}) } };
}
async function setConfig(p = {}, by) {
  const c = await getConfig();
  for (const k of ['senderName', 'senderRole', 'senderOrg', 'postalAddress', 'replyTo', 'sandboxUrl', 'patientAppUrl', 'publicBaseUrl']) if (p[k] !== undefined) c[k] = String(p[k] || '').trim().slice(0, 300);
  for (const k of ['sandboxUrl', 'patientAppUrl', 'publicBaseUrl']) if (c[k] && !/^https?:\/\//i.test(c[k])) throw err(422, `${k} must start with http:// or https://`);
  if (p.enabled !== undefined) c.enabled = !!p.enabled;
  if (p.caps) for (const ch of ['email', 'sms', 'whatsapp']) if (p.caps[ch] !== undefined) { const n = Number(p.caps[ch]); if (!(n >= 0 && n <= 2000)) throw err(422, 'caps must be 0-2000'); c.caps[ch] = Math.floor(n); }
  if (p.hours) { const f = Number(p.hours.from); const t = Number(p.hours.to); if (!(f >= 0 && t <= 24 && f < t)) throw err(422, 'hours must be 0-24 with from < to'); c.hours = { from: f, to: t }; }
  c.updatedAt = now(); c.updatedBy = by || null;
  await store.settings.set(CFG, c);
  return publicConfig();
}
async function publicConfig() {
  const c = await getConfig();
  const ready = [];
  if (!c.senderName) ready.push('sender name');
  if (!c.postalAddress) ready.push('postal address');
  if (!c.publicBaseUrl) ready.push('public base URL (for unsubscribe/tracking links)');
  return { ...c, readyToSend: ready.length === 0, missing: ready, emailConfigured: email.configured() };
}

// ----------------------------------------------------------- organisations
const ORGS = 'out:orgs';
async function allOrgs() { return (await store.settings.get(ORGS)) || []; }
async function saveOrgs(a) { await store.settings.set(ORGS, a); }
async function seedOrgs() {
  const cur = await allOrgs(); const have = new Set(cur.map((o) => `${o.type}|${o.name.toUpperCase()}`));
  let added = 0;
  for (const s of seed) {
    if (have.has(`${s.type}|${s.name.toUpperCase()}`)) continue;
    cur.push({ id: rid('org'), name: s.name, type: s.type, country: s.country || '', website: '', note: s.note || '', tier: s.rank || '', status: 'new', createdAt: now() });
    added++;
  }
  await saveOrgs(cur); return { added, total: cur.length };
}
async function listOrgs({ type, status, q, country, page = 1, pageSize = 50 } = {}) {
  let a = await allOrgs();
  if (type) a = a.filter((o) => o.type === type);
  if (status) a = a.filter((o) => o.status === status);
  if (country) a = a.filter((o) => (o.country || '').toLowerCase() === String(country).toLowerCase());
  if (q) { const s = String(q).toLowerCase(); a = a.filter((o) => `${o.name} ${o.country} ${o.note}`.toLowerCase().includes(s)); }
  const counts = {}; for (const c of await allContacts()) counts[c.orgId] = (counts[c.orgId] || 0) + 1;
  const total = a.length; const p = Math.max(1, +page || 1); const n = Math.min(200, Math.max(1, +pageSize || 50));
  return { total, page: p, pageSize: n, rows: a.slice((p - 1) * n, p * n).map((o) => ({ ...o, contacts: counts[o.id] || 0 })) };
}
async function addOrg(b = {}) {
  const name = String(b.name || '').trim().slice(0, 120); if (!name) throw err(422, 'name_required');
  if (!TYPES.includes(b.type)) throw err(422, `type must be one of ${TYPES.join(', ')}`);
  const a = await allOrgs();
  const o = { id: rid('org'), name, type: b.type, country: String(b.country || '').slice(0, 60), website: String(b.website || '').slice(0, 200), note: String(b.note || '').slice(0, 400), tier: '', status: 'new', createdAt: now() };
  a.push(o); await saveOrgs(a); return o;
}
async function updateOrg(id, b = {}) {
  const a = await allOrgs(); const o = a.find((x) => x.id === id); if (!o) throw err(404, 'org_not_found');
  for (const k of ['name', 'country', 'website', 'note']) if (b[k] !== undefined) o[k] = String(b[k]).slice(0, 400);
  if (b.type !== undefined) { if (!TYPES.includes(b.type)) throw err(422, 'bad_type'); o.type = b.type; }
  if (b.status !== undefined) { if (!ORG_STATUS.includes(b.status)) throw err(422, 'bad_status'); o.status = b.status; }
  await saveOrgs(a); return o;
}
async function bumpOrg(orgId, status) {
  const a = await allOrgs(); const o = a.find((x) => x.id === orgId); if (!o) return;
  if (ORG_STATUS.indexOf(status) > ORG_STATUS.indexOf(o.status) && o.status !== 'declined') { o.status = status; await saveOrgs(a); }
}

// ---------------------------------------------------------- suppression list
const supKey = (v) => 'out:sup:' + sha(String(v).trim().toLowerCase());
async function suppress(value, reason) {
  if (!value) return;
  await store.settings.set(supKey(value), { reason: reason || 'opt_out', at: now() }); // hash only: the value itself is not kept
}
async function isSuppressed(value) { return !!value && !!(await store.settings.get(supKey(value))); }
const canonPhone = (raw) => messaging.toDialable(String(raw || '').replace(/^whatsapp:/i, '').replace(/[\s().-]/g, ''));
const validPhone = (p) => /^\+\d{8,15}$/.test(p);

// ------------------------------------------------------------------ contacts
const CON = 'out:con:';
async function allContacts() { const out = []; for (const k of await store.settings.keys(CON)) { const c = await store.settings.get(k); if (c) out.push(c); } return out; }
const conPublic = (c) => ({ ...c, history: (c.history || []).slice(-15) });

async function addContact(b = {}, { by } = {}) {
  const orgs = await allOrgs(); const org = orgs.find((o) => o.id === b.orgId); if (!org) throw err(422, 'org_required');
  const name = String(b.name || '').trim().slice(0, 100); if (!name) throw err(422, 'name_required');
  const source = String(b.source || '').trim().slice(0, 300);
  if (!source) throw err(422, 'source_required: record the public page where this business contact was found');
  const persona = PERSONAS.includes(b.persona) ? b.persona : 'other';
  let em = String(b.email || '').trim().toLowerCase(); let ph = b.phone ? canonPhone(b.phone) : '';
  if (!em && !ph && !b.linkedin) throw err(422, 'email, phone or linkedin required');
  if (em) {
    if (!EMAIL_RE.test(em)) throw err(422, 'email_invalid');
    if (FREE_MAIL.has(em.split('@')[1])) throw err(422, 'free-mail addresses are not allowed for B2B cold outreach; use a work address');
  }
  if (ph && !validPhone(ph)) throw err(422, 'phone_invalid');
  if (b.linkedin && !/^https:\/\/([\w-]+\.)?linkedin\.com\//i.test(b.linkedin)) throw err(422, 'linkedin must be a linkedin.com URL');
  if ((em && (await isSuppressed(em))) || (ph && (await isSuppressed(ph)))) throw err(409, 'suppressed: this person opted out or asked to be erased');
  const all = await allContacts();
  const dup = all.find((c) => (em && c.email === em) || (ph && c.phone === ph) || (b.linkedin && c.linkedin === b.linkedin));
  if (dup) throw err(409, 'duplicate_contact');
  const lang = b.lang && i18n.isKnown(b.lang) ? i18n.normalise(b.lang) : 'en';
  const c = {
    id: rid('con'), orgId: org.id, name, role: String(b.role || '').slice(0, 100), persona, email: em, phone: ph, linkedin: b.linkedin || '',
    lang, source, lawfulBasis: 'legitimate_interest_b2b', waOptIn: !!b.waOptIn, status: 'new', seq: null, history: [], token: crypto.randomBytes(9).toString('base64url'),
    createdAt: now(), createdBy: by || null,
  };
  await store.settings.set(CON + c.id, c); await store.settings.set('out:tok:' + c.token, { id: c.id });
  return conPublic(c);
}
async function importContacts(rows, opts) {
  const res = { added: 0, rejected: [] };
  for (const [i, r] of (Array.isArray(rows) ? rows : []).slice(0, 2000).entries()) {
    try {
      let orgId = r.orgId;
      if (!orgId && r.org) { const o = (await allOrgs()).find((x) => x.name.toLowerCase() === String(r.org).toLowerCase()); orgId = o && o.id; }
      await addContact({ ...r, orgId }, opts); res.added++;
    } catch (e) { res.rejected.push({ row: i + 1, error: e.message }); }
  }
  return res;
}
async function listContacts({ orgId, status, persona, q, page = 1, pageSize = 50 } = {}) {
  let a = await allContacts();
  if (orgId) a = a.filter((c) => c.orgId === orgId);
  if (status) a = a.filter((c) => c.status === status);
  if (persona) a = a.filter((c) => c.persona === persona);
  if (q) { const s = String(q).toLowerCase(); a = a.filter((c) => `${c.name} ${c.role} ${c.email}`.toLowerCase().includes(s)); }
  const orgs = new Map((await allOrgs()).map((o) => [o.id, o]));
  const total = a.length; const p = Math.max(1, +page || 1); const n = Math.min(200, Math.max(1, +pageSize || 50));
  return { total, page: p, pageSize: n, rows: a.slice((p - 1) * n, p * n).map((c) => ({ ...conPublic(c), orgName: (orgs.get(c.orgId) || {}).name })) };
}
async function getContact(id) { const c = await store.settings.get(CON + id); if (!c) throw err(404, 'contact_not_found'); return c; }
async function saveContact(c) { await store.settings.set(CON + c.id, c); }
function note(c, ev) { c.history = (c.history || []).concat({ at: now(), ...ev }).slice(-200); }
async function setContactStatus(id, status, by) {
  const c = await getContact(id);
  if (!['new', 'queued', 'contacted', 'replied', 'sandbox', 'meeting', 'declined'].includes(status)) throw err(422, 'bad_status');
  c.status = status; if (['replied', 'sandbox', 'meeting', 'declined'].includes(status)) c.seq = null;
  note(c, { type: 'status', status, by: by || null }); await saveContact(c);
  await bumpOrg(c.orgId, { replied: 'engaged', sandbox: 'sandbox', meeting: 'meeting', declined: 'declined' }[status] || 'contacting');
  return conPublic(c);
}
async function patchContact(id, b = {}) {
  const c = await getContact(id);
  if (b.waOptIn !== undefined) c.waOptIn = !!b.waOptIn;
  if (b.lang !== undefined && i18n.isKnown(b.lang)) c.lang = i18n.normalise(b.lang);
  if (b.persona !== undefined && PERSONAS.includes(b.persona)) c.persona = b.persona;
  if (b.role !== undefined) c.role = String(b.role).slice(0, 100);
  await saveContact(c); return conPublic(c);
}
/** Erase a person (privacy request). Their address/number is kept only as a hash on the suppression list. */
async function eraseContact(id) {
  const c = await getContact(id);
  for (const v of [c.email, c.phone, c.linkedin]) if (v) await suppress(v, 'erased');
  await store.settings.set(CON + id, null); await store.settings.set('out:tok:' + c.token, null);
  return { erased: true };
}
async function optOut(token, reason) {
  const ref = await store.settings.get('out:tok:' + token); if (!ref || !ref.id) return { ok: false };
  const c = await store.settings.get(CON + ref.id); if (!c) return { ok: false };
  for (const v of [c.email, c.phone]) if (v) await suppress(v, reason || 'unsubscribe');
  c.status = 'declined'; c.seq = null; c.optedOut = true; note(c, { type: 'opt_out', reason: reason || 'unsubscribe' }); await saveContact(c);
  await bumpOrg(c.orgId, 'new'); return { ok: true };
}
/** SMS "STOP" (or similar) from a number we texted. */
async function handleInboundText(from, text) {
  const ph = canonPhone(from); if (!validPhone(ph)) return null;
  const t = String(text || '').trim().toUpperCase();
  const isStop = /^(STOP|UNSUBSCRIBE|QUIT|CANCEL|END|OPT ?OUT)\b/.test(t);
  const c = (await allContacts()).find((x) => x.phone === ph);
  if (isStop) { await suppress(ph, 'sms_stop'); if (c) { if (c.email) await suppress(c.email, 'sms_stop'); c.status = 'declined'; c.seq = null; c.optedOut = true; note(c, { type: 'opt_out', reason: 'sms_stop' }); await saveContact(c); } return { outcome: 'outreach_opt_out', reply: 'You have been unsubscribed and will not hear from us again.' }; }
  if (c) { c.status = c.status === 'declined' ? c.status : 'replied'; c.seq = null; c.waOptIn = true; note(c, { type: 'reply', channel: 'sms' }); await saveContact(c); await bumpOrg(c.orgId, 'engaged'); return { outcome: 'outreach_reply' }; }
  return null;
}

// ----------------------------------------------------------------- templates
const SEGMENTS = ['bank', 'insurer_health', 'insurer_general', 'core_banking', 'ehr', 'adjudication', 'hospital'];
const segmentOf = (org, contact) => {
  switch (org.type) {
    case 'bank': return 'bank';
    case 'insurer': case 'reinsurer': return contact && contact.persona === 'claims' ? 'insurer_health' : 'insurer_general';
    case 'core_banking': return 'core_banking';
    case 'ehr': return 'ehr';
    case 'adjudication': return 'adjudication';
    case 'hospital': return 'hospital';
    default: return 'bank';
  }
};
const T = {
  bank: {
    subject: 'Embedded savings + micro-credit for {org} customers: try the sandbox',
    pitch: 'a ready-to-embed finance layer for your app and USSD: goal-based savings plans and micro-loans (health first, then education, agriculture, transport, rent and energy under our HEAT Shield programme). Credit demand is higher than savings demand, so we suggest credit first, with your credit-scoring partner. It plugs into your app, USSD or MoMo rails by API, so you keep the customer and the balance sheet decisions.',
  },
  insurer_health: {
    subject: 'Faster claims adjudication for {org}: rules + optional AI, in a sandbox',
    pitch: 'a claims adjudication workbench: configurable rules, optional AI assistance (off by default; fully optional, nothing depends on an AI vendor), prior approval, settlement batches and an API your claims system can call. Members get micro-credit for out-of-pocket costs and savings plans for predictable needs, which cuts leakage and delays.',
  },
  insurer_general: {
    subject: 'Claims adjudication and embedded micro-credit for {org}: try the sandbox',
    pitch: 'a claims adjudication workbench for any line of business: rules you can edit without code, optional AI assistance (off by default), audit trails, settlement batches and an API. Beyond claims, your customers can be offered micro-credit and savings through your own app or USSD.',
  },
  core_banking: {
    subject: 'A finance-for-impact module your {org} banks can switch on through APIs',
    pitch: 'an embedded finance module that sits beside your core: savings plans and micro-loan offers (health, education, agriculture, transport, rent, energy) triggered from verified bills and goals, delivered over REST APIs, webhooks, USSD and SMS/WhatsApp. It gives your bank clients a new revenue line without touching the ledger.',
  },
  ehr: {
    subject: 'Let {org} hospitals bill, get claims paid and offer payment plans from inside your EHR',
    pitch: 'a billing, claims and patient-finance layer your EHR can call: push a bill by API, get insurance claims adjudicated and tracked, and give the patient instant micro-credit or a savings plan, with receipts by SMS and WhatsApp. Embedded means your users never leave your screens.',
  },
  adjudication: {
    subject: 'Partner on adjudication and patient finance: {org} + HNN Biller',
    pitch: 'an adjudication and settlement layer that can run beside or inside your platform, with rule packs, optional AI assistance, APIs and webhooks, plus embedded micro-credit and savings for the patient at the point of care. We would like your feedback on what is missing.',
  },
  hospital: {
    subject: 'Bill faster, get claims paid, offer patients credit: sandbox for {org}',
    pitch: 'a billing and claims workbench with an InsureCredit micro-loan offer on any bill, savings plans for planned care (for example BirthPrep) and SMS/WhatsApp receipts. It connects to your EHR or runs on its own.',
  },
};
const CTA = (cfg) => `Try it in 2 minutes (no commitment): {sandbox_link}\n1) Click "New bill" top-right, fill it in, then open the InsureCredit tab to see an offer.\n2) Register on the patient app at ${cfg.patientAppUrl} and set up a savings plan.\nTell us what you would want added: {feedback_link}`;
function renderTemplate(channel, segment, persona, cfg) {
  const t = T[segment] || T.bank;
  if (channel === 'email') {
    const intro = { ceo: 'a short note for the CEO office', cto: 'a short note for the technology team', cmo: 'a short note for marketing and customer growth', product: 'a short note for product', sales: 'a short note for sales', claims: 'a short note for claims', ops: 'a short note for operations', other: 'a short note' }[persona] || 'a short note';
    return { subject: t.subject, body: `Dear {first_name},\n\nThis is ${intro} at {org}. We have built ${t.pitch}\n\n${CTA(cfg)}\n\nIf a 15-minute demo is easier, just reply with a time that suits you.\n\n{sender_signature}` };
  }
  if (channel === 'sms') return { body: 'Hi {first_name}, {sender_first} from HNN Biller. Embedded savings, micro-credit & claims adjudication your teams can test free: {sandbox_link} . Reply STOP to opt out.' };
  if (channel === 'whatsapp') return { body: 'Hi {first_name}, thanks for your interest. Here is the sandbox: {sandbox_link} . Feedback form: {feedback_link} . Reply STOP to opt out.' };
  return { body: `Hi {first_name}, I lead {sender_org}. We built ${t.pitch.split('. ')[0]}. Would you try our sandbox and tell us what to add? {sandbox_link}` }; // linkedin (<300 chars goal; trimmed on use)
}

// ----------------------------------------------------------------- sequences
const SEQS = 'out:seqs';
const DEFAULT_SEQS = [
  { id: 'standard', name: 'Standard 5-touch', steps: [
    { delayDays: 0, channel: 'email' }, { delayDays: 1, channel: 'linkedin' }, { delayDays: 4, channel: 'email', variant: 'followup' },
    { delayDays: 7, channel: 'sms' }, { delayDays: 14, channel: 'email', variant: 'last' } ] },
  { id: 'email-only', name: 'Email only (3 touches)', steps: [{ delayDays: 0, channel: 'email' }, { delayDays: 5, channel: 'email', variant: 'followup' }, { delayDays: 12, channel: 'email', variant: 'last' }] },
  { id: 'warm', name: 'Warm (replied / opted in): WhatsApp + email', steps: [{ delayDays: 0, channel: 'whatsapp' }, { delayDays: 2, channel: 'email', variant: 'followup' }] },
];
async function listSequences() { return (await store.settings.get(SEQS)) || DEFAULT_SEQS; }
async function getSeq(id) { const s = (await listSequences()).find((x) => x.id === id); if (!s) throw err(404, 'sequence_not_found'); return s; }

async function enroll({ contactIds, orgType, persona, sequenceId = 'standard', limit = 500 } = {}) {
  const seq = await getSeq(sequenceId); const orgs = new Map((await allOrgs()).map((o) => [o.id, o]));
  let list = Array.isArray(contactIds) && contactIds.length ? (await Promise.all(contactIds.map((i) => store.settings.get(CON + i)))).filter(Boolean) : await allContacts();
  list = list.filter((c) => c.status === 'new' && !c.seq && !c.optedOut && (!orgType || (orgs.get(c.orgId) || {}).type === orgType) && (!persona || c.persona === persona)).slice(0, limit);
  let n = 0;
  for (const c of list) {
    if ((c.email && (await isSuppressed(c.email))) || (c.phone && (await isSuppressed(c.phone)))) continue;
    c.seq = { id: seq.id, step: 0, nextAt: now() }; c.status = 'queued'; note(c, { type: 'enrolled', sequence: seq.id }); await saveContact(c); n++;
  }
  return { enrolled: n, sequence: seq.id };
}
async function pause(contactId) { const c = await getContact(contactId); c.seq = null; if (c.status === 'queued') c.status = 'new'; note(c, { type: 'paused' }); await saveContact(c); return conPublic(c); }

// ------------------------------------------------------------------- sending
const dayKey = () => new Date().toISOString().slice(0, 10);
async function sentToday(channel) { return ((await store.settings.get(`out:cnt:${dayKey()}:${channel}`)) || { n: 0 }).n; }
async function bumpSent(channel) { await store.settings.set(`out:cnt:${dayKey()}:${channel}`, { n: (await sentToday(channel)) + 1 }); }

async function publicUrls(c, cfg) {
  const base = String(cfg.publicBaseUrl || '').replace(/\/$/, '');
  return { sandbox: `${base}/o/t/${c.token}`, feedback: `${base}/o/feedback?t=${c.token}`, unsub: `${base}/o/u/${c.token}` };
}
function fill(s, vars) { return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : vars[k])); }

/** Build the exact message a step would send (also used by dry-run and the preview in Master Control). */
async function compose(c, org, step, cfg) {
  const segment = segmentOf(org, c);
  const tpl = renderTemplate(step.channel, segment, c.persona, cfg);
  const urls = await publicUrls(c, cfg);
  const first = (c.name || '').trim().split(/\s+/)[0] || 'there';
  const sig = `${cfg.senderName}${cfg.senderRole ? ', ' + cfg.senderRole : ''}\n${cfg.senderOrg}${cfg.replyTo ? '\n' + cfg.replyTo : ''}`;
  const vars = { first_name: first, org: org.name, sandbox_link: urls.sandbox, feedback_link: urls.feedback, sender_signature: sig, sender_first: (cfg.senderName || '').split(/\s+/)[0], sender_org: cfg.senderOrg };
  let subject = tpl.subject ? fill(tpl.subject, vars) : undefined; let body = fill(tpl.body, vars);
  if (step.variant === 'followup') { subject = subject && 'Re: ' + subject; body = `Dear ${first},\n\nA quick follow-up in case my note got buried. The sandbox takes two minutes and I would value your honest view on what is missing.\n\n${CTA(cfg).replace('{sandbox_link}', urls.sandbox).replace('{feedback_link}', urls.feedback)}\n\n${sig}`; }
  if (step.variant === 'last') { subject = subject && 'Closing the loop: ' + subject; body = `Dear ${first},\n\nI will stop here so I do not crowd your inbox. If embedded savings, micro-credit or claims adjudication is on your roadmap, the sandbox stays open: ${urls.sandbox}\nAnd if you would rather not hear from us, use the link below.\n\n${sig}`; }
  let translated = false;
  if (c.lang && c.lang !== 'en') {
    const tb = await i18n.translate(body, 'en', c.lang); if (tb.ok) { body = tb.text; translated = true; }
    if (subject) { const ts = await i18n.translate(subject, 'en', c.lang); if (ts.ok) subject = ts.text; }
  }
  if (step.channel === 'email') body += `\n\n--\nYou are receiving this business message because your role at ${org.name} appears on a public page (${c.source}). ${cfg.senderOrg}, ${cfg.postalAddress}.\nNot relevant? Unsubscribe in one click: ${urls.unsub}`;
  if (step.channel === 'linkedin') body = body.slice(0, 290);
  return { channel: step.channel, subject, body, translated, lang: translated ? c.lang : 'en', links: urls };
}

async function withinHours(cfg) { const h = new Date().getUTCHours(); return h >= cfg.hours.from && h < cfg.hours.to; }

async function stepOne(c, org, seq, cfg, { dry } = {}) {
  const step = seq.steps[c.seq.step];
  const out = { contactId: c.id, name: c.name, org: org.name, channel: step.channel, step: c.seq.step + 1, of: seq.steps.length };
  const advance = async (result, extra = {}) => {
    note(c, { type: 'step', channel: step.channel, result, step: c.seq.step + 1, ...extra });
    const nextStep = c.seq.step + 1;
    if (nextStep >= seq.steps.length) { c.seq = null; if (c.status === 'queued') c.status = 'contacted'; }
    else { c.seq = { ...c.seq, step: nextStep, nextAt: new Date(Date.now() + seq.steps[nextStep].delayDays * 86400000).toISOString() }; c.status = 'contacted'; }
    await saveContact(c); await bumpOrg(c.orgId, 'contacting');
  };
  const skip = async (why) => { if (!dry) await advance('skipped:' + why); return { ...out, result: 'skipped', reason: why }; };

  if ((c.email && (await isSuppressed(c.email))) || (c.phone && (await isSuppressed(c.phone)))) { if (!dry) { c.seq = null; c.optedOut = true; await saveContact(c); } return { ...out, result: 'suppressed' }; }
  if (step.channel === 'email' && !c.email) return skip('no_email');
  if (step.channel === 'sms' && !c.phone) return skip('no_phone');
  if (step.channel === 'whatsapp') { if (!c.phone) return skip('no_phone'); if (!c.waOptIn) return skip('whatsapp_requires_opt_in'); }
  if (step.channel === 'linkedin' && !c.linkedin) return skip('no_linkedin');
  const msg = await compose(c, org, step, cfg);
  if (dry) return { ...out, result: 'would_send', subject: msg.subject, preview: msg.body.slice(0, 400), translated: msg.translated };
  if (step.channel === 'linkedin') {
    await store.settings.set('out:task:' + rid('t'), { contactId: c.id, name: c.name, org: org.name, profile: c.linkedin, text: msg.body, status: 'open', createdAt: now() });
    await advance('task_created'); return { ...out, result: 'task_created' };
  }
  if ((await sentToday(step.channel)) >= cfg.caps[step.channel]) return { ...out, result: 'deferred', reason: 'daily_cap' };
  let r;
  if (step.channel === 'email') r = await email.send({ to: c.email, subject: msg.subject, text: msg.body });
  else r = await messaging.send({ channel: step.channel, to: c.phone, body: msg.body, tenant: null });
  if (!r.ok) { note(c, { type: 'send_failed', channel: step.channel, error: r.error }); await saveContact(c); return { ...out, result: 'failed', error: r.error }; }
  await bumpSent(step.channel);
  await advance(r.sandbox ? 'sandbox' : 'sent', { translated: msg.translated });
  return { ...out, result: r.sandbox ? 'sandbox' : 'sent' };
}

/** Process due steps. dryRun lists what would go without sending or changing anything. */
async function runDue({ dryRun = false, max = 200, force = false } = {}) {
  const cfg = await getConfig();
  if (!dryRun) {
    if (!cfg.enabled && !force) return { skipped: 'outreach_disabled', results: [] };
    const pc = await publicConfig(); if (!pc.readyToSend) return { skipped: 'missing_settings', missing: pc.missing, results: [] };
    if (!(await withinHours(cfg)) && !force) return { skipped: 'outside_sending_hours', results: [] };
  }
  const orgs = new Map((await allOrgs()).map((o) => [o.id, o])); const seqs = new Map((await listSequences()).map((s) => [s.id, s]));
  const due = (await allContacts()).filter((c) => c.seq && new Date(c.seq.nextAt) <= new Date() && !c.optedOut).sort((a, b) => a.seq.nextAt.localeCompare(b.seq.nextAt)).slice(0, max);
  const results = [];
  for (const c of due) {
    const org = orgs.get(c.orgId); const seq = seqs.get(c.seq.id); if (!org || !seq) continue;
    const r = await stepOne(c, org, seq, cfg, { dry: dryRun }); results.push(r);
    if (!dryRun && ['sent', 'sandbox'].includes(r.result)) await sleep(cfg.paceMs);
  }
  return { dryRun, due: due.length, results };
}

// -------------------------------------------------- tasks, tracking, feedback
async function listTasks({ status = 'open' } = {}) {
  const out = []; for (const k of await store.settings.keys('out:task:')) { const t = await store.settings.get(k); if (t && (!status || t.status === status)) out.push({ id: k.slice('out:task:'.length), ...t }); }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
async function completeTask(id, status = 'done') { const t = await store.settings.get('out:task:' + id); if (!t) throw err(404, 'task_not_found'); t.status = status; t.doneAt = now(); await store.settings.set('out:task:' + id, t); return t; }

async function trackClick(token) {
  const ref = await store.settings.get('out:tok:' + token); if (!ref || !ref.id) return null;
  const c = await store.settings.get(CON + ref.id); if (!c) return null;
  if (!c.optedOut) { if (['new', 'queued', 'contacted', 'replied'].includes(c.status)) c.status = 'sandbox'; c.seq = null; }
  note(c, { type: 'sandbox_click' }); await saveContact(c); await bumpOrg(c.orgId, 'sandbox');
  return (await getConfig()).sandboxUrl;
}
async function submitFeedback(b = {}) {
  const text = String(b.wants || b.text || '').trim().slice(0, 3000); if (!text) throw err(422, 'feedback_required');
  const f = { id: rid('fb'), at: now(), name: String(b.name || '').slice(0, 100), org: String(b.org || '').slice(0, 120), email: String(b.email || '').slice(0, 160), wants: text, token: b.token || null };
  if (b.token) {
    const ref = await store.settings.get('out:tok:' + b.token);
    if (ref && ref.id) { const c = await store.settings.get(CON + ref.id); if (c) { f.contactId = c.id; f.org = f.org || ''; note(c, { type: 'feedback' }); c.seq = null; if (c.status !== 'declined') c.status = 'meeting' === c.status ? 'meeting' : 'replied'; await saveContact(c); await bumpOrg(c.orgId, 'engaged'); } }
  }
  await store.settings.set('out:fb:' + f.id, f); return { received: true };
}
async function listFeedback() { const out = []; for (const k of await store.settings.keys('out:fb:')) { const f = await store.settings.get(k); if (f) out.push(f); } return out.sort((a, b) => b.at.localeCompare(a.at)); }

async function overview() {
  const orgs = await allOrgs(); const cons = await allContacts();
  const by = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const clicks = cons.filter((c) => (c.history || []).some((h) => h.type === 'sandbox_click')).length;
  return {
    orgs: orgs.length, orgsByType: by(orgs, (o) => o.type), orgsByStatus: by(orgs, (o) => o.status),
    contacts: cons.length, contactsByStatus: by(cons, (c) => c.status), withEmail: cons.filter((c) => c.email).length, withPhone: cons.filter((c) => c.phone).length,
    sandboxVisitors: clicks, feedback: (await listFeedback()).length, openTasks: (await listTasks()).length,
    sentToday: { email: await sentToday('email'), sms: await sentToday('sms'), whatsapp: await sentToday('whatsapp') },
    suppressed: (await store.settings.keys('out:sup:')).length,
  };
}
/** Preview the first step for one contact without sending (Master Control "Preview"). */
async function preview(contactId, sequenceId = 'standard', stepIndex = 0) {
  const c = await getContact(contactId); const org = (await allOrgs()).find((o) => o.id === c.orgId); const seq = await getSeq(sequenceId); const cfg = await getConfig();
  const step = seq.steps[stepIndex]; if (!step) throw err(422, 'bad_step');
  return compose(c, org, step, { ...cfg, senderName: cfg.senderName || '(your name)', postalAddress: cfg.postalAddress || '(your postal address)', publicBaseUrl: cfg.publicBaseUrl || 'https://example.invalid' });
}

module.exports = {
  TYPES, PERSONAS, ORG_STATUS, getConfig, setConfig, publicConfig,
  seedOrgs, listOrgs, addOrg, updateOrg, addContact, importContacts, listContacts, setContactStatus, patchContact, eraseContact, optOut, handleInboundText,
  listSequences, enroll, pause, runDue, preview, listTasks, completeTask, trackClick, submitFeedback, listFeedback, overview, isSuppressed, suppress,
};
