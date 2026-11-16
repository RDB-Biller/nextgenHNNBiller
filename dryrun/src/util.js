'use strict';
const crypto = require('crypto');
const err = (status, message) => Object.assign(new Error(message), { status });
const iso = () => new Date().toISOString();
const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newKey = (p) => `${p}_${crypto.randomBytes(18).toString('hex')}`;
// Seeded PRNG so every run can be repeated exactly.
function rng(seed) { let a = (Number(seed) || 1) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Small CSV parser: quotes, commas, newlines. First row is the header.
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false; const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
module.exports = { err, iso, id, sha, newKey, rng, median, round, wrap, parseCsv };
