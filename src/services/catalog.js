'use strict';

/**
 * Chargeable catalog. Combines a small demo list with the full NHIS Medicines List
 * (2025, 550 formulations, official NHIA codes + tariff prices + prescribing level).
 * Each tenant/provider can still override prices per line item at bill time; this is
 * the shared reference catalog so coded items resolve to a name, price and NHIS level.
 */

let NHIS = [];
try {
  // eslint-disable-next-line global-require
  NHIS = require('../data/nhis-medicines.json');
} catch (e) {
  NHIS = [];
}

const DEMO_CATALOG = [
  { code: 'Coartem', name: 'Coartem', category: 'drug', price: 200 },
  { code: 'FBC', name: 'Full Blood Count', category: 'lab', price: 120 },
  { code: 'GP-CONSULT', name: 'GP Consultation', category: 'service', price: 100 },
];

// Normalise NHIS records into catalog items (code, name, category, price, unit, level).
const NHIS_CATALOG = NHIS.map((m) => ({
  code: m.code,
  name: m.name,
  category: m.category || 'drug',
  price: m.price == null ? null : Number(m.price),
  unit: m.unit || null,
  level: m.level || null,
  source: m.source || 'NHIS-ML-2025',
}));

const DEFAULT_CATALOG = [...DEMO_CATALOG, ...NHIS_CATALOG];

// Index by upper-cased code for O(1) lookup across 550+ items.
const BY_CODE = new Map();
for (const item of DEFAULT_CATALOG) {
  if (item.code) BY_CODE.set(String(item.code).toUpperCase(), item);
}

function findItem(key) {
  if (!key) return null;
  const k = String(key).trim();
  const byCode = BY_CODE.get(k.toUpperCase());
  if (byCode) return byCode;
  // fall back to a case-insensitive name match (demo items + exact names)
  const lower = k.toLowerCase();
  return DEFAULT_CATALOG.find((i) => i.name && i.name.toLowerCase() === lower) || null;
}

/**
 * Search the catalog by code or name substring. Returns up to `limit` matches,
 * code-prefix matches first, then name matches. For type-ahead in the biller UI.
 */
function search(query, { limit = 20, category = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return DEFAULT_CATALOG.slice(0, limit);
  const codeHits = [];
  const nameHits = [];
  for (const item of DEFAULT_CATALOG) {
    if (category && item.category !== category) continue;
    const code = (item.code || '').toLowerCase();
    const name = (item.name || '').toLowerCase();
    if (code.startsWith(q)) codeHits.push(item);
    else if (name.includes(q) || code.includes(q)) nameHits.push(item);
    if (codeHits.length >= limit) break;
  }
  return [...codeHits, ...nameHits].slice(0, limit);
}

function count() {
  return { total: DEFAULT_CATALOG.length, nhis: NHIS_CATALOG.length, demo: DEMO_CATALOG.length };
}

module.exports = { DEFAULT_CATALOG, findItem, search, count };
