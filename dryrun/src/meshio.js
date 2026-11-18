'use strict';
/** Reading 3D files the person already has: binary and ASCII STL, and OBJ. Welds shared vertices so the closed-solid check works. */
const { err } = require('./util');
const MAX_TRIANGLES = 400000;

function parseSTL(buf) {
  const n = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
  const tris = [];
  if (buf.length >= 84 && 84 + n * 50 === buf.length) { // binary
    if (n > MAX_TRIANGLES) throw err(422, `That model has ${n.toLocaleString('en')} triangles. The limit is ${MAX_TRIANGLES.toLocaleString('en')}. Reduce it in your 3D tool first.`);
    for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let k = 0; k < 9; k++) tris.push(buf.readFloatLE(o + k * 4)); }
    return tris;
  }
  const text = buf.toString('latin1'); if (!/^\s*solid/i.test(text) || !/facet\s+normal/i.test(text)) throw err(422, 'This does not look like an STL file. Export it from your 3D tool as STL (binary or text).');
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g; let m, c = 0;
  while ((m = re.exec(text))) { tris.push(Number(m[1]), Number(m[2]), Number(m[3])); if (++c > MAX_TRIANGLES * 3) throw err(422, 'That model has too many triangles.'); }
  if (!tris.length || (tris.length / 3) % 3) throw err(422, 'The STL file is incomplete or damaged.');
  return tris;
}
function parseOBJ(buf) {
  const v = [], tris = []; const lines = buf.toString('utf8').split(/\r?\n/);
  for (const ln of lines) {
    if (ln.startsWith('v ')) { const p = ln.trim().split(/\s+/).slice(1, 4).map(Number); if (p.length === 3 && p.every(Number.isFinite)) v.push(p); }
    else if (ln.startsWith('f ')) {
      const idx = ln.trim().split(/\s+/).slice(1).map((t) => { const i = parseInt(t.split('/')[0], 10); return i < 0 ? v.length + i : i - 1; });
      if (idx.length < 3 || idx.some((i) => !(i >= 0 && i < v.length))) continue;
      for (let k = 1; k + 1 < idx.length; k++) { for (const i of [idx[0], idx[k], idx[k + 1]]) tris.push(...v[i]); }
      if (tris.length / 9 > MAX_TRIANGLES) throw err(422, 'That model has too many triangles.');
    }
  }
  if (!tris.length) throw err(422, 'No faces were found in this OBJ file.');
  return tris;
}
/** tris is a flat list of x,y,z triples (three per triangle). */
function weld(tris) {
  const ids = new Map(); const v = [], f = []; const q = (x) => Math.round(x * 1000) / 1000; let dropped = 0;
  const vid = (x, y, z) => { const k = `${q(x)},${q(y)},${q(z)}`; let i = ids.get(k); if (i === undefined) { i = v.length / 3; ids.set(k, i); v.push(q(x), q(y), q(z)); } return i; };
  for (let i = 0; i < tris.length; i += 9) {
    if (tris.slice(i, i + 9).some((x) => !Number.isFinite(x) || Math.abs(x) > 1e5)) throw err(422, 'The file has invalid coordinates.');
    const a = vid(tris[i], tris[i + 1], tris[i + 2]), b = vid(tris[i + 3], tris[i + 4], tris[i + 5]), c = vid(tris[i + 6], tris[i + 7], tris[i + 8]);
    if (a === b || b === c || a === c) { dropped++; continue; } f.push(a, b, c);
  }
  if (!f.length) throw err(422, 'The model has no usable triangles.');
  return { mesh: { v, f }, dropped };
}
function parse(name, buf) {
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  if (ext === 'stl') return weld(parseSTL(buf));
  if (ext === 'obj') return weld(parseOBJ(buf));
  throw err(422, 'Upload an .stl or .obj file for a 3D model, or a .gcode file to print.');
}
/** Vertex clustering: a lighter copy for the on-screen viewer only. Printing and export always use the full model. */
function decimate(m, maxTris = 12000) {
  const nt = m.f.length / 3; if (nt <= maxTris) return m;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < m.v.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m.v[i + k]); hi[k] = Math.max(hi[k], m.v[i + k]); }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1; let cells = Math.round(Math.sqrt(maxTris) * 1.1);
  for (let attempt = 0; attempt < 6; attempt++) {
    const size = span / cells; const ids = new Map(); const sum = []; const vid = new Int32Array(m.v.length / 3);
    for (let i = 0; i < vid.length; i++) { const k = `${Math.floor((m.v[i * 3] - lo[0]) / size)},${Math.floor((m.v[i * 3 + 1] - lo[1]) / size)},${Math.floor((m.v[i * 3 + 2] - lo[2]) / size)}`; let c = ids.get(k); if (c === undefined) { c = sum.length; ids.set(k, c); sum.push([0, 0, 0, 0]); } const s = sum[c]; s[0] += m.v[i * 3]; s[1] += m.v[i * 3 + 1]; s[2] += m.v[i * 3 + 2]; s[3]++; vid[i] = c; }
    const f = []; for (let i = 0; i < m.f.length; i += 3) { const a = vid[m.f[i]], b = vid[m.f[i + 1]], c = vid[m.f[i + 2]]; if (a !== b && b !== c && a !== c) f.push(a, b, c); }
    if (f.length / 3 <= maxTris * 1.3 || attempt === 5) return { v: sum.flatMap((s) => [s[0] / s[3], s[1] / s[3], s[2] / s[3]]), f };
    cells = Math.floor(cells * 0.75);
  }
  return m;
}
const scale = (m, k) => ({ v: m.v.map((x) => x * k), f: m.f });
module.exports = { parse, parseSTL, parseOBJ, weld, decimate, scale, MAX_TRIANGLES };
