#!/usr/bin/env node
'use strict';
/**
 * Dry Run Bridge. One file, no installs, Node 18 or newer.
 *
 * It runs on a computer on the same network as your printers and robots (a Raspberry Pi or any PC) and connects OUT to Dry Run.
 * Nothing is opened on your router. Your printer keys and passwords stay in this computer's config file and are never sent to Dry Run.
 *
 *   node dryrun-bridge.js --init      writes a starter dryrun-bridge.json
 *   node dryrun-bridge.js             runs the bridge
 *
 * The limits in the config file are enforced HERE, whatever Dry Run asks for:
 *   - G-code is scanned again on arrival. Over-temperature, out-of-bed moves and settings-changing commands are refused.
 *   - A print only starts if "allowStart" is true for that printer. Otherwise files are only uploaded.
 *   - A robot program only runs if "allowRun" is true for that robot. Otherwise it is only saved to the robot's folder.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { spawn } = require('child_process');
const VERSION = 1;

// ---- G-code safety scan -------------------------------------------------------------------------------------------------------------
const BLOCKED_M = { 28: 'writes to the SD card', 29: 'writes to the SD card', 30: 'deletes a file', 32: 'starts a file from the SD card', 92: 'changes motor steps', 206: 'changes home offsets', 301: 'changes heater tuning', 303: 'runs heater auto-tuning', 500: 'saves settings to the printer', 501: 'loads settings', 502: 'resets settings', 503: 'reads settings', 504: 'validates settings', 550: 'renames the printer', 552: 'changes network settings', 553: 'changes network settings', 554: 'changes network settings', 587: 'stores Wi-Fi credentials', 588: 'forgets Wi-Fi credentials', 997: 'updates firmware', 999: 'restarts the printer' };
const MACROS = new Set(['PRINT_START', 'START_PRINT', 'PRINT_END', 'END_PRINT', 'SET_PRINT_STATS_INFO', 'BED_MESH_CALIBRATE', 'BED_MESH_PROFILE', 'CLEAN_NOZZLE']);
const num = (line, ch) => { const m = new RegExp('(?:^|\\s)' + ch + '(-?\\d*\\.?\\d+)', 'i').exec(line); return m ? Number(m[1]) : null; };
function scan(text, limits = {}) {
  const L = { hotend: 280, bed: 120, x: null, y: null, z: null, ...limits }; const errors = [], warnings = []; const st = { lines: 0, moves: 0, maxHotend: 0, maxBed: 0, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity, minZ: Infinity };
  const pos = { x: 0, y: 0, z: 0 }; let abs = true, relSeen = false; const bad = (n, line, why) => { if (errors.length < 20) errors.push({ line: n, text: line.slice(0, 80), why }); else if (errors.length === 20) errors.push({ line: n, text: '', why: 'More problems follow.' }); };
  const rows = String(text).split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i].replace(/;.*$/, '').replace(/\([^)]*\)/g, '').trim(); if (!line) continue; st.lines++;
    const word = line.split(/\s+/)[0].toUpperCase(); const m = /^([GM])(\d+)(?:\.\d+)?$/.exec(word);
    if (!m) { if (/^T\d+$/.test(word) || MACROS.has(word)) continue; bad(i + 1, line, `"${word}" is not a plain G-code command. Printer macros can do anything, so only a few well-known ones are allowed.`); continue; }
    const code = Number(m[2]);
    if (m[1] === 'M') {
      if (BLOCKED_M[code]) { bad(i + 1, line, `M${code} ${BLOCKED_M[code]}.`); continue; }
      if (code === 104 || code === 109) { const s = num(line, 'S') ?? num(line, 'R'); if (s !== null) { st.maxHotend = Math.max(st.maxHotend, s); if (s > L.hotend) bad(i + 1, line, `Hotend set to ${s} C. This printer's limit is ${L.hotend} C.`); } }
      if (code === 140 || code === 190) { const s = num(line, 'S') ?? num(line, 'R'); if (s !== null) { st.maxBed = Math.max(st.maxBed, s); if (s > L.bed) bad(i + 1, line, `Bed set to ${s} C. This printer's limit is ${L.bed} C.`); } }
      continue;
    }
    if (code === 90) abs = true; else if (code === 91) { abs = false; relSeen = true; }
    else if (code === 28) { pos.x = 0; pos.y = 0; pos.z = 0; }
    else if (code === 92) { for (const k of ['x', 'y', 'z']) { const v = num(line, k); if (v !== null) pos[k] = v; } }
    else if (code >= 0 && code <= 3) {
      st.moves++; const f = num(line, 'F'); if (f !== null && f > 30000) bad(i + 1, line, `Feed rate ${f} mm/min is far above what a printer can do.`);
      if (abs) for (const k of ['x', 'y', 'z']) { const v = num(line, k); if (v !== null) pos[k] = v; }
      else for (const k of ['x', 'y', 'z']) { const v = num(line, k); if (v !== null) pos[k] += v; }
      st.maxX = Math.max(st.maxX, pos.x); st.maxY = Math.max(st.maxY, pos.y); st.maxZ = Math.max(st.maxZ, pos.z); st.minZ = Math.min(st.minZ, pos.z);
      if (abs && L.x && (pos.x < -1 || pos.x > L.x + 1)) bad(i + 1, line, `X ${pos.x} is outside the bed (0 to ${L.x}).`);
      if (abs && L.y && (pos.y < -1 || pos.y > L.y + 1)) bad(i + 1, line, `Y ${pos.y} is outside the bed (0 to ${L.y}).`);
      if (abs && L.z && pos.z > L.z + 1) bad(i + 1, line, `Z ${pos.z} is above the printer's height (${L.z}).`);
      if (pos.z < -1) bad(i + 1, line, `Z ${pos.z} would drive the nozzle into the bed.`);
    }
  }
  if (relSeen) warnings.push('The file uses relative moves (G91). Bed and height limits are only checked on absolute moves.');
  if (!st.moves) errors.push({ line: 0, text: '', why: 'The file has no movement commands. It does not look like a print file.' });
  if (!Number.isFinite(st.maxX)) { st.maxX = st.maxY = st.maxZ = st.minZ = 0; }
  return { ok: errors.length === 0, errors, warnings, stats: st };
}

// ---- HTTP helper (the server injects its own, with private-address blocking, for direct mode) -------------------------------------------
function makeHttp({ lookup, timeout = 20000 } = {}) {
  return (method, url, { headers = {}, body, insecure } = {}) => new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error('That is not a valid web address.')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Use an http or https address.'));
    const lib = u.protocol === 'https:' ? https : http; const b = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { 'user-agent': 'DryRunBridge/1', ...headers }; if (b) { h['content-length'] = b.length; if (!h['content-type'] && !h['Content-Type']) h['content-type'] = 'application/json'; }
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers: h, timeout, lookup, rejectUnauthorized: !insecure }, (res) => {
      const chunks = []; let n = 0; res.on('data', (c) => { n += c.length; if (n < 2e6) chunks.push(c); }); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json() { try { return JSON.parse(text); } catch { return null; } } }); });
    });
    req.on('timeout', () => req.destroy(new Error('The device did not answer in time.'))); req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'The device refused the connection. Check the address and port.' : e.code === 'ENOTFOUND' ? 'That address could not be found.' : e.message)));
    if (b) req.write(b); req.end();
  });
}
function multipart(fields, file) {
  const boundary = '----dryrun' + crypto.randomBytes(8).toString('hex'); const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.buf, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}
const base = (c) => String(c.url || '').replace(/\/+$/, '');
const fail = (r, what) => { throw new Error(r.status === 401 || r.status === 403 ? 'The printer refused the key. Check the API key.' : `${what} failed (the printer answered ${r.status}).`); };
const cleanName = (n) => { const s = String(n || 'dryrun').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 60) || 'dryrun'; return /\.(gcode|gco|g)$/i.test(s) ? s : s + '.gcode'; };

// ---- printer adapters: each takes (connection, http) --------------------------------------------------------------------------------
const ADAPTERS = {
  octoprint: {
    label: 'OctoPrint', needs: ['url', 'key'], hint: 'Address of OctoPrint, for example http://octopi.local. The API key is under Settings, then API in OctoPrint. Classic USB printers connected to a Raspberry Pi running OctoPrint use this too.',
    async status(c, h) { const hd = { 'X-Api-Key': c.key }; const p = await h('GET', base(c) + '/api/printer', { headers: hd, insecure: c.insecureTls }); if (p.status === 409) return { state: 'offline', note: 'OctoPrint is up but the printer is not connected to it.' }; if (p.status !== 200) fail(p, 'Reading the printer'); const j = (await h('GET', base(c) + '/api/job', { headers: hd, insecure: c.insecureTls })).json() || {}; const d = p.json() || {}; const f = (d.state || {}).flags || {}; return { state: f.printing ? 'printing' : f.paused ? 'paused' : f.error ? 'error' : f.ready ? 'idle' : 'busy', hotend: ((d.temperature || {}).tool0 || {}).actual, bed: ((d.temperature || {}).bed || {}).actual, progress: (j.progress || {}).completion === null || (j.progress || {}).completion === undefined ? null : Math.round(j.progress.completion), file: ((j.job || {}).file || {}).name || null }; },
    async upload(c, name, buf, o, h) { const m = multipart({ select: 'true', print: o.start ? 'true' : 'false' }, { field: 'file', name, buf }); const r = await h('POST', base(c) + '/api/files/local', { headers: { 'X-Api-Key': c.key, 'content-type': m.type }, body: m.body, insecure: c.insecureTls }); if (r.status !== 201 && r.status !== 200) fail(r, 'Sending the file'); return { message: o.start ? `Sent ${name} and started the print.` : `Sent ${name}. It is selected on the printer and waiting for you to start it.` }; },
    async cancel(c, h) { const r = await h('POST', base(c) + '/api/job', { headers: { 'X-Api-Key': c.key }, body: { command: 'cancel' }, insecure: c.insecureTls }); if (r.status !== 204 && r.status !== 200) fail(r, 'Cancelling'); return { message: 'Cancel sent.' }; },
  },
  moonraker: {
    label: 'Klipper (Moonraker)', needs: ['url'], hint: 'Address of Moonraker, for example http://printer.local:7125 (or the Fluidd or Mainsail address). A key is only needed if you turned on authorisation.',
    async status(c, h) { const hd = c.key ? { 'X-Api-Key': c.key } : {}; const r = await h('GET', base(c) + '/printer/objects/query?extruder&heater_bed&print_stats&display_status', { headers: hd, insecure: c.insecureTls }); if (r.status !== 200) fail(r, 'Reading the printer'); const s = ((r.json() || {}).result || {}).status || {}; const ps = (s.print_stats || {}).state; return { state: ps === 'printing' ? 'printing' : ps === 'paused' ? 'paused' : ps === 'error' ? 'error' : 'idle', hotend: (s.extruder || {}).temperature, bed: (s.heater_bed || {}).temperature, progress: (s.display_status || {}).progress === undefined ? null : Math.round(s.display_status.progress * 100), file: (s.print_stats || {}).filename || null }; },
    async upload(c, name, buf, o, h) { const m = multipart({ root: 'gcodes', print: o.start ? 'true' : 'false' }, { field: 'file', name, buf }); const r = await h('POST', base(c) + '/server/files/upload', { headers: { ...(c.key ? { 'X-Api-Key': c.key } : {}), 'content-type': m.type }, body: m.body, insecure: c.insecureTls }); if (r.status !== 201 && r.status !== 200) fail(r, 'Sending the file'); return { message: o.start ? `Sent ${name} and started the print.` : `Sent ${name} to the printer's gcodes folder.` }; },
    async cancel(c, h) { const r = await h('POST', base(c) + '/printer/print/cancel', { headers: c.key ? { 'X-Api-Key': c.key } : {}, insecure: c.insecureTls }); if (r.status !== 200) fail(r, 'Cancelling'); return { message: 'Cancel sent.' }; },
  },
  prusalink: {
    label: 'PrusaLink', needs: ['url', 'key'], hint: 'Address of the printer, for example http://prusa-mk4.local. The API key is on the printer under Settings, then Network, then PrusaLink.',
    async status(c, h) { const r = await h('GET', base(c) + '/api/v1/status', { headers: { 'X-Api-Key': c.key }, insecure: c.insecureTls }); if (r.status !== 200) fail(r, 'Reading the printer'); const d = r.json() || {}; const p = d.printer || {}; const s = String(p.state || '').toUpperCase(); return { state: s === 'PRINTING' ? 'printing' : s === 'PAUSED' ? 'paused' : /ERROR|ATTENTION/.test(s) ? 'error' : s === 'IDLE' || s === 'FINISHED' || s === 'STOPPED' || s === 'READY' ? 'idle' : 'busy', hotend: p.temp_nozzle, bed: p.temp_bed, progress: (d.job || {}).progress === undefined ? null : Math.round(d.job.progress), file: null, jobId: (d.job || {}).id }; },
    async upload(c, name, buf, o, h) { const st = c.storage || 'usb'; const r = await h('PUT', `${base(c)}/api/v1/files/${encodeURIComponent(st)}/${encodeURIComponent(name)}`, { headers: { 'X-Api-Key': c.key, 'content-type': 'application/octet-stream', 'Print-After-Upload': o.start ? '?1' : '?0', Overwrite: '?1' }, body: buf, insecure: c.insecureTls }); if (![200, 201, 204].includes(r.status)) fail(r, 'Sending the file'); return { message: o.start ? `Sent ${name} and started the print.` : `Sent ${name}. Start it from the printer's screen.` }; },
    async cancel(c, h) { const s = await this.status(c, h); if (!s.jobId) return { message: 'There is no job running.' }; const r = await h('DELETE', `${base(c)}/api/v1/job/${encodeURIComponent(s.jobId)}`, { headers: { 'X-Api-Key': c.key }, insecure: c.insecureTls }); if (![200, 204].includes(r.status)) fail(r, 'Cancelling'); return { message: 'Cancel sent.' }; },
  },
  bambu: {
    label: 'Bambu Lab (local network)', needs: ['host', 'accessCode'], bridgeOnly: true, experimental: true,
    hint: 'Turn on LAN Only Mode and Developer Mode on the printer, then use its IP address and the access code from the printer screen. Dry Run uploads the file to the printer. You start it from the printer screen. Not yet tested on a real printer.',
    async status() { return { state: 'unknown', note: 'Live status is not read for this printer. Look at the printer screen.' }; },
    async upload(c, name, buf, o) { if (o.start) throw new Error('Starting a print on this printer from Dry Run is not supported. The file was not sent. Send it without starting, then start it on the printer.'); await ftpsUpload({ host: c.host, port: c.port || 990, user: 'bblp', pass: c.accessCode, name, buf }); return { message: `Uploaded ${name} to the printer's storage. Start it from the printer screen.` }; },
    async cancel() { throw new Error('Cancelling from Dry Run is not supported for this printer. Use the printer screen.'); },
  },
};
/** Minimal FTP over implicit TLS (what Bambu Lab printers expose on port 990 in LAN mode). */
function ftpsUpload({ host, port, user, pass, name, buf }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false }); let acc = '', wait = null, done = false;
    const end = (e) => { if (done) return; done = true; try { sock.destroy(); } catch { /* closed */ } e ? reject(e) : resolve(); };
    const timer = setTimeout(() => end(new Error('The printer did not answer in time.')), 60000); timer.unref();
    sock.on('error', (e) => end(new Error('Could not reach the printer: ' + e.message)));
    sock.on('data', (d) => { acc += d.toString('latin1'); const lines = acc.split(/\r?\n/); const last = lines.filter((l) => /^\d{3} /.test(l)).pop(); if (last && wait) { const w = wait; wait = null; acc = ''; w(last); } });
    const reply = () => new Promise((r) => { wait = r; }); const send = async (cmd, ok) => { sock.write(cmd + '\r\n'); const r = await reply(); if (!ok.test(r)) throw new Error(`The printer rejected "${cmd.split(' ')[0]}": ${r.slice(0, 60)}`); return r; };
    (async () => {
      await reply(); await send(`USER ${user}`, /^(331|230)/); await send(`PASS ${pass}`, /^230/); await send('PBSZ 0', /^200/); await send('PROT P', /^200/); await send('TYPE I', /^200/);
      const p = await send('PASV', /^227/); const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(p); if (!m) throw new Error('The printer sent an unexpected reply.');
      const data = tls.connect({ host, port: Number(m[5]) * 256 + Number(m[6]), rejectUnauthorized: false, session: sock.getSession() }); await new Promise((r, j) => { data.once('secureConnect', r); data.once('error', j); });
      sock.write(`STOR ${name}\r\n`); const s = await reply(); if (!/^1/.test(s)) throw new Error('The printer would not accept the file: ' + s.slice(0, 60));
      const finished = reply(); data.end(buf); await finished; await send('QUIT', /^2/).catch(() => {}); clearTimeout(timer); end();
    })().catch(end);
  });
}
const adapterList = () => Object.entries(ADAPTERS).map(([key, a]) => ({ key, label: a.label, needs: a.needs, hint: a.hint, bridgeOnly: !!a.bridgeOnly, experimental: !!a.experimental }));

// ---- the bridge program ---------------------------------------------------------------------------------------------------------------
const SAMPLE = {
  server: 'https://dry-run-production-6267ad2d.up.railway.app', token: 'paste the bridge token from Dry Run here', pollSeconds: 3,
  printers: [
    { name: 'Workshop printer', adapter: 'octoprint', url: 'http://octopi.local', key: 'OCTOPRINT_API_KEY', allowStart: false, limits: { hotend: 260, bed: 100, x: 220, y: 220, z: 250 } },
  ],
  robots: [
    { name: 'Arm 1', dir: './robot-programs', allowRun: false, run: 'python3 {file}', stop: 'pkill -f {file}' },
  ],
};
async function main() {
  const arg = process.argv[2]; const cfgPath = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('--')) || 'dryrun-bridge.json');
  if (arg === '--init') { if (fs.existsSync(cfgPath)) { console.log(cfgPath + ' already exists. Not overwriting it.'); return; } fs.writeFileSync(cfgPath, JSON.stringify(SAMPLE, null, 2)); fs.chmodSync(cfgPath, 0o600); console.log('Wrote ' + cfgPath + '. Edit it, then run: node dryrun-bridge.js'); return; }
  let cfg; try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { console.error('Could not read ' + cfgPath + '. Run "node dryrun-bridge.js --init" first.'); process.exit(1); }
  const server = String(cfg.server || '').replace(/\/+$/, ''); if (!/^https?:\/\//.test(server) || !cfg.token || /paste/.test(cfg.token)) { console.error('Set "server" and "token" in ' + cfgPath + '. The token is shown once in Dry Run, under Design studio, Printers and robots.'); process.exit(1); }
  const h = makeHttp(); const printers = new Map((cfg.printers || []).map((p) => [p.name, p])); const robots = new Map((cfg.robots || []).map((r) => [r.name, r])); const running = new Map(); let results = [];
  const api = (method, p, body) => h(method, server + p, { headers: { authorization: 'Bearer ' + cfg.token }, body });
  async function getBuf(job) { // binary-safe download
    return new Promise((resolve, reject) => { const u = new URL(`${server}/api/bridge/file/${encodeURIComponent(job.id)}`); const lib = u.protocol === 'https:' ? https : http; lib.get(u, { headers: { authorization: 'Bearer ' + cfg.token } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(c)) : reject(new Error('Could not download the file from Dry Run.')))); }).on('error', reject); });
  }
  async function handle(job) {
    try {
      if (job.kind === 'printer') {
        const p = printers.get(job.target); if (!p) throw new Error('This bridge has no printer called "' + job.target + '".'); const a = ADAPTERS[p.adapter]; if (!a) throw new Error('Unknown printer type "' + p.adapter + '".');
        if (job.op === 'status') return { id: job.id, ok: true, status: await a.status(p, h) };
        if (job.op === 'cancel') return { id: job.id, ok: true, message: (await a.cancel(p, h)).message };
        if (job.op === 'upload') {
          const buf = await getBuf(job); if (crypto.createHash('sha256').update(buf).digest('hex') !== job.sha256) throw new Error('The file changed on the way. Nothing was sent.');
          const s = scan(buf.toString('utf8'), p.limits || {}); if (!s.ok) throw new Error('This bridge refused the file: ' + s.errors[0].why + (s.errors[0].line ? ` (line ${s.errors[0].line})` : ''));
          if (job.start && !p.allowStart) throw new Error('This printer is set to "upload only" in the bridge config (allowStart is false). The file was not sent. Set allowStart to true to let Dry Run start prints, or send it without starting.');
          return { id: job.id, ok: true, message: (await a.upload(p, cleanName(job.name), buf, { start: !!job.start }, h)).message };
        }
        throw new Error('Unknown request.');
      }
      if (job.kind === 'robot') {
        const r = robots.get(job.target); if (!r) throw new Error('This bridge has no robot called "' + job.target + '".'); const dir = path.resolve(path.dirname(cfgPath), r.dir || './robot-programs');
        if (job.op === 'deploy' || job.op === 'run') {
          const buf = await getBuf(job); if (buf.length > 512 * 1024) throw new Error('The program is too large.'); if (crypto.createHash('sha256').update(buf).digest('hex') !== job.sha256) throw new Error('The file changed on the way. Nothing was saved.');
          fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, String(job.name || 'program').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 60)); fs.writeFileSync(file, buf);
          if (job.op === 'deploy') return { id: job.id, ok: true, message: `Saved ${path.basename(file)} to ${dir}. It was not run.` };
          if (!r.allowRun) { return { id: job.id, ok: true, message: `Saved ${path.basename(file)} to ${dir}. This robot is set to "save only" in the bridge config (allowRun is false), so it was not run.` }; }
          if (!r.run) throw new Error('No "run" command is set for this robot in the bridge config.');
          const parts = String(r.run).split(/\s+/).map((x) => x.replace('{file}', file)); const child = spawn(parts[0], parts.slice(1), { cwd: dir, stdio: 'ignore' }); running.set(job.target, { child, file }); child.on('exit', () => running.delete(job.target)); child.on('error', () => running.delete(job.target));
          return { id: job.id, ok: true, message: `Started ${path.basename(file)}.` };
        }
        if (job.op === 'stop') {
          const run = running.get(job.target); if (run) { try { run.child.kill('SIGTERM'); } catch { /* gone */ } }
          if (r.stop) { const parts = String(r.stop).split(/\s+/).map((x) => x.replace('{file}', run ? run.file : (job.name || ''))); try { spawn(parts[0], parts.slice(1), { stdio: 'ignore' }).on('error', () => {}); } catch { /* ignore */ } }
          return { id: job.id, ok: true, message: 'Stop sent.' };
        }
      }
      throw new Error('Unknown request.');
    } catch (e) { return { id: job.id, ok: false, message: e.message }; }
  }
  const advert = () => ({ version: VERSION, printers: [...printers.values()].map((p) => ({ name: p.name, adapter: p.adapter, allowStart: !!p.allowStart, limits: p.limits || {} })), robots: [...robots.values()].map((r) => ({ name: r.name, allowRun: !!r.allowRun })) });
  console.log(`Dry Run Bridge ${VERSION}. Printers: ${printers.size}. Robots: ${robots.size}. Talking to ${server}`);
  let backoff = 0;
  for (;;) {
    try {
      const r = await api('POST', '/api/bridge/poll', { ...advert(), results }); results = [];
      if (r.status === 401) { console.error('Dry Run did not accept the token. Make a new bridge token in Dry Run.'); backoff = 30; }
      else if (r.status !== 200) { console.error('Dry Run answered ' + r.status); backoff = 10; }
      else { backoff = 0; for (const job of (r.json() || {}).jobs || []) { console.log('request:', job.kind, job.op, job.target); const out = await handle(job); console.log(' ->', out.ok ? 'done' : 'refused', out.message || ''); results.push(out); } }
    } catch (e) { console.error('Could not reach Dry Run: ' + e.message); backoff = Math.min(60, (backoff || 2) * 2); }
    await new Promise((r) => setTimeout(r, (backoff || Number(cfg.pollSeconds) || 3) * 1000));
  }
}
if (require.main === module) main(); else module.exports = { scan, ADAPTERS, adapterList, makeHttp, cleanName, ftpsUpload, multipart };
