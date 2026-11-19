'use strict';
/**
 * Translation for the multilingual Workroom. It uses your own LibreTranslate service (set LIBRETRANSLATE_URL, and
 * LIBRETRANSLATE_API_KEY if it needs one). Nothing depends on it: when it is off, down, or lacks a language, people
 * simply read the original text and are told so. Each message is stored once, in the author's words; translations are
 * made for the reader and cached, so the same text is only ever translated once per language pair.
 * Code, links, file paths and @mentions are never translated.
 */
const http = require('http'); const https = require('https'); const crypto = require('crypto');
const reg = require('./registry');
const iso = () => new Date().toISOString();

// lt = LibreTranslate's code. Whether the running service really has a language is checked against its /languages list.
const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', rtl: false, lt: 'en' },
  { code: 'pt', name: 'Portuguese', native: 'Português', rtl: false, lt: 'pt' },
  { code: 'fr', name: 'French', native: 'Français', rtl: false, lt: 'fr' },
  { code: 'es', name: 'Spanish', native: 'Español', rtl: false, lt: 'es' },
  { code: 'ar', name: 'Arabic', native: 'العربية', rtl: true, lt: 'ar' },
  { code: 'zh', name: 'Chinese (Simplified)', native: '中文', rtl: false, lt: 'zh' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', rtl: false, lt: 'hi' },
  { code: 'de', name: 'German', native: 'Deutsch', rtl: false, lt: 'de' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili', rtl: false, lt: 'sw' },
  { code: 'tw', name: 'Twi', native: 'Twi', rtl: false, lt: 'ak' },
  { code: 'ha', name: 'Hausa', native: 'Hausa', rtl: false, lt: 'ha' },
  { code: 'yo', name: 'Yoruba', native: 'Yorùbá', rtl: false, lt: 'yo' },
  { code: 'gaa', name: 'Ga', native: 'Gã', rtl: false, lt: 'gaa' },
];
const BY = new Map(LANGUAGES.map((l) => [l.code, l]));
const DEFAULT = 'en', MAX = 2000, CACHE_MAX = 4000;
const DAILY_ALL = Number(process.env.TRANSLATE_DAILY_CHARS) || 300000, DAILY_ORG = Number(process.env.TRANSLATE_DAILY_CHARS_PER_TEAM) || 60000;
const isKnown = (c) => !!c && BY.has(String(c).toLowerCase().trim());
const normalise = (c) => { if (!c) return DEFAULT; const x = String(c).toLowerCase().trim().replace('_', '-'); if (BY.has(x)) return x; const b = x.split('-')[0]; if (b === 'ak') return 'tw'; return BY.has(b) ? b : DEFAULT; };
const lang = (c) => BY.get(normalise(c));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

const cfg = () => ({ url: (process.env.LIBRETRANSLATE_URL || '').trim().replace(/\/+$/, ''), key: process.env.LIBRETRANSLATE_API_KEY || '' });
let impl = null; let supportCache = null;
const _setRequestForTests = (fn) => { impl = fn; supportCache = null; };
function request(method, urlStr, body, timeoutMs = 8000) {
  if (impl) return impl(method, urlStr, body);
  return new Promise((resolve) => { let u; try { u = new URL(urlStr); } catch { return resolve({ status: 0, error: 'The translator address is not valid.' }); }
    const lib = u.protocol === 'https:' ? https : http; const data = body ? JSON.stringify(body) : null;
    const req = lib.request({ method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, timeout: timeoutMs }, (res) => { let b = ''; res.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not JSON */ } resolve({ status: res.statusCode, json: j }); }); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', (e) => resolve({ status: 0, error: e.message })); if (data) req.write(data); req.end(); });
}
/** Which of our languages the running LibreTranslate can handle. Cached for a few minutes. */
async function support() {
  const c = cfg(); if (!c.url) return { on: false, why: 'The translator is not set up yet.' };
  if (supportCache && Date.now() - supportCache.at < 300000) return supportCache.v;
  const r = await request('GET', c.url + '/languages', null, 6000); let v;
  if (r.status === 200 && Array.isArray(r.json)) v = { on: true, codes: new Set(r.json.map((x) => x.code)), targets: Object.fromEntries(r.json.map((x) => [x.code, new Set(x.targets || [])])) };
  else v = { on: false, why: r.error ? 'The translator did not answer.' : `The translator answered ${r.status}.` };
  supportCache = { at: v.on ? Date.now() : Date.now() - 270000, v }; return v;
}
const canPair = (s, from, to) => { const a = BY.get(from), b = BY.get(to); return !!(s.on && a && b && s.codes.has(a.lt) && s.codes.has(b.lt) && (!s.targets[a.lt] || !s.targets[a.lt].size || s.targets[a.lt].has(b.lt))); };

// ---- usage cap and cache ------------------------------------------------------------------------------------------------------------
const usage = () => { const r = reg.load(); r.trUsage = r.trUsage || { day: '', chars: 0, calls: 0, orgs: {} }; const d = iso().slice(0, 10); if (r.trUsage.day !== d) r.trUsage = { day: d, chars: 0, calls: 0, orgs: {} }; return r.trUsage; };
const cacheOf = () => { const r = reg.load(); r.trCache = r.trCache || { keys: [], map: {} }; return r.trCache; };
function remember(k, v) { const c = cacheOf(); if (!(k in c.map)) { c.keys.push(k); if (c.keys.length > CACHE_MAX) for (const old of c.keys.splice(0, 500)) delete c.map[old]; } c.map[k] = v; }

// ---- what is never translated -------------------------------------------------------------------------------------------------------
const KEEP = /(```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+|(?:^|\s)(?:\/|~\/|\.\/)[\w.\-/]+|@[\w.-]+)/g;
function segments(text) { const out = []; let last = 0, m; KEEP.lastIndex = 0; while ((m = KEEP.exec(text))) { if (m.index > last) out.push({ t: text.slice(last, m.index), tr: true }); out.push({ t: m[0], tr: false }); last = m.index + m[0].length; } if (last < text.length) out.push({ t: text.slice(last), tr: true }); return out; }

/**
 * Translate text for a reader. Always resolves, never throws.
 * Result: { ok:true, text, cached } or { ok:false, why } where why is one of: same, off, pair, cap, error.
 */
async function translate(text, from, to, { orgId } = {}) {
  const f = normalise(from), t = normalise(to); const src = String(text == null ? '' : text).slice(0, MAX);
  if (!src.trim()) return { ok: false, why: 'same' }; if (f === t) return { ok: false, why: 'same' };
  const key = `${f}>${t}:${sha(src)}`; const c = cacheOf(); if (key in c.map) return { ok: true, text: c.map[key], cached: true };
  const s = await support(); if (!s.on) return { ok: false, why: 'off', note: s.why }; if (!canPair(s, f, t)) return { ok: false, why: 'pair' };
  const u = usage(); const need = src.length; const org = orgId ? (u.orgs[orgId] || 0) : 0;
  if (u.chars + need > DAILY_ALL || org + need > DAILY_ORG) return { ok: false, why: 'cap' };
  const C = cfg(); const parts = segments(src); let out = '', any = false;
  for (const p of parts) {
    if (!p.tr || !/\p{L}/u.test(p.t)) { out += p.t; continue; }
    const lead = p.t.match(/^\s*/)[0], trail = p.t.match(/\s*$/)[0]; const core = p.t.trim();
    const r = await request('POST', C.url + '/translate', { q: core, source: BY.get(f).lt, target: BY.get(t).lt, format: 'text', ...(C.key ? { api_key: C.key } : {}) });
    if (r.status !== 200 || !r.json || typeof r.json.translatedText !== 'string') { supportCache = null; return { ok: false, why: 'error', note: r.error || `The translator answered ${r.status}.` }; }
    out += lead + r.json.translatedText + trail; any = true;
  }
  if (!any) return { ok: false, why: 'same' };
  u.chars += need; u.calls++; if (orgId) u.orgs[orgId] = org + need; remember(key, out); reg.save(); return { ok: true, text: out, cached: false };
}
/** What the translator is doing right now, for the platform owner. */
async function status() { const c = cfg(); const s = await support(); const u = usage(); return { configured: !!c.url, reachable: !!s.on, why: s.on ? null : s.why, languages: LANGUAGES.map((l) => ({ code: l.code, name: l.name, native: l.native, rtl: l.rtl, machine: !!(s.on && s.codes.has(l.lt)) })), usedToday: u.chars, cap: DAILY_ALL, calls: u.calls, cached: Object.keys(cacheOf().map).length }; }
const refresh = () => { supportCache = null; return status(); };
module.exports = { LANGUAGES, lang, isKnown, normalise, translate, status, refresh, segments, _setRequestForTests };
