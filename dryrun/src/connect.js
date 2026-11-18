'use strict';
/**
 * Connected sites.
 *  - "Dry Run signed": the owner installs the Dry Run connector (a server add-on and/or a small page script). They prove they control
 *    the site by publishing a token at /.well-known/dryrun.json. A site that also runs the server add-on answers signed read-only
 *    capture requests (routes, forms, settings, optional sample data). The page script lets Dry Run preview iterations as overlays.
 *  - "Inferred": any other public site. Dry Run reads what a visitor can see (and respects robots.txt) and guesses the functions.
 * Iterations are patch lists applied as overlays in a sandbox preview. They leave as a "Dry Run pack" the owner reviews and installs.
 * Dry Run never changes a live site and never copies code from a site that has not signed.
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const orgs = require('./orgs');
const plans = require('./plans');
const audit = require('./audit');
const bench = require('./bench');
const { err, iso, id } = require('./util');

const COL = 'wr_sites';
const ad = (orgId) => audit.adapter(orgId);
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const MAX_SITES = 20, MAX_ITER = 20, MAX_PATCH = 50;
const UA = () => `DryRunReader/1 (+${process.env.DRYRUN_PUBLIC_URL || 'https://dryrun.hnnworld.com'})`;
const SIGNED_EXTRAS = ['Exact structure of the site (routes, forms, settings), not a guess', 'Live preview of your iterations on the real pages', 'Test with sandbox sample data', 'Export each iteration as a Dry Run pack to install'];

// ---- keys -----------------------------------------------------------------------------------------------------------------------
const master = () => crypto.createHash('sha256').update('site-keys:' + (process.env.DRYRUN_SECRET_KEY || 'dryrun-dev-key-change-me')).digest();
const secretFor = (s, orgId) => 'drs_' + crypto.createHmac('sha256', master()).update(`${orgId}:${s.id}:${s.nonce}`).digest('hex').slice(0, 40);
const sign = (secret, ts, method, path) => crypto.createHmac('sha256', secret).update(`${ts}.${method}.${path}`).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---- safe fetching --------------------------------------------------------------------------------------------------------------
function get(url, { headers = {}, maxBytes = 300000, timeout = 7000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let u; try { u = new URL(url); } catch { return resolve({ error: 'That is not a web address.' }); }
    const ap = process.env.DRYRUN_ALLOW_PRIVATE_TESTS === '1';
    if (!(u.protocol === 'https:' || (ap && u.protocol === 'http:'))) return resolve({ error: 'Only https addresses can be read.' });
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) && !ap && bench.isPrivate(u.hostname)) return resolve({ error: 'That is a private address, so it was not contacted.' });
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', lookup: bench.guardedLookup, timeout, headers: { 'user-agent': UA(), accept: 'text/html,application/json,*/*', ...headers } }, (res) => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => { if (buf.length < maxBytes) buf += c; else res.destroy(); });
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: buf, ms: Date.now() - t0 }); res.on('end', done); res.on('close', done);
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'No answer within 7 seconds.' }); }); req.on('error', (e) => resolve({ error: e.message })); req.end();
  });
}
function normalise(url) {
  let u; try { u = new URL(String(url || '').trim()); } catch { throw err(422, 'That is not a web address. Include https://'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw err(422, 'Use an https:// address.'); if (u.username || u.password) throw err(422, 'Take the username and password out of the address.');
  if (u.protocol === 'http:' && process.env.DRYRUN_ALLOW_PRIVATE_TESTS !== '1') throw err(422, 'Use an https:// address.');
  return { origin: u.origin, href: u.origin + (u.pathname === '/' ? '' : u.pathname) + u.search, host: u.hostname };
}

// ---- patches (iterations) -------------------------------------------------------------------------------------------------------
const SEL = /^[\w\s.#\[\]=\-:>+~*"'(),^$|]{1,200}$/;
const BAD_CSS = /[{}<>]|@import|url\s*\(|expression|javascript:|\\/i;
const ATTRS = ['alt', 'title', 'placeholder', 'aria-label', 'href', 'value'];
function cleanPatch(p) {
  const type = String((p || {}).type || ''); const sel = String(p.selector || '').trim();
  if (type === 'setting') { const key = clip(p.key, 60); if (!/^[\w.\-]{1,60}$/.test(key)) throw err(422, 'A setting name uses letters, numbers, dots and dashes.'); const v = typeof p.value === 'number' || typeof p.value === 'boolean' ? p.value : clip(p.value, 500); return { type, key, value: v }; }
  if (!SEL.test(sel)) throw err(422, 'That selector is not valid. Use a class, id or tag, for example ".hero h1".');
  if (type === 'text') return { type, selector: sel, value: clip(p.value, 1000) };
  if (type === 'hide') return { type, selector: sel };
  if (type === 'style') { const css = clip(p.css, 500); if (!css || BAD_CSS.test(css)) throw err(422, 'Style changes are plain declarations such as "color: #b00; font-size: 1.2rem". Links, imports and braces are not allowed.'); return { type, selector: sel, css }; }
  if (type === 'attr') { const name = String(p.name || ''); if (!ATTRS.includes(name)) throw err(422, `Attributes you can change: ${ATTRS.join(', ')}.`); const v = clip(p.value, 500); if (name === 'href' && !/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(v)) throw err(422, 'A link must start with https://, /, #, mailto: or tel:.'); return { type, selector: sel, name, value: v }; }
  throw err(422, 'Choose a kind of change: text, style, hide, attribute or setting.');
}

// ---- reading a public site (the "Inferred" level) -------------------------------------------------------------------------------
function robotsAllows(body, path) {
  let applies = false, rules = []; for (const raw of String(body || '').split(/\r?\n/)) { const line = raw.replace(/#.*/, '').trim(); const m = line.match(/^([a-z\-]+)\s*:\s*(.*)$/i); if (!m) continue; const k = m[1].toLowerCase(), v = m[2].trim(); if (k === 'user-agent') applies = v === '*' || /dryrun/i.test(v); else if (applies && k === 'disallow' && v) rules.push(v); }
  return !rules.some((r) => path.startsWith(r.replace(/\*.*$/, '')));
}
const strip = (s) => String(s).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function readPage(html, base) {
  const meta = (n) => { const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${n}["']`, 'i')); return m ? clip(m[1], 200) : null; };
  const all = (re, f) => { const out = []; let m; while ((m = re.exec(html)) && out.length < 40) { const v = f(m); if (v) out.push(v); } return out; };
  const links = all(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m) => { try { const u = new URL(m[1], base); if (u.origin !== new URL(base).origin) return null; return { path: u.pathname + u.search, text: clip(strip(m[2]), 60) }; } catch { return null; } });
  const forms = all(/<form\b([\s\S]*?)<\/form>/gi, (m) => { const inner = m[1]; const inputs = [...inner.matchAll(/<(input|textarea|select)\b[^>]*>/gi)].map((i) => ({ tag: i[1].toLowerCase(), type: ((i[0].match(/type=["']([^"']+)/i) || [])[1] || (i[1].toLowerCase() === 'input' ? 'text' : i[1].toLowerCase())).toLowerCase(), name: clip((i[0].match(/name=["']([^"']+)/i) || [])[1], 40) })); return { action: clip((inner.match(/action=["']([^"']*)/i) || [])[1], 100), inputs: inputs.slice(0, 20) }; });
  const heads = all(/<h([12])[^>]*>([\s\S]*?)<\/h\1>/gi, (m) => clip(strip(m[2]), 100)).filter(Boolean).slice(0, 12);
  const buttons = all(/<button\b[^>]*>([\s\S]*?)<\/button>/gi, (m) => clip(strip(m[1]), 40)).filter(Boolean).slice(0, 15);
  const scripts = all(/<script[^>]+src=["']([^"']+)["']/gi, (m) => clip(m[1], 160)); const text = strip(html);
  return { title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ? clip(strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)[1]), 120) : null, description: meta('description') || meta('og:description'), lang: (html.match(/<html[^>]+lang=["']([^"']+)/i) || [])[1] || null, viewport: /name=["']viewport["']/i.test(html), headings: heads, buttons, links, forms, scripts, textSample: clip(text, 400), htmlLower: html.toLowerCase().slice(0, 150000), generator: meta('generator') };
}
function detectStack(p) {
  const h = p.htmlLower, s = p.scripts.join(' ').toLowerCase(), out = [];
  if (/__next_data__|\/_next\//.test(h)) out.push('Next.js'); else if (/data-reactroot|react(-dom)?(\.|-)/.test(h + s)) out.push('React'); if (/ng-version|angular/.test(h + s)) out.push('Angular'); if (/data-v-[0-9a-f]{6}|vue(\.|-)|__vue__|\/_nuxt\//.test(h + s)) out.push(/_nuxt/.test(h) ? 'Nuxt' : 'Vue');
  if (/wp-content|wp-includes/.test(h)) out.push('WordPress'); if (/cdn\.shopify|shopify/.test(h)) out.push('Shopify'); if (/wixstatic|wix\.com/.test(h)) out.push('Wix'); if (/squarespace/.test(h)) out.push('Squarespace'); if (/webflow/.test(h)) out.push('Webflow'); if (p.generator) out.push(clip(p.generator, 40));
  return [...new Set(out)];
}
function inferFeatures(pages) {
  const f = []; const add = (name, confidence, evidence) => { if (!f.find((x) => x.name === name)) f.push({ name, confidence, evidence }); };
  const links = pages.flatMap((p) => p.links.map((l) => ({ ...l, page: p.path }))); const forms = pages.flatMap((p) => p.forms.map((x) => ({ ...x, page: p.path }))); const hay = pages.map((p) => p.htmlLower).join(' ');
  const pw = forms.find((x) => x.inputs.some((i) => i.type === 'password')); if (pw) add('Sign-in', 'high', `A password field on ${pw.page}`); else { const l = links.find((x) => /\b(log ?in|sign ?in)\b/i.test(x.text)); if (l) add('Sign-in', 'medium', `A "${l.text}" link`); }
  if (pw && pw.inputs.filter((i) => i.type === 'password').length > 1 || links.some((x) => /\b(sign ?up|register|create (an )?account|join)\b/i.test(x.text))) add('Create an account', 'medium', 'A sign-up or register link');
  if (forms.some((x) => x.inputs.some((i) => i.type === 'search' || /^(q|s|search|query)$/i.test(i.name)))) add('Search', 'medium', 'A search box');
  const contact = forms.find((x) => x.inputs.some((i) => i.tag === 'textarea') && !x.inputs.some((i) => i.type === 'password')); if (contact) add('Contact or enquiry form', 'medium', `A message form on ${contact.page}`);
  const news = forms.find((x) => x.inputs.length <= 2 && x.inputs.some((i) => i.type === 'email') && !x.inputs.some((i) => i.type === 'password' || i.tag === 'textarea')); if (news) add('Email sign-up', 'low', `An email-only form on ${news.page}`);
  const pay = ['stripe', 'paystack', 'flutterwave', 'paypal', 'mobile money', 'momo', 'checkout', 'add to cart', 'add to basket'].filter((k) => hay.includes(k)); if (pay.length) add('Online payments or checkout', pay.some((k) => ['stripe', 'paystack', 'flutterwave', 'paypal'].includes(k)) ? 'medium' : 'low', `Mentions: ${pay.slice(0, 3).join(', ')}`);
  const q = links.find((x) => /\b(get (a )?quote|pricing|plans?|premium|cover)\b/i.test(x.text)); if (q) add('Pricing or quotes', 'low', `A "${q.text}" link`);
  const acct = links.find((x) => /\b(dashboard|my account|portal|profile)\b/i.test(x.text) || /^\/(dashboard|account|portal)/i.test(x.path)); if (acct) add('Account area (behind sign-in)', 'low', `A "${acct.text || acct.path}" link. Dry Run cannot see inside it.`);
  const lang = pages[0] && pages[0].lang; if (lang) add('Language', 'high', `Page language is "${lang}"`); if (pages[0] && pages[0].viewport) add('Made for phones', 'medium', 'Has a mobile viewport setting');
  return f;
}
async function readSite(href) {
  const { origin } = normalise(href); const rb = await get(origin + '/robots.txt', { maxBytes: 50000 }); const robots = rb.status === 200 ? rb.body : '';
  const start = new URL(href).pathname + new URL(href).search; if (!robotsAllows(robots, start)) return { blocked: true, notes: ['The site asks readers not to visit this page (robots.txt), so Dry Run did not read it.'] };
  const first = await get(origin + start); if (first.error) return { error: first.error }; if (first.status >= 400) return { error: `The site answered with status ${first.status}.` };
  const pages = []; const p0 = readPage(first.body, origin + start); p0.path = start; p0.status = first.status; pages.push(p0);
  const seen = new Set([start]); const next = p0.links.filter((l) => !seen.has(l.path) && !/\.(png|jpe?g|gif|svg|pdf|zip|css|js)$/i.test(l.path) && l.path !== '/' && robotsAllows(robots, l.path)).slice(0, 4);
  for (const l of next) { if (seen.has(l.path)) continue; seen.add(l.path); const r = await get(origin + l.path); if (r.error || r.status >= 400 || !/html/i.test(r.headers['content-type'] || '')) continue; const p = readPage(r.body, origin + l.path); p.path = l.path; p.status = r.status; pages.push(p); }
  const features = inferFeatures(pages); const stack = detectStack(p0);
  const nav = [...new Map(p0.links.filter((l) => l.text).map((l) => [l.path, l])).values()].slice(0, 15);
  return { at: iso(), pagesRead: pages.length, title: p0.title, description: p0.description, stack, features, nav, headings: p0.headings, buttons: p0.buttons, forms: pages.flatMap((p) => p.forms.map((x) => ({ page: p.path, action: x.action, fields: x.inputs.map((i) => i.name || i.type) }))).slice(0, 12), notes: [`Dry Run read ${pages.length} public page${pages.length === 1 ? '' : 's'} and guessed the rest.`, 'It cannot see anything behind a sign-in, the back end, or private flows, so every feature here is a guess with a confidence level.', 'Install the Dry Run connector to get an exact view and to preview iterations on the real pages.'] };
}

// ---- site records ---------------------------------------------------------------------------------------------------------------
async function all(orgId) { return ad(orgId).list(orgId, COL); }
const save = (orgId, s) => ad(orgId).put(orgId, COL, s.id, s);
async function find(orgId, siteId) { const s = await ad(orgId).get(orgId, COL, siteId); if (!s) throw err(404, 'That site is not here.'); return s; }
function extrasOf(s) { const c = s.capabilities || {}, p = (s.manifest || {}).permissions || {}; const o = []; if (c.capture) o.push(SIGNED_EXTRAS[0]); if (c.overlay) o.push(SIGNED_EXTRAS[1]); if (c.capture && p.sampleData) o.push(SIGNED_EXTRAS[2]); if (c.overlay && p.iterate) o.push(SIGNED_EXTRAS[3]); return o; }
function view(s, me) {
  const level = s.level === 'signed' ? 'signed' : 'inferred';
  return { id: s.id, url: s.href, origin: s.origin, name: s.name, level, status: s.level, createdAt: s.createdAt, createdBy: s.createdBy, verifiedAt: s.verifiedAt || null, capabilities: s.capabilities || { capture: false, overlay: false }, permissions: s.manifest ? s.manifest.permissions : null, extras: level === 'signed' ? extrasOf(s) : [], capture: s.capture || null, inferred: s.inferred || null, lastCheckError: s.lastCheckError || null, checks: s.checks || null, research: (s.research || []).map((r) => ({ id: r.id, title: r.title, source: r.source, by: r.by, at: r.at, chars: r.text.length })), model: level === 'inferred' ? workingModel(s) : null, modelIterations: s.modelIters || [], iterations: (s.iterations || []).map((x) => ({ id: x.id, title: x.title, note: x.note, by: x.by, byId: x.byId || null, scope: x.scope || 'member', fromBallot: x.fromBallot || null, votes: x.votes === undefined ? null : x.votes, at: x.at, patches: x.patches, shares: (s.shares || []).filter((h) => h.iid === x.id && new Date(h.exp) > new Date()).map((h) => ({ id: h.id, exp: h.exp, by: h.by })) })), ballots: (s.ballots || []).map((b) => ballotView(b, me)).reverse() };
}
function installFor(s, orgId, publicUrl) {
  const secret = secretFor(s, orgId); const origin = publicUrl || 'https://dryrun.hnnworld.com';
  const manifest = { dryrun: 1, token: s.token, capture: '/dryrun/capture', overlay: true, permissions: { structure: true, iterate: true, sampleData: false }, allowedOrigins: [origin] };
  return {
    token: s.token, secret, manifest, manifestPath: '/.well-known/dryrun.json', dryrunOrigin: origin,
    env: `DRYRUN_TOKEN=${s.token}\nDRYRUN_SECRET=${secret}\nDRYRUN_ORIGIN=${origin}`,
    files: [{ name: 'dryrun-connector.js', url: origin + '/connector/dryrun-connector.js', for: 'Node' }, { name: 'dryrun_connector.py', url: origin + '/connector/dryrun_connector.py', for: 'Python' }, { name: 'dryrun-connector.php', url: origin + '/connector/dryrun-connector.php', for: 'PHP' }, { name: 'dryrun_django.py', url: origin + '/connector/dryrun_django.py', for: 'Django' }, { name: 'DryRunMiddleware.php', url: origin + '/connector/DryRunMiddleware.php', for: 'Laravel' }, { name: 'dryrun.js', url: origin + '/connector/dryrun.js', for: 'Page script (all)' }],
    node: `// Save dryrun-connector.js and dryrun.js side by side in your project.\nconst dryrun = require('./dryrun-connector');\napp.use(dryrun({ app,            // lets it list your routes\n  name: 'Your product',\n  token: process.env.DRYRUN_TOKEN, secret: process.env.DRYRUN_SECRET, origins: [process.env.DRYRUN_ORIGIN],\n  settings: { /* non-secret settings you want Dry Run to see */ },\n  permissions: { structure: true, iterate: true, sampleData: false } }));`,
    python: `# Save dryrun_connector.py and dryrun.js side by side.\nfrom dryrun_connector import DryRun\napp.wsgi_app = DryRun(app.wsgi_app, name="Your product", token=os.environ["DRYRUN_TOKEN"], secret=os.environ["DRYRUN_SECRET"], origins=[os.environ["DRYRUN_ORIGIN"]])`,
    php: `<?php // top of index.php. Save dryrun-connector.php and dryrun.js side by side.\nrequire __DIR__ . '/dryrun-connector.php';\ndryrun_connector(['name' => 'Your product', 'token' => getenv('DRYRUN_TOKEN'), 'secret' => getenv('DRYRUN_SECRET'), 'origins' => [getenv('DRYRUN_ORIGIN')]]);`,
    django: `# Save dryrun_django.py and dryrun.js next to manage.py. In settings.py:\nMIDDLEWARE = ["dryrun_django.DryRunMiddleware", *MIDDLEWARE]   # first in the list\nDRYRUN = {"token": os.environ["DRYRUN_TOKEN"], "secret": os.environ["DRYRUN_SECRET"], "origins": [os.environ["DRYRUN_ORIGIN"]], "name": "Your product"}`,
    laravel: `// Copy DryRunMiddleware.php to app/Http/Middleware/ and dryrun.js to public/dryrun/dryrun.js.\n// Put the three values in .env, then register it first (Laravel 11+, bootstrap/app.php):\n->withMiddleware(function (Middleware $middleware) {\n    $middleware->prepend(\\App\\Http\\Middleware\\DryRunMiddleware::class);\n})\n// Laravel 10 and older: add it at the top of $middleware in app/Http/Kernel.php.`,
    script: `<script src="/dryrun/dryrun.js" data-dryrun-origin="${origin}" defer></script>`,
    staticNote: 'No server add-on? Save the manifest above at /.well-known/dryrun.json, save dryrun.js on your site, and add the script tag to your pages. You will get the live preview, but not the exact server-side capture. Host dryrun.js yourself: it runs on your pages, so you should control it.'
  };
}
async function create(orgId, actor, role, { url, publicUrl } = {}) {
  const o = orgs.raw(orgId); plans.assertNotDemo(o, 'Connecting a site'); plans.assertWritable(o); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot connect sites.');
  const n = normalise(url); const list = await all(orgId); let s = list.find((x) => x.origin === n.origin);
  if (!s) { if (list.length >= MAX_SITES) throw err(422, 'That is the most sites a workspace can connect. Remove one first.'); s = { id: id('st'), origin: n.origin, href: n.href, name: n.host, level: 'pending', token: 'drt_' + crypto.randomBytes(16).toString('hex'), nonce: crypto.randomBytes(8).toString('hex'), createdAt: iso(), createdBy: actor.name, iterations: [], capabilities: { capture: false, overlay: false } }; await save(orgId, s); await audit.log(orgId, actor, 'site.create', { origin: n.origin }); }
  return { site: view(s), install: installFor(s, orgId, publicUrl) };
}
async function details(orgId, role, siteId, publicUrl, me) { const s = await find(orgId, siteId); return { site: view(s, me), install: orgs.can(role, 'write') ? installFor(s, orgId, publicUrl) : null }; }

async function handshake(s, orgId, manifest) {
  const path = String(manifest.capture || '/dryrun/capture'); if (!/^\/[\w\-./]{1,100}$/.test(path)) return { error: 'The capture path in your manifest is not valid.' };
  const ts = String(Date.now()); const r = await get(s.origin + path, { headers: { 'x-dryrun-ts': ts, 'x-dryrun-sig': sign(secretFor(s, orgId), ts, 'GET', path), accept: 'application/json' }, maxBytes: 400000 });
  if (r.error) return { error: r.error }; if (r.status === 401 || r.status === 403) return { error: 'The connector answered but did not accept the secret. Check DRYRUN_SECRET matches the one shown here.' }; if (r.status !== 200) return { error: `The capture address answered with status ${r.status}.` };
  let j; try { j = JSON.parse(r.body); } catch { return { error: 'The capture address did not answer with JSON.' }; } if (!j || j.dryrun !== 1) return { error: 'That answer is not from the Dry Run connector.' };
  return { capture: sanitiseCapture(j) };
}
const SECRETISH = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|private|credential|bearer|signature/i;
function scrub(v, depth = 0) {
  if (depth > 5) return null; if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrub(x, depth + 1)); if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v).slice(0, 100)) o[clip(k, 60)] = SECRETISH.test(k) ? '[hidden]' : scrub(x, depth + 1); return o; } if (typeof v === 'string') return clip(v, 500); return v;
}
function sanitiseCapture(j) { return { at: iso(), name: clip(j.name, 80), framework: clip(j.framework, 40), version: clip(j.version, 40), routes: scrub(j.routes) || [], forms: scrub(j.forms) || [], api: scrub(j.api) || null, settings: scrub(j.settings) || {}, flags: scrub(j.flags) || {}, sample: j.sample === undefined ? null : scrub(j.sample), permissions: scrub(j.permissions) || {} }; }

async function verify(orgId, actor, role, siteId) {
  if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot check sites.'); const s = await find(orgId, siteId);
  const r = await get(s.origin + '/.well-known/dryrun.json', { maxBytes: 20000 });
  const fail = async (m) => { s.lastCheckError = m; await save(orgId, s); return { site: view(s), ok: false, problem: m }; };
  if (r.error) return fail(`Could not reach your site: ${r.error}`); if (r.status !== 200) return fail(`Your site answered ${r.status} at /.well-known/dryrun.json. Publish the manifest there.`);
  let m; try { m = JSON.parse(r.body); } catch { return fail('The file at /.well-known/dryrun.json is not valid JSON.'); }
  if (!m || m.dryrun !== 1 || !same(m.token || '', s.token)) return fail('The file is there, but its token does not match the one shown here.');
  const perms = { structure: !(m.permissions && m.permissions.structure === false), iterate: !(m.permissions && m.permissions.iterate === false), sampleData: !!(m.permissions && m.permissions.sampleData) };
  s.manifest = { capture: m.capture ? clip(m.capture, 100) : null, overlay: m.overlay !== false, permissions: perms, allowedOrigins: Array.isArray(m.allowedOrigins) ? m.allowedOrigins.map((x) => clip(x, 200)).slice(0, 5) : [] };
  s.level = 'signed'; s.verifiedAt = iso(); s.lastCheckError = null; s.capabilities = { capture: false, overlay: s.manifest.overlay };
  const home = await get(s.origin + '/', { maxBytes: 200000 }); s.checks = { manifest: true, capture: false, script: !home.error && home.status < 400 ? /dryrun\.js/.test(home.body) : null };
  let note = null; if (m.capture && perms.structure) { const h = await handshake(s, orgId, m); if (h.capture) { s.capture = h.capture; s.capabilities.capture = true; s.checks.capture = true; if (!perms.sampleData) s.capture.sample = null; } else note = h.error; }
  if (note) s.lastCheckError = `Verified as yours, but the server add-on is not connected yet: ${note}`;
  await save(orgId, s); await audit.log(orgId, actor, 'site.verify', { origin: s.origin, capture: s.capabilities.capture });
  return { site: view(s), ok: true, problem: note };
}
async function capture(orgId, actor, role, siteId) {
  if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot capture sites.'); const s = await find(orgId, siteId); if (s.level !== 'signed' || !s.manifest) throw err(422, 'Check the site first. Capture only works for a signed site.');
  if (!s.manifest.permissions.structure) throw err(403, 'The owner has not allowed structure capture in the manifest.'); if (!s.manifest.capture) throw err(422, 'This site has the manifest but not the server add-on.');
  const h = await handshake(s, orgId, { capture: s.manifest.capture }); if (h.error) { s.lastCheckError = h.error; await save(orgId, s); throw err(422, h.error); }
  s.capture = h.capture; if (!s.manifest.permissions.sampleData) s.capture.sample = null; s.capabilities.capture = true; s.checks = { ...(s.checks || { manifest: true, script: null }), capture: true }; s.lastCheckError = null; await save(orgId, s); return view(s);
}
async function read(orgId, actor, role, { url } = {}) {
  const o = orgs.raw(orgId); plans.assertNotDemo(o, 'Reading a site'); plans.assertWritable(o); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot read sites.'); const n = normalise(url);
  const list = await all(orgId); let s = list.find((x) => x.origin === n.origin); if (s && s.level === 'signed') return { site: view(s), skipped: 'This site is Dry Run signed, so there is no need to guess.' };
  if (!s) { if (list.length >= MAX_SITES) throw err(422, 'That is the most sites a workspace can connect. Remove one first.'); s = { id: id('st'), origin: n.origin, href: n.href, name: n.host, level: 'inferred', token: 'drt_' + crypto.randomBytes(16).toString('hex'), nonce: crypto.randomBytes(8).toString('hex'), createdAt: iso(), createdBy: actor.name, iterations: [], capabilities: { capture: false, overlay: false } }; }
  const r = await readSite(n.href); if (r.error) throw err(422, r.error); s.inferred = r; if (s.level === 'pending') s.level = 'pending'; else s.level = 'inferred'; await save(orgId, s); await audit.log(orgId, actor, 'site.read', { origin: n.origin }); return { site: view(s) };
}
async function revoke(orgId, actor, role, siteId) { if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot disconnect sites.'); const s = await find(orgId, siteId); await ad(orgId).del(orgId, COL, siteId); await audit.log(orgId, actor, 'site.revoke', { origin: s.origin }); return { ok: true }; }
async function list(orgId) { return (await all(orgId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view); }
/** What the Workroom shows on a link: signed, inferred, or nothing known yet. */
async function labelFor(orgId, url) { try { const n = normalise(url); const s = (await all(orgId)).find((x) => x.origin === n.origin); if (!s) return { level: 'unknown' }; return { level: s.level === 'signed' ? 'signed' : s.inferred ? 'inferred' : 'unknown', siteId: s.id, extras: s.level === 'signed' ? extrasOf(s) : [], features: s.inferred ? s.inferred.features.length : 0 }; } catch { return { level: 'unknown' }; } }

// ---- iterations and packs ------------------------------------------------------------------------------------------------------
async function addIteration(orgId, actor, role, siteId, { title, note, patches } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'iterate')) throw err(403, 'Viewers can look at iterations but not make them.'); const s = await find(orgId, siteId);
  if (s.level !== 'signed') throw err(422, 'Iterations on a live page need the Dry Run connector. Install it and check the site first.'); if (!s.manifest.permissions.iterate) throw err(403, 'The owner has not allowed iterations in the manifest.');
  const t = clip(title, 80); if (!t) throw err(422, 'Name the iteration.'); if (!Array.isArray(patches) || !patches.length) throw err(422, 'Add at least one change.'); if (patches.length > MAX_PATCH) throw err(422, `An iteration can hold up to ${MAX_PATCH} changes.`);
  s.iterations = s.iterations || []; if (s.iterations.length >= MAX_ITER) throw err(422, 'That is the most iterations a site can hold. Remove one first.');
  const it = { id: id('it'), title: t, note: clip(note, 300), by: actor.name, byId: actor.id, scope: 'member', at: iso(), patches: patches.map(cleanPatch) }; s.iterations.push(it); await save(orgId, s); return { iteration: it, site: view(s) };
}
async function removeIteration(orgId, actor, role, siteId, iid) { if (!orgs.can(role, 'iterate')) throw err(403, 'Your role cannot remove iterations.'); const s = await find(orgId, siteId); const cur = (s.iterations || []).find((x) => x.id === iid); if (cur && !orgs.can(role, 'write') && cur.byId !== actor.id) throw err(403, 'You can remove your own iterations. An admin or builder can remove anyone\'s.'); if ((s.ballots || []).some((b) => b.status === 'open' && b.candidates.includes(iid))) throw err(422, 'This iteration is in a vote that is still open. Close the vote first.'); s.iterations = (s.iterations || []).filter((x) => x.id !== iid); await save(orgId, s); return view(s); }

// ---- working model: a editable picture of a product built from public pages and research the team supplies ------------------
// It holds structure and wording, never the site's code, images or private data. Anything behind a sign-in stays unknown.
const MAX_RESEARCH = 12, MAX_MODEL_ITER = 20;
const redact = (t) => String(t).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email removed]').replace(/(?<![\w.])\+?\d[\d\s().-]{8,}\d(?![\w.])/g, '[number removed]');
function workingModel(s) {
  const i = s.inferred || {}; const res = s.research || [];
  return { name: s.name, readFrom: i.pagesRead ? `${i.pagesRead} public page${i.pagesRead === 1 ? '' : 's'}` : 'no pages read yet', title: i.title || null, summary: i.description || null, stack: i.stack || [], menu: (i.nav || []).map((n) => ({ text: n.text, path: n.path })), headings: i.headings || [], actions: i.buttons || [], forms: i.forms || [], features: (i.features || []).map((f) => ({ name: f.name, confidence: f.confidence, evidence: f.evidence })),
    research: res.map((r) => ({ title: r.title, source: r.source, points: r.text.split(/\n+/).map((x) => x.trim()).filter(Boolean).slice(0, 5) })),
    unknown: ['Anything behind a sign-in', 'The back end and private flows', 'Exact settings and data'], note: 'This is a working model built from public pages and research you supplied. It is not a copy of the site and holds none of its code or images.' };
}
async function addResearch(orgId, actor, role, siteId, { title, text, source } = {}) {
  const o = orgs.raw(orgId); plans.assertNotDemo(o, 'Adding research'); plans.assertWritable(o); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot add research.'); const s = await find(orgId, siteId);
  const t = clip(title, 80), x = clip(redact(text), 8000); if (!t) throw err(422, 'Name the research, for example "2025 market survey".'); if (x.length < 20) throw err(422, 'Paste the text or load a text file. It looks empty.');
  s.research = s.research || []; if (s.research.length >= MAX_RESEARCH) throw err(422, `A site can hold ${MAX_RESEARCH} pieces of research. Remove one first.`);
  s.research.push({ id: id('rs'), title: t, source: clip(source, 120) || 'Uploaded by the team', text: x, by: actor.name, at: iso() }); await save(orgId, s); await audit.log(orgId, actor, 'site.research', { origin: s.origin }); return { site: view(s) };
}
async function removeResearch(orgId, actor, role, siteId, rid) { if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot remove research.'); const s = await find(orgId, siteId); s.research = (s.research || []).filter((r) => r.id !== rid); await save(orgId, s); return { site: view(s) }; }
async function addModelIteration(orgId, actor, role, siteId, { title, note, changes } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'iterate')) throw err(403, 'Viewers can look at iterations but not make them.'); const s = await find(orgId, siteId);
  if (s.level === 'signed') throw err(422, 'This site is Dry Run signed. Make iterations on the live pages instead.'); const t = clip(title, 80); if (!t) throw err(422, 'Name the iteration.');
  if (!Array.isArray(changes) || !changes.length || changes.length > 30) throw err(422, 'Add 1 to 30 changes.'); const KINDS = ['add', 'change', 'remove'];
  const cl = changes.map((c) => { const kind = KINDS.includes(c && c.kind) ? c.kind : null; const target = clip(c && c.target, 120), text = clip(c && c.text, 400); if (!kind || !target) throw err(422, 'Each change needs a kind (add, change or remove) and what it applies to.'); return { kind, target, text }; });
  s.modelIters = s.modelIters || []; if (s.modelIters.length >= MAX_MODEL_ITER) throw err(422, 'That is the most working-model iterations. Remove one first.');
  const it = { id: id('mi'), title: t, note: clip(note, 300), by: actor.name, byId: actor.id, at: iso(), changes: cl }; s.modelIters.push(it); await save(orgId, s); return { iteration: it, site: view(s) };
}
async function removeModelIteration(orgId, actor, role, siteId, iid) { if (!orgs.can(role, 'iterate')) throw err(403, 'Your role cannot remove iterations.'); const s = await find(orgId, siteId); const cur = (s.modelIters || []).find((x) => x.id === iid); if (cur && !orgs.can(role, 'write') && cur.byId !== actor.id) throw err(403, 'You can remove your own iterations. An admin or builder can remove anyone\'s.'); s.modelIters = (s.modelIters || []).filter((x) => x.id !== iid); await save(orgId, s); return { site: view(s) }; }
const FOOTNOTE = 'Get more done with DRI signing. If you have genuine access to the web application, install the following and get better control of the iterative process.';
/** One plain-text file with everything needed for DRI signing, so it can be saved, shared or uploaded elsewhere. */
async function signingKit(orgId, role, siteId, publicUrl) {
  if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot download the signing kit.'); const s = await find(orgId, siteId); const ins = installFor(s, orgId, publicUrl); const fs = require('fs'), path = require('path'); const dir = path.join(__dirname, '..', 'public', 'connector');
  const out = [`DRY RUN: DRI SIGNING KIT for ${s.origin}`, `Made ${iso()}`, '', FOOTNOTE, '', 'PRIVATE: this file holds your site secret. Keep it out of public places and source control.', 'Only install this on a web application you genuinely control. The connector is read-only, proves the site is yours, and hides anything that looks like a password or key.', '',
    '== 1. Three settings (put them in your server environment, not in code) ==', ins.env, '', '== 2. Pick the part for what your site runs on ==', '-- Node --', ins.node, '', '-- Python --', ins.python, '', '-- PHP --', ins.php, '', '-- Django --', ins.django, '', '-- Laravel --', ins.laravel, '', '== 3. Page script (add to your base template) ==', ins.script, '', '== 4. No server add-on? Static site ==', ins.staticNote, 'Save this as ' + ins.manifestPath + ':', JSON.stringify(ins.manifest, null, 2), '', '== 5. Download links ==', ...ins.files.map((f) => `${f.for}: ${f.url}`), '', '== 6. Then ==', 'Open Connected sites in the Workroom and press "Check my site".', '', '== Full source of each file (so this one text file is enough) =='];
  for (const f of ins.files) { try { out.push('', `-----BEGIN FILE ${f.name}-----`, fs.readFileSync(path.join(dir, f.name), 'utf8'), `-----END FILE ${f.name}-----`); } catch { /* file missing: the link above still works */ } }
  return out.join('\n');
}
async function pack(orgId, actor, role, siteId, iid, publicUrl) {
  if (!orgs.can(role, 'iterate')) throw err(403, 'Your role cannot export packs.'); const s = await find(orgId, siteId); const it = (s.iterations || []).find((x) => x.id === iid); if (!it) throw err(404, 'That iteration is not here.');
  const settings = {}; for (const p of it.patches) if (p.type === 'setting') settings[p.key] = p.value;
  const body = { dryrunPack: 1, site: s.origin, iteration: { id: it.id, title: it.title, note: it.note }, createdAt: iso(), createdBy: it.by, patches: it.patches.filter((p) => p.type !== 'setting'), settings,
    howToInstall: ['Read every change below. Nothing is applied until you install it.', 'Save this file as dryrun-pack.json next to your connector and set applyPack: true (or DRYRUN_APPLY_PACK=1). The page script then applies the text, style, hide and attribute changes on your live pages.', 'Settings are read in your own code with dryrun.setting("key").', 'To remove it, delete the file or turn applyPack off.'] };
  const digest = crypto.createHmac('sha256', secretFor(s, orgId)).update(JSON.stringify({ patches: body.patches, settings })).digest('hex'); body.digest = digest.slice(0, 32);
  await audit.log(orgId, actor, 'site.pack', { origin: s.origin, iteration: it.id }); return body;
}


// ---- team votes: member iterations become a Team iteration -------------------------------------------------------------------------
const MAX_BALLOTS = 20;
function ballotView(b, me) { const tally = {}; for (const iid of b.candidates) tally[iid] = 0; for (const v of Object.values(b.votes)) if (tally[v] !== undefined) tally[v]++; const total = Object.keys(b.votes).length; const mine = b.votes[me] || null;
  return { id: b.id, title: b.title, status: b.status, candidates: b.candidates, by: b.by, byId: b.byId, at: b.at, closedAt: b.closedAt || null, voters: total, mine, resultIid: b.resultIid || null, tally: b.status === 'closed' || mine ? tally : null, winner: b.winner || null }; }
async function createBallot(orgId, actor, role, siteId, { title, iids } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'iterate')) throw err(403, 'Viewers cannot start a vote.'); const s = await find(orgId, siteId); const its = s.iterations || [];
  const ids = [...new Set((iids || []).map(String))]; if (ids.length < 2) throw err(422, 'Choose at least two iterations to vote between.'); if (ids.length > 8) throw err(422, 'A vote can have up to 8 iterations.'); for (const i of ids) { const it = its.find((x) => x.id === i); if (!it) throw err(404, 'One of those iterations is no longer here.'); if (it.scope === 'team') throw err(422, 'Team iterations are the result of a vote. Choose members\' iterations.'); }
  s.ballots = s.ballots || []; if (s.ballots.length >= MAX_BALLOTS) throw err(422, 'That site has the most votes it can hold. Close or remove one first.'); const b = { id: id('bal'), title: clip(title, 80) || 'Which iteration should become the Team\'s?', candidates: ids, votes: {}, status: 'open', by: actor.name, byId: actor.id, at: iso() };
  s.ballots.push(b); await save(orgId, s); await audit.log(orgId, actor, 'site.ballot', { origin: s.origin, ballot: b.id }); return { ballot: ballotView(b, actor.id), site: view(s) };
}
async function vote(orgId, actor, role, siteId, bid, iid) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'iterate')) throw err(403, 'Viewers can watch a vote but not cast one.'); const s = await find(orgId, siteId); const b = (s.ballots || []).find((x) => x.id === bid); if (!b) throw err(404, 'That vote is not here.');
  if (b.status !== 'open') throw err(422, 'This vote is closed.'); if (!b.candidates.includes(String(iid))) throw err(422, 'Choose one of the iterations in this vote.'); b.votes[actor.id] = String(iid); await save(orgId, s); return { ballot: ballotView(b, actor.id) };
}
/** The person who started the vote, or an admin, can close it. The most votes wins; a tie goes to the iteration made first. The winner is copied as a Team iteration. */
async function closeBallot(orgId, actor, role, siteId, bid) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'iterate')) throw err(403, 'Your role cannot close a vote.'); const s = await find(orgId, siteId); const b = (s.ballots || []).find((x) => x.id === bid); if (!b) throw err(404, 'That vote is not here.');
  if (b.status !== 'open') throw err(422, 'This vote is already closed.'); if (b.byId !== actor.id && !orgs.can(role, 'team')) throw err(403, 'Only the person who started the vote, or an admin, can close it.'); const total = Object.keys(b.votes).length; if (!total) throw err(422, 'Nobody has voted yet.');
  const tally = {}; for (const i of b.candidates) tally[i] = 0; for (const v of Object.values(b.votes)) if (tally[v] !== undefined) tally[v]++; const order = b.candidates.map((i) => (s.iterations || []).find((x) => x.id === i)).filter(Boolean); if (!order.length) throw err(422, 'The iterations in this vote have been removed.');
  order.sort((x, y) => tally[y.id] - tally[x.id] || x.at.localeCompare(y.at)); const win = order[0]; if ((s.iterations || []).length >= MAX_ITER) throw err(422, 'That site is full of iterations. Remove one, then close the vote.');
  const team = { id: id('it'), title: `Team: ${win.title}`.slice(0, 80), note: clip(`Chosen by vote: ${tally[win.id]} of ${total} vote${total === 1 ? '' : 's'}. Made by ${win.by}. ${win.note || ''}`, 300), by: 'Team vote', byId: null, scope: 'team', fromIid: win.id, fromBallot: b.id, votes: tally[win.id], at: iso(), patches: JSON.parse(JSON.stringify(win.patches)) };
  s.iterations.push(team); b.status = 'closed'; b.closedAt = iso(); b.resultIid = team.id; b.winner = { iid: win.id, title: win.title, by: win.by, votes: tally[win.id], of: total }; await save(orgId, s); await audit.log(orgId, actor, 'site.ballot.close', { origin: s.origin, ballot: b.id, winner: win.id });
  return { ballot: ballotView(b, actor.id), iteration: team, site: view(s) };
}

// ---- Dry Run Iteration (DRI): the owner's own site, opened with an iteration applied and a watermark ------------------------------
const hashTok = (t) => crypto.createHash('sha256').update(t).digest('hex');
async function shareIteration(orgId, actor, role, siteId, iid, { days } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'iterate')) throw err(403, 'Your role cannot share iterations.'); const s = await find(orgId, siteId);
  if (s.level !== 'signed' || !s.manifest.permissions.iterate) throw err(422, 'Opening an iteration live needs a Dry Run signed site that allows iterations.'); const it = (s.iterations || []).find((x) => x.id === iid); if (!it) throw err(404, 'That iteration is not here.');
  const d = Math.min(30, Math.max(1, Math.round(Number(days) || 7))); s.shares = (s.shares || []).filter((x) => new Date(x.exp) > new Date()); if (s.shares.length >= 20) throw err(422, 'That site has the most open links it can hold. Revoke one first.');
  const token = `dri.${orgId}.${s.id}.${crypto.randomBytes(18).toString('hex')}`; const exp = new Date(Date.now() + d * 86400000).toISOString(); const sh = { id: id('shr'), iid, h: hashTok(token), exp, by: actor.name, at: iso() }; s.shares.push(sh); await save(orgId, s); await audit.log(orgId, actor, 'site.share', { origin: s.origin, iteration: iid, days: d });
  return { link: `${s.origin}/?dri=${token}`, token, expiresAt: exp, site: view(s) };
}
async function revokeShares(orgId, role, siteId, iid) { if (!orgs.can(role, 'iterate')) throw err(403, 'Your role cannot revoke links.'); const s = await find(orgId, siteId); s.shares = (s.shares || []).filter((x) => x.iid !== iid); await save(orgId, s); return view(s); }
/** What the page script on the owner's site fetches. Only the site the token was made for may read it. */
async function publicIteration(token, origin) {
  const dead = () => err(404, 'This link is not active.'); const parts = String(token || '').split('.'); if (parts.length !== 4 || parts[0] !== 'dri') throw dead();
  let s; try { orgs.raw(parts[1]); s = await ad(parts[1]).get(parts[1], COL, parts[2]); } catch { throw dead(); } if (!s || s.level !== 'signed' || !s.manifest || !s.manifest.permissions.iterate || !origin || origin !== s.origin) throw dead();
  const h = hashTok(token); const sh = (s.shares || []).find((x) => same(x.h, h)); if (!sh || new Date(sh.exp) < new Date()) throw dead(); const it = (s.iterations || []).find((x) => x.id === sh.iid); if (!it) throw dead();
  const settings = {}; for (const p of it.patches) if (p.type === 'setting') settings[p.key] = p.value;
  return { dryrunIteration: 1, label: 'Dry Run Iteration (DRI)', title: it.title, by: it.by, expiresAt: sh.exp, patches: it.patches.filter((p) => p.type !== 'setting'), settings, origin: s.origin };
}

module.exports = { FOOTNOTE, workingModel, addResearch, removeResearch, addModelIteration, removeModelIteration, signingKit, createBallot, vote, closeBallot, ballotView, find, shareIteration, revokeShares, publicIteration, create, details, verify, capture, read, revoke, list, labelFor, addIteration, removeIteration, pack, readSite, readPage, inferFeatures, robotsAllows, cleanPatch, sign, secretFor, normalise, SIGNED_EXTRAS };
