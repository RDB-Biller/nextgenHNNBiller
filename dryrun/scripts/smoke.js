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
  const atCalls = []; const atStub = http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { atCalls.push({ url: q.url, headers: q.headers, body: b }); r.setHeader('Content-Type', 'application/json'); if (q.url.startsWith('/sms')) return r.end(JSON.stringify({ SMSMessageData: { Recipients: [{ status: 'Success', messageId: 'm1' }] } })); r.end(JSON.stringify({ id: 'w1' })); }); }); await new Promise((r) => atStub.listen(0, r));
  const AT = { AT_API_KEY: 'atkey', AT_USERNAME: 'sandbox', AT_WA_NUMBER: '+233200000000', AT_SMS_URL: `http://127.0.0.1:${atStub.address().port}/sms`, AT_WA_URL: `http://127.0.0.1:${atStub.address().port}/wa` }; Object.assign(process.env, AT);
  const srv = app.listen(0); await new Promise((r) => srv.on('listening', r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, key, body, hdr = 'x-api-key', raw) => { const r = await fetch(base + url, { method, headers: { ...(raw ? { 'Content-Type': 'text/plain' } : { 'Content-Type': 'application/json' }), ...(key ? { [hdr]: key } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  const PK = 'test_platform_key'; const plat = (m, u, b) => call(m, '/api/platform' + u, PK, b, 'x-platform-key');

  section('Platform owner and accounts');
  ok((await call('POST', '/api/platform/orgs', 'wrong', {}, 'x-platform-key')).s === 401, 'bad platform key rejected');
  let r = await plat('POST', '/orgs', { name: 'Nationwide Medical Insurance', sector: 'insurer', adminName: 'Ama', adminEmail: 'ama@nationwide.test', pace: 'weeks' }); ok(r.s === 201 && r.j.admin.apiKey, 'org created with admin key');
  const orgId = r.j.org.id; const ADMIN = r.j.admin.apiKey; ok(r.j.org.plan === 'free_trial' && r.j.org.daysLeft > 50, 'starts on a free trial');
  ok((await call('GET', '/api/org', ADMIN)).j.pack.scenarios.length === 4, 'insurer pack offers four scenarios');
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


  section('Credentials by SMS and WhatsApp, and the directory');
  atCalls.length = 0;
  r = await plat('POST', '/orgs', { name: 'Gamma Insurance', adminName: 'Yaw', adminEmail: 'yaw@gamma.test', adminPhone: '0244123456', plan: 'paid', deliver: { sms: true, whatsapp: true } });
  ok(r.s === 201 && r.j.delivery.length === 2 && r.j.delivery.every((d) => d.ok), 'admin sign-in sent by SMS and WhatsApp'); const GAMMA = r.j.org.id, GADMIN = r.j.admin.apiKey;
  ok(atCalls.length === 2 && atCalls.every((c) => c.body.includes(GADMIN) || c.body.includes(encodeURIComponent(GADMIN))), 'the message carries the sign-in key'); ok(atCalls.some((c) => c.body.includes('%2B233244123456') || c.body.includes('+233244123456')), 'local number turned into +233 form');
  ok((await plat('POST', '/orgs', { name: 'Bad Phone', adminEmail: 'x@x.test', adminPhone: '12', plan: 'paid' })).s === 422, 'bad phone refused');
  r = await call('POST', '/api/org/team', GADMIN, { name: 'Efua', email: 'efua@gamma.test', phone: '0201234567', role: 'builder' }); ok(r.s === 201 && r.j.delivery.length === 2 && r.j.delivery.every((d) => d.ok), 'team invites default to SMS and WhatsApp');
  r = await call('POST', '/api/org/team', GADMIN, { name: 'Kojo', email: 'kojo@gamma.test', phone: '0201234568', role: 'viewer', deliver: { sms: true } }); ok(r.j.delivery.length === 1 && r.j.delivery[0].channel === 'sms', 'admin can pick SMS only'); const kojoId = r.j.id;
  r = await call('POST', '/api/org/team', GADMIN, { name: 'No Phone', email: 'np@gamma.test', role: 'viewer' }); ok(r.s === 201 && r.j.delivery.length === 0 && r.j.apiKey, 'no phone: key shown on screen instead');
  r = await plat('POST', `/orgs/${GAMMA}/members/${kojoId}/resend`, { deliver: { sms: true } }); ok(r.s === 200 && r.j.delivery[0].ok && r.j.apiKey, 'platform owner can re-send (issues a fresh key)');
  const dirOrg = (await plat('GET', '/directory')).j.find((o) => o.id === GAMMA); ok(dirOrg.members.length === 4 && dirOrg.members.some((m) => m.name === 'Efua' && m.addedBy === 'Yaw' && m.phone.includes('•')), 'directory shows who added whom, with masked phones');
  const msgs = (await plat('GET', '/messaging')).j; ok(msgs.configured.sms && msgs.recent.length >= 5 && !JSON.stringify(msgs.recent).includes(GADMIN), 'delivery log kept without keys');
  for (const k of Object.keys(AT)) delete process.env[k]; r = await plat('POST', '/orgs', { name: 'Delta Insurance', adminEmail: 'd@d.test', adminPhone: '0244000111', plan: 'paid', deliver: { sms: true } }); ok(r.s === 201 && r.j.delivery[0].ok === false && r.j.admin.apiKey, 'if SMS is not set up the org is still created and the key is shown'); Object.assign(process.env, AT);

  section('Product changes and the regulator');
  const baseProduct = { name: 'Outpatient cover', currency: 'GHS', premium: 70, benefitCap: 1800, coPayPct: 0, waitingDays: 30, exclusions: ['Cosmetic surgery'], hospitalTiers: [{ name: 'T1', costMultiple: 1 }, { name: 'T2', costMultiple: 1.6 }, { name: 'T3', costMultiple: 2.4 }], options: [{ name: 'Essential', tiers: ['T1'], premiumAdjPct: -8 }, { name: 'Standard', tiers: ['T1'], premiumAdjPct: 0 }] };
  const prod = (await call('POST', '/api/org/assets', BUILD, { kind: 'product', name: 'Outpatient cover', data: baseProduct })).j; ok(prod.classification === 'baseline', 'first version is the baseline');
  const widen = JSON.parse(JSON.stringify(baseProduct)); widen.options.push({ name: 'Choice', tiers: ['T1', 'T2'], premiumAdjPct: 0 }); widen.options[0].premiumAdjPct = -8;
  r = await call('POST', `/api/org/assets/${prod.id}/versions`, BUILD, { data: widen, note: 'Add higher-tier choice' }); let pd = (await call('GET', `/api/org/assets/${prod.id}`, BUILD)).j; ok(pd.versionList[1].classification.overall === 'none', 'adding a higher-tier hospital choice at the same premium needs no regulator approval');
  const dear = JSON.parse(JSON.stringify(widen)); dear.premium = 80; r = await call('POST', `/api/org/assets/${prod.id}/versions`, BUILD, { data: dear, note: 'Raise premium' }); pd = (await call('GET', `/api/org/assets/${prod.id}`, BUILD)).j; ok(pd.versionList[2].classification.overall === 'regulator', 'a premium increase needs the regulator');
  const deeper = JSON.parse(JSON.stringify(widen)); deeper.premium = 60; r = await call('POST', `/api/org/assets/${prod.id}/versions`, BUILD, { data: deeper, note: 'Big cut' }); pd = (await call('GET', `/api/org/assets/${prod.id}`, BUILD)).j; ok(pd.versionList[3].classification.overall === 'regulator', 'a cut beyond the discount limit needs the regulator');
  for (const to of ['dry_run', 'shadow']) await call('POST', `/api/org/assets/${prod.id}/promote`, BUILD, { version: 3, to }); r = await call('POST', `/api/org/assets/${prod.id}/promote`, APPR, { version: 3, to: 'approved' }); ok(r.s === 409, 'cannot approve a regulator-level version without the reference');
  ok((await call('POST', `/api/org/assets/${prod.id}/regulator`, BUILD, { version: 3, reference: 'X' })).s === 403, 'builder cannot record a regulator reference'); ok((await call('POST', `/api/org/assets/${prod.id}/regulator`, APPR, { version: 3, reference: 'NIC/2027/001' })).s === 200, 'approver records the reference'); ok((await call('POST', `/api/org/assets/${prod.id}/promote`, APPR, { version: 3, to: 'approved' })).s === 200, 'then it can be approved');
  r = await call('PUT', '/api/org/regulatory-rules', ADMIN, { maxDiscountPct: 5 }); ok(r.s === 200 && r.j.maxDiscountPct === 5, 'admin edits the rules'); ok((await call('PUT', '/api/org/regulatory-rules', BUILD, { maxDiscountPct: 50 })).s === 403, 'builder cannot edit rules'); await call('PUT', '/api/org/regulatory-rules', ADMIN, { maxDiscountPct: 10 });

  section('Plan options, campaign and surveys');
  const po = (await call('POST', '/api/org/runs', BUILD, { scenario: 'plan_options', name: 'tiers v1', inputs: { product: { assetId: prod.id, version: 3 } }, seed: 4 })).j; ok(po.result.options.length === 3 && po.headline.lossRatioPct > 0, 'plan options run on the uploaded product'); ok(po.result.options.some((o) => o.capReachedPct > 0), 'higher-tier members reach their cap');
  const poc = (await call('POST', `/api/org/runs/${po.id}/coach`, BUILD, {})).j; ok(Array.isArray(poc.suggestions) && poc.suggestions.every((x) => x.regulatory && x.draft.kind === 'product'), 'Coach labels each suggestion with its regulator status');
  const cm = (await call('POST', '/api/org/runs', BUILD, { scenario: 'campaign', name: 'win back', seed: 2 })).j; ok(cm.headline.signups > 0 && cm.result.byChannel.length === 2, 'campaign run'); const cmc = (await call('POST', `/api/org/runs/${cm.id}/coach`, BUILD, {})).j; ok(cmc.suggestions.length <= 1, 'campaign Coach');
  const tpl = (await call('GET', '/api/org', ADMIN)).j.pack.surveyTemplates[0]; const sv = (await call('POST', '/api/org/surveys', BUILD, { title: tpl.title, purpose: tpl.purpose, questions: tpl.questions })).j; ok(sv.token && sv.questions.length === 5, 'survey created from the template');
  const pubV = await call('GET', `/api/public/survey/${sv.token}`, null); ok(pubV.s === 200 && pubV.j.open && !JSON.stringify(pubV.j).includes('feeds'), 'public page needs no key and hides internals');
  const q2 = sv.questions[1].id; for (let i = 0; i < 6; i++) r = await call('POST', `/api/public/survey/${sv.token}`, null, { answers: { [sv.questions[0].id]: 'Local clinic or health centre', [q2]: i < 3 ? 'Yes' : 'No', [sv.questions[2].id]: 20 + i, [sv.questions[4].id]: 'Call me on 0244123456 or mail a@b.com' } }); ok(r.s === 201, 'answers accepted');
  ok((await call('POST', `/api/public/survey/${sv.token}`, null, { answers: { [q2]: 'Maybe' } })).s === 422, 'answer outside the options refused');
  const res = (await call('GET', `/api/org/surveys/${sv.id}/results`, BUILD)).j; ok(res.feeds[0].param === 'desireHigherTierPct' && res.feeds[0].value === 50, 'survey result feeds the scenario setting (50% said yes)'); ok(!JSON.stringify(res).includes('0244123456') && !JSON.stringify(res).includes('a@b.com'), 'phone numbers and emails scrubbed from free text');
  ok((await call('POST', `/api/public/survey/not.valid`, null, { answers: { x: 1 } })).s === 404, 'bad link'); await call('POST', `/api/org/surveys/${sv.id}/status`, BUILD, { status: 'closed' }); ok((await call('POST', `/api/public/survey/${sv.token}`, null, { answers: { [q2]: 'Yes' } })).s === 410, 'closed survey refuses answers');
  await call('POST', `/api/org/surveys/${sv.id}/status`, BUILD, { status: 'open' }); atCalls.length = 0; r = await call('POST', `/api/org/surveys/${sv.id}/invite`, BUILD, { phones: ['0244000001', '0244000002'], channels: { sms: true } }); ok(r.j.sent === 2 && atCalls.every((c) => c.body.includes('s.html')), 'survey link sent by SMS');

  section('Dry Run Live');
  const lv0 = await call('POST', '/api/org/live', APPR, { name: 'Early', productAssetId: prod.id, version: 2, cohortCap: 100 }); ok(lv0.s === 409, 'only approved versions can go live');
  r = await call('POST', '/api/org/live', BUILD, { name: 'x', productAssetId: prod.id, version: 3, cohortCap: 100 }); ok(r.s === 403, 'builder cannot start a live programme');
  r = await call('POST', '/api/org/live', APPR, { name: 'Outpatient beta', productAssetId: prod.id, version: 3, cohortCap: 200, forecastRunId: po.id, managed: true }); ok(r.s === 201 && r.j.status === 'planned' && r.j.forecast.lossRatioPct > 0, 'programme created from the approved version with its forecast'); const LV = r.j.id;
  ok((await call('POST', `/api/org/live/${LV}/status`, APPR, { status: 'live' })).s === 422, 'must start as beta'); ok((await call('POST', `/api/org/live/${LV}/status`, APPR, { status: 'beta' })).j.status === 'beta', 'beta started');
  ok((await call('POST', `/api/org/live/${LV}/status`, APPR, { status: 'live' })).s === 409, 'cannot go live before any actuals');
  r = await call('POST', `/api/org/live/${LV}/actuals`, BUILD, { period: '2026-12', members: 150, premiumCollected: 10000, claimsPaid: 6000, capReachedMembers: 3 }); ok(r.s === 200 && r.j.totals.lossRatioPct === 60 && r.j.health === 'on track', 'actuals within guardrails: on track');
  r = await call('POST', `/api/org/live/${LV}/actuals`, BUILD, { period: '2027-01', members: 160, premiumCollected: 10500, claimsPaid: 13000, capReachedMembers: 40 }); ok(r.j.health === 'breach' && r.j.alerts.length >= 1, 'loss ratio breach raises an alert');
  ok((await call('POST', `/api/org/live/${LV}/status`, APPR, { status: 'live' })).s === 409, 'cannot go live while a guardrail is breached'); ok((await call('POST', `/api/org/live/${LV}/status`, APPR, { status: 'paused' })).s === 422, 'pausing needs a reason'); ok((await call('POST', `/api/org/live/${LV}/status`, APPR, { status: 'paused', note: 'Loss ratio above guardrail' })).j.status === 'paused', 'paused with a reason');
  ok((await call('POST', `/api/org/live/${LV}/actuals`, BUILD, { period: 'Jan', members: 1, premiumCollected: 1, claimsPaid: 1 })).s === 422, 'bad period refused'); const lg2 = (await call('GET', `/api/org/live/${LV}`, BUILD)).j; ok(lg2.decisions.length >= 3, 'decisions are recorded');
  const allLive = (await plat('GET', '/live')).j; ok(allLive.some((x) => x.id === LV && x.managed && x.health === 'breach'), 'platform owner sees programmes across organisations'); ok((await plat('PATCH', `/live/${orgId}/${LV}`, { serviceTerms: 'Managed beta, 12 months' })).j.serviceTerms.includes('Managed'), 'service terms set by the platform owner');

  section('Partner network');
  r = await plat('POST', '/orgs', { name: 'Fieldwork Partners Ltd', sector: 'research_firm', adminEmail: 'r@fw.test', plan: 'paid' }); ok(r.s === 201 && r.j.org.pack === 'research_firm', 'research firm account created'); const RES = r.j.org.id, RKEY = r.j.admin.apiKey;
  r = await plat('POST', '/orgs', { name: 'Launch and Run Ltd', sector: 'operator', adminEmail: 'o@lr.test', plan: 'paid' }); const OPR = r.j.org.id, OKEY = r.j.admin.apiKey;
  ok((await call('GET', '/api/org/partners', ADMIN)).j.length === 0, 'unlisted partners are not visible to clients'); await plat('PATCH', `/orgs/${RES}/partner`, { listed: true, description: 'Household and member surveys', services: 'Fieldwork, surveys' }); await plat('PATCH', `/orgs/${OPR}/partner`, { listed: true, description: 'Launch and monitoring' });
  ok((await plat('PATCH', `/orgs/${orgId}/partner`, { listed: true })).s === 422, 'a client cannot be listed as a partner'); const listed = (await call('GET', '/api/org/partners', ADMIN)).j; ok(listed.length === 2 && listed.some((x) => x.role === 'researcher') && listed.some((x) => x.role === 'operator'), 'clients see listed partners');
  const svOwn = (await call('POST', '/api/org/surveys', BUILD, { title: 'Client survey', questions: [{ type: 'choice', prompt: 'A?', options: ['x', 'y'] }] })).j;
  ok((await call('POST', '/api/org/engagements', BUILD, { partnerOrgId: RES, scope: { surveyIds: 'all' } })).s === 403, 'only a client admin can make an offer'); ok((await call('POST', '/api/org/engagements', ADMIN, { partnerOrgId: RES, scope: {} })).s === 422, 'scope is required');
  r = await call('POST', '/api/org/engagements', ADMIN, { partnerOrgId: RES, scope: { surveyIds: [svOwn.id] }, fee: { oneOff: 5000, fixedPerMonth: 1000, commissionPct: 0 }, note: 'Member needs study' }); ok(r.s === 201 && r.j.status === 'offered' && r.j.platformSharePct === undefined, 'offer made; our share is hidden from the client'); const ENG1 = r.j.id;
  ok((await call('GET', `/api/org/engagements/${ENG1}/work/surveys`, RKEY)).s === 409, 'no access before accepting'); ok((await call('POST', `/api/org/engagements/${ENG1}/accept`, ADMIN)).s === 403, 'client cannot accept on the partner\'s behalf');
  const pe = (await call('GET', '/api/org/engagements', RKEY)).j; ok(pe.length === 1 && pe[0].side === 'partner' && pe[0].platformSharePct === 10, 'partner sees the offer and the platform share'); ok((await call('POST', `/api/org/engagements/${ENG1}/accept`, RKEY)).j.status === 'active', 'partner accepts');
  r = await call('GET', `/api/org/engagements/${ENG1}/work/surveys`, RKEY); ok(r.s === 200 && r.j.length === 1 && r.j[0].id === svOwn.id, 'researcher sees only the survey they were given');
  const other = (await call('POST', '/api/org/surveys', BUILD, { title: 'Private survey', questions: [{ type: 'choice', prompt: 'B?', options: ['x', 'y'] }] })).j; ok((await call('GET', `/api/org/engagements/${ENG1}/work/surveys/${other.id}/results`, RKEY)).s === 403, 'other surveys stay private');
  r = await call('POST', `/api/org/engagements/${ENG1}/work/surveys`, RKEY, { title: 'Fieldwork round 1', questions: [{ type: 'rating', prompt: 'How satisfied?' }] }); ok(r.s === 201, 'researcher creates a survey in the client workspace'); ok((await call('GET', `/api/org/engagements/${ENG1}/work/surveys`, RKEY)).j.length === 2, 'it joins their scope');
  ok((await call('GET', `/api/org/engagements/${ENG1}/work/live`, RKEY)).s === 403, 'a researcher cannot touch programmes'); ok((await call('GET', '/api/org/assets', RKEY)).j.length === 0, 'partner sees none of the client library');
  ok((await call('GET', '/api/org/audit', ADMIN)).j.some((x) => x.action === 'survey.create' && x.by.name.includes('Fieldwork Partners')), 'client audit log names the partner');
  r = await call('POST', '/api/org/engagements', ADMIN, { partnerOrgId: OPR, scope: { liveIds: [LV] }, fee: { oneOff: 0, fixedPerMonth: 2000, commissionPct: 3 } }); const ENG2 = r.j.id; await call('POST', `/api/org/engagements/${ENG2}/accept`, OKEY);
  r = await call('GET', `/api/org/engagements/${ENG2}/work/live`, OKEY); ok(r.s === 200 && r.j.length === 1, 'operator sees the programme given'); ok((await call('POST', `/api/org/engagements/${ENG2}/work/live/${LV}/status`, OKEY, { status: 'live' })).s === 403, 'operator cannot go live');
  ok((await call('POST', `/api/org/engagements/${ENG2}/work/live/${LV}/notes`, OKEY, { note: 'Weekly check done' })).s === 200, 'operator adds notes'); await call('POST', `/api/org/live/${LV}/status`, APPR, { status: 'beta' });
  ok((await call('POST', `/api/org/engagements/${ENG2}/work/live/${LV}/actuals`, OKEY, { period: '2027-02', members: 170, premiumCollected: 20000, claimsPaid: 9000, capReachedMembers: 5 })).s === 200, 'operator records the month'); ok((await call('POST', `/api/org/engagements/${ENG2}/work/live/${LV}/status`, OKEY, { status: 'paused', note: 'Precaution' })).s === 200, 'operator can pause');
  const stC = (await call('GET', `/api/org/engagements/${ENG2}/statement`, ADMIN)).j, stP = (await call('GET', `/api/org/engagements/${ENG2}/statement`, OKEY)).j; ok(stC.totals.total === stP.totals.total && stC.totals.platformShare === undefined, 'client sees the total only'); ok(stP.totals.platformShare > 0 && stP.totals.partnerNet === Math.round((stP.totals.total - stP.totals.platformShare) * 100) / 100, 'partner sees our share and their net');
  ok(stP.lines.some((l) => l.item.startsWith('Commission') && l.amount === 600), 'commission is 3% of premium collected (600 on 20,000)');
  r = await plat('PATCH', `/engagements/${ENG2}`, { platformSharePct: 25 }); ok(r.s === 200 && r.j.platformSharePct === 25, 'platform owner sets our share'); ok((await plat('GET', '/engagements')).j.length === 2, 'platform owner sees all engagements');
  ok((await call('POST', `/api/org/engagements/${ENG1}/end`, ADMIN)).j.status === 'ended', 'client can end an engagement'); ok((await call('GET', `/api/org/engagements/${ENG1}/work/surveys`, RKEY)).s === 409, 'access stops when it ends');

  section('Plans, trial expiry and caps');
  const raw = orgs.raw(orgId); raw.trialEndsAt = new Date(Date.now() - 5 * 86400000).toISOString(); ok((await call('GET', '/api/org', ADMIN)).j.org.status === 'grace', 'after trial: grace');
  ok((await call('POST', '/api/org/assets', BUILD, { kind: 'product', name: 'p', data: {} })).s === 201, 'still writable in grace');
  raw.trialEndsAt = new Date(Date.now() - 45 * 86400000).toISOString(); ok((await call('GET', '/api/org', ADMIN)).j.org.status === 'read_only', 'after grace: read-only');
  ok((await call('POST', '/api/org/assets', BUILD, { kind: 'product', name: 'q', data: {} })).s === 402, 'read-only blocks writes'); ok((await call('GET', '/api/org/assets', BUILD)).s === 200, 'but reading still works');
  r = await plat('PATCH', `/orgs/${orgId}/plan`, { extendDays: 30 }); ok(r.j.status === 'active' && r.j.plan === 'extended_trial', 'extending a trial reopens the workspace');
  r = await plat('PATCH', `/orgs/${orgId}/plan`, { plan: 'paid' }); ok(r.j.plan === 'paid' && r.j.daysLeft === null && r.j.limits.members === 50, 'switch to paid');
  await plat('PATCH', '/config', { maxFreeOrgs: 1 }); r = await plat('POST', '/orgs', { name: 'Free A', adminEmail: 'a@a.test' }); ok(r.s === 201, 'one free org fits under the cap'); r = await plat('POST', '/orgs', { name: 'Free B', adminEmail: 'b@b.test' }); ok(r.s === 402, 'free-org cap enforced');
  ok((await plat('POST', '/orgs', { name: 'Paying C', adminEmail: 'c@c.test', plan: 'paid' })).s === 201, 'paid orgs ignore the free cap');

  srv.close(); hnnStub.close(); atStub.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
