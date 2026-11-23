'use strict';
/**
 * "My apps": the platform owner's catalogue of web applications (Railway addresses and custom subdomains), and a bulk way to open any list of
 * addresses for iteration in a workspace. Each address becomes a connected site: Dry Run reads the public pages and builds a working model
 * straight away, so teams can iterate with nothing installed; installing the Dry Run connector later upgrades a site to Dry Run signed.
 * An address that cannot be read yet (a sign-in wall, a cold start) is still added, and shows what to do next.
 */
const reg = require('./registry');
const orgs = require('./orgs');
const connect = require('./connect');
const audit = require('./audit');
const { err, iso, id } = require('./util');

const DEFAULT_APPS = [
  { name: 'Dry Run', note: 'This platform', urls: ['https://dryrun.hnnworld.com', 'https://dry-run-production-6267ad2d.up.railway.app'] },
  { name: 'HNN Biller', note: 'Billing, claims, InsureCredit, savings plans', urls: ['https://hnnbiller.xchangeinsure.com', 'https://nextgenhnnbiller-production-bdf1.up.railway.app', 'https://nextgenhnnbiller-production-ba01.up.railway.app'] },
  { name: 'TrimesterSave app (Afriyie)', note: 'Patient savings and health app', urls: ['https://tmsapp.trimestersave.com', 'https://trimestersavefe-production.up.railway.app'] },
  { name: 'ERHeat', note: '', urls: ['https://erheat-app-production.up.railway.app'] },
  { name: 'SMS dashboard', note: 'Africa\'s Talking SMS', urls: ['https://sms-dashboard-s24m-production.up.railway.app'] },
  { name: 'SMS API', note: '', urls: ['https://sms-api-production-7342.up.railway.app'] },
];
const cfg = () => { const r = reg.load(); r.config = r.config || {}; return r.config; };
const clip = (s, n) => String(s || '').trim().slice(0, n);
function cleanUrl(u) {
  let x; try { x = new URL(String(u).trim()); } catch { return null; } const okProto = x.protocol === 'https:' || (x.protocol === 'http:' && process.env.DRYRUN_ALLOW_PRIVATE_TESTS === '1'); if (!okProto || x.username || x.password) return null; return x.origin;
}
const hostOk = (h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) && h.length <= 253;
/** Turn what a person typed into https origins. Railway names (no dots) get .up.railway.app; subdomains are joined to the base domain. */
function expand({ railway = [], base = '', subs = [], urls = [] } = {}) {
  const out = []; const bad = []; const push = (raw, u) => { const o = cleanUrl(u); if (o && (hostOk(new URL(o).hostname) || (process.env.DRYRUN_ALLOW_PRIVATE_TESTS === '1' && /^\d+\.\d+\.\d+\.\d+$/.test(new URL(o).hostname)))) { if (!out.includes(o)) out.push(o); } else bad.push(raw); };
  const toList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  for (const r of toList(railway)) { const h = r.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); push(r, `https://${h.includes('.') ? h : `${h}.up.railway.app`}`); }
  const b = String(base || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\.+|\/.*$/g, '');
  for (const s of toList(subs)) { if (!b) { bad.push(s); continue; } const sub = s.replace(/\.$/, '').replace(new RegExp(`\\.${b.replace(/\./g, '\\.')}$`), ''); push(s, sub === '@' || sub === '' ? `https://${b}` : `https://${sub}.${b}`); }
  for (const u of toList(urls)) push(u, /^https?:\/\//.test(u) ? u : `https://${u}`);
  return { urls: out, rejected: bad };
}
function apps() { const c = cfg(); return c.myApps && Array.isArray(c.myApps) ? c.myApps : DEFAULT_APPS.map((a) => ({ ...a, id: a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') })); }
function setApps(list) {
  if (!Array.isArray(list) || list.length > 40) throw err(422, 'Send up to 40 apps.');
  const clean = list.map((a) => { const e = expand({ urls: a.urls || [], railway: a.railway || [], base: a.base, subs: a.subs }); if (!clip(a.name, 80)) throw err(422, 'Every app needs a name.'); return { id: a.id || id('app'), name: clip(a.name, 80), note: clip(a.note, 160), urls: e.urls }; });
  cfg().myApps = clean; reg.save(); return clean;
}
/** Open addresses for iteration in a workspace. Returns one line per address; never stops at the first problem. */
async function openIn(orgId, actor, role, urls, { read = true } = {}) {
  const o = orgs.raw(orgId); const list = [...new Set((urls || []).map(cleanUrl).filter(Boolean))].slice(0, 20); if (!list.length) throw err(422, 'Give at least one https address.');
  const results = [];
  for (const url of list) {
    try {
      let r; let how = 'connected';
      if (read) { try { r = await connect.read(orgId, actor, role, { url }); how = r.skipped ? 'already signed' : 'read, working model built'; } catch (e) { if (e.status === 422 && /most sites/.test(e.message)) throw e; r = await connect.create(orgId, actor, role, { url }); how = `added, not read yet (${e.message})`; } }
      else { r = await connect.create(orgId, actor, role, { url }); }
      const site = (r.site || r); results.push({ url, ok: true, how, siteId: site.id, level: site.level });
    } catch (e) { results.push({ url, ok: false, problem: e.message }); if (/most sites/.test(e.message)) break; }
  }
  await audit.log(orgId, actor, 'apps.open', { count: results.filter((x) => x.ok).length, of: list.length });
  return { organisation: o.name, results, added: results.filter((x) => x.ok).length };
}
module.exports = { DEFAULT_APPS, expand, apps, setApps, openIn };
