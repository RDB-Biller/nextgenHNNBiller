'use strict';
/** A small Express-compatible router (just what Dry Run uses), so the service has no web-framework dependency to install. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function compile(pattern) { const keys = []; const re = new RegExp('^' + pattern.replace(/\/+$/, '').replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$'); return { re, keys }; }

function Router() {
  const layers = [];
  const r = (req, res, out) => {
    let i = 0; const baseUrl = req.baseUrl || ''; const url = req.url; const pathname = url.split('?')[0];
    const next = (e) => {
      req.baseUrl = baseUrl; req.url = url;
      const l = layers[i++]; if (!l) return out(e);
      if (e && !l.err) return next(e); if (!e && l.err) return next();
      try {
        if (l.kind === 'use') {
          const p = l.path; if (p && !(pathname === p || pathname.startsWith(p + '/'))) return next(e);
          if (p) { req.baseUrl = baseUrl + p; req.url = url.slice(p.length) || '/'; }
          const cont = (x) => { req.baseUrl = baseUrl; req.url = url; next(x); };
          return l.err ? l.fn(e, req, res, cont) : l.fn(req, res, cont);
        }
        if (req.method !== l.method) return next(e);
        const m = l.re.exec(pathname); if (!m) return next(e);
        req.params = Object.fromEntries(l.keys.map((k, n) => [k, decodeURIComponent(m[n + 1])]));
        const hs = l.fns; let j = 0;
        const step = (x) => { if (x) return next(x); const h = hs[j++]; if (!h) return next(); try { const ret = h(req, res, step); if (ret && ret.catch) ret.catch(next); } catch (er) { next(er); } };
        return step();
      } catch (er) { next(er); }
    };
    next();
  };
  r.use = (a, ...fns) => { const p = typeof a === 'string' ? a : ''; const list = typeof a === 'string' ? fns : [a, ...fns]; for (const fn of list) layers.push({ kind: 'use', path: p, fn, err: fn.length === 4 }); return r; };
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) r[m] = (p, ...fns) => { layers.push({ kind: 'route', method: m.toUpperCase(), ...compile(p), fns }); return r; };
  return r;
}

function json(opts = {}) { const limit = parseSize(opts.limit); return (req, res, next) => body(req, limit, (e, raw) => { if (e) return next(e); if (!raw || !/json/.test(req.headers['content-type'] || '')) return next(); try { req.body = JSON.parse(raw); next(); } catch { next(Object.assign(new Error('The request body is not valid JSON.'), { status: 400 })); } }); }
function text(opts = {}) { const limit = parseSize(opts.limit); return (req, res, next) => { if (!/text\/csv|text\/plain/.test(req.headers['content-type'] || '')) return next(); body(req, limit, (e, raw) => { if (e) return next(e); req.body = raw; next(); }); }; }
function parseSize(s) { const m = /^(\d+)\s*(mb|kb)?$/i.exec(String(s || '1mb')); return Number(m[1]) * (/mb/i.test(m[2] || '') ? 1048576 : /kb/i.test(m[2] || '') ? 1024 : 1); }
function body(req, limit, cb) {
  if (req.method === 'GET' || req.method === 'DELETE' && !req.headers['content-length']) return cb(null, '');
  if (/^application\/octet-stream/.test(req.headers['content-type'] || '')) return cb(null, '');
  if (req._raw !== undefined) return cb(null, req._raw);
  let size = 0; const chunks = []; req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); return cb(Object.assign(new Error('The request is too large.'), { status: 413 })); } chunks.push(c); });
  req.on('end', () => { req._raw = Buffer.concat(chunks).toString('utf8'); cb(null, req._raw); }); req.on('error', cb);
}
function serveStatic(dir) {
  return (req, res, next) => {
    if (req.method !== 'GET') return next(); let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const f = path.join(dir, path.normalize(p)); if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return next();
    res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res);
  };
}
function express() {
  const app = Router();
  app.handler = (req, res) => {
    const q = new URL(req.url, 'http://x'); req.query = Object.fromEntries(q.searchParams); req.body = req.body || {}; req.params = {};
    req.get = (h) => req.headers[String(h).toLowerCase()];
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
    app(req, res, (e) => { res.status(e && e.status || 404).json({ error: e ? e.message : 'Not found.' }); });
  };
  app.listen = (port, cb) => http.createServer(app.handler).listen(port, cb);
  return app;
}
/** Reads a binary request body up to `limit` bytes. */
express.readBinary = (req, limit) => new Promise((resolve, reject) => { let size = 0; const chunks = []; req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); return reject(Object.assign(new Error('That file is too large.'), { status: 413 })); } chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); });
express.Router = Router; express.json = json; express.text = text; express.static = serveStatic;
module.exports = express;
