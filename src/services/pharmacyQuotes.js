'use strict';

const crypto = require('crypto');
const store = require('../store');

/**
 * Prospective pharmacy pricing: quotations a pharmacy SUBMITS (price list
 * uploaded as CSV/XLSX by HNN staff) before any billing exists, so comparison
 * works from day one. They sit next to -- never mixed into -- the claims-based
 * prices HNN observes on real bills (services/pharmacyPricing.js), and every
 * comparison row says which kind of price it is. As bills accumulate the same
 * pharmacy/item shows both numbers and a variance, which is how "does this
 * pharmacy actually charge what it quoted?" gets answered over time.
 *
 * A quote is append-only: a newer upload for the same pharmacy+item supersedes
 * the older one for comparison, but history stays and an upload can be removed
 * whole. A quote expires after its own validUntil, and comparisons also ignore
 * quotes older than a caller-set age so stale lists don't pose as current.
 */

const norm = (s) => String(s || '').trim().toLowerCase();
const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const err = (status, message, detail) => { const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e; };
const MAX_ROWS = 20000;
const MAX_PRICE = 1000000;

const ALIASES = {
  pharmacy: ['pharmacy', 'pharmacy name', 'outlet', 'facility', 'supplier', 'vendor'],
  name: ['item', 'item name', 'name', 'drug', 'drug name', 'medicine', 'medicine name', 'product', 'description', 'medication'],
  code: ['code', 'item code', 'drug code', 'sku', 'nhis code', 'product code'],
  price: ['price', 'unit price', 'cost', 'amount', 'quoted price', 'selling price', 'price ghs', 'unit cost'],
  unit: ['unit', 'pack', 'pack size', 'uom', 'form'],
};

/** CSV text -> array of rows (arrays). Handles quotes, BOM, CRLF and comma/semicolon/tab delimiters. */
function parseCsv(text) {
  const t = String(text || '').replace(/^﻿/, '');
  const first = t.split(/\r?\n/, 1)[0] || '';
  const count = (c) => (first.match(new RegExp(`\\${c}`, 'g')) || []).length;
  const delim = [['\t', count('\t')], [';', count(';')], [',', count(',')]].sort((a, b) => b[1] - a[1])[0];
  const d = delim[1] ? delim[0] : ',';
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

function parsePrice(raw) {
  let s = String(raw ?? '').replace(/[^\d.,-]/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  return Number(s);
}

function mapColumns(header) {
  const h = header.map(norm);
  const find = (aliases) => h.findIndex((x) => aliases.includes(x));
  return { pharmacy: find(ALIASES.pharmacy), name: find(ALIASES.name), code: find(ALIASES.code), price: find(ALIASES.price), unit: find(ALIASES.unit) };
}

/** table: array of row arrays (first row = header, or headerless "item,price"). Returns { quotes, rejected, columns }. */
function readTable(table, { defaultPharmacy } = {}) {
  if (!Array.isArray(table) || !table.length) throw err(422, 'empty_file');
  if (table.length - 1 > MAX_ROWS) throw err(422, `too_many_rows_max_${MAX_ROWS}`);
  let cols = mapColumns(table[0]);
  let start = 1;
  if (cols.price < 0 || (cols.name < 0 && cols.code < 0)) {
    // No recognisable header: treat as item,price (2 columns) or pharmacy,item,price (3).
    const w = table[0].length;
    if (w === 2) cols = { pharmacy: -1, name: 0, code: -1, price: 1, unit: -1 };
    else if (w >= 3 && !defaultPharmacy) cols = { pharmacy: 0, name: 1, code: -1, price: 2, unit: -1 };
    else throw err(422, 'unrecognised_columns', 'need a header row with an item/drug column and a price column (see the template)');
    start = 0;
  }
  const out = []; const rejected = [];
  for (let i = start; i < table.length; i++) {
    const r = table[i]; const line = i + 1;
    const get = (k) => (cols[k] >= 0 ? String(r[cols[k]] ?? '').trim() : '');
    const name = get('name'); const code = get('code'); const pharmacy = get('pharmacy') || defaultPharmacy || '';
    const price = parsePrice(get('price'));
    if (!name && !code) { rejected.push({ line, reason: 'no_item' }); continue; }
    if (!pharmacy) { rejected.push({ line, reason: 'no_pharmacy' }); continue; }
    if (!Number.isFinite(price) || price <= 0 || price > MAX_PRICE) { rejected.push({ line, reason: 'invalid_price', value: get('price') }); continue; }
    out.push({ pharmacyName: pharmacy, itemName: name || code, itemCode: code || null, unit: get('unit') || null, unitPrice: Math.round(price * 100) / 100 });
  }
  return { quotes: out, rejected, columns: cols };
}

async function importQuotes({ pharmacyName, tenantId, csv, table, validFrom, validUntil, label, by } = {}) {
  let tenant = null;
  if (tenantId) {
    tenant = await store.tenants.get(tenantId);
    if (!tenant) throw err(404, 'tenant_not_found');
  }
  const defaultPharmacy = String(pharmacyName || tenant?.name || '').trim();
  const t = table || (csv != null ? parseCsv(csv) : null);
  const { quotes, rejected } = readTable(t, { defaultPharmacy });
  if (!quotes.length) throw err(422, 'no_valid_rows', rejected.slice(0, 3).map((r) => `line ${r.line}: ${r.reason}`).join('; '));
  const vf = validFrom ? new Date(validFrom) : new Date();
  const vu = validUntil ? new Date(validUntil) : null;
  if (Number.isNaN(vf.getTime()) || (vu && Number.isNaN(vu.getTime()))) throw err(422, 'invalid_date');
  if (vu && vu < vf) throw err(422, 'validUntil_before_validFrom');

  // Within one upload the last row for a pharmacy+item wins.
  const dedup = new Map();
  for (const q of quotes) dedup.set(`${norm(q.pharmacyName)}|${norm(q.itemCode) || norm(q.itemName)}`, q);
  const uploadId = id('pqu');
  const now = new Date().toISOString();
  for (const q of dedup.values()) {
    await store.pharmacyQuotes.insert({
      id: id('pq'), uploadId, ...q,
      tenantId: tenantId || null, currency: 'GHS',
      validFrom: vf.toISOString(), validUntil: vu ? vu.toISOString() : null,
      label: label ? String(label).slice(0, 80) : null, createdAt: now, createdBy: by || null,
    });
  }
  return { uploadId, accepted: dedup.size, duplicatesInFile: quotes.length - dedup.size, rejected: rejected.slice(0, 50), rejectedCount: rejected.length };
}

async function listUploads() {
  const all = await store.pharmacyQuotes.all();
  const by = new Map();
  for (const q of all) {
    const u = by.get(q.uploadId) || { uploadId: q.uploadId, pharmacies: new Set(), items: 0, createdAt: q.createdAt, validFrom: q.validFrom, validUntil: q.validUntil, label: q.label, tenantId: q.tenantId };
    u.pharmacies.add(q.pharmacyName); u.items++;
    by.set(q.uploadId, u);
  }
  return [...by.values()].map((u) => ({ ...u, pharmacies: [...u.pharmacies] })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function deleteUpload(uploadId) {
  const n = await store.pharmacyQuotes.deleteByUpload(uploadId);
  if (!n) throw err(404, 'upload_not_found');
  return { deleted: n };
}

/** Pharmacy identity: a linked tenant id, else the same name as a classified pharmacy tenant, else the quoted name itself. */
async function currentQuotes({ maxAgeDays = 180, now = Date.now() } = {}) {
  const all = await store.pharmacyQuotes.all();
  const tenants = (await store.tenants.all()).filter((t) => t.facilityType === 'pharmacy');
  const byName = new Map(tenants.map((t) => [norm(t.name), t]));
  const latest = new Map();
  for (const q of all) {
    const from = new Date(q.validFrom).getTime();
    if (from > now) continue; // not valid yet
    if (q.validUntil && new Date(q.validUntil).getTime() < now) continue; // expired
    if (maxAgeDays && now - new Date(q.createdAt).getTime() > maxAgeDays * 86400000) continue;
    const tenant = (q.tenantId && tenants.find((t) => t.id === q.tenantId)) || byName.get(norm(q.pharmacyName)) || null;
    const key = tenant ? tenant.id : `q:${norm(q.pharmacyName)}`;
    const item = norm(q.itemCode) || norm(q.itemName);
    const k = `${key}|${item}`;
    const prev = latest.get(k);
    if (!prev || String(q.createdAt) > String(prev.createdAt)) {
      latest.set(k, { ...q, key, tenantId: tenant ? tenant.id : null, pharmacyName: tenant ? tenant.name : q.pharmacyName,
        ageDays: Math.floor((now - new Date(q.createdAt).getTime()) / 86400000) });
    }
  }
  return [...latest.values()];
}

/** Current quotes matching one medicine by code or name. */
async function forItem({ code, name, maxAgeDays } = {}) {
  const c = norm(code); const n = norm(name);
  return (await currentQuotes({ maxAgeDays })).filter((q) => (c && (norm(q.itemCode) === c || norm(q.itemName) === c)) || (n && (norm(q.itemName) === n || norm(q.itemCode) === n)));
}

async function summary() {
  const cur = await currentQuotes({ maxAgeDays: 0 });
  const by = new Map();
  for (const q of cur) {
    const p = by.get(q.key) || { key: q.key, pharmacyName: q.pharmacyName, linkedTenantId: q.tenantId, items: 0, lastUploaded: q.createdAt };
    p.items++; if (String(q.createdAt) > String(p.lastUploaded)) p.lastUploaded = q.createdAt;
    by.set(q.key, p);
  }
  return [...by.values()].sort((a, b) => a.pharmacyName.localeCompare(b.pharmacyName));
}

const TEMPLATE = 'pharmacy,item,code,unit_price,unit\nAlpha Pharmacy,Amoxicillin 500mg caps,AMOX500,2.50,capsule\nAlpha Pharmacy,Paracetamol 500mg tabs,PARA500,0.40,tablet\n';

module.exports = { parseCsv, parsePrice, readTable, importQuotes, listUploads, deleteUpload, currentQuotes, forItem, summary, TEMPLATE, MAX_ROWS };
