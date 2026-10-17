'use strict';

/**
 * Languages, UI catalogs and machine translation.
 *
 * Machine translation uses LibreTranslate ONLY (self-hostable, no per-message
 * cost, no vendor lock-in). Nothing here depends on it to operate:
 *   - UI text comes from reviewed catalogs in src/i18n/locales/*.json and falls
 *     back key-by-key to English;
 *   - translate() returns {ok:false} when LibreTranslate is not configured, is
 *     down, does not support the language pair, or the daily cap is reached --
 *     callers then show the original text.
 * Translations are cached forever in the settings store (same text + pair is
 * only ever translated once), and counted against a daily character cap.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const store = require('../store');

// `lt` = LibreTranslate code. Whether the *running* server really supports it
// is checked against its /languages list, so Hausa/Yoruba/Twi/Ga only
// machine-translate if the operator's LibreTranslate has those models.
// `reviewed:false` = UI strings need a native speaker before patients see them.
const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', rtl: false, lt: 'en', reviewed: true },
  { code: 'fr', name: 'French', native: 'Français', rtl: false, lt: 'fr', reviewed: true },
  { code: 'pt', name: 'Portuguese', native: 'Português', rtl: false, lt: 'pt', reviewed: true },
  { code: 'es', name: 'Spanish', native: 'Español', rtl: false, lt: 'es', reviewed: true },
  { code: 'ar', name: 'Arabic', native: 'العربية', rtl: true, lt: 'ar', reviewed: true },
  { code: 'zh', name: 'Chinese (Simplified)', native: '中文', rtl: false, lt: 'zh', reviewed: true },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', rtl: false, lt: 'hi', reviewed: true },
  { code: 'de', name: 'German', native: 'Deutsch', rtl: false, lt: 'de', reviewed: true },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili', rtl: false, lt: 'sw', reviewed: true },
  { code: 'tw', name: 'Twi', native: 'Twi', rtl: false, lt: 'ak', reviewed: false },
  { code: 'ha', name: 'Hausa', native: 'Hausa', rtl: false, lt: 'ha', reviewed: false },
  { code: 'yo', name: 'Yoruba', native: 'Yorùbá', rtl: false, lt: 'yo', reviewed: false },
  { code: 'gaa', name: 'Ga', native: 'Gã', rtl: false, lt: 'gaa', reviewed: false },
];
const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
const DEFAULT_LANG = 'en';
const MAX_TEXT = 2000;

function lang(code) { return BY_CODE.get(normalise(code)) || null; }
function normalise(code) {
  if (!code) return DEFAULT_LANG;
  const c = String(code).toLowerCase().trim().replace('_', '-');
  if (BY_CODE.has(c)) return c;
  const base = c.split('-')[0];
  if (base === 'zh') return 'zh';
  if (base === 'ak') return 'tw';
  return BY_CODE.has(base) ? base : DEFAULT_LANG;
}
function isKnown(code) { return !!code && BY_CODE.has(String(code).toLowerCase().trim()); }

// ---------------------------------------------------------------- catalogs
const CATALOG_DIR = path.join(__dirname, '..', 'i18n', 'locales');
const catalogs = {};
function loadCatalog(code) {
  if (catalogs[code]) return catalogs[code];
  let o = {};
  try { o = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, code + '.json'), 'utf8')); } catch (_) { o = {}; }
  catalogs[code] = o;
  return o;
}
/** Catalog for a language with English filled in for every missing key. */
function catalog(code) {
  const c = normalise(code);
  const en = loadCatalog('en');
  const cur = c === 'en' ? en : loadCatalog(c);
  const out = { ...en, ...cur };
  const missing = Object.keys(en).filter((k) => !cur[k]).length;
  return { lang: c, rtl: lang(c).rtl, reviewed: lang(c).reviewed, total: Object.keys(en).length, missing, strings: out };
}
/** Server-side message lookup, e.g. t('sms.otp', 'fr', {code:'123456'}). */
function t(key, code, vars) {
  const c = normalise(code);
  let s = loadCatalog(c)[key] || loadCatalog('en')[key] || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
  return s;
}

// ------------------------------------------------------------------ config
const CFG_KEY = 'i18n_config';
function envConfig() {
  return {
    url: (process.env.LIBRETRANSLATE_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.LIBRETRANSLATE_API_KEY || '',
  };
}
async function getConfig() {
  const s = (await store.settings.get(CFG_KEY)) || {};
  const e = envConfig();
  return {
    enabled: s.enabled !== false, // switch in Master Control
    url: (s.url || e.url || '').replace(/\/+$/, ''),
    apiKey: s.apiKey || e.apiKey || '',
    dailyCharCap: Number.isFinite(s.dailyCharCap) ? s.dailyCharCap : 200000,
    showUnreviewed: s.showUnreviewed === true, // unreviewed UI languages hidden from patients by default
    updatedAt: s.updatedAt || null,
    updatedBy: s.updatedBy || null,
  };
}
async function setConfig(patch, by) {
  const cur = (await store.settings.get(CFG_KEY)) || {};
  const next = { ...cur };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.url !== undefined) {
    const u = String(patch.url || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) { const e = new Error('url must start with http:// or https://'); e.status = 422; throw e; }
    next.url = u;
  }
  if (patch.apiKey !== undefined) next.apiKey = String(patch.apiKey || '').trim();
  if (patch.dailyCharCap !== undefined) {
    const n = Number(patch.dailyCharCap);
    if (!Number.isFinite(n) || n < 0) { const e = new Error('dailyCharCap must be a number >= 0'); e.status = 422; throw e; }
    next.dailyCharCap = Math.floor(n);
  }
  if (patch.showUnreviewed !== undefined) next.showUnreviewed = !!patch.showUnreviewed;
  next.updatedAt = new Date().toISOString();
  next.updatedBy = by || null;
  await store.settings.set(CFG_KEY, next);
  supportCache = null;
  return publicConfig();
}
async function publicConfig() {
  const c = await getConfig();
  const used = await usageToday();
  return {
    enabled: c.enabled, url: c.url, apiKeySet: !!c.apiKey, configured: !!c.url,
    dailyCharCap: c.dailyCharCap, usedToday: used.chars, showUnreviewed: c.showUnreviewed,
    updatedAt: c.updatedAt, updatedBy: c.updatedBy,
  };
}
async function listLanguages({ audience } = {}) {
  const c = await getConfig();
  return LANGUAGES
    .filter((l) => audience !== 'patient' || l.reviewed || c.showUnreviewed)
    .map(({ code, name, native, rtl, reviewed }) => ({ code, name, native, rtl, reviewed }));
}

// ----------------------------------------------------------------- transport
let requestImpl = null; // tests
function _setRequestImplForTests(fn) { requestImpl = fn; supportCache = null; }

function rawRequest(method, urlStr, body, timeoutMs) {
  if (requestImpl) return requestImpl(method, urlStr, body);
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      timeout: timeoutMs || 8000,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; if (buf.length > 2e6) req.destroy(new Error('response too large')); });
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Languages the running LibreTranslate actually offers (cached 10 min).
let supportCache = null;
async function ltSupport(cfg) {
  const now = Date.now();
  if (supportCache && supportCache.url === cfg.url && now - supportCache.at < 10 * 60000) return supportCache.codes;
  try {
    const r = await rawRequest('GET', cfg.url + '/languages', null, 5000);
    const codes = Array.isArray(r.body) ? new Set(r.body.map((x) => x.code)) : null;
    supportCache = { url: cfg.url, at: now, codes };
    return codes;
  } catch (_) {
    supportCache = { url: cfg.url, at: now - 9 * 60000, codes: null }; // retry in ~1 min
    return null;
  }
}

// ------------------------------------------------------------- usage / cache
const day = () => new Date().toISOString().slice(0, 10);
async function usageToday() { return (await store.settings.get('i18n_usage:' + day())) || { chars: 0, calls: 0 }; }
async function addUsage(chars) {
  const u = await usageToday();
  await store.settings.set('i18n_usage:' + day(), { chars: u.chars + chars, calls: u.calls + 1 });
}
const ckey = (text, from, to) => 'i18n_cache:' + crypto.createHash('sha256').update(from + '>' + to + '\n' + text).digest('hex').slice(0, 40);

// ------------------------------------------------- code / URL preservation
// Developers paste code, paths, URLs, @mentions: translate the prose around
// them, never the tokens themselves.
const KEEP_RE = /(```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+|@[\w.-]+|\b[\w.-]+\/[\w./-]+\b|\b[A-Za-z_][\w]*\([^)\n]*\)|\b[A-Z][A-Z0-9_]{2,}\b)/g;
function segments(text) {
  const out = [];
  let last = 0;
  text.replace(KEEP_RE, (m, _g, off) => {
    if (off > last) out.push({ t: text.slice(last, off), keep: false });
    out.push({ t: m, keep: true });
    last = off + m.length;
    return m;
  });
  if (last < text.length) out.push({ t: text.slice(last), keep: false });
  return out;
}

/**
 * translate(text, from, to) -> { ok, text, from, to, cached?, reason? }
 * Never throws for operational problems; reason is one of:
 * same-language | empty | not-configured | disabled | unsupported-pair |
 * cap-reached | too-long | unavailable
 */
async function translate(text, from, to) {
  const src = normalise(from); const dst = normalise(to);
  const s = String(text == null ? '' : text);
  if (!s.trim()) return { ok: false, text: s, from: src, to: dst, reason: 'empty' };
  if (src === dst) return { ok: true, text: s, from: src, to: dst, reason: 'same-language' };
  if (s.length > MAX_TEXT) return { ok: false, text: s, from: src, to: dst, reason: 'too-long' };
  const hit = await store.settings.get(ckey(s, src, dst));
  if (hit && typeof hit.text === 'string') return { ok: true, text: hit.text, from: src, to: dst, cached: true };
  const cfg = await getConfig();
  if (!cfg.enabled) return { ok: false, text: s, from: src, to: dst, reason: 'disabled' };
  if (!cfg.url) return { ok: false, text: s, from: src, to: dst, reason: 'not-configured' };
  const supported = await ltSupport(cfg);
  const lt = (l) => lang(l).lt;
  if (!supported) return { ok: false, text: s, from: src, to: dst, reason: 'unavailable' };
  if (!supported.has(lt(src)) || !supported.has(lt(dst))) return { ok: false, text: s, from: src, to: dst, reason: 'unsupported-pair' };
  const segs = segments(s);
  const proseChars = segs.filter((g) => !g.keep && /\p{L}/u.test(g.t)).reduce((n, g) => n + g.t.length, 0);
  if (proseChars === 0) return { ok: true, text: s, from: src, to: dst, reason: 'nothing-to-translate' };
  const used = await usageToday();
  if (used.chars + proseChars > cfg.dailyCharCap) return { ok: false, text: s, from: src, to: dst, reason: 'cap-reached' };
  try {
    let out = '';
    for (const g of segs) {
      if (g.keep || !/\p{L}/u.test(g.t)) { out += g.t; continue; }
      const lead = g.t.match(/^\s*/)[0]; const trail = g.t.match(/\s*$/)[0];
      const r = await rawRequest('POST', cfg.url + '/translate', {
        q: g.t.trim(), source: lt(src), target: lt(dst), format: 'text', ...(cfg.apiKey ? { api_key: cfg.apiKey } : {}),
      });
      if (r.status !== 200 || !r.body || typeof r.body.translatedText !== 'string') {
        return { ok: false, text: s, from: src, to: dst, reason: 'unavailable' };
      }
      out += lead + r.body.translatedText + trail;
    }
    await addUsage(proseChars);
    await store.settings.set(ckey(s, src, dst), { text: out, at: new Date().toISOString() });
    return { ok: true, text: out, from: src, to: dst };
  } catch (_) {
    return { ok: false, text: s, from: src, to: dst, reason: 'unavailable' };
  }
}

async function status() {
  const cfg = await getConfig();
  const out = { configured: !!cfg.url, enabled: cfg.enabled, reachable: false, machineLanguages: [], unsupportedLanguages: [] };
  if (!cfg.url) return out;
  const sup = await ltSupport(cfg);
  if (!sup) return out;
  out.reachable = true;
  for (const l of LANGUAGES) (sup.has(l.lt) ? out.machineLanguages : out.unsupportedLanguages).push(l.code);
  return out;
}
/** Force a fresh reachability check (Master Control "Test" button). */
async function testConnection() { supportCache = null; return status(); }

module.exports = {
  LANGUAGES, DEFAULT_LANG, lang, normalise, isKnown, catalog, t, listLanguages,
  getConfig, setConfig, publicConfig, translate, status, testConnection, segments,
  _setRequestImplForTests,
};
