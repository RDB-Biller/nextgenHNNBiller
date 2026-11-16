'use strict';
// End-to-end check of Dry Run over HTTP, in memory. Run: npm run smoke
process.env.DRYRUN_MEMORY = '1'; process.env.PLATFORM_ADMIN_KEY = 'test_platform_key'; process.env.DRYRUN_SECRET_KEY = 'smoke_test_secret_key_value_0123456789';
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path');
const app = require('../src/server'); const orgs = require('../src/orgs');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const section = (s) => console.log(s);

async function main() {
  const hnnStub = http.createServer((q, r) => {
    if (q.headers['x-platform-key'] !== 'stubkey') { r.statusCode = 401; return r.end('{}'); }
    r.setHeader('Content-Type', 'application/json');
    if (q.url === '/api/platform/price-books') return r.end(JSON.stringify({ books: [{ id: 'pb1', name: 'Outpatient 2026' }] }));
    if (q.url === '/api/platform/price-books/pb1') return r.end(JSON.stringify({ id: 'pb1', name: 'Outpatient 2026', currency: 'GHS', items: [{ code: 'CONSULT-GP', name: 'GP consult', price: 40 }, { code: 'MALARIA-RDT', name: 'Malaria RDT', price: 25 }] }));
    r.statusCode = 404; r.end('{}');
  }); await new Promise((r) => hnnStub.listen(0, r));
  process.env.HNN_BASE_URL = `http://127.0.0.1:${hnnStub.address().port}`; process.env.HNN_PLATFORM_KEY = 'stubkey';
  const srv = app.listen(0); await new Promise((r) => srv.on('listening', r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, key, body, hdr = 'x-api-key', raw) => { const r = await fetch(base + url, { method, headers: { ...(raw ? { 'Content-Type': 'text/plain' } : { 'Content-Type': 'application/json' }), ...(key ? { [hdr]: key } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  const PK = 'test_platform_key'; const plat = (m, u, b) => call(m, '/api/platform' + u, PK, b, 'x-platform-key');

  section('Platform owner and accounts');
  ok((await call('POST', '/api/platform/orgs', 'wrong', {}, 'x-platform-key')).s === 401, 'bad platform key rejected');
  let r = await plat('POST', '/orgs', { name: 'Nationwide Medical Insurance', sector: 'insurer', adminName: 'Ama', adminEmail: 'ama@nationwide.test', pace: 'weeks' }); ok(r.s === 201 && r.j.admin.apiKey, 'org created with admin key');
  const orgId = r.j.org.id; const ADMIN = r.j.admin.apiKey; ok(r.j.org.plan === 'free_trial' && r.j.org.daysLeft > 50, 'starts on a free trial');
  ok((await call('GET', '/api/org', ADMIN)).j.pack.scenarios.length === 2, 'insurer pack offers two scenarios');
  ok((await plat('POST', '/orgs', { name: 'X', sector: 'nope', adminEmail: 'x@x.test' })).s === 422, 'unknown pack refused');

  section('Team, roles and limits');
  const b = (await call('POST', '/api/org/team', ADMIN, { name: 'Kofi', email: 'kofi@nationwide.test', role: 'builder' })).j; const ap = (await call('POST', '/api/org/team', ADMIN, { name: 'Esi', email: 'esi@nationwide.test', role: 'approver' })).j;
  ok(b.apiKey && ap.apiKey, 'members added'); const BUILD = b.apiKey, APPR = ap.apiKey;
  r = await call('POST', '/api/org/team', ADMIN, { name: 'Four', email: 'four@nationwide.test' }); ok(r.s === 402, 'free plan stops at 3 members: ' + r.s);
  ok((await call('POST', '/api/org/team', BUILD, { name: 'Z', email: 'z@z.test' })).s === 403, 'builder cannot add team');
  ok((await call('GET', '/api/org/assets', 'bad')).s === 401, 'bad member key rejected');

  section('Upload and privacy');
  const csv = 'claim_id,member_id,provider,date,diagnosis,service_code,amount,eligible,benefit_limit,known_issue\n' + Array.from({ length: 60 }, (_, i) => `C${i},M${i % 20},PRV-0${(i % 3) + 1},2026-03-${String((i % 27) + 1).padStart(2, '0')},B50.9,CONSULT-GP,${i === 5 ? 120 : 40 + (i % 3)},yes,1500,${i === 5 ? 'overpriced' : 'none'}`).join('\n');
  r = await call('POST', '/api/org/upload', BUILD, { kind: 'claims_dataset', name: 'March claims', csv }); ok(r.s === 201 && r.j.summary.memberIdsReplaced, 'claims uploaded');
  const claimsAsset = r.j.asset.id; const full = (await call('GET', `/api/org/assets/${claimsAsset}?data=1`, BUILD)).j; ok(!JSON.stringify(full).includes('"M1"') && full.versionList[0].data.claims[0].member_id.length === 12, 'member ids replaced by codes');
  r = await call('POST', '/api/org/upload', BUILD, { kind: 'customer_dataset', name: 'Members', csv: 'member_id,name,phone,email,age,plan\nM1,Kwame Mensah,0244000000,k@x.test,34,Gold\nM2,Abena Osei,0200000000,a@x.test,41,Silver' });
  const cust = (await call('GET', `/api/org/assets/${r.j.asset.id}?data=1`, BUILD)).j.versionList[0].data.customers[0]; ok(!cust.name && !cust.phone && !cust.email && cust.pid && cust.age === '34', 'customer identifiers dropped, pid added');
  ok((await call('POST', '/api/org/upload', BUILD, { kind: 'claims_dataset', csv: 'a,b\n1,2' })).s === 422, 'missing columns explained');

  section('HNN connector');
  r = await call('GET', '/api/org/hnn/price-books', BUILD); ok(r.s === 200 && r.j[0].id === 'pb1', 'lists HNN price books');
  r = await call('POST', '/api/org/hnn/import', BUILD, { priceBookId: 'pb1' }); ok(r.s === 201 && r.j.items === 2, 'imports a price book as an asset'); const pbAsset = r.j.asset.id;

  section('Runs, Compare and Coach');
  const rules = (await call('POST', '/api/org/assets', BUILD, { kind: 'rule_set', name: 'Outpatient rules', data: { rules: [{ name: 'Malaria routine', icdPrefixes: ['B50.9'], maxAmount: 30 }], settings: { maxMissRatePct: 0.5 } } })).j;
  const inputs = { claims_dataset: { assetId: claimsAsset }, rule_set: { assetId: rules.id }, price_book: { assetId: pbAsset } };
  const r1 = (await call('POST', '/api/org/runs', BUILD, { scenario: 'adjudication_ladder', name: 'v1', inputs, seed: 3 })).j; ok(r1.id && r1.headline.autoPct >= 0, 'ladder run on uploaded data');
  const r1b = (await call('POST', '/api/org/runs', BUILD, { scenario: 'adjudication_ladder', name: 'v1 again', inputs, seed: 3 })).j; ok(JSON.stringify(r1.headline) === JSON.stringify(r1b.headline), 'same seed gives the same answer');
  const s1 = (await call('POST', '/api/org/runs', BUILD, { scenario: 'adjudication_ladder', name: 'synthetic', seed: 7, synthetic: { claims: 1500 } })).j; ok(s1.inputs.claims_dataset.synthetic, 'synthetic data is labelled as synthetic');
  const co = (await call('POST', `/api/org/runs/${s1.id}/coach`, BUILD, {})).j; ok(co.suggestions.length === 1 && co.suggestions[0].expected.autoPct.to > co.suggestions[0].expected.autoPct.from, 'Coach finds a safer-or-better rule set'); ok(co.suggestions[0].expected.missRatePctOfAuto.to <= 0.5, 'Coach respects the miss-rate guardrail');
  const ap1 = await call('POST', `/api/org/runs/${s1.id}/coach/apply`, BUILD, { index: 0 }); ok(ap1.s === 201 && ap1.j.asset.latestGate === 'draft', 'Coach applies only as a draft');
  const cmp = (await call('POST', '/api/org/compare', BUILD, { runIds: [r1.id, s1.id] })).j; ok(cmp.metrics.length > 3 && cmp.metrics[0].values.length === 2, 'compare returns metrics for both runs');
  const e1 = (await call('POST', '/api/org/runs', BUILD, { scenario: 'expedited_settlement', name: 'settle', seed: 2, synthetic: { claims: 1500 } })).j; ok(e1.headline.netBenefit > 0, 'settlement run');
  ok((await call('POST', '/api/org/compare', BUILD, { runIds: [r1.id, e1.id] })).s === 422, 'cannot compare different scenarios');
  const ce = (await call('POST', `/api/org/runs/${e1.id}/coach`, BUILD, { maxDiscountPct: 12 })).j; ok(ce.suggestions.every((s) => s.draft.data.tiers.every((t) => t.discountPct <= 12)), 'settlement Coach stays inside the maximum discount');
  ok((await call('POST', '/api/org/runs', BUILD, { scenario: 'adjudication_ladder', inputs: { claims_dataset: { assetId: pbAsset } } })).s === 422, 'wrong asset type refused');
  const v = (await call('POST', '/api/org/runs', (await call('POST', '/api/org/team', ADMIN, { name: 'V', email: 'v@x.test', role: 'viewer' }).then((x) => x.j.apiKey || '')) || 'x', { scenario: 'adjudication_ladder' })); ok(v.s === 401 || v.s === 403 || v.s === 402, 'viewer cannot run (or plan limit reached)');

  section('Gates');
  r = await call('POST', `/api/org/assets/${rules.id}/promote`, BUILD, { version: 1, to: 'approved' }); ok(r.s === 403 || r.s === 422, 'cannot skip gates or self-approve');
  for (const to of ['dry_run', 'shadow']) ok((await call('POST', `/api/org/assets/${rules.id}/promote`, BUILD, { version: 1, to })).s === 200, 'builder moves to ' + to);
  ok((await call('POST', `/api/org/assets/${rules.id}/promote`, BUILD, { version: 1, to: 'approved' })).s === 403, 'builder cannot approve');
  ok((await call('GET', `/api/org/assets/${rules.id}/export`, APPR)).s === 409, 'nothing exportable before approval');
  ok((await call('POST', `/api/org/assets/${rules.id}/promote`, APPR, { version: 1, to: 'approved', note: 'ok' })).s === 200, 'approver approves'); ok((await call('GET', `/api/org/assets/${rules.id}/export`, APPR)).j.version === 1, 'approved version exports');
  const lg = (await call('GET', '/api/org/audit', ADMIN)).j; ok(lg.some((x) => x.action === 'asset.gate') && lg.some((x) => x.action === 'coach.apply'), 'audit log records gates and Coach');

  section('Pace');
  r = await call('PUT', '/api/org/pace/adjudication_ladder/0', BUILD, { done: true }); ok(r.s === 200 && r.j['0'] === true, 'tick a step'); ok((await call('GET', '/api/org/pace', BUILD)).j[0].steps[0].done === true, 'step shows as done');
  ok((await call('PATCH', '/api/org/settings', ADMIN, { pace: 'days' })).j.pace === 'days' && (await call('GET', '/api/org/pace', BUILD)).j[0].pace === 'days', 'pace can switch to days');

  section('Storage change');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-')); const before = (await call('GET', '/api/org/assets', ADMIN)).j.length;
  r = await call('PUT', '/api/org/storage', ADMIN, { kind: 'file', dir }); ok(r.s === 200 && r.j.copied.assets === before, 'data moved to the client folder with counts verified');
  ok((await call('GET', '/api/org/assets', ADMIN)).j.length === before && fs.readdirSync(dir).length > 0, 'workspace still works from the new location');
  ok((await call('PUT', '/api/org/storage', BUILD, { kind: 'platform' })).s === 403, 'only admin changes storage');
  r = await call('PUT', '/api/org/storage', ADMIN, { kind: 'platform' }); ok(r.s === 200 && (await call('GET', '/api/org/assets', ADMIN)).j.length === before, 'and back to our system');

  section('Plans, trial expiry and caps');
  const raw = orgs.raw(orgId); raw.trialEndsAt = new Date(Date.now() - 5 * 86400000).toISOString(); ok((await call('GET', '/api/org', ADMIN)).j.org.status === 'grace', 'after trial: grace');
  ok((await call('POST', '/api/org/assets', BUILD, { kind: 'product', name: 'p', data: {} })).s === 201, 'still writable in grace');
  raw.trialEndsAt = new Date(Date.now() - 45 * 86400000).toISOString(); ok((await call('GET', '/api/org', ADMIN)).j.org.status === 'read_only', 'after grace: read-only');
  ok((await call('POST', '/api/org/assets', BUILD, { kind: 'product', name: 'q', data: {} })).s === 402, 'read-only blocks writes'); ok((await call('GET', '/api/org/assets', BUILD)).s === 200, 'but reading still works');
  r = await plat('PATCH', `/orgs/${orgId}/plan`, { extendDays: 30 }); ok(r.j.status === 'active' && r.j.plan === 'extended_trial', 'extending a trial reopens the workspace');
  r = await plat('PATCH', `/orgs/${orgId}/plan`, { plan: 'paid' }); ok(r.j.plan === 'paid' && r.j.daysLeft === null && r.j.limits.members === 50, 'switch to paid');
  await plat('PATCH', '/config', { maxFreeOrgs: 1 }); r = await plat('POST', '/orgs', { name: 'Free A', adminEmail: 'a@a.test' }); ok(r.s === 201, 'one free org fits under the cap'); r = await plat('POST', '/orgs', { name: 'Free B', adminEmail: 'b@b.test' }); ok(r.s === 402, 'free-org cap enforced');
  ok((await plat('POST', '/orgs', { name: 'Paying C', adminEmail: 'c@c.test', plan: 'paid' })).s === 201, 'paid orgs ignore the free cap');

  srv.close(); hnnStub.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
