'use strict';
/**
 * Assets are the things an organisation rehearses with: products, price books, rule sets, campaigns, value-added services,
 * payment plans, and datasets. Every change makes a new version; nothing is overwritten. Each version moves through gates:
 * draft -> dry_run -> shadow -> approved. Only an approver (or admin) can approve, and only approved versions can be exported.
 */
const orgs = require('./orgs');
const plans = require('./plans');
const audit = require('./audit');
const regulatory = require('./regulatory');
const { err, iso, id, sha, parseCsv } = require('./util');

const KINDS = ['product', 'price_book', 'rule_set', 'campaign', 'vas', 'payment_plan', 'customer_dataset', 'claims_dataset', 'finance_offer', 'outcomes_programme'];
const GATES = ['draft', 'dry_run', 'shadow', 'approved'];
const DATASET = new Set(['customer_dataset', 'claims_dataset']);
const adapter = (orgId) => audit.adapter(orgId);

function validate(kind, data) {
  if (!KINDS.includes(kind)) throw err(422, `kind must be one of ${KINDS.join(', ')}.`);
  if (!data || typeof data !== 'object') throw err(422, 'data must be an object.');
  if (kind === 'price_book' && !Array.isArray(data.items)) throw err(422, 'A price book needs an items list.');
  if (kind === 'rule_set' && !Array.isArray(data.rules)) throw err(422, 'A rule set needs a rules list.');
  if (kind === 'claims_dataset' && !Array.isArray(data.claims)) throw err(422, 'A claims dataset needs a claims list.');
  if (kind === 'customer_dataset' && !Array.isArray(data.customers)) throw err(422, 'A customer dataset needs a customers list.');
  if (kind === 'outcomes_programme' && !(data.condition && Array.isArray(data.bands) && data.bands.length)) throw err(422, 'An outcomes programme needs a condition and pay bands.');
  if (kind === 'finance_offer' && !(data.premiumOverdraft || data.coverCash)) throw err(422, 'A finance offer needs a premiumOverdraft or a coverCash section.');
  if (kind === 'payment_plan' && !Array.isArray(data.tiers)) throw err(422, 'A payment plan needs a tiers list.');
}
const rowsOf = (kind, d) => (kind === 'claims_dataset' ? d.claims.length : kind === 'customer_dataset' ? d.customers.length : kind === 'price_book' ? d.items.length : 0);
const brief = (a) => { const last = a.versions[a.versions.length - 1]; return { classification: last.classification ? last.classification.overall : null, id: a.id, kind: a.kind, name: a.name, card: a.card, latest: last.v, latestGate: last.gate, approvedVersion: a.versions.filter((v) => v.gate === 'approved').map((v) => v.v).pop() || null, versions: a.versions.length, rows: last.rows, updatedAt: last.at }; };

/** For a product, compare a new version with the approved one (or the latest) and record which changes need the regulator. */
function classifyVersion(o, a, data) {
  if (a.kind !== 'product') return null;
  const prev = [...a.versions].reverse().find((v) => v.gate === 'approved') || a.versions[a.versions.length - 1];
  return regulatory.classify(prev ? prev.data : null, data, o.regulatoryRules);
}
async function create(orgId, actor, { kind, name, description = '', tags = [], data, note = 'First version' } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o);
  if (!name) throw err(422, 'name is required.'); validate(kind, data);
  const ad = adapter(orgId); const all = await ad.list(orgId, 'assets');
  plans.assertRoom(o, 'assets', all.length);
  const rows = rowsOf(kind, data); if (rows && (DATASET.has(kind) || kind === 'price_book')) plans.assertRoom(o, 'datasetRows', rows - 1);
  const a = { id: id('ast'), kind, name, card: { description, tags, owner: actor ? actor.name : 'platform owner', createdAt: iso() },
    versions: [{ v: 1, at: iso(), by: actor ? actor.name : 'platform owner', note, gate: 'draft', gateLog: [], rows, data, classification: kind === 'product' ? regulatory.classify(null, data, o.regulatoryRules) : null }] };
  await ad.put(orgId, 'assets', a.id, a);
  await audit.log(orgId, actor, 'asset.create', { assetId: a.id, kind, name, rows });
  return brief(a);
}
async function addVersion(orgId, actor, assetId, { data, note = '' } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o);
  const a = await load(orgId, assetId); validate(a.kind, data);
  const rows = rowsOf(a.kind, data); if (rows) plans.assertRoom(o, 'datasetRows', rows - 1);
  const v = { v: a.versions.length + 1, at: iso(), by: actor ? actor.name : 'platform owner', note, gate: 'draft', gateLog: [], rows, data, classification: classifyVersion(o, a, data) };
  a.versions.push(v); await adapter(orgId).put(orgId, 'assets', a.id, a);
  await audit.log(orgId, actor, 'asset.version', { assetId, version: v.v, note }); return brief(a);
}
async function load(orgId, assetId) { const a = await adapter(orgId).get(orgId, 'assets', assetId); if (!a) throw err(404, 'Unknown asset.'); return a; }
async function list(orgId, kind) { return (await adapter(orgId).list(orgId, 'assets')).filter((a) => !kind || a.kind === kind).map(brief).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)); }
async function detail(orgId, assetId, { withData = false } = {}) {
  const a = await load(orgId, assetId);
  return { ...brief(a), versionList: a.versions.map((v) => ({ classification: v.classification || null, regulator: v.regulator || null, v: v.v, at: v.at, by: v.by, note: v.note, gate: v.gate, gateLog: v.gateLog, rows: v.rows, ...(withData ? { data: v.data } : { preview: preview(a.kind, v.data) }) })) };
}
function preview(kind, d) { if (kind === 'claims_dataset') return d.claims.slice(0, 5); if (kind === 'customer_dataset') return d.customers.slice(0, 5); if (kind === 'price_book') return d.items.slice(0, 8); return d; }
async function versionData(orgId, assetId, version) {
  const a = await load(orgId, assetId); const v = version ? a.versions.find((x) => x.v === Number(version)) : a.versions[a.versions.length - 1];
  if (!v) throw err(404, 'Unknown version.'); return { asset: a, version: v };
}
/** Move a version between gates. Any builder can move it up to shadow or back to draft; only an approver or admin can approve. */
async function promote(orgId, actor, role, assetId, version, to, note = '') {
  const o = orgs.raw(orgId); plans.assertWritable(o);
  if (!GATES.includes(to)) throw err(422, `gate must be one of ${GATES.join(', ')}.`);
  const { asset, version: v } = await versionData(orgId, assetId, version);
  if (to === 'approved' && !orgs.can(role, 'approve')) throw err(403, 'Only an approver or admin can approve a version.');
  if (to === 'approved' && v.classification && v.classification.overall === 'regulator' && !v.regulator) throw err(409, 'This version changes things that need regulator approval. Record the regulator reference first, then approve.');
  if (!orgs.can(role, 'promote')) throw err(403, 'Your role cannot move versions between gates.');
  const from = GATES.indexOf(v.gate), target = GATES.indexOf(to);
  if (target > from + 1) throw err(422, `A version moves one gate at a time: ${v.gate} -> ${GATES[from + 1]}.`);
  if (v.gate === 'approved' && to !== 'approved' && !orgs.can(role, 'approve')) throw err(403, 'Only an approver or admin can withdraw an approved version.');
  v.gateLog.push({ from: v.gate, to, by: actor ? actor.name : 'platform owner', at: iso(), note }); v.gate = to;
  await adapter(orgId).put(orgId, 'assets', asset.id, asset);
  await audit.log(orgId, actor, 'asset.gate', { assetId, version: v.v, from: GATES[from], to, note }); return brief(asset);
}
/** An approver records that the regulator has approved (or been notified of) this version. */
async function recordRegulator(orgId, actor, role, assetId, version, { reference, note = '' } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'approve')) throw err(403, 'Only an approver or admin can record a regulator approval.');
  if (!reference) throw err(422, 'Enter the regulator reference (letter or approval number).');
  const { asset, version: v } = await versionData(orgId, assetId, version); if (!v.classification) throw err(422, 'Only product versions are checked against regulator rules.');
  v.regulator = { reference: String(reference), note, by: actor ? actor.name : 'platform owner', at: iso() }; await adapter(orgId).put(orgId, 'assets', asset.id, asset);
  await audit.log(orgId, actor, 'asset.regulator', { assetId, version: v.v, reference }); return brief(asset);
}
async function exportApproved(orgId, actor, assetId) {
  const a = await load(orgId, assetId); const v = [...a.versions].reverse().find((x) => x.gate === 'approved');
  if (!v) throw err(409, 'Nothing to export: no version of this asset has been approved yet.');
  await audit.log(orgId, actor, 'asset.export', { assetId, version: v.v });
  return { asset: { id: a.id, kind: a.kind, name: a.name }, version: v.v, approvedAt: v.gateLog.filter((g) => g.to === 'approved').pop().at, data: v.data };
}

// ---- uploads ---------------------------------------------------------------------------------------------------------------------
const IDENTIFIERS = ['name', 'full_name', 'first_name', 'last_name', 'surname', 'phone', 'phone_number', 'msisdn', 'mobile', 'email', 'national_id', 'ghana_card', 'address'];
const num = (x) => { const n = Number(String(x).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : NaN; };
function fromCsv(kind, csv, salt) {
  const rows = parseCsv(csv); if (!rows.length) throw err(422, 'The file has no rows.');
  const cols = Object.keys(rows[0]);
  if (kind === 'price_book') {
    need(cols, ['code', 'price']); return { data: { currency: 'GHS', items: rows.map((r) => ({ code: r.code, name: r.name || r.code, unit: r.unit || '', category: r.category || '', price: num(r.price) })).filter((i) => i.code && Number.isFinite(i.price)) }, summary: { rows: rows.length } };
  }
  if (kind === 'claims_dataset') {
    need(cols, ['claim_id', 'provider', 'diagnosis', 'service_code', 'amount']);
    const claims = rows.map((r) => ({ claim_id: r.claim_id, member_id: sha(salt + (r.member_id || r.member || '')).slice(0, 12), provider: r.provider, date: r.date || '', diagnosis: r.diagnosis, service_code: r.service_code, amount: num(r.amount),
      eligible: !/^(no|false|0)$/i.test(r.eligible || 'yes'), benefit_limit: r.benefit_limit ? num(r.benefit_limit) : null, known_issue: r.known_issue ? r.known_issue.toLowerCase() : null }));
    const bad = claims.filter((c) => !Number.isFinite(c.amount)).length; if (bad) throw err(422, `${bad} rows have an amount that is not a number.`);
    return { data: { claims }, summary: { rows: claims.length, memberIdsReplaced: true, labelled: claims.some((c) => c.known_issue) } };
  }
  if (kind === 'customer_dataset') {
    const dropped = cols.filter((c) => IDENTIFIERS.includes(c));
    const idCol = cols.find((c) => ['customer_id', 'member_id', 'id'].includes(c));
    const customers = rows.map((r, i) => { const o = {}; for (const c of cols) if (!IDENTIFIERS.includes(c) && c !== idCol) o[c] = r[c]; o.pid = sha(salt + (idCol ? r[idCol] : dropped.map((d) => r[d]).join('|') || i)).slice(0, 12); return o; });
    return { data: { customers }, summary: { rows: customers.length, identifiersRemoved: dropped, note: 'Names, phone numbers, emails and ID numbers are not stored. Each person is a code.' } };
  }
  throw err(422, 'CSV upload is available for price books, claims datasets and customer datasets.');
}
function need(cols, req) { const miss = req.filter((c) => !cols.includes(c)); if (miss.length) throw err(422, `The file is missing these columns: ${miss.join(', ')}.`); }
async function upload(orgId, actor, { kind, name, csv, description = '', assetId } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o);
  const { data, summary } = fromCsv(kind, csv, o.salt);
  if (assetId) { const r = await addVersion(orgId, actor, assetId, { data, note: 'Uploaded file' }); return { asset: r, summary }; }
  const a = await create(orgId, actor, { kind, name: name || `${kind} upload`, description, data, note: 'Uploaded file' });
  return { asset: a, summary };
}
module.exports = { recordRegulator, KINDS, GATES, create, addVersion, list, detail, versionData, promote, exportApproved, upload };
