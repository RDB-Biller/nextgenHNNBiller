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
const countries = require('../data/countries');
const countrySeed = require('../data/outreachCountrySeed');

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const rid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = ['bank', 'insurer', 'reinsurer', 'core_banking', 'ehr', 'adjudication', 'hospital', 'other'];
const PERSONAS = ['ceo', 'cto', 'cmo', 'product', 'sales', 'claims', 'ops', 'general', 'comms', 'partnerships', 'other'];
const PHONE_TYPES = ['mobile', 'landline', 'tollfree', 'unknown'];

// Role / team mailboxes published by organisations (sales@, info@, enquiries@, communications@ ...). They are business
// addresses, not personal ones, but every rule below (source, opt-out, suppression) still applies to them.
const ROLE_BOXES = [
  [/^(sales|business|bd|businessdevelopment|newbusiness)$/, 'sales', 'sales'],
  [/^(partnership|partnerships|partners|alliances)$/, 'partnerships', 'partnerships'],
  [/^(marketing|brand|campaigns)$/, 'marketing', 'cmo'],
  [/^(comms|communications|corporatecomms|corporatecommunications|media|press|pr|publicrelations|corporateaffairs)$/, 'communications', 'comms'],
  [/^(claims|claim|claimsenquiries)$/, 'claims', 'claims'],
  [/^(innovation|digital|product|products|fintech|ict|it|tech|technology)$/, 'product', 'product'],
  [/^(info|enquiries|enquiry|inquiries|inquiry|contact|contactus|hello|mail|office|reception|admin|service|services|customercare|customerservice|care|helpdesk|support)$/, 'enquiries', 'general'],
];
// Mailboxes that must never be cold-pitched (not a business-enquiry channel).
const BANNED_BOXES = /^(noreply|donotreply|postmaster|abuse|webmaster|hostmaster|careers|jobs|recruitment|hr|humanresources|privacy|dpo|security|fraud|unsubscribe|bounce|mailerdaemon)$/;
function roleOf(em) {
  const local = String(em).split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (BANNED_BOXES.test(local)) throw err(422, 'not_a_business_enquiry_mailbox: careers, HR, privacy, abuse and no-reply mailboxes are not valid outreach targets');
  const hit = ROLE_BOXES.find(([re]) => re.test(local));
  return hit ? { purpose: hit[1], persona: hit[2] } : null;
}

// Best-effort mobile / landline / toll-free classification by country calling code (national significant number).
// It is a heuristic for routing (SMS/WhatsApp only to mobiles, switchboards to a call task); a person can override it.
const PHONE_RULES = {
  '233': { m: /^(20|23|24|25|26|27|28|29|50|53|54|55|56|57|59)\d{7}$/, t: /^800\d{6}$/, l: /^3\d{8}$/ },
  '234': { m: /^(70|71|80|81|90|91)\d{8}$/, l: /^[1-9]\d{6,8}$/ },
  '254': { m: /^[17]\d{8}$/, t: /^800\d{6}$/, l: /^[2-6]\d{7,8}$/ },
  '27': { m: /^(6\d|7\d|8[1-5])\d{7}$/, t: /^80\d{7}$/, l: /^[1-5]\d{8}$/ },
  '20': { m: /^1\d{9}$/, l: /^[2-9]\d{7,8}$/ },
  '212': { m: /^[67]\d{8}$/, t: /^80\d{7}$/, l: /^5\d{8}$/ },
  '216': { m: /^[2459]\d{7}$/, l: /^[37]\d{7}$/ },
  '213': { m: /^[567]\d{8}$/, l: /^[2-4]\d{7,8}$/ },
  '225': { m: /^(01|05|07)\d{8}$/, l: /^2[1-7]\d{8}$/ },
  '255': { m: /^[67]\d{8}$/, l: /^2\d{8}$/ },
  '256': { m: /^7\d{8}$/, l: /^[34]\d{8}$/ },
  '263': { m: /^7\d{8}$/ },
  '260': { m: /^9\d{8}$/, l: /^2\d{8}$/ },
  '265': { m: /^[89]\d{8}$/, l: /^1\d{7}$/ },
  '244': { m: /^9\d{8}$/, l: /^2\d{8}$/ },
  '230': { m: /^5\d{7}$/, l: /^[246]\d{6,7}$/ },
  '267': { m: /^7\d{7}$/, l: /^[2-6]\d{6}$/ },
  '250': { m: /^7\d{8}$/, l: /^2\d{8}$/ },
  '221': { m: /^7\d{8}$/, l: /^33\d{7}$/ },
  '243': { m: /^[89]\d{8}$/ },
  '44': { m: /^7\d{9}$/, t: /^80\d{7,8}$/, l: /^[12]\d{9}$/ },
  '33': { m: /^[67]\d{8}$/, l: /^[1-59]\d{8}$/ },
  '41': { m: /^7[5-9]\d{7}$/, l: /^[2-6]\d{8}$/ },
  '49': { m: /^1[567]\d{8,9}$/ },
  '91': { m: /^[6-9]\d{9}$/, l: /^[1-5]\d{9}$/ },
};
function classifyPhone(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  for (const len of [3, 2, 1]) {
    const rule = PHONE_RULES[d.slice(0, len)]; if (!rule) continue;
    const rest = d.slice(len);
    if (rule.m && rule.m.test(rest)) return 'mobile';
    if (rule.t && rule.t.test(rest)) return 'tollfree';
    if (rule.l && rule.l.test(rest)) return 'landline';
    return 'unknown';
  }
  return 'unknown';
}
const ORG_STATUS = ['new', 'contacting', 'engaged', 'sandbox', 'meeting', 'partner', 'declined'];
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com']);
const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

// ----------------------------------------------------------------- settings
const CFG = 'out:cfg';
const DEFAULTS = {
  enabled: false, senderName: '', senderRole: '', senderOrg: 'HNN Biller / TrimesterSave', postalAddress: '', replyTo: '',
  sandboxUrl: 'https://hnnbiller.xchangeinsure.com', patientAppUrl: 'https://tmsapp.trimestersave.com', publicBaseUrl: '',
  caps: { email: 50, sms: 30, whatsapp: 30 }, hours: { from: 8, to: 16 }, paceMs: 400,
  approvedCountries: [],
  referral: {
    enabled: false, maxIntrosPerDay: 5, terms: '',
    points: { replied: 0, sandbox: 1, meeting: 3, partner: 10 },
    tiers: [{ at: 1, label: 'Founding Referrer', reward: '' }, { at: 5, label: 'Sandbox Champion', reward: '' }, { at: 15, label: 'Ecosystem Partner', reward: '' }],
  },
};
async function getConfig() {
  const s = (await store.settings.get(CFG)) || {};
  const dr = JSON.parse(JSON.stringify(DEFAULTS.referral)); const sr = s.referral || {};
  return { ...DEFAULTS, ...s, caps: { ...DEFAULTS.caps, ...(s.caps || {}) }, hours: { ...DEFAULTS.hours, ...(s.hours || {}) }, referral: { ...dr, ...sr, points: { ...dr.points, ...(sr.points || {}) }, tiers: Array.isArray(sr.tiers) ? sr.tiers : dr.tiers } };
}
async function setConfig(p = {}, by) {
  const c = await getConfig();
  for (const k of ['senderName', 'senderRole', 'senderOrg', 'postalAddress', 'replyTo', 'sandboxUrl', 'patientAppUrl', 'publicBaseUrl']) if (p[k] !== undefined) c[k] = String(p[k] || '').trim().slice(0, 300);
  for (const k of ['sandboxUrl', 'patientAppUrl', 'publicBaseUrl']) if (c[k] && !/^https?:\/\//i.test(c[k])) throw err(422, `${k} must start with http:// or https://`);
  if (p.enabled !== undefined) c.enabled = !!p.enabled;
  if (p.approvedCountries !== undefined) {
    if (!Array.isArray(p.approvedCountries)) throw err(422, 'approvedCountries must be a list of country codes');
    const codes = p.approvedCountries.map((x) => { const k = countries.find(x); if (!k) throw err(422, `unknown country: ${x}`); return k.code; });
    c.approvedCountries = Array.from(new Set(codes));
  }
  if (p.caps) for (const ch of ['email', 'sms', 'whatsapp']) if (p.caps[ch] !== undefined) { const n = Number(p.caps[ch]); if (!(n >= 0 && n <= 2000)) throw err(422, 'caps must be 0-2000'); c.caps[ch] = Math.floor(n); }
  if (p.hours) { const f = Number(p.hours.from); const t = Number(p.hours.to); if (!(f >= 0 && t <= 24 && f < t)) throw err(422, 'hours must be 0-24 with from < to'); c.hours = { from: f, to: t }; }
  if (p.referral) {
    const r = p.referral; const cur = c.referral;
    if (r.enabled !== undefined) cur.enabled = !!r.enabled;
    if (r.maxIntrosPerDay !== undefined) { const n = Number(r.maxIntrosPerDay); if (!(n >= 0 && n <= 50)) throw err(422, 'maxIntrosPerDay must be 0-50'); cur.maxIntrosPerDay = Math.floor(n); }
    if (r.points) for (const k of ['replied', 'sandbox', 'meeting', 'partner']) if (r.points[k] !== undefined) { const n = Number(r.points[k]); if (!(n >= 0 && n <= 1000)) throw err(422, 'points must be 0-1000'); cur.points[k] = n; }
    if (r.tiers !== undefined) {
      if (!Array.isArray(r.tiers) || r.tiers.length > 8) throw err(422, 'tiers must be a list of up to 8');
      cur.tiers = r.tiers.map((t) => { const at = Number(t.at); if (!(at >= 1)) throw err(422, 'each tier needs points >= 1'); return { at, label: String(t.label || '').trim().slice(0, 60) || `Tier ${at}`, reward: String(t.reward || '').trim().slice(0, 300) }; }).sort((a, b) => a.at - b.at);
    }
    if (r.terms !== undefined) cur.terms = String(r.terms || '').slice(0, 2000);
  }
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
  return { ...c, reviewCountries: countries.list.filter((k) => k.level === 'review').map((k) => k.code), readyToSend: ready.length === 0, missing: ready, emailConfigured: email.configured() };
}

// ----------------------------------------------------------- organisations
const ORGS = 'out:orgs';
const normName = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\b(plc|ltd|limited|inc|corp|corporation|sa|ag|nv|se|co|company|group|holdings?|the|of|de|du|des|la|le|les)\b/g, ' ').replace(/\s+/g, ' ').trim();
const geoOf = (o) => countries.find(o && (o.cc || o.country));
async function allOrgs() {
  const a = (await store.settings.get(ORGS)) || [];
  for (const o of a) { if (!o.cc) { const g = countries.find(o.country); if (g) o.cc = g.code; } if (!o.lists) o.lists = []; if (!o.lang && o.cc) { const g = countries.find(o.cc); if (g) o.lang = g.langs[0]; } }
  return a;
}
async function saveOrgs(a) { await store.settings.set(ORGS, a); }
async function seedOrgs() {
  const cur = await allOrgs(); const have = new Set(cur.map((o) => `${o.type}|${o.name.toUpperCase()}`));
  let added = 0;
  for (const s of seed) {
    if (have.has(`${s.type}|${s.name.toUpperCase()}`)) continue;
    const g = countries.find(s.country); cur.push({ id: rid('org'), name: s.name, type: s.type, country: s.country || '', cc: g ? g.code : '', lang: g ? g.langs[0] : '', lists: [], website: '', note: s.note || '', tier: s.rank || '', status: 'new', createdAt: now() });
    added++;
  }
  await saveOrgs(cur); return { added, total: cur.length };
}
async function listOrgs({ type, status, q, country, cc, list, lang, commonwealth, region, page = 1, pageSize = 50 } = {}) {
  let a = await allOrgs(); const cfg0 = await getConfig();
  if (type) a = a.filter((o) => o.type === type);
  if (status) a = a.filter((o) => o.status === status);
  if (country) { const g = countries.find(country); a = a.filter((o) => (g ? o.cc === g.code : (o.country || '').toLowerCase() === String(country).toLowerCase())); }
  if (cc) a = a.filter((o) => o.cc === String(cc).toUpperCase());
  if (list) a = a.filter((o) => (o.lists || []).includes(list));
  if (lang) a = a.filter((o) => o.lang === lang);
  if (commonwealth === true || commonwealth === 'true' || commonwealth === '1') a = a.filter((o) => (geoOf(o) || {}).commonwealth);
  if (region) a = a.filter((o) => (geoOf(o) || {}).region === region);
  if (q) { const s = String(q).toLowerCase(); a = a.filter((o) => `${o.name} ${o.country} ${o.note}`.toLowerCase().includes(s)); }
  const counts = {}; for (const c of await allContacts()) counts[c.orgId] = (counts[c.orgId] || 0) + 1;
  const total = a.length; const p = Math.max(1, +page || 1); const n = Math.min(200, Math.max(1, +pageSize || 50));
  return { total, page: p, pageSize: n, rows: a.slice((p - 1) * n, p * n).map((o) => ({ ...o, contacts: counts[o.id] || 0, reach: reachOf(o, cfg0) })) };
}
async function addOrg(b = {}) {
  const name = String(b.name || '').trim().slice(0, 120); if (!name) throw err(422, 'name_required');
  if (!TYPES.includes(b.type)) throw err(422, `type must be one of ${TYPES.join(', ')}`);
  const a = await allOrgs();
  const g = countries.find(b.country); const o = { id: rid('org'), name, type: b.type, country: g ? g.name : String(b.country || '').slice(0, 60), cc: g ? g.code : '', lang: g ? g.langs[0] : '', lists: Array.isArray(b.lists) ? b.lists.slice(0, 10) : [], website: String(b.website || '').slice(0, 200), note: String(b.note || '').slice(0, 400), tier: '', status: 'new', createdAt: now() };
  a.push(o); await saveOrgs(a); return o;
}
async function updateOrg(id, b = {}) {
  const a = await allOrgs(); const o = a.find((x) => x.id === id); if (!o) throw err(404, 'org_not_found');
  for (const k of ['name', 'country', 'website', 'note']) if (b[k] !== undefined) o[k] = String(b[k]).slice(0, 400);
  if (b.type !== undefined) { if (!TYPES.includes(b.type)) throw err(422, 'bad_type'); o.type = b.type; }
  if (b.status !== undefined) { if (!ORG_STATUS.includes(b.status)) throw err(422, 'bad_status'); o.status = b.status; }
  await saveOrgs(a); return o;
}

/** What the campaign can do for an organisation, from its country. */
function reachOf(o, cfg) {
  const g = geoOf(o);
  if (!g) return { known: false, email: true, sms: true, call: true, whatsapp: 'opt-in only', linkedin: 'manual', held: false };
  const held = g.level === 'review' && !((cfg && cfg.approvedCountries) || []).includes(g.code);
  return { known: true, country: g.code, level: g.level, email: !held, sms: !held && !g.noColdSms, call: true, whatsapp: 'opt-in only', linkedin: 'manual', held, reason: held ? 'needs a legal review for ' + g.name : (g.noColdSms ? 'cold SMS not sent in ' + g.name : '') };
}
const countryTable = async () => {
  const cfg = await getConfig(); const orgs = await allOrgs(); const cons = await allContacts(); const orgCc = new Map(orgs.map((o) => [o.id, o.cc]));
  return countries.list.map((c) => ({ ...c, approved: c.level === 'open' || cfg.approvedCountries.includes(c.code), orgs: orgs.filter((o) => o.cc === c.code).length, contacts: cons.filter((x) => orgCc.get(x.orgId) === c.code).length }));
};
function derivedTags(c) {
  const t = [];
  if (c.commonwealth) t.push('commonwealth'); if (c.code === 'GH') t.push('ghana-health-finance'); const l0 = c.langs[0];
  if (l0 === 'fr') t.push('francophone'); if (l0 === 'pt') t.push('lusophone'); if (l0 === 'es') t.push('hispanic'); if (l0 === 'ar' || ['DZ', 'MA', 'TN'].includes(c.code)) t.push('arabic');
  if (c.region === 'Asia') t.push('asia'); return t;
}
/** Load the country / index starter lists. Pick countries, "commonwealth", "all", or named packs; safe to repeat. */
async function seedCountries({ countries: codes, commonwealth, all, packs } = {}) {
  const want = new Set((codes || []).map((x) => { const c = countries.find(x); return c && c.code; }).filter(Boolean));
  if (commonwealth) for (const c of countries.list) if (c.commonwealth) want.add(c.code);
  if (all) for (const c of countries.list) want.add(c.code);
  const packSet = new Set(packs || []);
  if (!want.size && !packSet.size) throw err(422, 'choose countries, commonwealth, all, or at least one list');
  const cur = await allOrgs(); const idx = new Map(cur.map((o) => [normName(o.name), o]));
  let added = 0, merged = 0;
  for (const sd of countrySeed.orgs) {
    const c = countries.find(sd.cc); if (!c) continue; const tags = Array.from(new Set([...sd.tags, ...derivedTags(c)]));
    if (!(want.has(sd.cc) || tags.some((t) => packSet.has(t)))) continue;
    const key = normName(sd.name); let o = idx.get(key);
    if (o) {
      const before = JSON.stringify([o.cc, o.lang, o.lists]); o.cc = o.cc || c.code; o.lang = o.lang || c.langs[0]; o.country = o.country || c.name; o.lists = Array.from(new Set([...(o.lists || []), ...tags]));
      if (before !== JSON.stringify([o.cc, o.lang, o.lists])) merged++; continue;
    }
    o = { id: rid('org'), name: sd.name, type: sd.type, country: c.name, cc: c.code, lang: c.langs[0], lists: tags, website: '', note: 'country list (starter; verify against the source)', tier: '', status: 'new', createdAt: now() };
    cur.push(o); idx.set(key, o); added++;
  }
  await saveOrgs(cur); return { added, merged, total: cur.length };
}
function classifyName(name) {
  const n = String(name || '');
  if (/\b(insurance|insurer|assurance|assurances|assurer|seguros|seguradora|versicherung|assicurazioni|takaful|reinsurance|reassurance|life|medical aid|medical scheme|health plan|hmo|mutuelle|mutualit|mutual)\b/i.test(n) && !/\bbank\b/i.test(n)) return 'insurer';
  if (/\b(bank|banque|banco|banca|bancorp|bancshares|sparkasse|building society|savings|microfinance|mobile money|momo|payments?|credit union)\b/i.test(n)) return 'bank';
  if (/\b(hospital|hopital|hôpital|clinic|clinique|cl[ií]nica|medical cent(er|re)|teaching hospital|krankenhaus|klinik|ospedale)\b/i.test(n)) return 'hospital';
  if (/\b(emr|ehr|health information|health it|medical software|healthtech)\b/i.test(n)) return 'ehr';
  if (/\b(claims|adjudication)\b/i.test(n)) return 'adjudication';
  if (/\b(core banking|temenos|finastra|finacle)\b/i.test(n)) return 'core_banking';
  return 'other';
}
const PACK_CUSTOM = 'out:packs';
async function listPacks() {
  const orgs = await allOrgs(); const custom = (await store.settings.get(PACK_CUSTOM)) || [];
  const derived = [{ id: 'commonwealth' }, { id: 'francophone' }, { id: 'lusophone' }, { id: 'hispanic' }, { id: 'arabic' }, { id: 'asia' }];
  const seedCount = {}; for (const sd of countrySeed.orgs) { const c = countries.find(sd.cc); if (!c) continue; for (const t of new Set([...sd.tags, ...derivedTags(c)])) seedCount[t] = (seedCount[t] || 0) + 1; }
  const loaded = {}; for (const o of orgs) for (const t of o.lists || []) loaded[t] = (loaded[t] || 0) + 1;
  void derived;
  return [...countrySeed.PACKS, ...custom].map((p) => ({ ...p, starterSize: seedCount[p.id] || 0, loaded: loaded[p.id] || 0 }));
}
/** Import a pasted/uploaded list of organisation names into a list pack (one name per line; leading ranks are ignored). */
async function importList({ listId, listName, country, type, text, names } = {}) {
  const id = String(listId || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); if (id.length < 2) throw err(422, 'listId required (for example fortune500 or ghana-club-100)');
  const g = country ? countries.find(country) : null; if (country && !g) throw err(422, `unknown country: ${country}`);
  if (type && !TYPES.includes(type)) throw err(422, 'bad type');
  let rows = Array.isArray(names) ? names.map(String) : String(text || '').split(/\r?\n/);
  rows = rows.map((l) => {
    const cols = l.replace(/^\s*\d{1,4}\s*[.)]\s+/, '').split(/\t|\|/).map((c) => c.trim().replace(/^"|"$/g, '').replace(/^\d{1,4}\s*[,:;-]\s*/, '').trim());
    while (cols.length > 1 && /^[\d\s.,]*$/.test(cols[0])) cols.shift();
    return cols[0] || '';
  }).filter((l) => l && /[a-z]/i.test(l) && l.length <= 120).slice(0, 3000);
  if (!rows.length) throw err(422, 'no organisation names found');
  const packs = (await listPacks()); if (!packs.some((p) => p.id === id)) {
    const custom = (await store.settings.get(PACK_CUSTOM)) || []; custom.push({ id, name: String(listName || id).slice(0, 80), country: g ? g.code : '', source: '', note: 'custom list', complete: false, custom: true }); await store.settings.set(PACK_CUSTOM, custom);
  }
  const cur = await allOrgs(); const idx = new Map(cur.map((o) => [normName(o.name), o])); let added = 0, tagged = 0, known = 0; const types = {};
  for (const name of rows) {
    const key = normName(name); if (!key) continue; let o = idx.get(key);
    if (o) { known++; if (!o.lists.includes(id)) { o.lists.push(id); tagged++; } continue; }
    const t = type || classifyName(name);
    o = { id: rid('org'), name, type: t, country: g ? g.name : '', cc: g ? g.code : '', lang: g ? g.langs[0] : '', lists: [id], website: '', note: 'imported to ' + id + (t === 'other' ? ' (sector unclear: review before pitching)' : ''), tier: '', status: 'new', createdAt: now() };
    cur.push(o); idx.set(key, o); added++; types[t] = (types[t] || 0) + 1;
  }
  await saveOrgs(cur); return { listId: id, read: rows.length, added, tagged, known, types };
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
/** All numbers on a contact (older records only have `phone`). */
const phonesOf = (c) => (Array.isArray(c.phones) ? c.phones : (c.phone ? [{ number: c.phone, type: 'mobile' }] : []));
function derivePhones(c) {
  const ps = phonesOf(c);
  c.phone = (ps.find((p) => p.type === 'mobile') || {}).number || '';
  c.landline = (ps.find((p) => p.type !== 'mobile') || {}).number || '';
}
const pickCallNumber = (c) => { const ps = phonesOf(c); return ps.find((p) => p.type !== 'mobile') || ps[0] || null; };
async function anySuppressed(c) {
  if (c.email && (await isSuppressed(c.email))) return true;
  for (const p of phonesOf(c)) if (await isSuppressed(p.number)) return true;
  return false;
}
async function suppressAll(c, reason) { for (const v of [c.email, ...phonesOf(c).map((p) => p.number)]) if (v) await suppress(v, reason); }

// ------------------------------------------------------------------ contacts
const CON = 'out:con:';
async function allContacts() { const out = []; for (const k of await store.settings.keys(CON)) { const c = await store.settings.get(k); if (c) out.push(c); } return out; }
const conPublic = (c) => ({ ...c, history: (c.history || []).slice(-15) });

async function addContact(b = {}, { by } = {}) {
  const orgs = await allOrgs(); const org = orgs.find((o) => o.id === b.orgId); if (!org) throw err(422, 'org_required');
  let name = String(b.name || '').trim().slice(0, 100);
  const source = String(b.source || '').trim().slice(0, 300);
  if (!source) throw err(422, 'source_required: record the public page where this business contact was found');
  const em = String(b.email || '').trim().toLowerCase();
  const rb = em ? roleOf(em) : null;
  const kind = (b.kind === 'role' || rb || !name) ? 'role' : 'person';
  const purpose = String(b.purpose || (rb && rb.purpose) || '').slice(0, 40);
  const persona = (b.persona && b.persona !== 'other' && PERSONAS.includes(b.persona)) ? b.persona : (rb ? rb.persona : (kind === 'role' ? 'general' : 'other'));
  // phones: `phone`/`phones` are auto-classified; `mobile` / `landline` force the type
  const raw = [];
  if (b.phone) raw.push({ v: b.phone });
  if (b.mobile) raw.push({ v: b.mobile, force: 'mobile' });
  if (b.landline) raw.push({ v: b.landline, force: 'landline' });
  for (const p of Array.isArray(b.phones) ? b.phones : []) { if (typeof p === 'string') raw.push({ v: p }); else if (p && (p.number || p.phone)) raw.push({ v: p.number || p.phone, force: p.type }); }
  const phones = [];
  for (const r of raw.slice(0, 6)) {
    const n = canonPhone(r.v); if (!validPhone(n)) throw err(422, 'phone_invalid');
    if (phones.some((p) => p.number === n)) continue;
    phones.push({ number: n, type: PHONE_TYPES.includes(r.force) ? r.force : classifyPhone(n) });
  }
  if (!em && !phones.length && !b.linkedin) throw err(422, 'email, phone or linkedin required');
  if (!name && !em && !phones.length) throw err(422, 'name_required');
  if (!name) name = `${org.name} ${purpose || 'general enquiries'} desk`.slice(0, 100);
  if (em) {
    if (!EMAIL_RE.test(em)) throw err(422, 'email_invalid');
    if (FREE_MAIL.has(em.split('@')[1])) throw err(422, 'free-mail addresses are not allowed for B2B cold outreach; use a work address');
  }
  if (b.linkedin && !/^https:\/\/([\w-]+\.)?linkedin\.com\//i.test(b.linkedin)) throw err(422, 'linkedin must be a linkedin.com URL');
  if ((em && (await isSuppressed(em))) || (await Promise.all(phones.map((p) => isSuppressed(p.number)))).some(Boolean)) throw err(409, 'suppressed: this person opted out or asked to be erased');
  const all = await allContacts();
  const dup = all.find((c) => (em && c.email === em) || phones.some((p) => phonesOf(c).some((q) => q.number === p.number)) || (b.linkedin && c.linkedin === b.linkedin));
  if (dup) throw err(409, 'duplicate_contact');
  const lang = b.lang && i18n.isKnown(b.lang) ? i18n.normalise(b.lang) : (org.lang && i18n.isKnown(org.lang) ? i18n.normalise(org.lang) : 'en');
  const c = {
    id: rid('con'), orgId: org.id, kind, name, role: String(b.role || '').slice(0, 100), purpose, persona, email: em, phones, phone: '', landline: '', linkedin: b.linkedin || '',
    lang, source, lawfulBasis: 'legitimate_interest_b2b', waOptIn: !!b.waOptIn, status: 'new', seq: null, history: [], token: crypto.randomBytes(9).toString('base64url'),
    createdAt: now(), createdBy: by || null,
  };
  derivePhones(c);
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
async function listContacts({ orgId, status, persona, kind, q, page = 1, pageSize = 50 } = {}) {
  let a = await allContacts();
  if (orgId) a = a.filter((c) => c.orgId === orgId);
  if (status) a = a.filter((c) => c.status === status);
  if (persona) a = a.filter((c) => c.persona === persona);
  if (kind) a = a.filter((c) => (c.kind || 'person') === kind);
  if (q) { const s = String(q).toLowerCase(); a = a.filter((c) => `${c.name} ${c.role} ${c.email} ${c.purpose || ''}`.toLowerCase().includes(s)); }
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
  if (b.phoneType && b.phoneType.number) { // correct a mis-detected line type
    const n = canonPhone(b.phoneType.number); const p = phonesOf(c).find((x) => x.number === n);
    if (!p || !PHONE_TYPES.includes(b.phoneType.type)) throw err(422, 'phoneType needs a number on this contact and a type of ' + PHONE_TYPES.join('/'));
    c.phones = phonesOf(c).map((x) => (x.number === n ? { ...x, type: b.phoneType.type } : x)); derivePhones(c);
  }
  await saveContact(c); return conPublic(c);
}
/** Erase a person (privacy request). Their address/number is kept only as a hash on the suppression list. */
async function eraseContact(id) {
  const c = await getContact(id);
  await suppressAll(c, 'erased'); if (c.linkedin) await suppress(c.linkedin, 'erased');
  await store.settings.set('out:ref:c' + c.token, null);
  await store.settings.set(CON + id, null); await store.settings.set('out:tok:' + c.token, null);
  return { erased: true };
}
async function optOut(token, reason) {
  const ref = await store.settings.get('out:tok:' + token); if (!ref || !ref.id) return { ok: false };
  const c = await store.settings.get(CON + ref.id); if (!c) return { ok: false };
  await suppressAll(c, reason || 'unsubscribe');
  c.status = 'declined'; c.seq = null; c.optedOut = true; note(c, { type: 'opt_out', reason: reason || 'unsubscribe' }); await saveContact(c);
  await bumpOrg(c.orgId, 'new'); return { ok: true };
}
/** SMS "STOP" (or similar) from a number we texted. */
async function handleInboundText(from, text) {
  const ph = canonPhone(from); if (!validPhone(ph)) return null;
  const t = String(text || '').trim().toUpperCase();
  const isStop = /^(STOP|UNSUBSCRIBE|QUIT|CANCEL|END|OPT ?OUT)\b/.test(t);
  const c = (await allContacts()).find((x) => phonesOf(x).some((p) => p.number === ph));
  if (isStop) { await suppress(ph, 'sms_stop'); if (c) { await suppressAll(c, 'sms_stop'); c.status = 'declined'; c.seq = null; c.optedOut = true; note(c, { type: 'opt_out', reason: 'sms_stop' }); await saveContact(c); } return { outcome: 'outreach_opt_out', reply: 'You have been unsubscribed and will not hear from us again.' }; }
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
    const intro = { ceo: 'a short note for the CEO office', cto: 'a short note for the technology team', cmo: 'a short note for marketing and customer growth', product: 'a short note for product', sales: 'a short note for sales', claims: 'a short note for claims', ops: 'a short note for operations', general: 'a short note for your team', comms: 'a short note for corporate communications', partnerships: 'a short note for partnerships', other: 'a short note' }[persona] || 'a short note';
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
  { id: 'switchboard', name: 'Role mailbox / switchboard (email, call task, follow-ups)', steps: [{ delayDays: 0, channel: 'email' }, { delayDays: 2, channel: 'call' }, { delayDays: 6, channel: 'email', variant: 'followup' }, { delayDays: 14, channel: 'email', variant: 'last' }] },
  { id: 'referral', name: 'Referral introduction (email x3)', steps: [{ delayDays: 0, channel: 'email', variant: 'referral' }, { delayDays: 5, channel: 'email', variant: 'followup' }, { delayDays: 12, channel: 'email', variant: 'last' }] },
  { id: 'warm', name: 'Warm (replied / opted in): WhatsApp + email', steps: [{ delayDays: 0, channel: 'whatsapp' }, { delayDays: 2, channel: 'email', variant: 'followup' }] },
];
async function listSequences() { return (await store.settings.get(SEQS)) || DEFAULT_SEQS; }
async function getSeq(id) { const s = (await listSequences()).find((x) => x.id === id); if (!s) throw err(404, 'sequence_not_found'); return s; }

async function enroll({ contactIds, orgType, persona, sequenceId = 'standard', limit = 500 } = {}) {
  const seq = await getSeq(sequenceId); const orgs = new Map((await allOrgs()).map((o) => [o.id, o]));
  let list = Array.isArray(contactIds) && contactIds.length ? (await Promise.all(contactIds.map((i) => store.settings.get(CON + i)))).filter(Boolean) : await allContacts();
  list = list.filter((c) => c.status === 'new' && !c.seq && !c.optedOut && (!orgType || (orgs.get(c.orgId) || {}).type === orgType) && (!persona || c.persona === persona)).slice(0, limit);
  let n = 0; let held = 0; const cfg = await getConfig();
  for (const c of list) {
    if (await anySuppressed(c)) continue;
    if (c.email && reachOf(orgs.get(c.orgId), cfg).held && seq.steps.some((st) => st.channel === 'email')) { held++; continue; } // country awaiting legal review
    c.seq = { id: seq.id, step: 0, nextAt: now() }; c.status = 'queued'; note(c, { type: 'enrolled', sequence: seq.id }); await saveContact(c); n++;
  }
  return { enrolled: n, held, sequence: seq.id };
}
async function pause(contactId) { const c = await getContact(contactId); c.seq = null; if (c.status === 'queued') c.status = 'new'; note(c, { type: 'paused' }); await saveContact(c); return conPublic(c); }

// ------------------------------------------------------------------- sending
const dayKey = () => new Date().toISOString().slice(0, 10);
async function sentToday(channel) { return ((await store.settings.get(`out:cnt:${dayKey()}:${channel}`)) || { n: 0 }).n; }
async function bumpSent(channel) { await store.settings.set(`out:cnt:${dayKey()}:${channel}`, { n: (await sentToday(channel)) + 1 }); }

async function publicUrls(c, cfg) {
  const base = String(cfg.publicBaseUrl || '').replace(/\/$/, '');
  return { sandbox: `${base}/o/t/${c.token}`, feedback: `${base}/o/feedback?t=${c.token}`, unsub: `${base}/o/u/${c.token}`, referral: `${base}/o/refer/c${c.token}` };
}
function fill(s, vars) { return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : vars[k])); }

/** Build the exact message a step would send (also used by dry-run and the preview in Master Control). */
async function compose(c, org, step, cfg) {
  const segment = segmentOf(org, c);
  const tpl = renderTemplate(step.channel, segment, c.persona, cfg);
  const urls = await publicUrls(c, cfg);
  const isRole = c.kind === 'role';
  const first = isRole ? 'team' : ((c.name || '').trim().split(/\s+/)[0] || 'there');
  const sig0 = `${cfg.senderName}${cfg.senderRole ? ', ' + cfg.senderRole : ''}\n${cfg.senderOrg}${cfg.replyTo ? '\n' + cfg.replyTo : ''}`;
  const sig = (isRole && step.channel === 'email') ? `If you are not the right team, please pass this to whoever leads technology, product, claims or partnerships. Thank you.\n\n${sig0}` : sig0;
  const vars = { first_name: first, org: org.name, sandbox_link: urls.sandbox, feedback_link: urls.feedback, sender_signature: sig, sender_first: (cfg.senderName || '').split(/\s+/)[0], sender_org: cfg.senderOrg };
  let subject = tpl.subject ? fill(tpl.subject, vars) : undefined; let body = fill(tpl.body, vars);
  if (step.variant === 'followup') { subject = subject && 'Re: ' + subject; body = `Dear ${first},\n\nA quick follow-up in case my note got buried. The sandbox takes two minutes and I would value your honest view on what is missing.\n\n${CTA(cfg).replace('{sandbox_link}', urls.sandbox).replace('{feedback_link}', urls.feedback)}\n\n${sig}`; }
  if (step.variant === 'referral') {
    const rr = c.referredBy ? await store.settings.get(REF + c.referredBy) : null; const who = rr ? rr.name : 'a colleague';
    subject = `${who} suggested we get in touch`;
    body = `Dear ${first},\n\n${who}${rr && rr.org ? ' (' + rr.org + ')' : ''} thought you would want to see this, so I am writing once. We have built ${(T[segment] || T.bank).pitch}\n\n${CTA(cfg).replace('{sandbox_link}', urls.sandbox).replace('{feedback_link}', urls.feedback)}\n\n${sig}`;
  }
  if (step.variant === 'last') { subject = subject && 'Closing the loop: ' + subject; body = `Dear ${first},\n\nI will stop here so I do not crowd your inbox. If embedded savings, micro-credit or claims adjudication is on your roadmap, the sandbox stays open: ${urls.sandbox}\nAnd if you would rather not hear from us, use the link below.\n\n${sig}`; }
  let translated = false;
  if (c.lang && c.lang !== 'en') {
    const tb = await i18n.translate(body, 'en', c.lang); if (tb.ok) { body = tb.text; translated = true; }
    if (subject) { const ts = await i18n.translate(subject, 'en', c.lang); if (ts.ok) subject = ts.text; }
  }
  if (step.channel === 'email' && cfg.referral && cfg.referral.enabled) body += `\n\nKnow a colleague or partner who should see this? Share your link or introduce them: ${urls.referral}`;
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

  if (await anySuppressed(c)) { if (!dry) { c.seq = null; c.optedOut = true; await saveContact(c); } return { ...out, result: 'suppressed' }; }
  const rc = reachOf(org, cfg);
  if (step.channel === 'email' && rc.held) return skip('country_needs_review');
  if (step.channel === 'sms' && rc.held) return skip('country_needs_review');
  if (step.channel === 'sms' && rc.known && !rc.sms) return skip('sms_not_allowed_in_country');
  if (step.channel === 'email' && !c.email) return skip('no_email');
  if (step.channel === 'sms' && !c.phone) return skip(phonesOf(c).length ? 'no_mobile_number' : 'no_phone');
  if (step.channel === 'whatsapp') { if (!c.phone) return skip(phonesOf(c).length ? 'no_mobile_number' : 'no_phone'); if (!c.waOptIn) return skip('whatsapp_requires_opt_in'); }
  if (step.channel === 'call') {
    const n = pickCallNumber(c); if (!n) return skip('no_phone');
    if (dry) return { ...out, result: 'would_create_call_task', phone: n.number, phoneType: n.type };
    const seg = segmentOf(org, c); const who = c.kind === 'role' ? `the ${c.purpose || 'general enquiries'} desk` : c.name;
    const script = `Ask for ${who} at ${org.name}. Say: "Hello, this is ${cfg.senderName || 'our team'} from ${cfg.senderOrg}. We emailed about a free sandbox for embedded savings, micro-credit and claims adjudication. Who is the right person in ${seg.startsWith('insurer') ? 'claims or product' : 'technology or product'} to try it, and may I send them the link?" Then record the outcome.`;
    await store.settings.set('out:task:' + rid('t'), { kind: 'call', contactId: c.id, name: c.name, org: org.name, phone: n.number, phoneType: n.type, text: script, status: 'open', createdAt: now() });
    await advance('task_created'); return { ...out, result: 'task_created' };
  }
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
  const orgs = await allOrgs(); const cons = await allContacts(); const cfgO = await getConfig();
  const by = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const clicks = cons.filter((c) => (c.history || []).some((h) => h.type === 'sandbox_click')).length;
  return {
    orgs: orgs.length, orgsByType: by(orgs, (o) => o.type), orgsByStatus: by(orgs, (o) => o.status),
    contacts: cons.length, contactsByStatus: by(cons, (c) => c.status), withEmail: cons.filter((c) => c.email).length, withPhone: cons.filter((c) => phonesOf(c).length).length,
    roleMailboxes: cons.filter((c) => c.kind === 'role' && c.email).length, mobileNumbers: cons.filter((c) => c.phone).length, nonMobileNumbers: cons.filter((c) => phonesOf(c).some((p) => p.type !== 'mobile')).length,
    sandboxVisitors: clicks, feedback: (await listFeedback()).length, openTasks: (await listTasks()).length,
    sentToday: { email: await sentToday('email'), sms: await sentToday('sms'), whatsapp: await sentToday('whatsapp') },
    suppressed: (await store.settings.keys('out:sup:')).length,
    orgsByCountry: Object.fromEntries(Object.entries(by(orgs, (o) => o.cc || 'unknown')).sort((a, b) => b[1] - a[1]).slice(0, 25)), orgsByList: by(orgs.flatMap((o) => (o.lists || []).map((l) => ({ l }))), (x) => x.l), orgsHeld: orgs.filter((o) => reachOf(o, cfgO).held).length,
  };
}
/** Preview the first step for one contact without sending (Master Control "Preview"). */
async function preview(contactId, sequenceId = 'standard', stepIndex = 0) {
  const c = await getContact(contactId); const org = (await allOrgs()).find((o) => o.id === c.orgId); const seq = await getSeq(sequenceId); const cfg = await getConfig();
  const step = seq.steps[stepIndex]; if (!step) throw err(422, 'bad_step');
  return compose(c, org, step, { ...cfg, senderName: cfg.senderName || '(your name)', postalAddress: cfg.postalAddress || '(your postal address)', publicBaseUrl: cfg.publicBaseUrl || 'https://example.invalid' });
}

// ------------------------------------------------------------ referral programme
// Anyone who has been contacted (or a partner who signs up) gets a personal link. They can (a) share a tracked link and
// (b) introduce a colleague by business email. An introduction only goes out if the referrer attests they know the
// person; it is one email + two follow-ups from the normal sequence, with the usual source note and one-click opt-out.
// Points come from what the referred person does (replied, opened the sandbox, took a meeting, org became a partner),
// never from raw sends. Rewards are set by the operator as free text: this module only tracks eligibility.
const REF = 'out:ref:'; const RFL = 'out:rfl:';
const firstWord = (n) => String(n || '').trim().split(/\s+/)[0] || '';
async function refEnabled() { return (await getConfig()).referral.enabled; }
async function getReferrer(code) {
  code = String(code || ''); if (!/^[A-Za-z0-9_-]{4,40}$/.test(code)) return null;
  const r = await store.settings.get(REF + code); if (r) return r;
  if (code[0] === 'c') { // contacts get a deterministic code from their token; the record is created on first use
    const t = await store.settings.get('out:tok:' + code.slice(1)); const c = t && t.id ? await store.settings.get(CON + t.id) : null;
    if (c && !c.optedOut) {
      const org = (await allOrgs()).find((o) => o.id === c.orgId);
      const rec = { code, kind: 'contact', contactId: c.id, name: c.kind === 'role' ? ((org && org.name) || 'A colleague') + ' team' : c.name, org: org ? org.name : '', clicks: 0, rewards: [], createdAt: now() };
      await store.settings.set(REF + code, rec); return rec;
    }
  }
  return null;
}
async function joinAsPartner(b = {}) {
  if (!(await refEnabled())) throw err(404, 'referral_programme_closed');
  const name = String(b.name || '').trim().slice(0, 100); if (!name) throw err(422, 'name_required');
  const em = String(b.email || '').trim().toLowerCase(); if (!EMAIL_RE.test(em)) throw err(422, 'email_invalid');
  const rec = { code: 'p' + crypto.randomBytes(5).toString('hex'), kind: 'partner', name, email: em, org: String(b.org || '').trim().slice(0, 120), clicks: 0, rewards: [], createdAt: now() };
  await store.settings.set(REF + rec.code, rec); return rec;
}
async function trackReferralClick(code) {
  if (!(await refEnabled())) return null; const r = await getReferrer(code); if (!r) return null;
  r.clicks = (r.clicks || 0) + 1; await store.settings.set(REF + r.code, r);
  const u = (await getConfig()).sandboxUrl; return u + (u.includes('?') ? '&' : '?') + 'ref=' + encodeURIComponent(r.code);
}
async function introsOf(code) { const out = []; for (const k of await store.settings.keys(RFL)) { const x = await store.settings.get(k); if (x && x.code === code) out.push(x); } return out.sort((a, b) => b.at.localeCompare(a.at)); }
function stageOf(c, org) {
  if (!c) return 'removed'; if (org && org.status === 'partner') return 'partner';
  return { new: 'introduced', queued: 'introduced', contacted: 'introduced', replied: 'replied', sandbox: 'sandbox', meeting: 'meeting', declined: 'declined' }[c.status] || 'introduced';
}
async function referralStats(code) {
  const r = await getReferrer(code); if (!r) throw err(404, 'referrer_not_found');
  const cfg = await getConfig(); const rc = cfg.referral; const orgs = new Map((await allOrgs()).map((o) => [o.id, o]));
  const rows = []; let points = 0; const partnerPaid = new Set();
  for (const i of await introsOf(r.code)) {
    const c = await store.settings.get(CON + i.contactId); const org = orgs.get(i.orgId); const stage = stageOf(c, org);
    let pts = rc.points[stage] || 0;
    if (stage === 'partner') { if (partnerPaid.has(i.orgId)) pts = 0; else partnerPaid.add(i.orgId); } // partner points once per organisation
    points += pts;
    rows.push({ first: firstWord(i.name), org: org ? org.name : '', stage, points: pts, at: i.at });
  }
  const tier = [...rc.tiers].reverse().find((t) => points >= t.at) || null; const next = rc.tiers.find((t) => points < t.at) || null;
  const base = String(cfg.publicBaseUrl || '').replace(/\/$/, '');
  return { code: r.code, name: r.name, org: r.org, kind: r.kind, clicks: r.clicks || 0, intros: rows, points, tier, next, rewards: r.rewards || [], terms: rc.terms, tiers: rc.tiers, pointsTable: rc.points, enabled: rc.enabled,
    shareLink: `${base}/o/r/${r.code}`, pageLink: `${base}/o/refer/${r.code}`, createdAt: r.createdAt };
}
async function introduce(code, b = {}) {
  const cfg = await getConfig(); if (!cfg.referral.enabled) throw err(404, 'referral_programme_closed');
  const r = await getReferrer(code); if (!r) throw err(404, 'referrer_not_found');
  if (!b.attest || b.attest === 'false') throw err(422, 'Please confirm that you know this person and that a short business introduction is welcome.');
  const today = now().slice(0, 10); const mine = (await introsOf(r.code)).filter((x) => x.at.slice(0, 10) === today).length;
  if (mine >= cfg.referral.maxIntrosPerDay) throw err(429, `You can introduce up to ${cfg.referral.maxIntrosPerDay} people a day. Please try again tomorrow.`);
  const orgName = String(b.org || '').trim().slice(0, 120); if (!orgName) throw err(422, 'organisation_required');
  const orgs = await allOrgs(); let org = orgs.find((o) => o.name.toLowerCase() === orgName.toLowerCase());
  if (!org) org = await addOrg({ name: orgName, type: TYPES.includes(b.orgType) ? b.orgType : 'other', country: b.country, note: 'added by referral' });
  let c;
  try {
    c = await addContact({ orgId: org.id, name: b.name, role: b.role, email: b.email, lang: b.lang, persona: b.persona, source: `Introduced by ${r.name}${r.org ? ' (' + r.org + ')' : ''} on ${today}; the referrer confirmed they know this person` }, { by: 'referral:' + r.code });
  } catch (e) {
    if (e.status === 409 && /duplicate/.test(e.message)) return { ok: true, already: true };
    if (e.status === 409) throw err(422, 'That address cannot be contacted.');
    throw e;
  }
  const full = await getContact(c.id); full.referredBy = r.code; note(full, { type: 'referred', by: r.code }); await saveContact(full);
  await enroll({ contactIds: [c.id], sequenceId: 'referral' });
  await store.settings.set(RFL + rid('i'), { code: r.code, contactId: c.id, orgId: org.id, name: c.name, at: now() });
  return { ok: true };
}
async function addReward(code, text, by) {
  const r = await getReferrer(code); if (!r) throw err(404, 'referrer_not_found');
  r.rewards = (r.rewards || []).concat({ at: now(), note: String(text || 'reward given').slice(0, 300), by: by || null }); await store.settings.set(REF + r.code, r); return r.rewards;
}
async function referralOverview() {
  const cfg = await getConfig(); const list = [];
  for (const k of await store.settings.keys(REF)) { const r = await store.settings.get(k); if (!r) continue; try { const s = await referralStats(r.code); if (r.kind === 'partner' || s.clicks || s.intros.length) list.push({ ...s, email: r.email }); } catch (_e) { /* skip */ } }
  list.sort((a, b) => b.points - a.points || b.intros.length - a.intros.length);
  const t = list.reduce((m, x) => ({ clicks: m.clicks + x.clicks, intros: m.intros + x.intros.length, sandbox: m.sandbox + x.intros.filter((i) => ['sandbox', 'meeting', 'partner'].includes(i.stage)).length, meetings: m.meetings + x.intros.filter((i) => ['meeting', 'partner'].includes(i.stage)).length }), { clicks: 0, intros: 0, sandbox: 0, meetings: 0 });
  return { config: cfg.referral, totals: t, referrers: list.slice(0, 200) };
}
async function addPartnerByAdmin(b) {
  const cfg = await getConfig(); const wasOn = cfg.referral.enabled;
  if (!wasOn) { cfg.referral.enabled = true; await store.settings.set(CFG, cfg); }
  try { const r = await joinAsPartner(b); return referralStats(r.code); } finally { if (!wasOn) { cfg.referral.enabled = false; await store.settings.set(CFG, cfg); } }
}

module.exports = {
  TYPES, PERSONAS, PHONE_TYPES, classifyPhone, roleOf, ORG_STATUS, getConfig, setConfig, publicConfig,
  seedOrgs, seedCountries, listPacks, importList, classifyName, countryTable, reachOf, listOrgs, addOrg, updateOrg, addContact, importContacts, listContacts, setContactStatus, patchContact, eraseContact, optOut, handleInboundText,
  getReferrer, joinAsPartner, trackReferralClick, referralStats, introduce, addReward, referralOverview, addPartnerByAdmin,
  listSequences, enroll, pause, runDue, preview, listTasks, completeTask, trackClick, submitFeedback, listFeedback, overview, isSuppressed, suppress,
};
