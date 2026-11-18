'use strict';
/**
 * Test bench for a product, used from its Workroom room.
 *  - Company constraints (typed rules) and an assumptions sheet (.csv or .xlsx) that every run is checked against.
 *  - Several variations, or a sweep of one parameter, run side by side. Each is saved as a draft variation.
 *  - The Coach checks regulator rules, best practice, market factors and (optionally) the web, only the ones the builder ticks.
 *  - An optional test against the product's live web address, with test customers.
 * Everything here is simulation on assumptions. Nothing is approved, moved or sent to a regulator.
 */
const dns = require('dns');
const https = require('https');
const http = require('http');
const orgs = require('./orgs');
const plans = require('./plans');
const assets = require('./assets');
const audit = require('./audit');
const engine = require('./engine');
const lab = require('./lab');
const regulatory = require('./regulatory');
const bp = require('./bestpractice');
const xl = require('./xlsx');
const wr = require('./workroom');
const { err, iso, id } = require('./util');

const ad = (orgId) => audit.adapter(orgId);
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const clip = (s, n) => String(s || '').trim().slice(0, n);
const METRICS = { lossRatioPct: 'loss ratio %', margin: 'margin', capReachedPct: 'cap reached %', higherTierSharePct: 'higher-tier share %', revenue: 'revenue', paybackMonths: 'payback months', womenPct: 'women %' };
const RULE_TYPES = ['payback_months', 'mix', 'tam', 'regions', 'metric', 'note'];
const PARAM_KEYS = { claims_per_member_year: 'claimsPerMemberYear', median_claim_cost: 'medianClaimCost', price_sensitivity: 'priceSensitivity', adverse_selection: 'adverseSelection', target_loss_ratio_pct: 'targetLossRatioPct' };
const KNOWN_KEYS = [['tam_members', 'Total addressable market (people)'], ['expected_members_year1', 'Members you expect in year 1'], ['acquisition_cost', 'Cost to win one member'], ['fixed_cost_year', 'Fixed yearly cost'], ['market_women_pct', 'Women as a share of your market, %'], ['uptake_women_vs_men', 'How much more likely women are than men to buy (1 = equal)'], ['target_regions', 'Regions you will sell in'], ['avg_monthly_income', 'Average monthly income of your target customer'], ['lapse_pct', 'Yearly lapse, %'], ['claims_per_member_year', 'Claims per member per year'], ['median_claim_cost', 'Median claim cost'], ['price_sensitivity', 'Price sensitivity (about 1.2)'], ['adverse_selection', 'Adverse selection (about 0.3)'], ['target_loss_ratio_pct', 'Target loss ratio, %']];
const APPEAL = { maternity: 4, family_plan: 1.3 }; // starting assumption: maternity cover mostly appeals to women

// ---- constraints and the assumptions sheet ------------------------------------------------------------------------------------
async function store(orgId, assetId) { return (await ad(orgId).get(orgId, 'wr_rules', assetId)) || { id: assetId, rules: [], sheets: [] }; }
const save = (orgId, rec) => ad(orgId).put(orgId, 'wr_rules', rec.id, rec);
async function needProduct(orgId, assetId) { const { asset, version } = await assets.versionData(orgId, assetId); if (asset.kind !== 'product') throw err(422, 'The test bench is for products.'); return { asset, version }; }
function assumptionMap(rec) { const m = {}; for (const sh of rec.sheets) for (const r of sh.rows) m[r.key] = r.value; return m; }

async function constraints(orgId, assetId) {
  await needProduct(orgId, assetId); const rec = await store(orgId, assetId);
  return { liveUrl: rec.liveUrl || '', rules: rec.rules, sheets: rec.sheets.map((s) => ({ id: s.id, name: s.name, at: s.at, by: s.by, count: s.rows.length })), assumptions: Object.entries(assumptionMap(rec)).map(([key, value]) => ({ key, value })), known: KNOWN_KEYS.map(([key, label]) => ({ key, label })) };
}
function cleanRule(b) {
  const type = String(b.type || ''); if (!RULE_TYPES.includes(type)) throw err(422, 'Choose a kind of rule.'); const num = (v, name, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw err(422, `${name} must be a number from ${lo} to ${hi}.`); return n; };
  if (type === 'payback_months') { const m = num(b.maxMonths, 'Months', 1, 240); return { type, maxMonths: m, label: `Payback within ${m} months` }; }
  if (type === 'mix') { const w = num(b.women, 'Women %', 0, 100), men = num(b.men === undefined || b.men === '' ? 100 - w : b.men, 'Men %', 0, 100); if (Math.abs(w + men - 100) > 0.01) throw err(422, 'Women and men must add up to 100.'); const t = num(b.tolerance === undefined || b.tolerance === '' ? 5 : b.tolerance, 'Tolerance', 0, 50); return { type, women: w, men, tolerance: t, label: `Customer base ${w}% women, ${men}% men (within ${t} points)` }; }
  if (type === 'tam') { const t = num(b.tamMembers, 'Market size', 1, 1e10); const s = num(b.maxSharePct === undefined || b.maxSharePct === '' ? 100 : b.maxSharePct, 'Share', 0.01, 100); return { type, tamMembers: t, maxSharePct: s, label: `Total addressable market ${t.toLocaleString('en-US')} people, year-1 members no more than ${s}% of it` }; }
  if (type === 'regions') { const a = (Array.isArray(b.allowed) ? b.allowed : String(b.allowed || '').split(',')).map((x) => clip(x, 60)).filter(Boolean).slice(0, 30); if (!a.length) throw err(422, 'List at least one region.'); return { type, allowed: a, label: `Sell only in: ${a.join(', ')}` }; }
  if (type === 'metric') { if (!METRICS[b.metric]) throw err(422, 'Choose a measure.'); if (!['<=', '>='].includes(b.op)) throw err(422, 'Choose at most or at least.'); const v = num(b.value, 'Value', -1e12, 1e12); return { type, metric: b.metric, op: b.op, value: v, label: `${METRICS[b.metric]} ${b.op === '<=' ? 'at most' : 'at least'} ${v}` }; }
  const t = clip(b.text, 240); if (!t) throw err(422, 'Write the rule.'); return { type: 'note', text: t, label: t };
}
async function addRule(orgId, actor, role, assetId, body) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot change constraints.'); await needProduct(orgId, assetId); const rec = await store(orgId, assetId);
  if (rec.rules.length >= 25) throw err(422, 'That is the most rules a product can hold. Remove one first.'); const r = { id: id('rul'), ...cleanRule(body || {}), by: actor.name, at: iso() }; rec.rules.push(r); await save(orgId, rec); return r;
}
async function removeRule(orgId, role, assetId, ruleId) { if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot change constraints.'); const rec = await store(orgId, assetId); rec.rules = rec.rules.filter((r) => r.id !== ruleId); await save(orgId, rec); return { ok: true }; }
async function addSheet(orgId, actor, role, assetId, { name, csv, xlsxBase64 } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot upload assumptions.'); await needProduct(orgId, assetId);
  let rows; if (xlsxBase64) rows = xl.xlsxRows(Buffer.from(String(xlsxBase64), 'base64')); else if (csv) rows = xl.csvRows(csv); else throw err(422, 'Attach a .csv or .xlsx file.');
  const a = xl.toAssumptions(rows); if (!a.length) throw err(422, 'No assumptions found. Put what it is in column A and the value in column B.');
  const rec = await store(orgId, assetId); if (rec.sheets.length >= 5) throw err(422, 'That is the most sheets a product can hold. Remove one first.');
  const sh = { id: id('sht'), name: clip(name, 80) || 'Assumptions', at: iso(), by: actor.name, rows: a }; rec.sheets.push(sh); await save(orgId, rec); return { id: sh.id, name: sh.name, count: a.length };
}
async function removeSheet(orgId, role, assetId, sheetId) { if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot change assumptions.'); const rec = await store(orgId, assetId); rec.sheets = rec.sheets.filter((s) => s.id !== sheetId); await save(orgId, rec); return { ok: true }; }

// ---- what the Coach would apply (shown before the builder consents) --------------------------------------------------------------
const CCY = { GHS: 'Ghana', NGN: 'Nigeria', KES: 'Kenya', UGX: 'Uganda', TZS: 'Tanzania', ZAR: 'South Africa', RWF: 'Rwanda', XOF: 'West Africa' };
const webKey = () => process.env.TAVILY_API_KEY || '';
async function plan(orgId, assetId) {
  const { asset, version } = await needProduct(orgId, assetId); const rec = await store(orgId, assetId); const R = regulatory.merge(orgs.raw(orgId).regulatoryRules); const a = assumptionMap(rec);
  const lvl = { regulator: 'needs regulator approval', notify: 'needs a notice to the regulator', none: 'needs nothing' };
  const items = Object.entries(R.levels).filter(([, v]) => v !== 'none').slice(0, 8).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${lvl[v]}`);
  const country = CCY[version.data.currency] || '';
  return { constraints: { title: 'Your company constraints', note: 'Always applied. They are your own rules.', items: [...rec.rules.map((r) => r.label), ...Object.keys(a).length ? [`${Object.keys(a).length} assumptions from your sheet${rec.sheets.length > 1 ? 's' : ''}`] : []], count: rec.rules.length },
    regulatory: { title: 'Regulator rules', note: 'Each variation is compared with your current product and classed as needing nothing, a notice, or approval.', items },
    bestPractice: { title: 'Best practice', note: bp.NOTE, items: bp.PLAN },
    market: { title: 'Market factors', note: 'Your sheet overrides the built-in typical assumptions. All are assumptions, and each is shown in the results.', items: Object.keys(a).length ? Object.entries(a).slice(0, 12).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`) : ['No sheet uploaded. Only the built-in typical assumptions for this product type are used.'] },
    customers: await (async () => { const ins = await require('./iterfeedback').listInsights(orgId); return { title: 'Customer feedback', note: 'Results from surveys you added to the design. Answers that match a bench assumption replace it, and every one is listed in the results.', items: ins.length ? ins.slice(0, 6).flatMap((x) => [`${x.title} (${x.responses} answers)`, ...x.lines.slice(0, 2).map((l) => '  ' + l)]) : ['No survey results have been added yet. Open a survey in Surveys and press "Use in design".'] }; })(),
    web: { title: 'Web lookup', available: !!webKey(), note: webKey() ? 'The Coach searches the web once, and you see every source it used.' : 'Web lookup is not connected. The platform owner can switch it on by setting TAVILY_API_KEY.', items: [`Search for current market and regulator information on "${asset.name.replace(/ · .*$/, '')}" type cover${country ? ' in ' + country : ''}`] } };
}
async function webLookup(asset, data) {
  const key = webKey(); if (!key) return { available: false, sources: [], note: 'Web lookup is not connected.' }; const country = CCY[data.currency] || '';
  const q = `${asset.name.replace(/ · .*$/, '')} health insurance product market and regulation ${country}`.trim();
  try { const r = await fetch(process.env.TAVILY_URL || 'https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: key, query: q, max_results: 4 }) }); if (!r.ok) throw new Error('status ' + r.status); const j = await r.json();
    return { available: true, query: q, sources: (j.results || []).slice(0, 4).map((x) => ({ title: clip(x.title, 120), url: clip(x.url, 300), snippet: clip(x.content, 280) })) };
  } catch (e) { return { available: true, query: q, sources: [], note: 'The web lookup failed: ' + e.message }; }
}

// ---- evaluating one run against the company's constraints -------------------------------------------------------------------
function derive(run, d, a, members) {
  const margin = run.headline.margin; const acq = a.acquisition_cost !== undefined ? Number(a.acquisition_cost) : 60; const fixed = Number(a.fixed_cost_year || 0);
  const payback = margin > 0 ? round(((acq * members + fixed) / (margin / 12)), 1) : null;
  const w = a.market_women_pct !== undefined ? Number(a.market_women_pct) : 50; const ratio = a.uptake_women_vs_men !== undefined ? Number(a.uptake_women_vs_men) : (APPEAL[d.archetype] || 1);
  const women = round(100 * w * ratio / (w * ratio + (100 - w)), 1);
  return { paybackMonths: payback, womenPct: women, members, acquisitionCost: acq, fixedCost: fixed, womenRatio: ratio, womenMarketPct: w, acquisitionIsDefault: a.acquisition_cost === undefined, ratioIsDefault: a.uptake_women_vs_men === undefined };
}
function evaluate(rules, run, d, a, dv) {
  const m = { ...run.headline, paybackMonths: dv.paybackMonths, womenPct: dv.womenPct }; const out = [];
  for (const r of rules) {
    const c = { ruleId: r.id, label: r.label, type: r.type };
    if (r.type === 'payback_months') { if (dv.paybackMonths == null) Object.assign(c, { status: 'fail', detail: 'It does not earn a margin, so it never pays back.' }); else Object.assign(c, { status: dv.paybackMonths <= r.maxMonths ? 'pass' : 'fail', detail: `Payback ${dv.paybackMonths} months against a limit of ${r.maxMonths}. Assumes ${dv.acquisitionCost} to win each of ${dv.members.toLocaleString('en-US')} members${dv.fixedCost ? ` and ${dv.fixedCost.toLocaleString('en-US')} fixed cost` : ''}${dv.acquisitionIsDefault ? ' (the cost to win a member is a placeholder; add acquisition_cost to your sheet)' : ''}.` }); }
    else if (r.type === 'mix') { const gap = Math.abs(dv.womenPct - r.women); const need = (r.women / (100 - r.women || 0.0001)) * ((100 - dv.womenMarketPct) / (dv.womenMarketPct || 0.0001)); Object.assign(c, { status: gap <= r.tolerance ? 'pass' : 'fail', detail: `Expected ${dv.womenPct}% women against a target of ${r.women}%. ${gap <= r.tolerance ? '' : `Reaching it needs women to be about ${round(need, 1)} times as likely as men to buy; today's assumption is ${dv.womenRatio}${dv.ratioIsDefault ? ' (a placeholder; add uptake_women_vs_men to your sheet)' : ''}. Benefits and marketing aimed at women would move it.`}`.trim() }); }
    else if (r.type === 'tam') { const share = round(100 * dv.members / r.tamMembers, 2); Object.assign(c, { status: share <= r.maxSharePct ? 'pass' : 'fail', detail: `${dv.members.toLocaleString('en-US')} members is ${share}% of a market of ${r.tamMembers.toLocaleString('en-US')} (limit ${r.maxSharePct}%).` }); }
    else if (r.type === 'regions') { const raw = d.regions !== undefined ? d.regions : a.target_regions; const have = (Array.isArray(raw) ? raw : String(raw || '').split(',')).map((x) => x.trim()).filter(Boolean); if (!have.length) Object.assign(c, { status: 'unchecked', detail: 'The product does not list where it sells. Add target_regions to your sheet.' }); else { const allowed = r.allowed.map((x) => x.toLowerCase()); const out2 = have.filter((x) => !allowed.includes(x.toLowerCase())); Object.assign(c, { status: out2.length ? 'fail' : 'pass', detail: out2.length ? `Outside the allowed regions: ${out2.join(', ')}.` : `All of ${have.join(', ')} are allowed.` }); } }
    else if (r.type === 'metric') { const v = m[r.metric]; if (v == null) Object.assign(c, { status: 'fail', detail: `${METRICS[r.metric]} could not be worked out.` }); else Object.assign(c, { status: (r.op === '<=' ? v <= r.value : v >= r.value) ? 'pass' : 'fail', detail: `${METRICS[r.metric]} is ${v} against ${r.op === '<=' ? 'at most' : 'at least'} ${r.value}.` }); }
    else Object.assign(c, { status: 'unchecked', detail: 'For your team to confirm. The bench cannot test this one.' });
    out.push(c);
  }
  return out;
}

// ---- a safe call to the product's live web address -------------------------------------------------------------------------
const allowPrivate = () => process.env.DRYRUN_ALLOW_PRIVATE_TESTS === '1';
function isPrivate(ip) {
  const s = String(ip).toLowerCase().replace(/^::ffff:/, ''); if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) { const [a, b] = s.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
}
function guardedLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (e, addrs) => {
    if (e) return cb(e); if (!allowPrivate() && addrs.some((x) => isPrivate(x.address))) return cb(new Error('That address points inside a private network. Tests can only call public web addresses.'));
    if (opts && opts.all) return cb(null, addrs.map((x) => ({ address: x.address, family: x.family }))); cb(null, addrs[0].address, addrs[0].family);
  });
}
function callOnce(url, payload) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let u; try { u = new URL(url); } catch { return resolve({ error: 'That is not a web address.' }); }
    if (!(u.protocol === 'https:' || (allowPrivate() && u.protocol === 'http:'))) return resolve({ error: 'Use an https:// address.' });
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) && !allowPrivate() && isPrivate(u.hostname)) return resolve({ error: 'Tests can only call public web addresses.' });
    const body = JSON.stringify(payload); const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST', lookup: guardedLookup, timeout: 6000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'DryRunBench/1' } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; if (buf.length > 100000) { res.destroy(); } }); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, ms: Date.now() - t0, json: j }); }); res.on('error', () => resolve({ status: res.statusCode, ms: Date.now() - t0, json: null }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'No answer within 6 seconds.' }); }); req.on('error', (e) => resolve({ error: e.message })); req.write(body); req.end();
  });
}
async function liveTest(url, product, tolerancePct) {
  const cases = [{ age: 22, sex: 'female', region: 'Greater Accra' }, { age: 31, sex: 'male', region: 'Ashanti' }, { age: 40, sex: 'female', region: 'Northern' }, { age: 47, sex: 'male', region: 'Western' }, { age: 55, sex: 'female', region: 'Volta' }, { age: 63, sex: 'male', region: 'Greater Accra' }];
  const tol = Number.isFinite(Number(tolerancePct)) ? Number(tolerancePct) : 5; const out = [];
  for (const c of cases) {
    const r = await callOnce(url, { product: { name: product.name, premium: product.premium, benefitCap: product.benefitCap, coPayPct: product.coPayPct, waitingDays: product.waitingDays }, member: c });
    const j = r.json || {}; const got = [j.premium, j.monthlyPremium, j.price, j.quote].find((x) => typeof x === 'number');
    if (r.error) out.push({ case: c, ok: false, error: r.error }); else if (r.status >= 300) out.push({ case: c, ok: false, status: r.status, ms: r.ms, error: `The address answered with status ${r.status}.` });
    else if (got === undefined) out.push({ case: c, ok: false, status: r.status, ms: r.ms, error: 'The answer had no premium number (premium, monthlyPremium, price or quote).' });
    else { const diff = round(100 * Math.abs(got - product.premium) / product.premium, 1); out.push({ case: c, ok: diff <= tol, status: r.status, ms: r.ms, premium: got, expected: product.premium, diffPct: diff }); }
    if (out[0].error && /private|public web|https|not a web/.test(out[0].error)) break;
  }
  return { url, tolerancePct: tol, cases: out, passed: out.filter((x) => x.ok).length, total: out.length };
}

// ---- the run ---------------------------------------------------------------------------------------------------------------------
const CH_KEYS = ['premiumPct', 'capPct', 'coPayPct', 'waitingDays', 'premium', 'benefitCap'];
function expandVariants({ variants, sweep }) {
  const out = []; for (const v of Array.isArray(variants) ? variants : []) { const ch = {}; for (const k of CH_KEYS) if (v && v.changes && v.changes[k] !== undefined && v.changes[k] !== '' && v.changes[k] !== null) ch[k] = Number(v.changes[k]); if (Object.keys(ch).length) out.push({ label: clip(v.label, 60), changes: ch }); }
  if (sweep && sweep.param) { if (!['premiumPct', 'capPct', 'coPayPct', 'waitingDays'].includes(sweep.param)) throw err(422, 'Choose what to sweep.'); const from = Number(sweep.from), to = Number(sweep.to), steps = Math.round(Number(sweep.steps)); if (![from, to, steps].every(Number.isFinite) || steps < 2 || steps > 5) throw err(422, 'A sweep needs a start, an end and 2 to 5 steps.'); for (let i = 0; i < steps; i++) { const val = round(from + (to - from) * i / (steps - 1), 2); out.push({ label: '', changes: { [sweep.param]: val } }); } }
  if (out.length > 5) throw err(422, 'Run up to 5 variations at a time, plus your current product.'); return out;
}
async function run(orgId, actor, role, assetId, body = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot run the test bench.');
  const { asset, version } = await needProduct(orgId, assetId); const rec = await store(orgId, assetId); const a = assumptionMap(rec); const consent = { regulatory: !!(body.consent || {}).regulatory, bestPractice: !!(body.consent || {}).bestPractice, market: !!(body.consent || {}).market, web: !!(body.consent || {}).web, customers: !!(body.consent || {}).customers };
  const ins = consent.customers ? await require('./iterfeedback').listInsights(orgId) : []; const applied = []; for (const x of [...ins].reverse()) for (const f of x.feeds || []) if (Number.isFinite(Number(f.value))) { a[f.param] = Number(f.value); applied.push({ param: f.param, value: Number(f.value), from: x.title }); }
  const vs = expandVariants(body); if (body.live && body.live.url) plans.assertNotDemo(o, 'Live tests');
  const members = Math.min(Math.max(Math.round(Number(body.members || (consent.market && a.expected_members_year1) || 2000)), 100), 20000);
  const params = { members }; if (consent.market) for (const [k, p] of Object.entries(PARAM_KEYS)) if (a[k] !== undefined && Number.isFinite(Number(a[k]))) params[p] = Number(a[k]);
  const out = []; const label0 = 'Your current product';
  const one = async (label, aid, changesText, reg) => { const run1 = await engine.run(orgId, actor, role, { scenario: 'plan_options', name: label, inputs: { product: { assetId: aid } }, params, seed: 1 }); const dv = (await assets.versionData(orgId, aid)).version.data; const dvv = derive(run1, dv, a, members);
    const row = { label, assetId: aid, runId: run1.id, changes: changesText, metrics: { ...run1.headline, paybackMonths: dvv.paybackMonths, womenPct: dvv.womenPct, premium: dv.premium, benefitCap: dv.benefitCap, coPayPct: dv.coPayPct, waitingDays: dv.waitingDays }, checks: evaluate(rec.rules, run1, dv, a, dvv), assumptionsUsed: run1.result.assumptions, regulatory: reg };
    if (consent.bestPractice) row.bestPractice = bp.check(dv, run1.headline, a); if (consent.regulatory && aid !== assetId) { const cls = regulatory.classify(version.data, dv, o.regulatoryRules); row.regulatory = { overall: cls.overall, summary: cls.summary, changes: cls.changes.map((c) => ({ field: c.field, level: c.level, reason: c.reason })) }; } else if (consent.regulatory) row.regulatory = { overall: 'baseline', summary: 'Your current product. The others are measured against it.', changes: [] };
    return row; };
  out.push(await one(label0, assetId, [], null));
  for (const v of vs) { const r = await lab.variation(orgId, actor, role, assetId, { name: v.label || undefined, changes: v.changes, extraTags: ['bench'] }); out.push(await one(v.label || r.changes.join(', '), r.asset.id, r.changes, null)); }
  for (const row of out) { row.failed = row.checks.filter((c) => c.status === 'fail').length; row.passed = row.checks.filter((c) => c.status === 'pass').length; }
  const eligible = out.filter((r) => r.failed === 0).sort((x, y) => y.metrics.margin - x.metrics.margin); const winner = eligible.length ? eligible[0] : null;
  const rec2 = { id: id('bch'), assetId, at: iso(), by: actor.name, byId: actor.id, consent, members, variants: out, winnerId: winner ? winner.assetId : null, ruleCount: rec.rules.length, assumptionsFromSheet: Object.keys(a).length };
  if (consent.market) rec2.market = { fromSheet: Object.entries(a).map(([key, value]) => ({ key, value })), builtIn: out[0].assumptionsUsed };
  if (consent.customers) rec2.customers = { insights: ins.map((x) => ({ title: x.title, responses: x.responses, at: x.at, lines: x.lines })), applied };
  if (consent.web) rec2.web = await webLookup(asset, version.data);
  if (body.live && body.live.url) rec2.live = await liveTest(String(body.live.url).trim(), version.data, body.live.tolerancePct);
  await ad(orgId).put(orgId, 'wr_bench', rec2.id, rec2); await audit.log(orgId, actor, 'bench.run', { assetId, variants: vs.length });
  // say so in the room
  const names = out.map((r) => r.label); const best = winner ? (winner.assetId === assetId ? 'your current product is still the best choice' : `best choice: "${winner.label}" (margin ${Math.round(winner.metrics.margin).toLocaleString('en-US')}${winner.metrics.paybackMonths != null ? `, payback ${winner.metrics.paybackMonths} months` : ''})`) : (rec.rules.length ? 'none of them meets all your constraints' : 'add constraints to rank them');
  const lines = [`Test bench: ${out.length === 1 ? 'your current product' : `your current product and ${out.length - 1} variation${out.length === 2 ? '' : 's'}`}. ${best.charAt(0).toUpperCase() + best.slice(1)}.`];
  for (const r of out) if (rec.rules.length) lines.push(`${r.label}: ${r.passed} of ${r.checks.filter((c) => c.status !== 'unchecked').length} constraints met${r.failed ? ' (fails: ' + r.checks.filter((c) => c.status === 'fail').map((c) => c.label).join('; ') + ')' : ''}`);
  if (rec2.live) lines.push(`Live test: ${rec2.live.passed} of ${rec2.live.total} test customers matched the simulated price.`);
  try { await wr.coachNote(orgId, 'rm_' + assetId, lines.join('\n'), { benchId: rec2.id }); } catch { /* the room may not exist yet */ }
  return rec2;
}
/** Looks at a web address the way a visitor would: does it answer, how fast, what is it called. Public https addresses only. */
function probe(url) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let u; try { u = new URL(url); } catch { return resolve({ error: 'That is not a web address.' }); }
    if (!(u.protocol === 'https:' || (allowPrivate() && u.protocol === 'http:'))) return resolve({ error: 'Not checked: only https addresses are checked.' });
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) && !allowPrivate() && isPrivate(u.hostname)) return resolve({ error: 'Not checked: it is a private address.' });
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', lookup: guardedLookup, timeout: 6000, headers: { 'user-agent': 'DryRunBench/1', accept: 'text/html,*/*' } }, (res) => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', (c) => { if (buf.length < 100000) buf += c; else res.destroy(); }); const done = () => { const t = (buf.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]; resolve({ status: res.statusCode, ms: Date.now() - t0, contentType: clip(res.headers['content-type'], 80), title: t ? clip(t.replace(/\s+/g, ' '), 120) : null }); }; res.on('end', done); res.on('close', done);
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'No answer within 6 seconds.' }); }); req.on('error', (e) => resolve({ error: e.message })); req.end();
  });
}
async function setLiveUrl(orgId, assetId, url) { const rec = await store(orgId, assetId); rec.liveUrl = url; await save(orgId, rec); }
async function history(orgId, assetId) { await needProduct(orgId, assetId); return (await ad(orgId).list(orgId, 'wr_bench')).filter((b) => b.assetId === assetId).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 10); }

module.exports = { probe, setLiveUrl, constraints, addRule, removeRule, addSheet, removeSheet, plan, run, history, isPrivate, guardedLookup, expandVariants, METRICS };
