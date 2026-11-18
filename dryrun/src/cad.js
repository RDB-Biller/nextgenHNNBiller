'use strict';
/**
 * Design studio geometry for the Hardware Developer pack. No dependencies.
 *  - Parametric parts (robot, machine and automobile parts) built from extrusions and revolves. Units are millimetres.
 *  - Triangle meshes with exact volume, area and a watertight check, exported as STL (binary) or OBJ.
 *  - Print preparation: bed fit, best flat orientation, overhangs, thin walls, mass, time and cost estimates, plate layout.
 *  - A simple slicer that writes G-code (perimeters, rectilinear infill, solid top and bottom layers).
 * Estimates use stated assumptions. The slicer is for checking and prototyping: use your printer's own slicer for production prints.
 */
const { err } = require('./util');

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const r3 = (n) => Math.round(n * 1000) / 1000;

// ---- mesh ---------------------------------------------------------------------------------------------------------------------
const newMesh = () => ({ v: [], f: [] });
function addV(m, x, y, z) { m.v.push(x, y, z); return m.v.length / 3 - 1; }
function merge(...ms) { const o = newMesh(); for (const m of ms) { const base = o.v.length / 3; for (const x of m.v) o.v.push(x); for (const i of m.f) o.f.push(i + base); } return o; }
function transform(m, fn) { const o = { v: [], f: m.f.slice() }; for (let i = 0; i < m.v.length; i += 3) { const p = fn(m.v[i], m.v[i + 1], m.v[i + 2]); o.v.push(p[0], p[1], p[2]); } return o; }
const translate = (m, dx, dy, dz) => transform(m, (x, y, z) => [x + dx, y + dy, z + dz]);
function rotate(m, axis, ang) { const c = Math.cos(ang), s = Math.sin(ang); return transform(m, (x, y, z) => (axis === 'x' ? [x, y * c - z * s, y * s + z * c] : axis === 'y' ? [x * c + z * s, y, -x * s + z * c] : [x * c - y * s, x * s + y * c, z])); }
function bbox(m) { const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; for (let i = 0; i < m.v.length; i += 3) for (let k = 0; k < 3; k++) { const x = m.v[i + k]; if (x < b.min[k]) b.min[k] = x; if (x > b.max[k]) b.max[k] = x; } return b; }
const extent = (m) => { const b = bbox(m); return [0, 1, 2].map((k) => b.max[k] - b.min[k]); };
function volume(m) { let s = 0; const v = m.v; for (let i = 0; i < m.f.length; i += 3) { const a = m.f[i] * 3, b = m.f[i + 1] * 3, c = m.f[i + 2] * 3; s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]); } return s / 6; }
function triNormal(m, i) { const v = m.v, a = m.f[i] * 3, b = m.f[i + 1] * 3, c = m.f[i + 2] * 3; const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2]; const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const l = Math.hypot(nx, ny, nz) || 1; return { n: [nx / l, ny / l, nz / l], area: l / 2 }; }
function area(m) { let s = 0; for (let i = 0; i < m.f.length; i += 3) s += triNormal(m, i).area; return s; }
/** Every edge must be used by exactly two triangles, once in each direction, for the mesh to be a closed solid. */
function watertight(m) {
  const key = (a, b) => `${a},${b}`; const dir = new Map(); const q = new Map(); const pos = (i) => `${r3(m.v[i * 3])},${r3(m.v[i * 3 + 1])},${r3(m.v[i * 3 + 2])}`; const id = new Map(); const canon = (i) => { const p = pos(i); if (!id.has(p)) id.set(p, id.size); return id.get(p); };
  for (let i = 0; i < m.f.length; i += 3) { const t = [canon(m.f[i]), canon(m.f[i + 1]), canon(m.f[i + 2])]; if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue; for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; dir.set(key(a, b), (dir.get(key(a, b)) || 0) + 1); } }
  let open = 0; for (const [k, c] of dir) { const [a, b] = k.split(','); const back = dir.get(key(b, a)) || 0; if (c !== 1 || back !== 1) open++; } void q; return open === 0;
}
function fixOrientation(m) { return volume(m) < 0 ? { v: m.v, f: m.f.map((x, i, a) => (i % 3 === 1 ? a[i + 1] : i % 3 === 2 ? a[i - 1] : x)) } : m; }
function stats(m) { const b = bbox(m); return { triangles: m.f.length / 3, bbox: { min: b.min.map(r3), max: b.max.map(r3) }, size: [0, 1, 2].map((k) => r3(b.max[k] - b.min[k])), volumeMm3: r3(volume(m)), areaMm2: r3(area(m)), watertight: watertight(m) }; }

// ---- 2D shapes and triangulation with holes -------------------------------------------------------------------------------------
const signedArea = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const ccw = (p) => (signedArea(p) < 0 ? p.slice().reverse() : p.slice());
const cw = (p) => (signedArea(p) > 0 ? p.slice().reverse() : p.slice());
const circle = (cx, cy, r, n = 48) => { const o = []; for (let i = 0; i < n; i++) { const a = TAU * i / n; o.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } return o; };
function roundRect(w, d, r, n = 8) { const o = []; const rr = Math.min(r, w / 2 - 0.01, d / 2 - 0.01); if (rr <= 0.01) return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]; const c = [[w / 2 - rr, d / 2 - rr, 0], [-w / 2 + rr, d / 2 - rr, 90], [-w / 2 + rr, -d / 2 + rr, 180], [w / 2 - rr, -d / 2 + rr, 270]]; for (const [cx, cy, a0] of c) for (let i = 0; i <= n; i++) { const a = (a0 + 90 * i / n) * DEG; o.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); } return o; }
const rect = (w, d, cx = 0, cy = 0) => [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]];
function sectorPoly(r0, r1, a0, a1, n = 10) { const o = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; o.push([r1 * Math.cos(a), r1 * Math.sin(a)]); } for (let i = n; i >= 0; i--) { const a = a0 + (a1 - a0) * i / n; o.push([r0 * Math.cos(a), r0 * Math.sin(a)]); } return o; }

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function segCross(p1, p2, p3, p4) { // proper crossing only: touching at an endpoint does not count
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4); const e = 1e-9;
  return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}
/** Join each hole to the outline with a short bridge that crosses nothing, giving one polygon that touches itself along the bridges. */
function bridgeHoles(outer, holes) {
  let poly = outer.map((p, i) => ({ p, k: i })); const rest = holes.map((h) => h.slice()); const edgesOf = (pts) => pts.map((p, i) => [p, pts[(i + 1) % pts.length]]);
  rest.sort((a, b) => Math.min(...a.map((p) => p[0])) - Math.min(...b.map((p) => p[0])));
  while (rest.length) {
    const others = rest.flatMap(edgesOf); let best = null;
    for (let hi = 0; hi < rest.length; hi++) {
      const h = rest[hi]; const pe = edgesOf(poly.map((x) => x.p));
      for (let a = 0; a < h.length; a++) for (let b = 0; b < poly.length; b++) {
        const A = h[a], B = poly[b].p; const dist = (A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2; if (best && dist >= best.dist) continue;
        let bad = false; for (const e of pe) { if (segCross(A, B, e[0], e[1])) { bad = true; break; } } if (!bad) for (const e of others) { if (segCross(A, B, e[0], e[1])) { bad = true; break; } } if (bad) continue;
        const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]; if (!pointInPoly(mid, poly.map((x) => x.p))) continue; // the bridge must run inside the solid
        best = { dist, hi, a, b };
      }
    }
    if (!best) throw err(422, 'This shape has features too close together to build. Move holes apart or away from the edge.');
    const h = rest.splice(best.hi, 1)[0]; const seq = []; for (let i = 0; i <= h.length; i++) seq.push({ p: h[(best.a + i) % h.length], k: -1 }); seq.push({ p: poly[best.b].p, k: -1 });
    poly = [...poly.slice(0, best.b + 1), ...seq, ...poly.slice(best.b + 1)];
  }
  return poly.map((x) => x.p);
}
function pointInPoly(pt, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; } return inside; }
function earClip(pts) { // pts: weakly simple CCW polygon, may repeat points along bridges. Returns triples of indexes into pts.
  const n = pts.length; const idx = pts.map((_, i) => i); const out = []; let guard = n * n + 10; const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  const inTri = (p, a, b, c) => { const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p); const neg = d1 < -1e-12 || d2 < -1e-12 || d3 < -1e-12, pos = d1 > 1e-12 || d2 > 1e-12 || d3 > 1e-12; return !(neg && pos); };
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false; const L = idx.length; const reflex = []; for (let i = 0; i < L; i++) { const a = pts[idx[(i + L - 1) % L]], b = pts[idx[i]], c = pts[idx[(i + 1) % L]]; if (cross(a, b, c) <= 1e-12) reflex.push(i); }
    for (let i = 0; i < L && !clipped; i++) {
      const ia = idx[(i + L - 1) % L], ib = idx[i], ic = idx[(i + 1) % L]; const a = pts[ia], b = pts[ib], c = pts[ic]; if (cross(a, b, c) <= 1e-12) continue;
      let ok = true; for (const r of reflex) { const ir = idx[r]; if (ir === ia || ir === ib || ir === ic) continue; const p = pts[ir]; if (same(p, a) || same(p, b) || same(p, c)) continue; if (inTri(p, a, b, c)) { ok = false; break; } }
      if (ok) { out.push(ia, ib, ic); idx.splice(i, 1); clipped = true; }
    }
    if (!clipped) { // numerical corner: drop the flattest vertex
      let bi = 0, ba = Infinity; for (let i = 0; i < L; i++) { const a = pts[idx[(i + L - 1) % L]], b = pts[idx[i]], c = pts[idx[(i + 1) % L]]; const ar = Math.abs(cross(a, b, c)); if (ar < ba) { ba = ar; bi = i; } } idx.splice(bi, 1);
    }
  }
  if (idx.length === 3 && cross(pts[idx[0]], pts[idx[1]], pts[idx[2]]) > 1e-12) out.push(idx[0], idx[1], idx[2]);
  return out;
}
function triangulate(outer, holes = []) { const poly = holes.length ? bridgeHoles(ccw(outer), holes.map(cw)) : ccw(outer); return { pts: poly, tris: earClip(poly) }; }

/** Straight extrusion of an outline with holes, from z0 to z1. */
function extrude(outer, holes, z0, z1) {
  const m = newMesh(); const O = ccw(outer), H = holes.map(cw); const { pts, tris } = triangulate(O, H); const bot = pts.map((p) => addV(m, p[0], p[1], z0)), top = pts.map((p) => addV(m, p[0], p[1], z1));
  for (let i = 0; i < tris.length; i += 3) { m.f.push(top[tris[i]], top[tris[i + 1]], top[tris[i + 2]]); m.f.push(bot[tris[i]], bot[tris[i + 2]], bot[tris[i + 1]]); }
  for (const loop of [O, ...H]) { const b = loop.map((p) => addV(m, p[0], p[1], z0)), t = loop.map((p) => addV(m, p[0], p[1], z1)); for (let i = 0; i < loop.length; i++) { const j = (i + 1) % loop.length; m.f.push(b[i], b[j], t[j], b[i], t[j], t[i]); } }
  return m;
}

/** One flat face at height z, with optional holes, facing up or down. */
function capFace(m, outer, holes, z, up) { const { pts, tris } = triangulate(ccw(outer), holes.map(cw)); const ix = pts.map((q) => addV(m, q[0], q[1], z)); for (let i = 0; i < tris.length; i += 3) { if (up) m.f.push(ix[tris[i]], ix[tris[i + 1]], ix[tris[i + 2]]); else m.f.push(ix[tris[i]], ix[tris[i + 2]], ix[tris[i + 1]]); } }
/** A side wall around a loop. A counter-clockwise loop faces outward, a clockwise loop faces into the hole it bounds. */
function wallFace(m, loop, z0, z1) { const b = loop.map((q) => addV(m, q[0], q[1], z0)), t = loop.map((q) => addV(m, q[0], q[1], z1)); for (let i = 0; i < loop.length; i++) { const j = (i + 1) % loop.length; m.f.push(b[i], b[j], t[j], b[i], t[j], t[i]); } }
/** Revolve a closed (radius, height) outline about the Z axis. The outline runs counter-clockwise, radius to the right. */
function revolve(profile, seg = 64) {
  const m = newMesh(); const n = profile.length; const ring = profile.map(([r, z]) => (r < 1e-9 ? [addV(m, 0, 0, z)] : Array.from({ length: seg }, (_, k) => addV(m, r * Math.cos(TAU * k / seg), r * Math.sin(TAU * k / seg), z))));
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; const ra = profile[i][0], rb = profile[j][0]; if (ra < 1e-9 && rb < 1e-9) continue;
    for (let k = 0; k < seg; k++) { const k1 = (k + 1) % seg; const a0 = ring[i][ra < 1e-9 ? 0 : k], a1 = ring[i][ra < 1e-9 ? 0 : k1], b0 = ring[j][rb < 1e-9 ? 0 : k], b1 = ring[j][rb < 1e-9 ? 0 : k1];
      if (ra < 1e-9) m.f.push(a0, b1, b0); else if (rb < 1e-9) m.f.push(a0, a1, b0); else m.f.push(a0, b1, b0, a0, a1, b1); } }
  return fixOrientation(m);
}

// ---- parts ----------------------------------------------------------------------------------------------------------------------
const P = (key, label, unit, min, max, def) => ({ key, label, unit, min, max, def });
function involute(rb, rho) { const a = Math.acos(Math.min(1, rb / rho)); return Math.tan(a) - a; }
function gearOutline(mod, z) {
  const r = mod * z / 2, rb = r * Math.cos(20 * DEG), ra = r + mod, rf = Math.max(r - 1.25 * mod, 0.3 * mod); const inv20 = Math.tan(20 * DEG) - 20 * DEG; const half = (rho) => Math.PI / (2 * z) + inv20 - involute(rb, rho);
  const out = []; const r0 = Math.max(rb, rf + 1e-6), steps = 6; const rhos = Array.from({ length: steps + 1 }, (_, i) => r0 + (ra - r0) * i / steps);
  for (let k = 0; k < z; k++) { const c = TAU * k / z; const at = (rho, ang) => [rho * Math.cos(ang), rho * Math.sin(ang)];
    if (rf < r0 - 1e-6) out.push(at(rf, c - half(r0))); for (const rho of rhos) out.push(at(rho, c - half(rho))); out.push(at(ra, c)); for (const rho of rhos.slice().reverse()) out.push(at(rho, c + half(rho))); if (rf < r0 - 1e-6) out.push(at(rf, c + half(r0))); out.push(at(rf, c + Math.PI / z)); }
  return { outline: out, rTip: ra, rRoot: rf, rPitch: r };
}
const need = (c, msg) => { if (!c) throw err(422, msg); };
const PARTS = {
  spur_gear: { label: 'Spur gear', group: 'machine', params: [P('module', 'Module (tooth size)', 'mm', 0.5, 6, 1.5), P('teeth', 'Teeth', '', 8, 120, 24), P('thickness', 'Thickness', 'mm', 2, 60, 8), P('bore', 'Bore diameter', 'mm', 0, 60, 5)],
    build(p) { const g = gearOutline(p.module, Math.round(p.teeth)); need(p.bore < 2 * g.rRoot - 3, 'The bore leaves less than 1.5 mm of metal under the teeth. Make the bore smaller or the gear bigger.'); return { mesh: extrude(g.outline, p.bore > 0 ? [circle(0, 0, p.bore / 2, 40)] : [], 0, p.thickness), minFeature: Math.min(Math.PI * p.module / 2 * 0.9, (g.rRoot - p.bore / 2)), note: `Pitch diameter ${r3(2 * g.rPitch)} mm, outside diameter ${r3(2 * g.rTip)} mm` }; } },
  mounting_plate: { label: 'Mounting plate', group: 'robot', params: [P('width', 'Width', 'mm', 20, 400, 100), P('depth', 'Depth', 'mm', 20, 400, 80), P('thickness', 'Thickness', 'mm', 1.5, 20, 4), P('corner', 'Corner radius', 'mm', 0, 40, 6), P('cols', 'Hole columns', '', 0, 12, 4), P('rows', 'Hole rows', '', 0, 12, 3), P('hole', 'Hole diameter', 'mm', 1.5, 12, 3.4), P('margin', 'Margin to holes', 'mm', 4, 40, 8)],
    build(p) { const cols = Math.round(p.cols), rows = Math.round(p.rows); const holes = []; const sx = cols > 1 ? (p.width - 2 * p.margin) / (cols - 1) : 0, sy = rows > 1 ? (p.depth - 2 * p.margin) / (rows - 1) : 0; need(!cols || !rows || ((cols < 2 || sx > p.hole + 3) && (rows < 2 || sy > p.hole + 3)), 'The holes are too close together. Use fewer holes, smaller holes or a bigger plate.'); need(p.margin > p.hole / 2 + 2, 'The holes are too close to the edge.');
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) holes.push(circle(cols > 1 ? -p.width / 2 + p.margin + i * sx : 0, rows > 1 ? -p.depth / 2 + p.margin + j * sy : 0, p.hole / 2, 24)); return { mesh: extrude(roundRect(p.width, p.depth, p.corner), holes, 0, p.thickness), minFeature: Math.min(p.thickness, (cols > 1 ? sx : 99) - p.hole, (rows > 1 ? sy : 99) - p.hole, p.margin - p.hole / 2), note: `${cols * rows} holes` }; } },
  robot_link: { label: 'Robot arm link', group: 'robot', params: [P('length', 'Hole to hole', 'mm', 30, 300, 100), P('width', 'Width', 'mm', 10, 60, 24), P('thickness', 'Thickness', 'mm', 2, 20, 6), P('hole', 'Pivot hole diameter', 'mm', 2, 20, 6), P('slot', 'Lightening slot length (0 for none)', 'mm', 0, 250, 50)],
    build(p) { const r = p.width / 2; need(p.hole < p.width - 5, 'The pivot holes leave under 2.5 mm of wall. Make them smaller or the link wider.'); const o = []; const n = 14; for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + Math.PI * i / n; o.push([p.length + r * Math.cos(a), r * Math.sin(a)]); } for (let i = 0; i <= n; i++) { const a = Math.PI / 2 + Math.PI * i / n; o.push([r * Math.cos(a), r * Math.sin(a)]); }
      const holes = [circle(0, 0, p.hole / 2, 24), circle(p.length, 0, p.hole / 2, 24)]; if (p.slot > 0) { const sw = p.width / 3; need(p.slot + sw < p.length - p.hole - 6, 'The lightening slot runs into the pivot holes. Make it shorter.'); const s = []; for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + Math.PI * i / 8; s.push([p.length / 2 + p.slot / 2 + sw / 2 * Math.cos(a), sw / 2 * Math.sin(a)]); } for (let i = 0; i <= 8; i++) { const a = Math.PI / 2 + Math.PI * i / 8; s.push([p.length / 2 - p.slot / 2 + sw / 2 * Math.cos(a), sw / 2 * Math.sin(a)]); } holes.push(s); }
      return { mesh: extrude(o, holes, 0, p.thickness), minFeature: Math.min(p.thickness, (p.width - p.hole) / 2, p.slot > 0 ? (p.width - p.width / 3) / 2 : 99), note: 'Two pivot holes' + (p.slot > 0 ? ' and a lightening slot' : '') }; } },
  gripper_finger: { label: 'Gripper finger', group: 'robot', params: [P('length', 'Length', 'mm', 20, 150, 60), P('baseWidth', 'Width at the base', 'mm', 10, 50, 22), P('tipWidth', 'Width at the tip', 'mm', 3, 30, 8), P('thickness', 'Thickness', 'mm', 2, 20, 6), P('pivot', 'Pivot hole diameter', 'mm', 2, 12, 4)],
    build(p) { need(p.tipWidth < p.baseWidth, 'The tip must be narrower than the base.'); need(p.pivot < p.baseWidth - 5, 'The pivot hole is too big for the base.'); const b = p.baseWidth / 2, t = p.tipWidth / 2; const o = [[-b, 0], [b, 0], [b, p.length * 0.45], [t, p.length], [-t, p.length], [-t, p.length * 0.8], [-b, p.length * 0.35]]; return { mesh: extrude(o, [circle(0, p.baseWidth / 2, p.pivot / 2, 20)], 0, p.thickness), minFeature: Math.min(p.thickness, p.tipWidth, (p.baseWidth - p.pivot) / 2), note: 'Pivot hole near the base' }; } },
  enclosure_box: { label: 'Electronics enclosure', group: 'robot', params: [P('width', 'Outside width', 'mm', 30, 300, 90), P('depth', 'Outside depth', 'mm', 30, 300, 60), P('height', 'Height', 'mm', 15, 150, 30), P('wall', 'Wall thickness', 'mm', 1.2, 8, 2.4), P('floor', 'Floor thickness', 'mm', 1.2, 8, 2.4)],
    build(p) { need(p.width > 2 * p.wall + 10 && p.depth > 2 * p.wall + 10, 'The walls leave too little room inside.'); need(p.height > p.floor + 8, 'The box is too shallow for its floor.'); const O = rect(p.width, p.depth), I = cw(rect(p.width - 2 * p.wall, p.depth - 2 * p.wall)); const m = newMesh(); capFace(m, O, [], 0, false); wallFace(m, ccw(O), 0, p.height); capFace(m, O, [I], p.height, true); wallFace(m, I, p.floor, p.height); capFace(m, I, [], p.floor, true); return { mesh: m, minFeature: Math.min(p.wall, p.floor), note: `Inside ${r3(p.width - 2 * p.wall)} x ${r3(p.depth - 2 * p.wall)} mm` }; } },
  enclosure_lid: { label: 'Enclosure lid', group: 'robot', params: [P('width', 'Outside width', 'mm', 30, 300, 90), P('depth', 'Outside depth', 'mm', 30, 300, 60), P('thickness', 'Lid thickness', 'mm', 1.2, 8, 2.4), P('wall', 'Box wall thickness', 'mm', 1.2, 8, 2.4), P('lip', 'Lip height', 'mm', 2, 12, 4), P('fit', 'Clearance for the fit', 'mm', 0.1, 0.8, 0.3)],
    build(p) { const iw = p.width - 2 * p.wall - 2 * p.fit, id = p.depth - 2 * p.wall - 2 * p.fit; need(iw > 10 && id > 10, 'The walls leave too little room for the lip.'); const a = extrude(rect(p.width, p.depth), [], 0, p.thickness); const b = extrude(rect(iw, id), [rect(iw - 2 * Math.min(1.6, p.wall), id - 2 * Math.min(1.6, p.wall))], p.thickness, p.thickness + p.lip); return { mesh: merge(a, b), minFeature: Math.min(p.thickness, 1.6), note: 'Print upside down: lip pointing up', stacked: true }; } },
  wheel_rim: { label: 'Wheel or rim', group: 'automobile', params: [P('diameter', 'Diameter', 'mm', 30, 500, 120), P('width', 'Width', 'mm', 6, 120, 30), P('spokes', 'Spokes', '', 3, 16, 5), P('hub', 'Hub diameter', 'mm', 10, 120, 30), P('bore', 'Axle bore', 'mm', 2, 30, 8), P('rim', 'Rim thickness', 'mm', 2, 20, 5), P('spokeWidth', 'Spoke width', 'mm', 3, 40, 10)],
    build(p) { const n = Math.round(p.spokes); const R = p.diameter / 2, rh = p.hub / 2, ri = R - p.rim; need(rh + 4 < ri && p.bore < p.hub - 4, 'The hub is too big for the rim, or the bore too big for the hub.'); const holes = [circle(0, 0, p.bore / 2, 32)]; const r0 = rh + 2, r1 = ri - 2; const gap = Math.max(0.05, 2 * Math.asin(Math.min(0.95, (p.spokeWidth / 2) / ((r0 + r1) / 2))));
      for (let k = 0; k < n; k++) { const a0 = TAU * k / n + gap / 2, a1 = TAU * (k + 1) / n - gap / 2; need(a1 > a0 + 0.05, 'The spokes are too wide for this many spokes.'); holes.push(sectorPoly(r0, r1, a0, a1, 8)); } return { mesh: extrude(circle(0, 0, R, 72), holes, 0, p.width), minFeature: Math.min(p.rim, p.spokeWidth, p.width), note: `${n} spokes` }; } },
  brake_disc: { label: 'Brake disc', group: 'automobile', params: [P('diameter', 'Outside diameter', 'mm', 60, 400, 160), P('thickness', 'Thickness', 'mm', 3, 30, 8), P('centre', 'Centre bore', 'mm', 10, 150, 50), P('boltCircle', 'Bolt circle diameter', 'mm', 20, 200, 70), P('bolts', 'Bolts', '', 3, 8, 5), P('bolt', 'Bolt hole diameter', 'mm', 3, 20, 8), P('slots', 'Cooling slots', '', 0, 36, 12)],
    build(p) { const R = p.diameter / 2; need(p.boltCircle / 2 + p.bolt / 2 + 3 < R - 15 && p.boltCircle / 2 - p.bolt / 2 - 3 > p.centre / 2, 'The bolt holes do not fit between the centre bore and the braking surface.'); const holes = [circle(0, 0, p.centre / 2, 40)]; for (let k = 0; k < Math.round(p.bolts); k++) { const a = TAU * k / Math.round(p.bolts); holes.push(circle(p.boltCircle / 2 * Math.cos(a), p.boltCircle / 2 * Math.sin(a), p.bolt / 2, 20)); }
      const s0 = p.boltCircle / 2 + p.bolt / 2 + 8, s1 = R - 8; const ns = Math.round(p.slots); if (ns > 0) need(s1 > s0 + 5, 'No room for cooling slots at this size.'); for (let k = 0; k < ns; k++) { const a = TAU * (k + 0.5) / ns; const c = Math.cos(a), s = Math.sin(a); const w = 2.5; holes.push([[s0 * c - w * s, s0 * s + w * c], [s1 * c - w * s, s1 * s + w * c], [s1 * c + w * s, s1 * s - w * c], [s0 * c + w * s, s0 * s - w * c]]); } return { mesh: extrude(circle(0, 0, R, 90), holes, 0, p.thickness), minFeature: Math.min(p.thickness, 2.5 * 2), note: `${Math.round(p.bolts)} bolts, ${ns} slots` }; } },
  connecting_rod: { label: 'Connecting rod', group: 'automobile', params: [P('centres', 'Centre to centre', 'mm', 40, 300, 120), P('bigEnd', 'Big end diameter', 'mm', 20, 90, 44), P('bigBore', 'Big end bore', 'mm', 8, 70, 28), P('smallEnd', 'Small end diameter', 'mm', 10, 60, 24), P('smallBore', 'Small end bore', 'mm', 4, 40, 12), P('thickness', 'Thickness', 'mm', 4, 40, 12)],
    build(p) { const r1 = p.bigEnd / 2, r2 = p.smallEnd / 2; need(p.bigBore < p.bigEnd - 6 && p.smallBore < p.smallEnd - 5, 'A bore leaves too little wall around it.'); need(p.centres > r1 + r2 + 10 && r1 > r2, 'The big end must be larger than the small end, with room between them.'); const phi = Math.acos((r1 - r2) / p.centres); const o = []; const n = 28; for (let i = 0; i <= n; i++) { const a = phi + (TAU - 2 * phi) * i / n; o.push([r1 * Math.cos(a), r1 * Math.sin(a)]); } for (let i = 0; i <= 16; i++) { const a = -phi + 2 * phi * i / 16; o.push([p.centres + r2 * Math.cos(a), r2 * Math.sin(a)]); }
      return { mesh: extrude(o, [circle(0, 0, p.bigBore / 2, 36), circle(p.centres, 0, p.smallBore / 2, 28)], 0, p.thickness), minFeature: Math.min((p.bigEnd - p.bigBore) / 2, (p.smallEnd - p.smallBore) / 2, p.thickness), note: 'Print flat. For a real engine use a machined metal part: a printed rod will not survive.' }; } },
  pulley: { label: 'V-groove pulley', group: 'machine', params: [P('diameter', 'Outside diameter', 'mm', 15, 200, 50), P('width', 'Width', 'mm', 6, 40, 14), P('bore', 'Bore', 'mm', 2, 40, 8), P('groove', 'Groove depth', 'mm', 1, 8, 3)],
    build(p) { const R = p.diameter / 2, rb = p.bore / 2; need(rb + p.groove + 3 < R, 'The bore and groove leave too little wall.'); const g = Math.min(p.width / 2 - 1.5, p.groove * 0.9); const prof = [[rb, 0], [R, 0], [R, p.width / 2 - g], [R - p.groove, p.width / 2], [R, p.width / 2 + g], [R, p.width], [rb, p.width]]; return { mesh: revolve(prof, 72), minFeature: Math.min(R - p.groove - rb, 1.5), note: 'Turned shape: print lying flat on one side' }; } },
  shaft: { label: 'Stepped shaft', group: 'machine', params: [P('length', 'Length', 'mm', 20, 300, 100), P('diameter', 'Middle diameter', 'mm', 4, 60, 12), P('endDiameter', 'End diameter', 'mm', 3, 50, 8), P('endLength', 'End length', 'mm', 4, 60, 15)],
    build(p) { need(p.endDiameter <= p.diameter, 'The ends cannot be wider than the middle.'); need(2 * p.endLength < p.length - 4, 'The ends are too long for the shaft.'); const a = p.diameter / 2, e = p.endDiameter / 2, L = p.length, l = p.endLength; return { mesh: revolve([[0, 0], [e, 0], [e, l], [a, l], [a, L - l], [e, L - l], [e, L], [0, L]], 64), minFeature: p.endDiameter, note: 'Printed shafts are weak across the layers. Print lying down for strength along its length.' }; } },
  pipe_reducer: { label: 'Pipe reducer', group: 'machine', params: [P('length', 'Length', 'mm', 15, 200, 50), P('diameterA', 'Outer diameter, large end', 'mm', 10, 120, 40), P('diameterB', 'Outer diameter, small end', 'mm', 6, 100, 25), P('wall', 'Wall thickness', 'mm', 1.2, 10, 2.4)],
    build(p) { need(p.diameterB < p.diameterA, 'The small end must be smaller than the large end.'); need(p.diameterB / 2 - p.wall > 2, 'The wall leaves no opening at the small end.'); const A = p.diameterA / 2, B = p.diameterB / 2, w = p.wall; return { mesh: revolve([[A - w, 0], [A, 0], [B, p.length], [B - w, p.length]], 64), minFeature: w, note: 'Print standing on the large end' }; } },
  bolt_hex: { label: 'Hex bolt (plain shank)', group: 'machine', params: [P('shank', 'Shank diameter', 'mm', 3, 24, 8), P('length', 'Shank length', 'mm', 8, 120, 30), P('acrossFlats', 'Head across flats', 'mm', 6, 40, 13), P('headHeight', 'Head height', 'mm', 2, 16, 5.3)],
    build(p) { need(p.acrossFlats > p.shank + 2, 'The head must be wider than the shank.'); const R = p.acrossFlats / Math.sqrt(3); const hex = Array.from({ length: 6 }, (_, i) => [R * Math.cos(TAU * i / 6), R * Math.sin(TAU * i / 6)]); const head = extrude(hex, [], 0, p.headHeight); const shank = revolve([[0, -p.length], [p.shank / 2, -p.length], [p.shank / 2, 0], [0, 0]], 40); return { mesh: merge(head, shank), minFeature: p.shank, note: 'No thread is modelled. Cut or tap threads, or use a real fastener.', stacked: true }; } },
  l_bracket: { label: 'L bracket', group: 'machine', params: [P('legA', 'Leg A length', 'mm', 15, 200, 50), P('legB', 'Leg B length', 'mm', 15, 200, 40), P('thickness', 'Thickness', 'mm', 2, 12, 4), P('width', 'Width', 'mm', 8, 100, 25)],
    build(p) { const t = p.thickness; need(t < p.legA - 5 && t < p.legB - 5, 'The legs are too short for this thickness.'); return { mesh: extrude([[0, 0], [p.legA, 0], [p.legA, t], [t, t], [t, p.legB], [0, p.legB]], [], 0, p.width), minFeature: t, note: 'The bend is a sharp corner: add material there if it carries load.' }; } },
};
const types = () => Object.entries(PARTS).map(([key, d]) => ({ key, label: d.label, group: d.group, params: d.params }));
function cleanParams(type, raw = {}) {
  const d = PARTS[type]; if (!d) throw err(422, `Unknown part type "${type}".`); const out = {};
  for (const sp of d.params) { const v = raw[sp.key] === undefined || raw[sp.key] === '' || raw[sp.key] === null ? sp.def : Number(raw[sp.key]); if (!Number.isFinite(v) || v < sp.min || v > sp.max) throw err(422, `${d.label}: ${sp.label} must be a number from ${sp.min} to ${sp.max}${sp.unit ? ' ' + sp.unit : ''}.`); out[sp.key] = v; }
  return out;
}
/** Build one part. The result sits on z = 0 with its middle on the origin, ready to print as it stands. */
function buildPart(type, raw) {
  const p = cleanParams(type, raw); const d = PARTS[type]; const b = d.build(p); let mesh = fixOrientation(b.mesh); const bb = bbox(mesh); mesh = translate(mesh, -(bb.min[0] + bb.max[0]) / 2, -(bb.min[1] + bb.max[1]) / 2, -bb.min[2]);
  return { type, label: d.label, params: p, mesh, minFeature: b.minFeature, note: b.note || '' };
}

// ---- materials, printers, estimates ----------------------------------------------------------------------------------------------
const MATERIALS = { PLA: { label: 'PLA', density: 1.24, costPerKg: 22, nozzle: 210, bed: 60, maxFlow: 11 }, PETG: { label: 'PETG', density: 1.27, costPerKg: 25, nozzle: 235, bed: 80, maxFlow: 10 }, ABS: { label: 'ABS', density: 1.04, costPerKg: 24, nozzle: 245, bed: 100, maxFlow: 11 }, ASA: { label: 'ASA', density: 1.07, costPerKg: 28, nozzle: 250, bed: 100, maxFlow: 11 }, TPU: { label: 'TPU (flexible)', density: 1.21, costPerKg: 35, nozzle: 225, bed: 50, maxFlow: 4 }, NYLON: { label: 'Nylon', density: 1.14, costPerKg: 45, nozzle: 260, bed: 80, maxFlow: 8 } };
const PRINTERS = { small: { label: 'Small (180 x 180 x 180 mm)', bed: [180, 180, 180] }, standard: { label: 'Standard (220 x 220 x 250 mm)', bed: [220, 220, 250] }, large: { label: 'Large (300 x 300 x 400 mm)', bed: [300, 300, 400] } };
const DEFAULT_SETTINGS = { material: 'PLA', printer: 'standard', layerHeight: 0.2, infillPct: 20, perimeters: 2, solidLayers: 4, nozzle: 0.4 };
function cleanSettings(s = {}) {
  const num = (k, lo, hi, def) => { const v = s[k] === undefined || s[k] === '' ? def : Number(s[k]); if (!Number.isFinite(v) || v < lo || v > hi) throw err(422, `${k} must be a number from ${lo} to ${hi}.`); return v; };
  const material = s.material || DEFAULT_SETTINGS.material; if (!MATERIALS[material]) throw err(422, 'Choose a material from the list.'); const printer = s.printer || DEFAULT_SETTINGS.printer; let bed; if (s.bed) { bed = [0, 1, 2].map((i) => Number(s.bed[i])); if (bed.some((x) => !Number.isFinite(x) || x < 20 || x > 2000)) throw err(422, 'Bed sizes must be from 20 to 2000 mm.'); } else { if (!PRINTERS[printer]) throw err(422, 'Choose a printer size from the list.'); bed = PRINTERS[printer].bed; }
  const nozzle = num('nozzle', 0.2, 1.2, 0.4); const layerHeight = num('layerHeight', 0.05, nozzle * 0.8, Math.min(0.2, nozzle * 0.5)); return { material, printer, bed, layerHeight, infillPct: num('infillPct', 0, 100, 20), perimeters: Math.round(num('perimeters', 1, 6, 2)), solidLayers: Math.round(num('solidLayers', 0, 10, 4)), nozzle };
}
/** Orientation: try the six faces down. Prefer the least overhang, then the shortest print. */
function orientations() { return [{ name: 'as designed', fn: (m) => m }, { name: 'flipped over', fn: (m) => rotate(m, 'x', Math.PI) }, { name: 'on its side (long edge)', fn: (m) => rotate(m, 'x', Math.PI / 2) }, { name: 'on its other side', fn: (m) => rotate(m, 'x', -Math.PI / 2) }, { name: 'on its end', fn: (m) => rotate(m, 'y', Math.PI / 2) }, { name: 'on its other end', fn: (m) => rotate(m, 'y', -Math.PI / 2) }]; }
function ground(m) { const b = bbox(m); return translate(m, -(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]); }
function overhangArea(m, maxAngleDeg = 45) { const lim = -Math.cos(maxAngleDeg * DEG); let a = 0, base = 0; for (let i = 0; i < m.f.length; i += 3) { const t = triNormal(m, i); const zc = (m.v[m.f[i] * 3 + 2] + m.v[m.f[i + 1] * 3 + 2] + m.v[m.f[i + 2] * 3 + 2]) / 3; if (t.n[2] < lim) { if (zc < 0.05) base += t.area; else a += t.area; } } return { overhang: a, onBed: base }; }
function bestOrientation(m) {
  let best = null; for (const o of orientations()) { const g = ground(o.fn(m)); const oh = overhangArea(g); const h = bbox(g).max[2]; const score = oh.overhang * 3 + h * 2 - oh.onBed * 0.2; if (!best || score < best.score) best = { name: o.name, mesh: g, overhangMm2: r3(oh.overhang), onBedMm2: r3(oh.onBed), height: r3(h), score }; }
  return best;
}
function estimate(mesh, st) {
  const mat = MATERIALS[st.material]; const V = Math.max(0, volume(mesh)), A = area(mesh), H = Math.max(0.1, bbox(mesh).max[2]); const lineW = st.nozzle * 1.1; const shell = Math.min(V, A * 0.5 * st.perimeters * lineW); const caps = Math.min(V - shell, 2 * st.solidLayers * st.layerHeight * (V / H)); const infill = Math.max(0, V - shell - caps) * st.infillPct / 100; const ext = shell + caps + infill;
  const flow = Math.min(mat.maxFlow, 45 * lineW * st.layerHeight); const layers = Math.ceil(H / st.layerHeight); const seconds = ext / Math.max(flow, 0.5) * 1.18 + layers * 2.5; const grams = ext * mat.density / 1000;
  return { volumeMm3: r3(V), printedMm3: r3(ext), grams: r3(grams), materialCost: r3(grams / 1000 * mat.costPerKg), hours: r3(seconds / 3600), layers };
}
function printCheck(part, st) {
  const warnings = []; const best = bestOrientation(part.mesh); const g = best.mesh; const size = extent(g).map(r3); const [bx, by, bz] = st.bed; const fits = size[0] <= bx && size[1] <= by && size[2] <= bz; const fitsFlat = [...size.slice(0, 2)].sort((a, b) => b - a); const bedFlat = [bx, by].sort((a, b) => b - a);
  if (!fits) warnings.push(`It does not fit the printer (${size.join(' x ')} mm against a bed of ${st.bed.join(' x ')} mm). Make it smaller, split it into two parts or use a larger printer.`);
  const minWall = part.minFeature; if (minWall < st.nozzle * 2) warnings.push(`The thinnest feature is about ${r3(minWall)} mm, under two nozzle widths (${r3(st.nozzle * 2)} mm). It may not print solidly.`);
  const tot = area(g); const ohShare = tot ? best.overhangMm2 / tot : 0; if (ohShare > 0.12) warnings.push(`${Math.round(ohShare * 100)}% of the surface hangs over empty space at more than 45 degrees, even in the best orientation. Expect supports or sagging.`);
  if (best.height > 150 && Math.min(size[0], size[1]) < best.height / 6) warnings.push('It is tall and thin on the bed, so it may wobble or snap along a layer line. Print it lying down if you can.');
  if (!watertight(part.mesh)) warnings.push('The model has open edges. Slicers may fail on it.');
  if (/will not survive|weak across/.test(part.note)) warnings.push(part.note);
  void fitsFlat; void bedFlat;
  return { fits, size, orientation: best.name, overhangMm2: best.overhangMm2, height: best.height, warnings, estimate: estimate(g, st) };
}
/** Lay parts out on bed-sized plates in rows. Each part sits in its best orientation. */
function plates(items, st) {
  const [bx, by] = st.bed; const gap = 6; const out = []; let cur = null; const place = (it) => { const sz = extent(it.mesh);
    if (!cur) { cur = { x: gap, y: gap, rowH: 0, items: [] }; out.push(cur); } if (cur.x + sz[0] > bx - gap + 0.001) { cur.x = gap; cur.y += cur.rowH + gap; cur.rowH = 0; } if (cur.y + sz[1] > by - gap + 0.001) { cur = { x: gap, y: gap, rowH: 0, items: [] }; out.push(cur); } if (sz[0] > bx || sz[1] > by) return false;
    cur.items.push({ name: it.name, dx: cur.x + sz[0] / 2 - bx / 2, dy: cur.y + sz[1] / 2 - by / 2, mesh: it.mesh }); cur.x += sz[0] + gap; cur.rowH = Math.max(cur.rowH, sz[1]); return true; };
  const skipped = []; for (const it of items.slice().sort((a, b) => extent(b.mesh)[1] - extent(a.mesh)[1])) if (!place(it)) skipped.push(it.name);
  return { plates: out.map((p) => ({ parts: p.items.map((x) => x.name), mesh: merge(...p.items.map((x) => translate(x.mesh, x.dy * 0 + x.dx, x.dy, 0))) })), skipped };
}

// ---- export ---------------------------------------------------------------------------------------------------------------------
function toSTL(m, name = 'dryrun') { const nt = m.f.length / 3; const buf = Buffer.alloc(84 + nt * 50); buf.write(('Dry Run ' + name).slice(0, 79), 0, 'latin1'); buf.writeUInt32LE(nt, 80); let o = 84; for (let i = 0; i < m.f.length; i += 3) { const t = triNormal(m, i); for (const x of t.n) { buf.writeFloatLE(x, o); o += 4; } for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) { buf.writeFloatLE(m.v[m.f[i + k] * 3 + c], o); o += 4; } buf.writeUInt16LE(0, o); o += 2; } return buf; }
function toOBJ(parts) { let s = '# Dry Run design export. Units: millimetres\n'; let off = 0; for (const p of parts) { s += `o ${String(p.name).replace(/\s+/g, '_')}\n`; for (let i = 0; i < p.mesh.v.length; i += 3) s += `v ${r3(p.mesh.v[i])} ${r3(p.mesh.v[i + 1])} ${r3(p.mesh.v[i + 2])}\n`; for (let i = 0; i < p.mesh.f.length; i += 3) s += `f ${p.mesh.f[i] + 1 + off} ${p.mesh.f[i + 1] + 1 + off} ${p.mesh.f[i + 2] + 1 + off}\n`; off += p.mesh.v.length / 3; } return s; }

// ---- slicer ---------------------------------------------------------------------------------------------------------------------
function sliceLoops(m, z) {
  const segs = []; const v = m.v; for (let i = 0; i < m.f.length; i += 3) { const ia = m.f[i] * 3, ib = m.f[i + 1] * 3, ic = m.f[i + 2] * 3; const zs = [v[ia + 2], v[ib + 2], v[ic + 2]]; if ((zs[0] > z && zs[1] > z && zs[2] > z) || (zs[0] < z && zs[1] < z && zs[2] < z)) continue; const pts = []; const P3 = [[v[ia], v[ia + 1], zs[0]], [v[ib], v[ib + 1], zs[1]], [v[ic], v[ic + 1], zs[2]]];
    for (let k = 0; k < 3; k++) { const a = P3[k], b = P3[(k + 1) % 3]; if ((a[2] > z) !== (b[2] > z)) { const t = (z - a[2]) / (b[2] - a[2]); pts.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); } } if (pts.length === 2) segs.push(pts); }
  const key = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`; const map = new Map(); for (const s of segs) for (let e = 0; e < 2; e++) { const k = key(s[e]); if (!map.has(k)) map.set(k, []); map.get(k).push(s); }
  const used = new Set(); const loops = []; for (const s of segs) { if (used.has(s)) continue; used.add(s); const loop = [s[0], s[1]]; let end = s[1]; let guard = 0; while (guard++ < 100000) { const cands = (map.get(key(end)) || []).filter((x) => !used.has(x)); if (!cands.length) break; const nx = cands[0]; used.add(nx); const next = key(nx[0]) === key(end) ? nx[1] : nx[0]; loop.push(next); end = next; if (key(end) === key(loop[0])) break; } if (loop.length > 3) { loop.pop(); loops.push(loop); } }
  return loops;
}
function offsetLoop(loop, d) { // inward for counter-clockwise outlines, by the miter of each corner
  const n = loop.length; const out = []; for (let i = 0; i < n; i++) { const a = loop[(i + n - 1) % n], b = loop[i], c = loop[(i + 1) % n]; let e1 = [b[0] - a[0], b[1] - a[1]], e2 = [c[0] - b[0], c[1] - b[1]]; const l1 = Math.hypot(...e1) || 1, l2 = Math.hypot(...e2) || 1; e1 = [e1[0] / l1, e1[1] / l1]; e2 = [e2[0] / l2, e2[1] / l2]; const n1 = [-e1[1], e1[0]], n2 = [-e2[1], e2[0]]; let nx = n1[0] + n2[0], ny = n1[1] + n2[1]; const nl = Math.hypot(nx, ny); if (nl < 1e-6) { nx = n1[0]; ny = n1[1]; } else { const k = 1 / (1 + (n1[0] * n2[0] + n1[1] * n2[1])) ; nx *= k; ny *= k; const lim = 2; const ml = Math.hypot(nx, ny); if (ml > lim) { nx = nx / ml * lim; ny = ny / ml * lim; } } out.push([b[0] + nx * d, b[1] + ny * d]); }
  return out;
}
function gcode(mesh, st, opts = {}) {
  const mat = MATERIALS[st.material]; const lh = st.layerHeight, lw = st.nozzle * 1.1; const fil = 1.75, filArea = Math.PI * (fil / 2) ** 2; const H = bbox(mesh).max[2]; const layers = Math.floor(H / lh); if (layers < 1) throw err(422, 'The part is thinner than one layer.'); if (layers > 2500) throw err(422, 'That is more than 2,500 layers. Use a taller layer height or slice it in your own slicer.');
  if (mesh.f.length / 3 > 200000) throw err(422, 'The model has too many triangles to slice here.');
  const t0 = Date.now(); const [bx, by] = st.bed; const cx = bx / 2, cy = by / 2; const lines = []; let E = 0, len = 0, travel = 0, secs = 0, filament = 0; let px = 0, py = 0; const preview = []; const keepEvery = Math.max(1, Math.floor(layers / 50));
  const g = (s) => lines.push(s); g(`; Dry Run G-code. Prototype slicer: check the result in your printer's own slicer for production prints.`); g(`; material ${mat.label}, layer ${lh} mm, infill ${st.infillPct}%, perimeters ${st.perimeters}, nozzle ${st.nozzle} mm`); g('G21'); g('G90'); g('M82'); g(`M140 S${mat.bed}`); g(`M104 S${mat.nozzle}`); g('G28'); g(`M190 S${mat.bed}`); g(`M109 S${mat.nozzle}`); g('G92 E0');
  const move = (x, y, z) => { const d = Math.hypot(x - px, y - py); travel += d; secs += d / 120; g(`G0 X${r3(x + cx)} Y${r3(y + cy)}${z !== undefined ? ' Z' + r3(z) : ''} F7200`); px = x; py = y; };
  const extrudeTo = (x, y, f) => { const d = Math.hypot(x - px, y - py); if (d < 1e-4) return; const e = d * lw * lh / filArea; E += e; len += d; filament += e; secs += d / (f / 60); g(`G1 X${r3(x + cx)} Y${r3(y + cy)} E${r3(E)} F${f}`); px = x; py = y; };
  for (let li = 0; li < layers; li++) {
    if (Date.now() - t0 > 8000) throw err(422, 'Slicing this part takes too long here. Use a taller layer height, or slice it in your own slicer.');
    const z = (li + 0.5) * lh; const zTop = (li + 1) * lh; g(`;LAYER ${li + 1}`); if (li === 0) g('G1 Z' + r3(lh) + ' F600'); else g(`G0 Z${r3(zTop)} F1200`);
    const loops = sliceLoops(mesh, z).map((l) => ({ l, a: signedArea(l) })).filter((x) => Math.abs(x.a) > 0.05); if (!loops.length) continue; const lay = []; const solid = li < st.solidLayers || li >= layers - st.solidLayers;
    const oriented = loops.map((x) => (x.a < 0 ? x.l.slice().reverse() : x.l)); // outer outlines run counter-clockwise; holes come out clockwise after this test below
    const outerFlags = loops.map((x, i) => { const probe = x.l[0]; let depth = 0; loops.forEach((y, j) => { if (j !== i && pointInPoly(probe, y.l)) depth++; }); return depth % 2 === 0; });
    const paths = []; loops.forEach((x, i) => { let loop = x.l.slice(); const isOuter = outerFlags[i]; if ((signedArea(loop) > 0) !== isOuter) loop.reverse(); let cur = loop; for (let p = 0; p < st.perimeters; p++) { const o = offsetLoop(cur, lw * (p === 0 ? 0.5 : 1)); const a0 = Math.abs(signedArea(cur)), a1 = Math.abs(signedArea(o)); if (p > 0 || true) { if ((isOuter && a1 > a0) || (!isOuter && a1 < a0) || a1 < 0.2) break; } paths.push(o); cur = o; } x.inner = cur; });
    void oriented;
    for (const pth of paths) { move(pth[0][0], pth[0][1]); for (let k = 1; k <= pth.length; k++) { const q = pth[k % pth.length]; extrudeTo(q[0], q[1], k <= pth.length && paths.indexOf(pth) === 0 ? 1500 : 2400); } lay.push(pth); }
    const spacing = solid ? lw : lw / Math.max(st.infillPct / 100, 0.01); if (solid || st.infillPct > 0) {
      const ang = (li % 2 ? 45 : -45) * DEG, ca = Math.cos(ang), sa = Math.sin(ang); const innerLoops = loops.map((x) => x.inner).filter(Boolean).map((l) => l.map(([x, y]) => [x * ca + y * sa, -x * sa + y * ca])); let minY = Infinity, maxY = -Infinity; for (const l of innerLoops) for (const p of l) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
      let flip = false; for (let y = minY + spacing / 2; y < maxY; y += spacing) { const xs = []; for (const l of innerLoops) for (let i = 0; i < l.length; i++) { const a = l[i], b = l[(i + 1) % l.length]; if ((a[1] <= y) !== (b[1] <= y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])); } xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2) { let x0 = xs[k] + lw * 0.25, x1 = xs[k + 1] - lw * 0.25; if (x1 - x0 < lw) continue; if (flip) [x0, x1] = [x1, x0]; const w0 = [x0 * ca - y * sa, x0 * sa + y * ca], w1 = [x1 * ca - y * sa, x1 * sa + y * ca]; move(w0[0], w0[1]); extrudeTo(w1[0], w1[1], solid ? 2400 : 3600); lay.push([w0, w1]); } flip = !flip; }
    }
    if (li % keepEvery === 0 && preview.length < 60) preview.push({ layer: li + 1, z: r3(zTop), paths: lay.slice(0, 400).map((pp) => pp.map((p) => [r3(p[0]), r3(p[1])])) });
  }
  g('G92 E0'); g('G1 E-2 F1800'); g(`G0 Z${r3(H + 10)} F1200`); g('M104 S0'); g('M140 S0'); g('M84'); g('; end');
  const grams = filament * filArea * mat.density / 1000; return { gcode: lines.join('\n') + '\n', layers, lines: lines.length, filamentMm: r3(filament), grams: r3(grams), cost: r3(grams / 1000 * mat.costPerKg), hours: r3(secs / 3600), extrudedMm: r3(len), travelMm: r3(travel), preview, bed: st.bed, size: extent(mesh).map(r3) };
}

module.exports = { capFace, wallFace, PARTS, types, cleanParams, buildPart, cleanSettings, MATERIALS, PRINTERS, DEFAULT_SETTINGS, printCheck, bestOrientation, estimate, plates, toSTL, toOBJ, gcode, stats, volume, area, watertight, merge, translate, rotate, bbox, extrude, revolve, triangulate, circle, rect, sliceLoops, ground };
