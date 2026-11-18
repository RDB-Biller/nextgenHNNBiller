'use strict';
/**
 * Making things real for the Hardware Developer pack: imported 3D files, G-code, printers (direct or through a Dry Run Bridge),
 * and robot programs delivered to a Bridge.
 *
 * Safety rules, all enforced on the server AND again by the Bridge on the owner's own network:
 *  - Files are only stored and scanned. Nothing is run on Dry Run's servers.
 *  - G-code is scanned before it leaves: over-temperature, moves outside the bed and settings-changing commands are refused.
 *  - Sending is "upload only" unless a person with the run role asks to start AND confirms, AND the printer was set to allow starts.
 *  - Robot programs are only saved on the owner's computer unless the owner's own config allows running them.
 *  - Printer keys are encrypted on the server (direct mode) or never leave the owner's computer (bridge mode).
 */
const crypto = require('crypto');
const blobs = require('./blobs');
const audit = require('./audit');
const orgs = require('./orgs');
const plans = require('./plans');
const secret = require('./secret');
const cad = require('./cad');
const meshio = require('./meshio');
const robot = require('./robot');
const bench = require('./bench');
const bridgeLib = require('../public/bridge/dryrun-bridge.js');
const { err, iso, id, sha } = require('./util');
const ad = (orgId) => audit.adapter(orgId);
const MAX_MESH = 60 * 1048576, MAX_GCODE = 60 * 1048576, MAX_FILES = 200;
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const clip = (s, n) => String(s || '').slice(0, n);
const allowPrivate = () => process.env.DRYRUN_ALLOW_PRIVATE_TESTS === '1';
const can = (role, a, what) => { if (!orgs.can(role, a)) throw err(403, `Your role (${role}) cannot ${what}.`); };
const writable = (orgId, what) => { const o = orgs.raw(orgId); plans.assertWritable(o); plans.assertNotDemo(o, what); return o; };

// ---- imported files --------------------------------------------------------------------------------------------------------------
async function addFile(orgId, actor, role, { name, buf } = {}) {
  can(role, 'write', 'upload files'); writable(orgId, 'Uploading files'); if (!buf || !buf.length) throw err(422, 'The file is empty.');
  const fname = clip(String(name || 'file').replace(/[\\/]+/g, '_').replace(/[^\w.\- ()]+/g, '_'), 100) || 'file'; const ext = (fname.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  if ((await ad(orgId).list(orgId, 'hw_files')).length >= MAX_FILES) throw err(402, `You can keep up to ${MAX_FILES} files here. Remove some first.`);
  const fid = id('hwf'); let rec;
  if (ext === 'stl' || ext === 'obj') {
    if (buf.length > MAX_MESH) throw err(413, 'Model files can be up to 60 MB.');
    const { mesh, dropped } = meshio.parse(fname, buf); const s = cad.stats(mesh); const stl = cad.toSTL(mesh, fname); blobs.put(orgId, fid, stl);
    rec = { id: fid, kind: 'mesh', name: fname, size: stl.length, at: iso(), by: actor.name, triangles: s.triangles, size3d: s.size, volumeMm3: s.volumeMm3, watertight: s.watertight, droppedDegenerate: dropped, sourceFormat: ext };
  } else if (ext === 'gcode' || ext === 'gco' || ext === 'g') {
    if (buf.length > MAX_GCODE) throw err(413, 'G-code files can be up to 60 MB.'); const scan = bridgeLib.scan(buf.toString('utf8')); blobs.put(orgId, fid, buf);
    rec = { id: fid, kind: 'gcode', name: fname, size: buf.length, at: iso(), by: actor.name, sha256: hash(buf), scan: { ok: scan.ok, errors: scan.errors, warnings: scan.warnings, stats: scan.stats } };
  } else throw err(422, 'Upload an .stl or .obj model, or a .gcode file.');
  await ad(orgId).put(orgId, 'hw_files', fid, rec); await audit.log(orgId, actor, 'hardware.file', { name: fname, kind: rec.kind }); return rec;
}
const listFiles = async (orgId) => (await ad(orgId).list(orgId, 'hw_files')).sort((a, b) => b.at.localeCompare(a.at));
async function getFile(orgId, fid) { const r = await ad(orgId).get(orgId, 'hw_files', fid); if (!r) throw err(404, 'That file is not here.'); const buf = blobs.get(orgId, fid); if (!buf) throw err(404, 'That file is no longer stored.'); return { rec: r, buf }; }
async function removeFile(orgId, actor, role, fid) { can(role, 'write', 'remove files'); writable(orgId, 'Removing files'); const r = await ad(orgId).get(orgId, 'hw_files', fid); if (!r) throw err(404, 'That file is not here.'); await ad(orgId).del(orgId, 'hw_files', fid); blobs.del(orgId, fid); await audit.log(orgId, actor, 'hardware.file.remove', { name: r.name }); return { ok: true }; }
function groundMesh(m) { const b = cad.bbox(m); return cad.translate(m, -(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]); }
/** A part in a design that points at an imported model. Same shape as cad.buildPart so every check and export works on it. */
async function importedPart(orgId, p) {
  const f = await getFile(orgId, String(p.fileId || '')); if (f.rec.kind !== 'mesh') throw err(422, `${p.name || 'This part'} points at a file that is not a 3D model.`);
  const k = Number(p.scale === undefined ? 1 : p.scale); if (!(k >= 0.001 && k <= 1000)) throw err(422, 'Scale must be from 0.001 to 1000.');
  const { mesh } = meshio.parse('x.stl', f.buf); const m = groundMesh(k === 1 ? mesh : meshio.scale(mesh, k));
  return { type: 'imported', label: 'Imported model', params: { fileId: f.rec.id, scale: k }, mesh: m, minFeature: 99, note: `Imported from ${f.rec.name}. Wall thickness and strength are not checked for imported models.` };
}
const build = async (orgId, p) => (p && p.type === 'imported' ? importedPart(orgId, p) : cad.buildPart(p.type, p.params));
/** Gives each imported part in a design its geometry, so scenario engines (which run on plain data) can use it. */
async function attachMeshes(orgId, design) {
  for (const p of design.parts || []) if (p.type === 'imported') { try { Object.defineProperty(p, '_built', { value: await importedPart(orgId, p), enumerable: false, configurable: true }); } catch (e) { Object.defineProperty(p, '_error', { value: e.message, enumerable: false, configurable: true }); } }
  return design;
}
/** Slices a part in its best print orientation and keeps the G-code as a file you can send. */
async function sliceToFile(orgId, actor, role, { part, settings }) {
  can(role, 'write', 'create files'); writable(orgId, 'Creating files'); if (!part) throw err(422, 'Choose a part to slice.');
  const st = cad.cleanSettings(settings || {}); const built = await build(orgId, part); const o = cad.bestOrientation(built.mesh); const r = cad.gcode(o.mesh, st); if (r.gcode.length > MAX_GCODE) throw err(422, 'The G-code is too large. Use a taller layer height.');
  const name = `${String(part.name || 'part').replace(/[^\w.\- ]+/g, '_').slice(0, 50)}.gcode`; const rec = await addFile(orgId, actor, role, { name, buf: Buffer.from(r.gcode) }); return { file: rec, slice: { layers: r.layers, hours: r.hours, grams: r.grams, orientation: o.name } };
}

// ---- printers --------------------------------------------------------------------------------------------------------------------
const view = (p) => ({ id: p.id, ref: 'd:' + p.id, name: p.name, adapter: p.adapter, label: (bridgeLib.ADAPTERS[p.adapter] || {}).label, mode: 'direct', url: p.url, keyHint: p.keyHint || null, allowStart: !!p.allowStart, limits: p.limits, at: p.at });
function cleanLimits(l = {}) { const n = (v, lo, hi, d, w) => { if (v === undefined || v === '' || v === null) return d; const x = Number(v); if (!(x >= lo && x <= hi)) throw err(422, `${w} must be from ${lo} to ${hi}.`); return x; }; return { hotend: n(l.hotend, 150, 320, 260, 'Hotend limit'), bed: n(l.bed, 30, 130, 100, 'Bed limit'), x: n(l.x, 50, 1000, 220, 'Bed width'), y: n(l.y, 50, 1000, 220, 'Bed depth'), z: n(l.z, 50, 1000, 250, 'Height') }; }
function checkUrl(u) {
  let x; try { x = new URL(u); } catch { throw err(422, 'Enter the printer address as a full web address, for example https://printer.example.com.'); }
  if (!/^https?:$/.test(x.protocol)) throw err(422, 'The address must start with http:// or https://.');
  const h = x.hostname.toLowerCase(); if (!allowPrivate() && (h === 'localhost' || /\.(local|internal|lan|home|localdomain)$/.test(h) || !h.includes('.') || (/^[\d.]+$|:/.test(h) && bench.isPrivate(h.replace(/^\[|\]$/g, ''))))) throw err(422, 'Dry Run runs in the cloud, so it cannot reach an address inside your network. Use a Dry Run Bridge on your network, or enter a public address you have secured.');
  return x.origin + x.pathname.replace(/\/+$/, '');
}
async function addPrinter(orgId, actor, role, b = {}) {
  can(role, 'write', 'add printers'); writable(orgId, 'Connecting printers'); const a = bridgeLib.ADAPTERS[b.adapter]; if (!a) throw err(422, 'Choose a printer type.'); if (a.bridgeOnly) throw err(422, `${a.label} can only be reached through a Dry Run Bridge on your network.`);
  const name = clip(b.name, 40).trim(); if (!name) throw err(422, 'Give the printer a name.'); if (a.needs.includes('key') && !String(b.key || '').trim()) throw err(422, 'Enter the API key.');
  if ((await ad(orgId).list(orgId, 'hw_printers')).length >= 20) throw err(402, 'You can connect up to 20 printers directly.');
  const p = { id: id('prn'), name, adapter: b.adapter, url: checkUrl(b.url), keySealed: b.key ? secret.seal({ key: String(b.key).trim() }) : null, keyHint: b.key ? '…' + String(b.key).trim().slice(-4) : null, allowStart: !!b.allowStart, limits: cleanLimits(b.limits), at: iso(), by: actor.name, insecureTls: !!b.insecureTls };
  await ad(orgId).put(orgId, 'hw_printers', p.id, p); await audit.log(orgId, actor, 'printer.add', { name, adapter: p.adapter, mode: 'direct' }); return view(p);
}
async function removePrinter(orgId, actor, role, pid) { can(role, 'write', 'remove printers'); const p = await ad(orgId).get(orgId, 'hw_printers', pid); if (!p) throw err(404, 'That printer is not here.'); await ad(orgId).del(orgId, 'hw_printers', pid); await audit.log(orgId, actor, 'printer.remove', { name: p.name }); return { ok: true }; }

// ---- bridges ---------------------------------------------------------------------------------------------------------------------
const ONLINE_MS = 25000;
async function createBridge(orgId, actor, role, name) {
  can(role, 'write', 'add a bridge'); writable(orgId, 'Connecting a bridge'); if ((await ad(orgId).list(orgId, 'hw_bridges')).length >= 10) throw err(402, 'You can add up to 10 bridges.');
  const bid = id('brg'); const secretPart = crypto.randomBytes(20).toString('hex'); const token = `drb.${orgId}.${bid}.${secretPart}`;
  const rec = { id: bid, name: clip(name, 40).trim() || 'Bridge', h: sha(secretPart), at: iso(), by: actor.name, lastSeen: null, printers: [], robots: [] }; await ad(orgId).put(orgId, 'hw_bridges', bid, rec); await audit.log(orgId, actor, 'bridge.add', { name: rec.name });
  return { bridge: bridgeView(rec), token };
}
const bridgeView = (b) => ({ id: b.id, name: b.name, at: b.at, lastSeen: b.lastSeen, online: !!b.lastSeen && Date.now() - Date.parse(b.lastSeen) < ONLINE_MS, printers: b.printers, robots: b.robots });
const listBridges = async (orgId) => (await ad(orgId).list(orgId, 'hw_bridges')).map(bridgeView);
async function revokeBridge(orgId, actor, role, bid) { can(role, 'write', 'remove a bridge'); const b = await ad(orgId).get(orgId, 'hw_bridges', bid); if (!b) throw err(404, 'That bridge is not here.'); await ad(orgId).del(orgId, 'hw_bridges', bid); await audit.log(orgId, actor, 'bridge.remove', { name: b.name }); return { ok: true }; }
async function bridgeAuth(header) {
  const m = /^Bearer\s+(\S+)$/.exec(String(header || '')); const parts = m ? m[1].split('.') : []; const bad = () => err(401, 'Unknown or revoked bridge token.');
  if (parts.length !== 4 || parts[0] !== 'drb') throw bad(); let b; try { orgs.raw(parts[1]); b = await ad(parts[1]).get(parts[1], 'hw_bridges', parts[2]); } catch { throw bad(); }
  const want = Buffer.from(b ? b.h : ''), got = Buffer.from(sha(parts[3])); if (!b || want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw bad(); return { orgId: parts[1], bridge: b };
}
const str = (v, n) => clip(typeof v === 'string' ? v : '', n);
async function poll(auth, body = {}) {
  const { orgId, bridge } = auth; const adv = (Array.isArray(body.printers) ? body.printers : []).slice(0, 20).map((p) => ({ name: str(p.name, 40), adapter: str(p.adapter, 20), allowStart: !!p.allowStart, limits: cleanLimits(p.limits || {}) })).filter((p) => p.name && bridgeLib.ADAPTERS[p.adapter]);
  const rob = (Array.isArray(body.robots) ? body.robots : []).slice(0, 20).map((r) => ({ name: str(r.name, 40), allowRun: !!r.allowRun })).filter((r) => r.name);
  await ad(orgId).put(orgId, 'hw_bridges', bridge.id, { ...bridge, lastSeen: iso(), printers: adv, robots: rob });
  for (const r of (Array.isArray(body.results) ? body.results : []).slice(0, 50)) { const j = await ad(orgId).get(orgId, 'hw_jobs', str(r.id, 40)); if (!j || j.bridgeId !== bridge.id || j.status === 'done' || j.status === 'failed') continue; await ad(orgId).put(orgId, 'hw_jobs', j.id, { ...j, status: r.ok ? 'done' : 'failed', message: str(r.message, 300), device: r.status && typeof r.status === 'object' ? { state: str(r.status.state, 20), hotend: Number(r.status.hotend) || null, bed: Number(r.status.bed) || null, progress: r.status.progress === null || r.status.progress === undefined ? null : Number(r.status.progress), file: str(r.status.file, 80), note: str(r.status.note, 160) } : undefined, doneAt: iso() }); }
  const out = []; for (const j of await ad(orgId).list(orgId, 'hw_jobs')) { if (j.bridgeId !== bridge.id) continue; if (j.status === 'queued' && Date.now() - Date.parse(j.at) > 10 * 60000) { await ad(orgId).put(orgId, 'hw_jobs', j.id, { ...j, status: 'failed', message: 'The bridge did not pick this up within 10 minutes.' }); continue; } if (j.status !== 'queued') continue; await ad(orgId).put(orgId, 'hw_jobs', j.id, { ...j, status: 'sent' }); out.push({ id: j.id, kind: j.kind, op: j.op, target: j.target, name: j.name, sha256: j.sha256, size: j.size, start: !!j.start }); }
  return { jobs: out };
}
async function bridgeFile(auth, jobId) { const j = await ad(auth.orgId).get(auth.orgId, 'hw_jobs', String(jobId)); if (!j || j.bridgeId !== auth.bridge.id || !j.blob) throw err(404, 'No file for this request.'); const buf = blobs.get(auth.orgId, j.blob); if (!buf) throw err(404, 'The file is gone.'); return buf; }

// ---- sending ---------------------------------------------------------------------------------------------------------------------
async function targets(orgId) {
  const direct = (await ad(orgId).list(orgId, 'hw_printers')).map(view); const bridges = await listBridges(orgId); const viaBridge = [];
  for (const b of bridges) for (const p of b.printers) viaBridge.push({ ref: `b:${b.id}:${encodeURIComponent(p.name)}`, name: p.name, adapter: p.adapter, label: bridgeLib.ADAPTERS[p.adapter].label, mode: 'bridge', bridge: b.name, online: b.online, allowStart: p.allowStart, limits: p.limits, experimental: !!bridgeLib.ADAPTERS[p.adapter].experimental });
  const robots = []; for (const b of bridges) for (const r of b.robots) robots.push({ ref: `b:${b.id}:${encodeURIComponent(r.name)}`, name: r.name, bridge: b.name, online: b.online, allowRun: r.allowRun });
  return { direct, bridge: viaBridge, robots, bridges, adapters: bridgeLib.adapterList() };
}
async function resolveTarget(orgId, ref) {
  const m = /^(d):([\w]+)$/.exec(String(ref)) || /^(b):([\w]+):(.+)$/.exec(String(ref)); if (!m) throw err(422, 'Choose a printer.');
  if (m[1] === 'd') { const p = await ad(orgId).get(orgId, 'hw_printers', m[2]); if (!p) throw err(404, 'That printer is not here.'); return { mode: 'direct', p }; }
  const b = await ad(orgId).get(orgId, 'hw_bridges', m[2]); if (!b) throw err(404, 'That bridge is not here.'); const name = decodeURIComponent(m[3]); return { mode: 'bridge', b, name, p: b.printers.find((x) => x.name === name), r: b.robots.find((x) => x.name === name) };
}
async function recentJobs(orgId) { const cut = Date.now() - 60000; return (await ad(orgId).list(orgId, 'hw_jobs')).filter((j) => Date.parse(j.at) > cut).length; }
const jobView = (j) => ({ id: j.id, kind: j.kind, op: j.op, target: j.target, name: j.name, status: j.status, message: j.message || '', device: j.device, at: j.at, by: j.by, start: !!j.start });
async function waitFor(orgId, jid, ms) { const end = Date.now() + ms; for (;;) { const j = await ad(orgId).get(orgId, 'hw_jobs', jid); if (!j || j.status === 'done' || j.status === 'failed' || Date.now() > end) return j; await new Promise((r) => setTimeout(r, 400)); } }
async function getJob(orgId, jid) { const j = await ad(orgId).get(orgId, 'hw_jobs', jid); if (!j) throw err(404, 'That request is not here.'); return jobView(j); }
const directHttp = () => bridgeLib.makeHttp({ lookup: bench.guardedLookup, timeout: 15000 });
const recordJob = async (orgId, j) => { await ad(orgId).put(orgId, 'hw_jobs', j.id, j); return j; };

/** op: status | upload | cancel. For upload, file is a stored G-code file. start=true needs the run role, confirm=true, and a printer that allows starts. */
async function printerOp(orgId, actor, role, { ref, op, fileId, start, confirm, wait = 12000 } = {}) {
  can(role, op === 'status' ? 'read' : 'run', op === 'status' ? 'read printers' : 'send to printers'); if (op !== 'status') writable(orgId, 'Sending to printers');
  if (!['status', 'upload', 'cancel'].includes(op)) throw err(422, 'Unknown request.'); if (await recentJobs(orgId) >= 30) throw err(429, 'Too many printer requests in the last minute. Wait a little.');
  const t = await resolveTarget(orgId, ref); if (t.mode === 'bridge' && t.r) throw err(422, 'That is a robot, not a printer.'); const printer = t.mode === 'direct' ? t.p : t.p; if (!printer) throw err(404, 'This bridge no longer reports that printer. Is it running?');
  const lim = t.mode === 'direct' ? t.p.limits : t.p.limits; const allowStart = t.mode === 'direct' ? t.p.allowStart : t.p.allowStart; let f = null, scan = null;
  if (op === 'upload') {
    if (!fileId) throw err(422, 'Choose a G-code file to send.'); f = await getFile(orgId, fileId); if (f.rec.kind !== 'gcode') throw err(422, 'Only G-code files can be sent to a printer.');
    scan = bridgeLib.scan(f.buf.toString('utf8'), lim); if (!scan.ok) throw Object.assign(err(422, `Not sent. ${scan.errors[0].why}${scan.errors[0].line ? ` (line ${scan.errors[0].line})` : ''}`), { details: scan.errors });
    if (start) { if (confirm !== true) throw err(422, 'Starting a print needs your confirmation.'); if (!allowStart) throw err(403, 'This printer is set to "upload only". Turn on "allow starting prints" for it first, then confirm again.'); }
  }
  const label = `${t.mode === 'direct' ? t.p.name : t.name}`; const job = { id: id('job'), kind: 'printer', op, target: t.mode === 'direct' ? t.p.name : t.name, name: f ? f.rec.name : '', start: !!start, status: 'queued', at: iso(), by: actor.name, bridgeId: t.mode === 'bridge' ? t.b.id : null, sha256: f ? hash(f.buf) : null, size: f ? f.buf.length : 0 };
  await audit.log(orgId, actor, 'printer.' + op, { printer: label, file: job.name, start: !!start, mode: t.mode });
  if (t.mode === 'bridge') { if (f) { job.blob = id('jb'); blobs.put(orgId, job.blob, f.buf); } await recordJob(orgId, job); const done = await waitFor(orgId, job.id, wait); return jobView(done || job); }
  // direct: the server talks to the printer itself, through the same adapter code the bridge uses
  const a = bridgeLib.ADAPTERS[t.p.adapter]; const conn = { url: t.p.url, key: t.p.keySealed ? secret.open(t.p.keySealed).key : undefined, insecureTls: t.p.insecureTls }; const h = directHttp();
  try {
    if (op === 'status') { job.device = await a.status(conn, h); job.message = 'Read the printer.'; } else if (op === 'cancel') job.message = (await a.cancel(conn, h)).message; else job.message = (await a.upload(conn, bridgeLib.cleanName(job.name), f.buf, { start: !!start }, h)).message;
    job.status = 'done';
  } catch (e) { job.status = 'failed'; job.message = e.message; }
  job.doneAt = iso(); await recordJob(orgId, job); return jobView(job);
}

// ---- robots ----------------------------------------------------------------------------------------------------------------------
/** op: deploy (save the program on the owner's computer) | run | stop. Robots are bridge-only: running code is never exposed over the public internet. */
async function robotOp(orgId, actor, role, { ref, op, robotCfg, steps, confirm, wait = 12000 } = {}) {
  can(role, 'run', 'send to robots'); writable(orgId, 'Sending to robots'); if (!['deploy', 'run', 'stop'].includes(op)) throw err(422, 'Unknown request.'); if (await recentJobs(orgId) >= 30) throw err(429, 'Too many requests in the last minute. Wait a little.');
  const t = await resolveTarget(orgId, ref); if (t.mode !== 'bridge' || !t.r) throw err(404, 'Choose a robot that a bridge reports.'); let buf = null, name = '';
  if (op !== 'stop') {
    const ex = robot.exportCode(robotCfg, steps); if (ex.files.length !== 1) throw err(422, 'This target makes several files, so it is downloaded rather than sent. Choose Arduino, ESP32, Pico or Raspberry Pi.'); buf = Buffer.from(ex.files[0].content); name = ex.files[0].path.split('/').pop();
    if (op === 'run') { if (confirm !== true) throw err(422, 'Running a program moves the robot. Confirm that the area is clear.'); if (!t.r.allowRun) throw err(403, 'This robot is set to "save only" in its bridge config. Saving works. To run programs from Dry Run, the owner sets allowRun to true on the bridge computer.'); }
  }
  const job = { id: id('job'), kind: 'robot', op, target: t.name, name, status: 'queued', at: iso(), by: actor.name, bridgeId: t.b.id, sha256: buf ? hash(buf) : null, size: buf ? buf.length : 0 };
  if (buf) { job.blob = id('jb'); blobs.put(orgId, job.blob, buf); } await audit.log(orgId, actor, 'robot.' + op, { robot: t.name, file: name }); await recordJob(orgId, job); const done = await waitFor(orgId, job.id, wait); return jobView(done || job);
}
module.exports = { addFile, listFiles, getFile, removeFile, importedPart, build, attachMeshes, sliceToFile, addPrinter, removePrinter, createBridge, listBridges, revokeBridge, bridgeAuth, poll, bridgeFile, targets, printerOp, robotOp, getJob };
