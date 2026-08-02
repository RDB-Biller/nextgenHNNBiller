'use strict';

const store = require('./../store');

/**
 * Payer price lists: an insurer's pre-approved prices for medicines and procedures.
 * Prices may vary by hospital/pharmacy, so each row can optionally target a provider
 * (tenantId or a facility name); rows with no provider are the payer's default price.
 *
 * Uploaded from the master console as CSV (or the rows an Excel/CSV parser produced).
 * Expected columns (case-insensitive, flexible order):
 *   code, name, price [, unit] [, provider] [, category]
 * `provider` may be a tenant id (e.g. tenant_euracare) or a free-text facility name.
 *
 * Stored keyed by payer, so lookups are fast and a re-upload replaces the set.
 */

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const norm = (s) => String(s || '').trim();
const key = (payerId) => `pricelist:${payerId}`;

// Very small, dependency-free CSV parser (handles quoted fields + commas/newlines).
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => norm(c) !== ''));
}

// Map header names to our canonical fields.
const HEADER_ALIASES = {
  code: ['code', 'itemcode', 'nhiscode', 'tariffcode', 'sku'],
  name: ['name', 'item', 'description', 'medicine', 'procedure', 'generic'],
  price: ['price', 'amount', 'approvedprice', 'tariff', 'rate', 'cost'],
  unit: ['unit', 'unitofpricing', 'uom'],
  provider: ['provider', 'facility', 'hospital', 'pharmacy', 'tenant', 'tenantid'],
  category: ['category', 'type', 'class'],
};

function resolveHeaders(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const hn = norm(h).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(hn)) idx[canon] = i;
    }
  });
  return idx;
}

/**
 * Parse CSV text into price rows. Returns { rows, errors, headers }.
 * A row needs at least a code OR name, and a numeric price.
 */
function parse(csvText) {
  const table = parseCsv(csvText);
  if (!table.length) return { rows: [], errors: ['empty file'], headers: {} };
  const idx = resolveHeaders(table[0]);
  if (idx.price == null || (idx.code == null && idx.name == null)) {
    return { rows: [], errors: ['could not find required columns (need price, and code or name)'], headers: idx };
  }
  const rows = [];
  const errors = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const code = idx.code != null ? norm(cells[idx.code]) : '';
    const name = idx.name != null ? norm(cells[idx.name]) : '';
    const priceRaw = idx.price != null ? norm(cells[idx.price]).replace(/[^0-9.]/g, '') : '';
    const price = parseFloat(priceRaw);
    if (!code && !name) { errors.push(`row ${r + 1}: no code or name`); continue; }
    if (Number.isNaN(price)) { errors.push(`row ${r + 1}: invalid price "${idx.price != null ? cells[idx.price] : ''}"`); continue; }
    rows.push({
      code: code || null,
      name: name || null,
      price: r2(price),
      unit: idx.unit != null ? norm(cells[idx.unit]) || null : null,
      provider: idx.provider != null ? norm(cells[idx.provider]) || null : null,
      category: idx.category != null ? norm(cells[idx.category]) || null : null,
    });
  }
  return { rows, errors, headers: idx };
}

/** Replace a payer's price list with the parsed rows. */
async function upload(payerId, csvText, { replace = true } = {}) {
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('payer_not_found'); e.status = 404; throw e; }
  const { rows, errors } = parse(csvText);
  if (!rows.length) { const e = new Error('no_valid_rows'); e.status = 422; e.detail = errors; throw e; }

  let existing = [];
  if (!replace) {
    const saved = await store.settings.get(key(payerId));
    existing = (saved && saved.rows) || [];
  }
  const record = {
    payerId,
    rows: [...existing, ...rows],
    count: existing.length + rows.length,
    uploadedAt: new Date().toISOString(),
    errors,
  };
  await store.settings.set(key(payerId), record);
  return { payerId, imported: rows.length, total: record.count, skipped: errors.length, errors: errors.slice(0, 20) };
}

async function get(payerId) {
  const saved = await store.settings.get(key(payerId));
  return saved || { payerId, rows: [], count: 0 };
}

async function clear(payerId) {
  await store.settings.set(key(payerId), { payerId, rows: [], count: 0, uploadedAt: new Date().toISOString() });
  return { cleared: true };
}

/**
 * Look up the pre-approved price for a code/name for a payer, honouring an optional
 * provider override (facility-specific price beats the payer default).
 */
async function priceFor(payerId, { code, name, provider } = {}) {
  const saved = await store.settings.get(key(payerId));
  const rows = (saved && saved.rows) || [];
  const c = norm(code).toLowerCase();
  const n = norm(name).toLowerCase();
  const p = norm(provider).toLowerCase();
  const matches = rows.filter((row) => (c && norm(row.code).toLowerCase() === c)
    || (n && norm(row.name).toLowerCase() === n));
  if (!matches.length) return null;
  // Prefer a provider-specific row, else the default (no provider).
  const specific = matches.find((row) => p && norm(row.provider).toLowerCase() === p);
  const dflt = matches.find((row) => !row.provider);
  const chosen = specific || dflt || matches[0];
  return { code: chosen.code, name: chosen.name, price: chosen.price, unit: chosen.unit,
    provider: chosen.provider || null, matchedBy: specific ? 'provider' : 'default' };
}

/** Search a payer's price list (for a preview table). */
async function search(payerId, q, limit = 50) {
  const saved = await store.settings.get(key(payerId));
  const rows = (saved && saved.rows) || [];
  const query = norm(q).toLowerCase();
  const out = query
    ? rows.filter((r) => norm(r.code).toLowerCase().includes(query) || norm(r.name).toLowerCase().includes(query))
    : rows;
  return out.slice(0, limit);
}

module.exports = { parse, upload, get, clear, priceFor, search };
