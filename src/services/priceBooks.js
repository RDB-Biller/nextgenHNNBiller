'use strict';

/**
 * Price books. A price book is a named list of chargeable items (code, name, unit, category, price) in ONE currency.
 *  - "nhis-gh" is the official NHIS Medicines List (the original default; GHS).
 *  - The other built-in books (NHS England, US Medicare-style, private insurer schedules, Nigeria, Kenya, South Africa, India,
 *    Germany, self-pay) are ILLUSTRATIVE samples so people can see how different pricing structures look. They are labelled
 *    as such and are not official tariffs.
 *  - Anyone can upload their own book from a CSV (clinic level, or platform-wide from Master Control).
 * A clinic picks a default book; Master Control picks the platform default for clinics that have not chosen.
 * Bills are always made and settled in GHS: the biller converts a book's price to GHS (at the Master Control rate) when an item is added.
 */
const store = require('../store');
const catalog = require('./catalog');
const cur = require('./currencies');

const err = (status, message) => Object.assign(new Error(message), { status });
const iso = () => new Date().toISOString();
const DEFAULT_ID = 'nhis-gh';
const MAX_ROWS = 20000;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// ---- illustrative samples ---------------------------------------------------------------------------------------------
// Reference costs in US dollars for a common basket of services and medicines; each sample book scales them to its own market.
const BASKET = [
  ['CONSULT-GP', 'General practitioner consultation', 'service', 'visit', 14],
  ['CONSULT-SPEC', 'Specialist consultation', 'service', 'visit', 38],
  ['ANC-VISIT', 'Antenatal care visit', 'service', 'visit', 18],
  ['FBC', 'Full blood count', 'lab', 'test', 9],
  ['MALARIA-RDT', 'Malaria rapid diagnostic test', 'lab', 'test', 3],
  ['URINE-R', 'Urine routine examination', 'lab', 'test', 4],
  ['BLOOD-GLUC', 'Blood glucose', 'lab', 'test', 3],
  ['HIV-TEST', 'HIV screening test', 'lab', 'test', 5],
  ['LFT', 'Liver function tests', 'lab', 'panel', 16],
  ['XRAY-CHEST', 'Chest X-ray', 'imaging', 'study', 25],
  ['US-OBS', 'Obstetric ultrasound scan', 'imaging', 'scan', 22],
  ['US-ABD', 'Abdominal ultrasound scan', 'imaging', 'scan', 28],
  ['CT-HEAD', 'CT scan, head', 'imaging', 'scan', 140],
  ['ECG', 'Electrocardiogram', 'service', 'test', 12],
  ['DELIV-SVD', 'Normal delivery (spontaneous vaginal)', 'procedure', 'case', 160],
  ['DELIV-CS', 'Caesarean section', 'procedure', 'case', 520],
  ['APPEND', 'Appendicectomy', 'procedure', 'case', 450],
  ['BED-GEN', 'General ward bed, per day', 'service', 'day', 20],
  ['BED-PRIV', 'Private room, per day', 'service', 'day', 55],
  ['PARACET-500', 'Paracetamol tablet, 500 mg', 'drug', 'tablet', 0.03],
  ['AMOX-500', 'Amoxicillin capsule, 500 mg', 'drug', 'capsule', 0.09],
  ['COARTEM-80', 'Artemether/lumefantrine 80/480 mg (adult course)', 'drug', 'course', 2.2],
  ['METFORMIN-500', 'Metformin tablet, 500 mg', 'drug', 'tablet', 0.05],
  ['AMLODIPINE-5', 'Amlodipine tablet, 5 mg', 'drug', 'tablet', 0.06],
  ['ORS', 'Oral rehydration salts sachet', 'drug', 'sachet', 0.4],
  ['IV-SALINE-1L', 'Sodium chloride 0.9%, 1 litre infusion', 'drug', 'bag', 1.6],
  ['CEFTRIAXONE-1G', 'Ceftriaxone injection, 1 g', 'drug', 'vial', 1.8],
  ['FOLIC-5', 'Folic acid tablet, 5 mg', 'drug', 'tablet', 0.02],
  ['SP-IPT', 'Sulfadoxine/pyrimethamine tablet (IPTp)', 'drug', 'tablet', 0.15],
  ['DRESSING', 'Wound dressing and suturing', 'procedure', 'episode', 12],
];
const SAMPLES = [
  { id: 'nhs-uk', name: 'NHS England (illustrative tariff)', region: 'United Kingdom', currency: 'GBP', factor: 2.6, kind: 'public', note: 'Sample prices in the style of an NHS national tariff.' },
  { id: 'us-medicare', name: 'US Medicare-style fee schedule (illustrative)', region: 'United States', currency: 'USD', factor: 3.4, kind: 'public', note: 'Sample prices in the style of a Medicare fee schedule.' },
  { id: 'private-gh-standard', name: 'Private insurer, standard schedule (Ghana, illustrative)', region: 'Ghana', currency: 'GHS', factor: 1.0, kind: 'private', note: 'Sample private-insurance schedule for Ghanaian clinics.' },
  { id: 'private-gh-premium', name: 'Private insurer, premium / international plan (Ghana, illustrative)', region: 'Ghana', currency: 'GHS', factor: 1.9, kind: 'private', note: 'Sample premium schedule, higher than the standard plan.' },
  { id: 'private-uk', name: 'Private medical insurance (UK, illustrative)', region: 'United Kingdom', currency: 'GBP', factor: 4.2, kind: 'private', note: 'Sample private-insurance schedule in pounds.' },
  { id: 'self-pay-gh', name: 'Self-pay (cash) price list (Ghana, illustrative)', region: 'Ghana', currency: 'GHS', factor: 1.25, kind: 'cash', note: 'Sample walk-in cash prices.' },
  { id: 'ng-nhia', name: 'Nigeria health insurance schedule (illustrative)', region: 'Nigeria', currency: 'NGN', factor: 0.9, kind: 'public', note: 'Sample prices in naira.' },
  { id: 'ke-sha', name: 'Kenya social health schedule (illustrative)', region: 'Kenya', currency: 'KES', factor: 0.95, kind: 'public', note: 'Sample prices in Kenyan shillings.' },
  { id: 'za-private', name: 'South Africa private tariff (illustrative)', region: 'South Africa', currency: 'ZAR', factor: 2.2, kind: 'private', note: 'Sample prices in rand.' },
  { id: 'in-cghs', name: 'India government scheme rates (illustrative)', region: 'India', currency: 'INR', factor: 0.55, kind: 'public', note: 'Sample prices in rupees.' },
  { id: 'de-statutory', name: 'Germany statutory insurance (illustrative)', region: 'Germany', currency: 'EUR', factor: 3.0, kind: 'public', note: 'Sample prices in euros.' },
];
function round(v, dec) { const m = 10 ** dec; return Math.round(v * m) / m; }
function sampleItems(s) {
  const meta = cur.get(s.currency) || { decimals: 2 }; const rate = cur.SEED[s.currency] || 1;
  return BASKET.map(([code, name, category, unit, usd]) => {
    const raw = usd * s.factor * rate; const price = round(raw, raw < 1 ? 3 : meta.decimals);
    return { code, name, category, unit, price: price || round(raw, 4), level: null, source: s.id };
  });
}
const BUILTIN = new Map();
BUILTIN.set(DEFAULT_ID, { id: DEFAULT_ID, name: 'NHIS Medicines List 2025 (Ghana, official)', region: 'Ghana', currency: 'GHS', kind: 'public', official: true, builtin: true, note: 'The official NHIA medicines tariff: 550 formulations with codes and prescribing level.', items: catalog.DEFAULT_CATALOG });
for (const s of SAMPLES) BUILTIN.set(s.id, { id: s.id, name: s.name, region: s.region, currency: s.currency, kind: s.kind, official: false, builtin: true, note: `${s.note} Illustrative sample for demonstration: not an official tariff. Upload your own CSV for real prices.`, items: sampleItems(s) });

// ---- storage ------------------------------------------------------------------------------------------------------------
const customKey = (scope, id) => `pricebook:custom:${scope}:${id}`; // scope: 'platform' or a tenant id
const PLATFORM_CFG = 'pricebook:platform'; // { defaultId, disabled: [] }
const tenantCfgKey = (t) => `pricebook:tenant:${t}`; // { defaultId, followCurrency }
async function platformCfg() { const c = (await store.settings.get(PLATFORM_CFG)) || {}; return { defaultId: c.defaultId || DEFAULT_ID, disabled: Array.isArray(c.disabled) ? c.disabled : [] }; }
async function customBooks(scope) { const out = []; for (const k of await store.settings.keys(`pricebook:custom:${scope}:`)) { const b = await store.settings.get(k); if (b) out.push(b); } return out; }

const brief = (b, extra = {}) => ({ id: b.id, name: b.name, region: b.region || '', currency: b.currency, kind: b.kind || 'custom', official: !!b.official, builtin: !!b.builtin, scope: b.scope || 'builtin', itemCount: b.items.length, note: b.note || '', updatedAt: b.updatedAt || null, ...extra });

/** Books a clinic can use: built-in (unless Master Control switched one off), platform uploads, then the clinic's own. */
async function available(tenantId) {
  const pc = await platformCfg(); const off = new Set(pc.disabled);
  const list = [...BUILTIN.values()].filter((b) => b.id === DEFAULT_ID || !off.has(b.id));
  const plat = (await customBooks('platform')).filter((b) => !off.has(b.id));
  const own = tenantId ? await customBooks(tenantId) : [];
  return [...list, ...plat.map((b) => ({ ...b, scope: 'platform' })), ...own.map((b) => ({ ...b, scope: 'clinic' }))];
}
async function resolveDefaultId(tenantId) {
  const pc = await platformCfg(); const own = tenantId ? await store.settings.get(tenantCfgKey(tenantId)) : null;
  const all = await available(tenantId); const has = (id) => id && all.some((b) => b.id === id);
  return has(own && own.defaultId) ? own.defaultId : has(pc.defaultId) ? pc.defaultId : DEFAULT_ID;
}
async function get(tenantId, id) { const all = await available(tenantId); return all.find((b) => b.id === id) || null; }

/** For the biller screen: the books, the one in force, and where that choice came from. */
async function summary(tenantId) {
  const all = await available(tenantId); const pc = await platformCfg(); const own = tenantId ? await store.settings.get(tenantCfgKey(tenantId)) : null;
  const defaultId = await resolveDefaultId(tenantId);
  return { defaultId, source: own && own.defaultId === defaultId ? 'clinic' : pc.defaultId === defaultId ? 'platform' : 'built-in', platformDefaultId: pc.defaultId, followCurrency: own ? own.followCurrency !== false : true, books: all.map((b) => brief(b, { isDefault: b.id === defaultId })) };
}
async function setTenantDefault(tenantId, { bookId, followCurrency } = {}) {
  const cfg = (await store.settings.get(tenantCfgKey(tenantId))) || {};
  if (bookId !== undefined) { if (bookId !== null && !(await get(tenantId, bookId))) throw err(404, 'That price book is not available.'); cfg.defaultId = bookId || null; }
  if (followCurrency !== undefined) cfg.followCurrency = !!followCurrency;
  cfg.updatedAt = iso(); await store.settings.set(tenantCfgKey(tenantId), cfg); return summary(tenantId);
}

function search(book, query, { limit = 25, category = null } = {}) {
  const q = String(query || '').trim().toLowerCase(); const items = book.items; const out = [];
  if (!q) return items.filter((i) => !category || i.category === category).slice(0, limit);
  const codeHits = []; const nameHits = [];
  for (const item of items) {
    if (category && item.category !== category) continue;
    const code = String(item.code || '').toLowerCase(); const name = String(item.name || '').toLowerCase();
    if (code.startsWith(q)) codeHits.push(item); else if (name.includes(q) || code.includes(q)) nameHits.push(item);
    if (codeHits.length >= limit) break;
  }
  return out.concat(codeHits, nameHits).slice(0, limit);
}

// ---- CSV upload ---------------------------------------------------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false; const s = String(text || '').replace(/^﻿/, '');
  const delim = (s.split('\n')[0].match(/;/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? ';' : (s.split('\n')[0].match(/\t/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}
const HEAD = { code: ['code', 'item code', 'sku', 'id'], name: ['name', 'item', 'description', 'item name', 'service'], price: ['price', 'cost', 'tariff', 'amount', 'rate', 'unit price'], unit: ['unit', 'uom', 'pack'], category: ['category', 'type', 'group'], level: ['level', 'tier'] };
function mapHeader(row) { const idx = {}; row.forEach((h, i) => { const k = String(h).trim().toLowerCase(); for (const [f, names] of Object.entries(HEAD)) if (idx[f] === undefined && names.includes(k)) idx[f] = i; }); return idx; }
function itemsFromCsv(text) {
  const rows = parseCsv(text); if (rows.length < 2) throw err(422, 'The file needs a header row and at least one item.');
  const idx = mapHeader(rows[0]);
  if (idx.name === undefined || idx.price === undefined) throw err(422, 'The first row must have columns named "name" and "price" (optional: code, unit, category, level).');
  if (rows.length - 1 > MAX_ROWS) throw err(413, `Too many rows: the limit is ${MAX_ROWS}.`);
  const items = []; const skipped = []; const seen = new Set();
  rows.slice(1).forEach((r, n) => {
    const name = String(r[idx.name] || '').trim(); const raw = String(r[idx.price] == null ? '' : r[idx.price]).replace(/[^\d.,-]/g, '');
    const priceStr = raw.includes(',') && !raw.includes('.') && /,\d{1,2}$/.test(raw) ? raw.replace(',', '.') : raw.replace(/,/g, '');
    const price = priceStr === '' ? NaN : Number(priceStr);
    if (!name || !isFinite(price) || price < 0) { skipped.push({ row: n + 2, reason: !name ? 'no name' : 'price is not a number' }); return; }
    let code = idx.code !== undefined ? String(r[idx.code] || '').trim() : ''; if (!code) code = `ITEM-${n + 1}`;
    if (seen.has(code.toUpperCase())) { skipped.push({ row: n + 2, reason: `duplicate code ${code}` }); return; } seen.add(code.toUpperCase());
    items.push({ code: code.slice(0, 40), name: name.slice(0, 200), category: idx.category !== undefined ? String(r[idx.category] || '').trim().toLowerCase().slice(0, 30) || 'service' : 'service', unit: idx.unit !== undefined ? String(r[idx.unit] || '').trim().slice(0, 30) || null : null, level: idx.level !== undefined ? String(r[idx.level] || '').trim().slice(0, 10) || null : null, price: Math.round(price * 10000) / 10000, source: 'upload' });
  });
  if (!items.length) throw err(422, 'No usable rows found. Check the column names and that prices are numbers.');
  return { items, skipped };
}
/** Save an uploaded book. scope is 'platform' (Master Control) or a tenant id (a clinic's own). */
async function upload(scope, { name, currency, csv, region, replaceId } = {}) {
  const n = String(name || '').trim().slice(0, 80); if (!n) throw err(422, 'Give the price book a name.');
  const c = cur.norm(currency || 'GHS'); if (!cur.isKnown(c)) throw err(422, 'Choose the currency the prices are in.');
  const { items, skipped } = itemsFromCsv(csv);
  const id = replaceId || `${scope === 'platform' ? 'pf' : 'cl'}-${slug(n) || 'book'}-${Date.now().toString(36)}`;
  if (replaceId && !(await store.settings.get(customKey(scope, replaceId)))) throw err(404, 'That price book was not found.');
  const book = { id, name: n, region: String(region || '').trim().slice(0, 60), currency: c, kind: 'custom', official: false, scope: scope === 'platform' ? 'platform' : 'clinic', note: 'Uploaded price list.', items, updatedAt: iso() };
  await store.settings.set(customKey(scope, id), book);
  return { book: brief(book), imported: items.length, skipped: skipped.slice(0, 50), skippedCount: skipped.length };
}
async function remove(scope, id) {
  if (!(await store.settings.get(customKey(scope, id)))) throw err(404, 'That price book was not found, or it is built in and cannot be deleted.');
  await store.settings.set(customKey(scope, id), null);
  const pc = await platformCfg(); if (scope === 'platform' && pc.defaultId === id) await store.settings.set(PLATFORM_CFG, { ...pc, defaultId: DEFAULT_ID });
  if (scope !== 'platform') { const t = await store.settings.get(tenantCfgKey(scope)); if (t && t.defaultId === id) await store.settings.set(tenantCfgKey(scope), { ...t, defaultId: null }); }
  return { deleted: id };
}

// ---- Master Control -------------------------------------------------------------------------------------------------------
async function adminView() {
  const pc = await platformCfg(); const off = new Set(pc.disabled);
  const plat = (await customBooks('platform')).map((b) => ({ ...b, scope: 'platform' }));
  return { defaultId: pc.defaultId, books: [...BUILTIN.values(), ...plat].map((b) => brief(b, { isDefault: b.id === pc.defaultId, enabled: b.id === DEFAULT_ID || !off.has(b.id) })), currencies: cur.CURRENCIES.map((c) => ({ code: c.code, name: c.name })) };
}
async function adminSet({ defaultId, disabled } = {}) {
  const pc = await platformCfg(); const known = new Set([...BUILTIN.keys(), ...(await customBooks('platform')).map((b) => b.id)]);
  if (disabled !== undefined) { if (!Array.isArray(disabled)) throw err(422, 'disabled must be a list.'); pc.disabled = disabled.filter((id) => known.has(id) && id !== DEFAULT_ID); }
  if (defaultId !== undefined) { if (!known.has(defaultId)) throw err(404, 'Unknown price book.'); if (pc.disabled.includes(defaultId)) throw err(422, 'Switch that book on before making it the default.'); pc.defaultId = defaultId; }
  await store.settings.set(PLATFORM_CFG, pc); return adminView();
}
function sampleCsv() { return 'code,name,unit,category,price\nCONSULT-GP,General consultation,visit,service,50\nFBC,Full blood count,test,lab,40\nPARACET-500,Paracetamol 500 mg,tablet,drug,0.30\n'; }

module.exports = { DEFAULT_ID, BUILTIN, available, get, summary, resolveDefaultId, setTenantDefault, search, upload, remove, adminView, adminSet, itemsFromCsv, sampleCsv };
