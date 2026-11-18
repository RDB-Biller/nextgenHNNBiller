'use strict';
/** A small, dependency-free reader for the first sheet of an .xlsx file, and for CSV text. Returns rows of cell text. */
const zlib = require('zlib');
const { err } = require('./util');

function unzip(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--; if (e < 0) throw err(422, 'That does not look like an .xlsx file. Save it as .xlsx or .csv and try again.');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const files = {};
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8'); p += 46 + nlen + xlen + clen;
    if (!/^xl\/(sharedStrings\.xml|workbook\.xml|worksheets\/sheet\d+\.xml)$/.test(name)) continue;
    const lh = off; const l2 = 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28); const data = buf.slice(lh + l2, lh + l2 + csize);
    files[name] = method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data, { maxOutputLength: 20 * 1024 * 1024 }).toString('utf8');
  }
  return files;
}
const dec = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c)).replace(/&amp;/g, '&');
const colIdx = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function xlsxRows(buf) {
  const f = unzip(buf); const sheetName = Object.keys(f).filter((k) => k.startsWith('xl/worksheets/')).sort()[0]; if (!sheetName) throw err(422, 'No sheet found in that file.');
  const shared = []; if (f['xl/sharedStrings.xml']) for (const si of f['xl/sharedStrings.xml'].matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(dec([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
  const rows = [];
  for (const rm of f[sheetName].matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || ''; const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1]; if (!ref) continue; const t = (attrs.match(/\bt="(\w+)"/) || [])[1]; let v = '';
      const vm = body.match(/<v>([\s\S]*?)<\/v>/); if (t === 's' && vm) v = shared[Number(vm[1])] || ''; else if (t === 'inlineStr') v = dec([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')); else if (vm) v = dec(vm[1]);
      row[colIdx(ref)] = String(v).trim();
    }
    rows.push(Array.from(row, (x) => x || ''));
    if (rows.length > 2000) break;
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}
function csvRows(text) {
  const out = []; let row = [], cur = '', q = false; const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) { const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur.trim()); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur.trim()); out.push(row); row = []; cur = ''; if (out.length > 2000) break; } else cur += c; }
  row.push(cur.trim()); out.push(row); return out.filter((r) => r.some((c) => c !== ''));
}
const norm = (k) => String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
/** Rows -> assumptions. Column A = what, B = value, C = unit (optional), D = note (optional). A header row is skipped. */
function toAssumptions(rows) {
  const out = []; for (const r of rows) { const key = norm(r[0] || ''); if (!key || /^(key|assumption|assumptions|item|name|parameter|factor)$/.test(key)) continue; const raw = String(r[1] ?? '').trim(); if (raw === '') continue;
    const n = Number(raw.replace(/[%,\s]/g, '')); out.push({ key, value: raw !== '' && Number.isFinite(n) && /^[-+]?[\d.,\s]+%?$/.test(raw) ? n : raw, unit: r[2] || '', note: r[3] || '' }); if (out.length >= 300) break; }
  return out;
}
module.exports = { xlsxRows, csvRows, toAssumptions, norm };
