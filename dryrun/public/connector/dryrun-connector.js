'use strict';
/**
 * Dry Run connector for Node (no dependencies). Works with Express, Connect or a plain http server.
 *
 *   const dryrun = require('./dryrun-connector');
 *   app.use(dryrun({ app, name: 'My product', token: process.env.DRYRUN_TOKEN, secret: process.env.DRYRUN_SECRET,
 *                    origins: [process.env.DRYRUN_ORIGIN], settings: { currency: 'GHS' } }));
 *
 * What it does (all read-only, nothing is changed on your site):
 *   GET /.well-known/dryrun.json   proves you control this site (public token) and lists what you allow
 *   GET /dryrun/dryrun.js          the page script that lets Dry Run preview iterations (needs dryrun.js beside this file)
 *   GET /dryrun/capture            signed requests from Dry Run only: routes, forms, settings, optional sample data
 *   GET /dryrun/pack.json          only if applyPack is on and dryrun-pack.json exists: the changes you approved
 * It never sends passwords, keys, tokens or cookies. Values under keys that look secret are replaced with "[hidden]".
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRETISH = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|private|credential|bearer|signature/i;
function scrub(v, d = 0) { if (d > 5) return null; if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrub(x, d + 1)); if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v).slice(0, 100)) o[k] = SECRETISH.test(k) ? '[hidden]' : scrub(x, d + 1); return o; } if (typeof v === 'string') return v.slice(0, 500); return v; }
const sameStr = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function listRoutes(app) {
  const out = []; try {
    const stack = (app && ((app._router && app._router.stack) || (app.router && app.router.stack))) || [];
    const walk = (st, prefix) => { for (const l of st) { if (l.route) { for (const m of Object.keys(l.route.methods || {})) out.push({ method: m.toUpperCase(), path: prefix + (l.route.path || '') }); } else if (l.handle && l.handle.stack) walk(l.handle.stack, prefix); } };
    walk(stack, '');
  } catch (e) { /* routes are optional */ }
  return out.filter((r) => !/^\/(dryrun|\.well-known)/.test(r.path)).slice(0, 200);
}

module.exports = function dryrun(opts = {}) {
  const token = opts.token, secret = opts.secret; if (!token || !secret) throw new Error('Dry Run connector: set token and secret (shown in the Dry Run Workroom, Sites).');
  const perms = Object.assign({ structure: true, iterate: true, sampleData: false }, opts.permissions || {});
  const origins = (opts.origins || []).filter(Boolean); const capturePath = '/dryrun/capture';
  const packFile = opts.packFile || path.join(process.cwd(), 'dryrun-pack.json'); let packCache = null;
  const loadPack = () => { try { const st = fs.statSync(packFile); if (!packCache || packCache.m !== st.mtimeMs) packCache = { m: st.mtimeMs, j: JSON.parse(fs.readFileSync(packFile, 'utf8')) }; return packCache.j; } catch { return null; } };
  const val = async (x) => (typeof x === 'function' ? x() : x);
  const send = (res, code, body, type = 'application/json') => { res.statusCode = code; res.setHeader('Content-Type', type + '; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

  async function handle(req, res) {
    const url = (req.originalUrl || req.url || '/').split('?')[0];
    if (perms.iterate && origins.length && !res.getHeader('Content-Security-Policy')) res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${origins.join(' ')}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (url === '/.well-known/dryrun.json') { send(res, 200, { dryrun: 1, token, capture: capturePath, overlay: true, permissions: perms, allowedOrigins: origins }); return true; }
    if (url === '/dryrun/dryrun.js') { try { send(res, 200, fs.readFileSync(path.join(__dirname, 'dryrun.js'), 'utf8'), 'application/javascript'); } catch { send(res, 404, { error: 'Put dryrun.js beside dryrun-connector.js.' }); } return true; }
    if (url === '/dryrun/pack.json') { const p = opts.applyPack || process.env.DRYRUN_APPLY_PACK === '1' ? loadPack() : null; if (!p) send(res, 404, { error: 'No pack is applied.' }); else send(res, 200, p); return true; }
    if (url === capturePath) {
      const ts = String(req.headers['x-dryrun-ts'] || ''), sig = String(req.headers['x-dryrun-sig'] || '');
      const fresh = /^\d{13}$/.test(ts) && Math.abs(Date.now() - Number(ts)) < 5 * 60 * 1000; const want = crypto.createHmac('sha256', secret).update(`${ts}.GET.${capturePath}`).digest('hex');
      if (!fresh || !sameStr(sig, want)) { send(res, 401, { error: 'Not signed by Dry Run.' }); return true; }
      if (!perms.structure) { send(res, 403, { error: 'Structure capture is not allowed.' }); return true; }
      try {
        const body = { dryrun: 1, name: opts.name || '', framework: opts.framework || (opts.app ? 'Node' : 'Node'), version: opts.version || '', routes: opts.routes || listRoutes(opts.app), forms: scrub(await val(opts.forms)) || [], api: scrub(await val(opts.api)) || null, settings: scrub(await val(opts.settings)) || {}, flags: scrub(await val(opts.flags)) || {}, permissions: perms };
        if (perms.sampleData && opts.sample) body.sample = scrub(await val(opts.sample));
        send(res, 200, body);
      } catch (e) { send(res, 500, { error: 'The connector could not build the capture.' }); }
      return true;
    }
    return false;
  }
  const mw = (req, res, next) => { handle(req, res).then((done) => { if (!done && next) next(); }, (e) => { if (next) next(e); else { res.statusCode = 500; res.end(); } }); };
  mw.handle = handle;
  /** Read a setting from the approved pack, falling back to your own default. */
  mw.setting = (key, fallback) => { const p = (opts.applyPack || process.env.DRYRUN_APPLY_PACK === '1') ? loadPack() : null; return p && p.settings && key in p.settings ? p.settings[key] : fallback; };
  return mw;
};
