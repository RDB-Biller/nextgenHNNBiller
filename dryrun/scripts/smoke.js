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
  ok((await call('GET', '/api/org', ADMIN)).j.pack.scenarios.length === 5, 'insurer pack offers five scenarios');
  ok((await plat('POST', '/orgs', { name: 'X', sector: 'nope', adminEmail: 'x@x.test' })).s === 422, 'unknown pack refused');

  section('Team, roles and limits');
  const b = (await call('POST', '/api/org/team', ADMIN, { name: 'Kofi', email: 'kofi@nationwide.test', role: 'builder' })).j; const ap = (await call('POST', '/api/org/team', ADMIN, { name: 'Esi', email: 'esi@nationwide.test', role: 'approver' })).j;
  ok(b.apiKey && ap.apiKey, 'members added'); const BUILD = b.apiKey, APPR = ap.apiKey;
  ok((await call('POST', '/api/org/team', ADMIN, { name: 'Four', email: 'four@nationwide.test' })).s === 201, 'free plan allows a 4th member'); ok((await call('POST', '/api/org/team', ADMIN, { name: 'Five', email: 'five@nationwide.test' })).s === 201, 'free plan allows a 5th member'); r = await call('POST', '/api/org/team', ADMIN, { name: 'Six', email: 'six@nationwide.test' }); ok(r.s === 402, 'free plan stops at 5 members: ' + r.s);
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
  const gpw = r.j.admin.password, gun = r.j.admin.username; const dec = (c) => decodeURIComponent(c.body.replace(/\+/g, ' ')); ok(atCalls.length === 2 && atCalls.every((c) => dec(c).includes(gpw) && dec(c).includes(gun)), 'the message carries the username and password'); ok(atCalls.some((c) => c.body.includes('%2B233244123456') || c.body.includes('+233244123456')), 'local number turned into +233 form');
  ok((await plat('POST', '/orgs', { name: 'Bad Phone', adminEmail: 'x@x.test', adminPhone: '12', plan: 'paid' })).s === 422, 'bad phone refused');
  r = await call('POST', '/api/org/team', GADMIN, { name: 'Efua', email: 'efua@gamma.test', phone: '0201234567', role: 'builder' }); ok(r.s === 201 && r.j.delivery.length === 2 && r.j.delivery.every((d) => d.ok), 'team invites default to SMS and WhatsApp');
  r = await call('POST', '/api/org/team', GADMIN, { name: 'Kojo', email: 'kojo@gamma.test', phone: '0201234568', role: 'viewer', deliver: { sms: true } }); ok(r.j.delivery.length === 1 && r.j.delivery[0].channel === 'sms', 'admin can pick SMS only'); const kojoId = r.j.id;
  r = await call('POST', '/api/org/team', GADMIN, { name: 'No Phone', email: 'np@gamma.test', role: 'viewer' }); ok(r.s === 201 && r.j.delivery.length === 0 && r.j.password && r.j.username, 'no phone: username and password shown on screen instead');
  r = await plat('POST', `/orgs/${GAMMA}/members/${kojoId}/resend`, { deliver: { sms: true } }); ok(r.s === 200 && r.j.delivery[0].ok && r.j.password, 'platform owner can re-send (issues a fresh password)');
  { // platform owner: set a phone, resend with a sign-in link, message one person or an org
    const gd = await plat('GET', '/directory'); const gm = gd.j.find((o) => o.id === GAMMA).members.find((m) => m.id === kojoId);
    r = await plat('PATCH', `/orgs/${GAMMA}/members/${gm.id}`, { phone: '12' }); ok(r.s === 422, 'a bad phone number is refused when the owner sets it');
    r = await plat('PATCH', `/orgs/${GAMMA}/members/${gm.id}`, { phone: '0244111222' }); ok(r.s === 200, 'platform owner can set a phone number');
    atCalls.length = 0; r = await plat('POST', `/orgs/${GAMMA}/members/${gm.id}/resend`, { deliver: { sms: true } }); const rt = decodeURIComponent(atCalls[0].body.replace(/\+/g, ' '));
    ok(r.s === 200 && atCalls.length === 1 && rt.includes('/app?u=' + r.j.username) && rt.includes(r.j.password), 'resent sign-in text carries a link with the username filled in');
    atCalls.length = 0; r = await plat('POST', `/orgs/${GAMMA}/message`, { memberId: gm.id, text: 'Hello from Dry Run' }); ok(r.s === 200 && r.j.sent === 1 && atCalls.length === 1 && decodeURIComponent(atCalls[0].body.replace(/\+/g, ' ')).includes('Hello from Dry Run'), 'owner can message one person');
    r = await plat('POST', `/orgs/${GAMMA}/message`, { to: 'all', text: '' }); ok(r.s === 422, 'an empty message is refused');
    r = await plat('POST', `/orgs/${GAMMA}/message`, { to: 'admins', text: 'Admins only' }); ok(r.s === 200 && r.j.results.every((x) => x.name), 'owner can message an org\'s admins');
  }
  const dirOrg = (await plat('GET', '/directory')).j.find((o) => o.id === GAMMA); ok(dirOrg.members.length === 4 && dirOrg.members.some((m) => m.name === 'Efua' && m.addedBy === 'Yaw' && m.phone.includes('•')), 'directory shows who added whom, with masked phones');
  const msgs = (await plat('GET', '/messaging')).j; ok(msgs.configured.sms && msgs.recent.length >= 5 && !JSON.stringify(msgs.recent).includes(gpw), 'delivery log kept without passwords');
  for (const k of Object.keys(AT)) delete process.env[k]; r = await plat('POST', '/orgs', { name: 'Delta Insurance', adminEmail: 'd@d.test', adminPhone: '0244000111', plan: 'paid', deliver: { sms: true } }); ok(r.s === 201 && r.j.delivery[0].ok === false && r.j.admin.password, 'if SMS is not set up the org is still created and the password is shown'); Object.assign(process.env, AT);

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

  section('Username and password sign-in, messages, requests and demo');
  r = await call('POST', '/api/login', null, { username: gun, password: 'wrong' }); ok(r.s === 401, 'wrong password refused');
  r = await call('POST', '/api/login', null, { username: gun, password: gpw }); ok(r.s === 200 && r.j.sessionKey && r.j.mustChange, 'sign in with the texted username and password'); const SESS = r.j.sessionKey;
  ok((await call('GET', '/api/org/assets', SESS)).s === 403, 'a temporary password must be changed first'); ok((await call('GET', '/api/org', SESS)).s === 200, 'but the page can still load');
  ok((await call('POST', '/api/org/password', SESS, { current: gpw, next: 'short' })).s === 422, 'weak new password refused'); ok((await call('POST', '/api/org/password', SESS, { current: gpw, next: 'BetterPass2027' })).s === 200, 'password changed'); ok((await call('GET', '/api/org/assets', SESS)).s === 200, 'then the workspace opens');
  ok((await call('POST', '/api/login', null, { username: gun, password: gpw })).s === 401, 'the temporary password stops working'); ok((await call('POST', '/api/login', null, { username: gun.toUpperCase(), password: 'BetterPass2027' })).s === 200, 'usernames are not case-sensitive');
  for (let i = 0; i < 5; i++) await call('POST', '/api/login', null, { username: 'nobody.here', password: 'x' }); ok((await call('POST', '/api/login', null, { username: 'nobody.here', password: 'x' })).s === 429, 'repeated failures are locked out');
  const prev = (await plat('POST', '/message-preview', { org: 'XYZ Insurance', name: 'Ama Mensah', email: 'ama@xyz-insurance.com' })).j; ok(prev.admin.includes('Username:') && prev.admin.includes('/app?go=admin') && prev.admin.includes('clicking on Team') && !prev.admin.includes('dryrun.xyz-insurance.com') && !prev.admin.includes('/join?ref=') && !prev.admin.includes('/join?team='), 'admin message is short: username, interface, admin console and the Team how-to; no domain offer or invite links');
  ok(prev.teammate.includes('Username:') && !prev.teammate.includes('Admin console') && !prev.teammate.includes('own address') && prev.teammate.includes('/join?ref=') && prev.teammate.includes('/join?team='), 'teammate message has no admin console or domain offer, but has the invite link');
  ok(!(await plat('POST', '/message-preview', { email: 'x@gmail.com' })).j.admin.includes('e.g.'), 'no domain example for free email addresses');
  atCalls.length = 0; await call('POST', `/api/org/surveys/${sv.id}/invite`, BUILD, { phones: ['0244000009'], channels: { sms: true } }); ok(atCalls.length === 1 && dec(atCalls[0]).includes('/join?ref='), 'survey messages carry the invite link too');
  ok((await call('POST', '/api/org/domain-request', ADMIN, { domain: 'nope' })).s === 422, 'bad domain refused'); ok((await call('POST', '/api/org/domain-request', ADMIN, { domain: 'dryrun.nationwide.com.gh' })).j.status === 'requested', 'admin requests their own address'); ok((await plat('PATCH', `/orgs/${orgId}/domain`, { status: 'connected' })).j.status === 'connected', 'platform owner marks it connected');
  const ref = require('../src/orgs').refCode(orgId); r = await call('POST', '/api/public/request-account', null, { organisation: 'Kasapreko Bank', contactName: 'Nana', email: 'nana@kb.test', phone: '0244555000', sector: 'bank', interest: 'Test a new loan product', ref }); ok(r.s === 201, 'account request received');
  ok((await call('POST', '/api/public/request-account', null, { organisation: 'Kasapreko Bank', contactName: 'Nana', email: 'nana@kb.test' })).s === 409, 'duplicate request noticed'); ok((await call('POST', '/api/public/request-account', null, { organisation: 'X', contactName: 'Y', email: 'bad' })).s === 422, 'bad email refused'); ok((await call('POST', '/api/public/request-account', null, { organisation: 'Bot', contactName: 'B', email: 'b@b.test', website: 'spam.com' })).j.received === true, 'honeypot swallows bots'); 
  let rq = (await plat('GET', '/requests')).j; ok(rq.pending === 1 && rq.requests[0].referredBy.name === 'Nationwide Medical Insurance', 'platform owner sees the request and who introduced them');
  atCalls.length = 0; r = await plat('POST', `/requests/${rq.requests[0].id}/approve`, {}); ok(r.s === 200 && r.j.org.name === 'Kasapreko Bank' && r.j.delivery.every((d) => d.ok) && atCalls.length === 2, 'approving creates the organisation and sends the sign-in details'); ok((await plat('GET', '/requests')).j.pending === 0, 'request is cleared');
  ok((await plat('POST', `/requests/${rq.requests[0].id}/approve`, {})).s === 409, 'cannot approve twice');
  r = await call('POST', '/api/public/demo', null, {}); ok(r.s === 201 && r.j.sessionKey, 'demo workspace opens with no sign-up'); const DK = r.j.sessionKey; const dm = (await call('GET', '/api/org', DK)).j; ok(dm.demo && dm.org.plan === 'demo', 'it is marked as a demo');
  ok((await call('GET', '/api/org/assets', DK)).j.length >= 4 && (await call('GET', '/api/org/runs', DK)).j.length === 3 && (await call('GET', '/api/org/surveys', DK)).j[0].responses === 8, 'demo comes with sample assets, runs and survey answers');
  ok((await call('POST', '/api/org/team', DK, { name: 'A', email: 'a@a.test' })).s === 402, 'demo has one seat'); ok((await call('POST', '/api/org/surveys/' + (await call('GET', '/api/org/surveys', DK)).j[0].id + '/invite', DK, { phones: ['0244000000'] })).s === 403, 'demo cannot send messages'); ok((await call('PUT', '/api/org/storage', DK, { kind: 'file', dir: '/tmp/x' })).s === 403, 'demo cannot move data');
  ok((await plat('GET', '/orgs')).j.filter((o) => o.plan === 'demo').length === 1, 'demos are listed'); const freeBefore = (await plat('GET', '/config')).j.caps.maxFreeOrgs; ok(freeBefore !== undefined, 'config readable');
  orgs.raw((await plat('GET', '/orgs')).j.find((o) => o.plan === 'demo').id).trialEndsAt = new Date(Date.now() - 1000).toISOString(); await require('../src/demo').sweep(); ok((await plat('GET', '/orgs')).j.filter((o) => o.plan === 'demo').length === 0, 'expired demos are deleted');
  ok((await call('GET', '/app', null)).s !== 500, 'app route answers');

  section('Team invites versus general invites');
  r = await call('GET', '/api/org/team-invite', ADMIN); ok(r.s === 200 && r.j.on && /\/join\?team=tm_/.test(r.j.url), 'org has its own team invite link'); const TTOK = r.j.url.split('team=')[1]; ok(!r.j.url.includes('ref='), 'team link is not the general invite link');
  ok((await call('GET', '/api/org/team-invite', APPR)).s === 403, 'only admins see it');
  ok((await call('POST', '/api/org/team-invite/send', ADMIN, { phones: ['0244111333', '0244111444'] })).j.sent === 2, 'Quick Invite texts the team link to several numbers'); ok((await call('POST', '/api/org/team-invite/send', ADMIN, { phones: ['a','b','c','d','e','f','g'] })).j.failed.length === 5, 'Quick Invite caps at five numbers'); ok((await call('POST', '/api/org/team-invite/send', ADMIN, { phones: [] })).s === 422, 'Quick Invite needs at least one number'); ok((await call('POST', '/api/org/team-invite/send', APPR, { phones: ['0244111555'] })).s === 403, 'approvers and viewers who cannot write cannot Quick Invite');
  ok((await call('GET', '/api/public/team-invite/' + TTOK, null)).j.org === 'Nationwide Medical Insurance', 'public page can show which team it is for'); ok((await call('GET', '/api/public/team-invite/nope', null)).s === 404, 'bad link refused');
  r = await call('POST', '/api/public/request-team', null, { token: TTOK, contactName: 'Efua Boateng', email: 'efua@nationwide.test', phone: '0244111222', jobTitle: 'Actuary' }); ok(r.s === 201 && r.j.org, 'colleague asks to join');
  ok((await call('POST', '/api/public/request-team', null, { token: TTOK, contactName: 'Efua', email: 'efua@nationwide.test' })).s === 409, 'duplicate noticed'); ok((await call('POST', '/api/public/request-team', null, { token: 'nope', contactName: 'X', email: 'x@x.test' })).s === 404, 'bad token refused');
  ok((await plat('GET', '/requests')).j.requests.every((q) => q.type !== 'team'), 'platform owner queue stays for new organisations only');
  let tr = (await call('GET', '/api/org/team-requests', ADMIN)).j; ok(tr.length === 1 && tr[0].status === 'new', 'the org admin sees the request'); ok((await call('GET', '/api/org/team-requests', BUILD)).s === 403, 'builders do not');
  ok((await call('POST', `/api/org/team-requests/${tr[0].id}/approve`, ADMIN, { role: 'viewer' })).s === 402, 'approval respects the plan seat limit'); await plat('PATCH', `/orgs/${orgId}/plan`, { plan: 'paid' }); atCalls.length = 0; r = await call('POST', `/api/org/team-requests/${tr[0].id}/approve`, ADMIN, { role: 'viewer' }); ok(r.s === 200 && r.j.role === 'viewer' && r.j.username && atCalls.length === 2 && dec(atCalls[0]).includes('/join?team='), 'admin approves with a role and sign-in details are sent');
  ok((await call('POST', `/api/org/team-requests/${tr[0].id}/approve`, ADMIN, { role: 'viewer' })).s === 409, 'cannot approve twice');
  { // SMS notifications around team requests
    const tm = (await call('GET', '/api/org/team', ADMIN)).j; const lead = tm.find((m) => m.role === 'admin'); const bld = tm.find((m) => m.role === 'builder');
    await plat('PATCH', `/orgs/${orgId}/members/${lead.id}`, { phone: '0244900001' }); await plat('PATCH', `/orgs/${orgId}/members/${bld.id}`, { phone: '0244900002' });
    const txt = () => atCalls.map((c) => dec(c)); atCalls.length = 0;
    r = await call('POST', '/api/org/team-invite/send', BUILD, { phones: ['0244900003'] }); ok(r.s === 200 && r.j.sent === 1 && txt()[0].includes('&by=' + bld.id), 'a team member can invite a colleague, and the link carries who invited');
    ok((await call('POST', '/api/org/team-invite/send', BUILD, { phones: [] })).s === 422, 'an empty invitation list is refused');
    atCalls.length = 0; r = await call('POST', '/api/public/request-team', null, { token: TTOK, by: bld.id, contactName: 'Kojo Asare', email: 'kojo.asare@nationwide.test', phone: '0244900004', jobTitle: 'Analyst' });
    ok(r.s === 201 && atCalls.length === 1 && /asked to join/.test(txt()[0]) && /invited by/.test(txt()[0]) && txt()[0].includes('/app?go=admin') && txt()[0].includes('Kojo Asare'), 'the team lead gets a pending-request text with a link, saying who invited');
    r = await call('POST', '/api/public/request-team', null, { token: TTOK, by: 'mem_nonsense', contactName: 'Yaa Pee', email: 'yaa.pee@nationwide.test', phone: '0244900005' }); ok(r.s === 201, 'an unknown inviter id is ignored');
    const pend = (await call('GET', '/api/org/team-requests', ADMIN)).j.filter((q) => q.status === 'new'); const kq = pend.find((q) => q.contactName === 'Kojo Asare'), yq = pend.find((q) => q.contactName === 'Yaa Pee'); ok(kq.invitedBy && kq.invitedBy.id === bld.id && !yq.invitedBy, 'the inviter is recorded only when real');
    atCalls.length = 0; r = await call('POST', `/api/org/team-requests/${kq.id}/approve`, ADMIN, { role: 'viewer', deliver: { sms: true } }); const ap = txt();
    ok(r.s === 200 && atCalls.length === 3, 'approving texts the person, the team lead and the inviter');
    ok(ap.some((t) => /Username/.test(t) && /\/app\?u=/.test(t)) && ap.some((t) => /added Kojo Asare to the/.test(t) && t.includes('/app?go=admin')) && ap.some((t) => /who you invited/.test(t) && /\/app/.test(t)), 'each text is right and carries a link to the platform');
    atCalls.length = 0; r = await call('POST', `/api/org/team-requests/${yq.id}/decline`, ADMIN, { reason: 'Not on this team' }); const dc = txt();
    ok(r.s === 200 && atCalls.length === 2 && dc.some((t) => /not approved: Not on this team/.test(t) && /\/join/.test(t)) && dc.some((t) => /declined Yaa Pee/.test(t) && t.includes('/app?go=admin')), 'declining texts the person and the team lead, each with a link');
  }
  r = await call('POST', '/api/org/team-invite/rotate', ADMIN, {}); ok(r.j.url.split('team=')[1] !== TTOK && (await call('GET', '/api/public/team-invite/' + TTOK, null)).s === 404, 'a new link retires the old one');
  await call('POST', '/api/org/team-invite/off', ADMIN, {}); await plat('PATCH', `/orgs/${orgId}/plan`, { plan: 'free_trial' }); ok((await call('GET', '/api/public/team-invite/' + r.j.url.split('team=')[1], null)).s === 404, 'switching off stops requests');
  atCalls.length = 0; { const fp = await call('POST', '/api/public/forgot-password', null, { username: gun }); ok(fp.s === 200 && atCalls.length === 1 && atCalls[0].url.startsWith('/sms') && dec(atCalls[0]).includes('temporary password'), 'forgot-password texts a new temporary password by SMS'); } ok((await call('POST', '/api/public/forgot-password', null, { username: 'nobody.nowhere' })).s === 200, 'forgot-password gives a generic answer for unknown usernames'); ok((await call('POST', '/api/login', null, { username: gun, password: gpw })).s === 401, 'the previous password stops working after a reset');
  { const hr = await fetch(base + '/innovations'); const ht = await hr.text(); ok(hr.status === 200 && /text\/html/.test(hr.headers.get('content-type') || '') && /id="innovroot"/.test(ht) && /\/innov\.js/.test(ht) && /HNN/.test(ht), 'public innovations page is served without sign-in'); } ok((await fetch(base + '/ai')).status === 200, 'the /ai alias serves the innovations page');
  { const jr = await fetch(base + '/innov.js'); const jt = await jr.text(); ok(jr.status === 200 && /renderInnov/.test(jt) && /AI Adjudication Ladder/.test(jt), 'shared innov.js is served'); }
  { const ix = await (await fetch(base + '/')).text(); ok(/id="innovroot"/.test(ix) && /\/innov\.js/.test(ix) && /class="hnn"/.test(ix), 'home page features the innovations tabs and HNN badge'); }
  { const jn = await (await fetch(base + '/join')).text(); ok(/id="innovroot"/.test(jn) && /\/innov\.js/.test(jn), 'join page features the innovations before the form'); }

  section('Fintech designs, proposes, insurer accepts');
  const fs2 = require('fs'), path2 = require('path'); const walk = (d) => fs2.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path2.join(d, e.name)) : [path2.join(d, e.name)]);
  const hits = [...walk(path2.join(__dirname, '../src')), ...walk(path2.join(__dirname, '../public'))].filter((f) => /\b(MTN|Boost|Xtra|Nationwide)\b/i.test(fs2.readFileSync(f, 'utf8'))); ok(hits.length === 0, 'no brand names in the product code or pages' + (hits.length ? ': ' + hits.join(', ') : ''));
  r = await plat('POST', '/orgs', { name: 'Payly Fintech', adminName: 'Yaw Mensah', adminEmail: 'yaw@payly.test', sector: 'fintech' }); ok(r.s === 201, 'fintech organisation created'); const FIN = r.j.admin.apiKey; const finId = r.j.org.id;
  const fpack = (await call('GET', '/api/org', FIN)).j.pack; ok(fpack.status === 'ready' && fpack.scenarios.map((x) => x.key).join() === 'premium_financing,copay_cash', 'fintech pack offers the two facility scenarios');
  const offer = require('../src/scenarios/financing').DEFAULT_OFFER(); r = await call('POST', '/api/org/assets', FIN, { kind: 'finance_offer', name: 'Quarterly premium and cover cash', data: offer }); ok(r.s === 201, 'finance offer saved'); const OFF = r.j.id;
  ok((await call('POST', '/api/org/assets', FIN, { kind: 'finance_offer', name: 'bad', data: { x: 1 } })).s === 422, 'an empty offer is refused');
  r = await call('POST', '/api/org/runs', FIN, { scenario: 'premium_financing', name: 'Quarterly v1', inputs: { finance_offer: { assetId: OFF } }, params: {} }); ok(r.s === 201 && r.j.result.lapsePct < r.j.result.lapsePctWithoutOverdraft && r.j.result.collectedPct > r.j.result.collectedPctWithoutOverdraft, 'overdraft cuts lapses and raises collections'); const R1 = r.j.id; ok(r.j.result.extraMembersReached > 0 && r.j.result.caution, 'instalments reach more customers and carry a credit caution');
  r = await call('POST', '/api/org/runs', FIN, { scenario: 'copay_cash', name: 'Cover cash v1', inputs: { finance_offer: { assetId: OFF } }, params: {} }); ok(r.s === 201 && r.j.result.advances > 0 && r.j.result.extraServicesEnabled > 0, 'cover cash run works'); const R2 = r.j.id;
  ok((await call('POST', '/api/org/runs', FIN, { scenario: 'campaign', params: {} })).s === 422, 'fintech pack does not run insurer scenarios');
  r = await call('POST', `/api/org/runs/${R2}/coach`, FIN, {}); ok(r.s === 200 && r.j.suggestions.length === 1 && r.j.suggestions[0].draft.kind === 'finance_offer', 'Coach suggests a better fee and limit');
  r = await call('POST', `/api/org/runs/${R1}/coach`, FIN, {}); ok(r.s === 200, 'Coach runs on the premium scenario');
  r = await call('POST', '/api/org/proposals/suggest', FIN, { assetId: OFF, runIds: [R1, R2] }); ok(r.s === 200 && r.j.summary.includes('instalments') && r.j.evidence.length === 2, 'system drafts the proposal from the design and runs'); const DRAFT = r.j;
  ok((await call('POST', '/api/org/proposals', FIN, { title: 'x', summary: 'y', assetId: OFF })).s === 422, 'a proposal needs evidence'); ok((await call('POST', '/api/org/proposals', FIN, { ...DRAFT, assetId: OFF, runIds: [R1, R2], to: 'nope1234' })).s === 422, 'unknown partner code refused');
  const insCode = (await call('GET', '/api/org/partner-code', ADMIN)).j.code; atCalls.length = 0;
  r = await call('POST', '/api/org/proposals', FIN, { title: DRAFT.title, summary: DRAFT.summary, assetId: OFF, runIds: [R1, R2], to: insCode, launchPartner: 'platform' }); ok(r.s === 201 && r.j.status === 'sent' && r.j.fees.linkFeePct === 5 && r.j.launchPartner.kind === 'platform', 'proposal sent to the insurer with the platform fee terms'); const PID = r.j.id;
  const inbox = (await call('GET', '/api/org/proposals', ADMIN)).j; ok(inbox.length === 1 && inbox[0].side === 'received' && inbox[0].evidence.length === 2 && inbox[0].terms.premiumOverdraft, 'insurer sees the design and evidence'); ok(!JSON.stringify(inbox).includes('customers"'), 'but not the proposer\'s data');
  ok((await call('POST', `/api/org/proposals/${PID}/respond`, BUILD, { action: 'accept' })).s === 403, 'a builder cannot accept'); ok((await call('POST', `/api/org/proposals/${PID}/respond`, FIN, { action: 'accept' })).s === 403, 'the sender cannot accept their own proposal');
  ok((await call('POST', `/api/org/proposals/${PID}/respond`, ADMIN, { action: 'reply', note: 'Can the limit be lower?' })).s === 200, 'insurer can reply'); 
  r = await call('POST', `/api/org/proposals/${PID}/respond`, ADMIN, { action: 'accept' }); ok(r.s === 200 && r.j.status === 'accepted' && r.j.importedAssetId, 'insurer accepts'); const got = (await call('GET', '/api/org/assets?kind=finance_offer', ADMIN)).j; ok(got.length === 1 && got[0].name.startsWith('Proposal:'), 'the design lands in the insurer Lab Library as a draft');
  ok((await call('POST', `/api/org/proposals/${PID}/respond`, ADMIN, { action: 'decline' })).s === 409, 'closed proposals stay closed');
  r = await call('POST', '/api/org/proposals', FIN, { title: 'Second', summary: 'Please introduce us to a suitable insurer', assetId: OFF, runIds: [R1] }); ok(r.j.status === 'awaiting_introduction', 'no code: waits for an introduction'); const PID2 = r.j.id;
  ok((await call('GET', '/api/org/proposals', ADMIN)).j.length === 1, 'insurer cannot see it yet');
  r = await plat('PATCH', `/proposals/${PID2}`, { toOrgId: orgId, launchPartner: { kind: 'platform' }, linkFeePct: 7, launchCommissionPct: 12 }); ok(r.s === 200 && r.j.status === 'sent' && r.j.fees.linkFeePct === 7 && r.j.launchPartner.kind === 'platform', 'platform owner introduces, names itself launch partner and sets fees');
  ok((await call('GET', '/api/org/proposals', ADMIN)).j.length === 2, 'now the insurer sees it'); ok((await plat('PATCH', `/proposals/${PID2}`, { status: 'launched' })).s === 409, 'cannot launch before it is accepted');
  ok((await plat('PATCH', `/proposals/${PID}`, { status: 'launched' })).j.status === 'launched', 'accepted proposal can be marked launched'); ok((await plat('GET', '/proposals')).j.length === 2, 'platform sees all proposals');
  r = await call('POST', '/api/org/proposals', FIN, { kind: 'request', title: 'Looking for an insurer partner', summary: 'We want to offer instalments' }); ok(r.s === 201 && r.j.kind === 'request', 'an insurer or fintech can also post a request without a design');
  r = await plat('PATCH', '/config', { linkFeePct: 4 }); ok(r.j.linkFeePct === 4, 'default platform link fee is configurable');

  section('Product Lab');
  r = await call('GET', '/api/org/lab/archetypes', ADMIN); ok(r.s === 200 && r.j.length >= 7 && r.j.some((a) => a.key === 'maternity') && !r.j.some((a) => a.key === 'cover_cash'), 'insurer sees insurance product types, not fintech ones');
  r = await call('POST', '/api/org/lab/coach', ADMIN, { message: 'how do I build a product?' }); ok(r.s === 200 && /Build a product/i.test(r.j.reply), 'Lab Coach answers how to build a product'); ok(/compare|version/i.test((await call('POST', '/api/org/lab/coach', ADMIN, { message: 'how do I compare versions?' })).j.reply), 'Lab Coach explains comparing versions');
  r = await call('GET', '/api/org/lab/archetypes', FIN); ok(r.j.map((a) => a.key).sort().join() === 'cover_cash,instalment_overdraft', 'fintech sees finance types');
  ok((await call('POST', '/api/org/lab/generate', FIN, { archetype: 'maternity', params: {} })).s === 404, 'a type from another sector is refused');
  r = await call('POST', '/api/org/lab/preview', ADMIN, { archetype: 'micro_health', params: { monthlyPremium: 30 } }); ok(r.s === 200 && r.j.summary.premium === 30 && r.j.summary.tiers.length === 2 && r.j.data.options.length === 2, 'preview builds a product from a few parameters without saving');
  ok((await call('POST', '/api/org/lab/preview', ADMIN, { archetype: 'micro_health', params: { monthlyPremium: 1 } })).s === 422, 'out-of-range parameters refused');
  r = await call('POST', '/api/org/lab/generate', ADMIN, { archetype: 'outpatient_cover', params: { name: 'Lab outpatient', monthlyPremium: 80, annualCap: 2000 } }); ok(r.s === 201 && r.j.asset.kind === 'product' && r.j.run && r.j.run.scenario === 'plan_options' && r.j.run.result.options.length === 3, 'one step makes a complete draft product and runs it'); const LP = r.j.asset.id; ok(r.j.suggestions.length === 4 && r.j.asset.latestGate === 'draft', 'draft with suggested variations');
  r = await call('POST', `/api/org/lab/assets/${LP}/regenerate`, ADMIN, { params: { monthlyPremium: 85, coPayPct: 5 } }); ok(r.s === 200 && r.j.latest === 2, 'changing parameters makes version 2 of the same product');
  r = await call('POST', `/api/org/lab/assets/${LP}/variation`, ADMIN, { changes: { premiumPct: -8 } }); ok(r.s === 201 && r.j.asset.name.includes('premium -8%') && r.j.regulatory.overall, 'variation copies it with a change and says what the regulator would make of it'); const V1 = r.j.asset.id;
  r = await call('POST', `/api/org/lab/assets/${LP}/variation`, ADMIN, { changes: { capPct: 25, coPayPct: 10 } }); const V2 = r.j.asset.id; ok(r.s === 201, 'second variation');
  ok((await call('POST', `/api/org/lab/assets/${LP}/variation`, ADMIN, { changes: {} })).s === 422, 'an empty variation is refused');
  r = await call('GET', `/api/org/lab/assets/${V2}/family`, ADMIN); ok(r.j.length === 3 && r.j.filter((x) => x.isRoot).length === 1, 'the product and its variations are grouped');
  r = await call('POST', '/api/org/lab/compare', ADMIN, { assetIds: [LP, V1, V2] }); ok(r.s === 200 && r.j.comparison.runs.length === 3 && r.j.comparison.metrics.some((m) => m.metric === 'lossRatioPct') && r.j.regulatory.length === 3, 'compare runs all of them side by side with regulator classification');
  ok((await call('POST', '/api/org/lab/compare', ADMIN, { assetIds: [LP] })).s === 422, 'compare needs two or more');
  r = await call('POST', '/api/org/lab/ideas', BUILD, { title: 'Pay for dental scaling', proposal: 'Add a dental cleaning benefit', whoBenefits: 'Younger members', archetype: 'outpatient_cover' }); ok(r.s === 201 && r.j.votes.length === 1, 'builder adds an idea'); const IDEA = r.j.id;
  ok((await call('POST', `/api/org/lab/ideas/${IDEA}/vote`, ADMIN, {})).j.votes === 2, 'teammate votes'); ok((await call('POST', `/api/org/lab/ideas/${IDEA}/vote`, ADMIN, {})).j.votes === 1, 'vote toggles off');
  r = await call('GET', '/api/org/lab/ideas', ADMIN); ok(r.j.length === 1 && r.j[0].title.includes('dental'), 'ideas board lists it');
  r = await call('POST', `/api/org/lab/ideas/${IDEA}/promote`, BUILD, {}); ok(r.s === 200 && r.j.idea.status === 'promoted' && r.j.asset.name === 'Pay for dental scaling', 'promoting an idea builds a draft product from it'); ok((await call('POST', `/api/org/lab/ideas/${IDEA}/promote`, BUILD, {})).s === 409, 'cannot promote twice');
  r = await call('POST', '/api/org/lab/generate', FIN, { archetype: 'instalment_overdraft', params: { installments: '4', feePct: 4 } }); ok(r.s === 201 && r.j.asset.kind === 'finance_offer' && r.j.run.scenario === 'premium_financing', 'fintech builds a finance offer the same way');
  r = await call('POST', '/api/org/lab/generate', ADMIN, { archetype: 'cashback_loyalty', params: { cashbackPct: 8 } }); ok(r.s === 201 && r.j.asset.kind === 'campaign' && r.j.run.scenario === 'campaign', 'loyalty cashback builds a campaign and runs it');

  section('Outcomes-based care');
  r = await call('GET', '/api/org/lab/archetypes', ADMIN); ok(r.j.some((a) => a.key === 'outcomes_care'), 'outcomes-based care is offered to insurers');
  r = await call('POST', '/api/org/lab/generate', ADMIN, { archetype: 'outcomes_care', params: { name: 'Diabetes outcomes', condition: 'diabetes' } }); ok(r.s === 201 && r.j.asset.kind === 'outcomes_programme' && r.j.run.scenario === 'outcomes_based_care' && r.j.summary.rows.length >= 3, 'one step builds the programme and runs it'); const OP = r.j.asset.id; const orr = r.j.run;
  ok(orr.result.complicationsAvoided > 0 && orr.result.bands.length === 5 && orr.result.feeForServiceTrap.extraPaidToHighComplicationProvidersPct > 0, 'it shows complications avoided, bands and the fee-for-service trap');
  ok(orr.result.measures.map((m) => m.key).join() === 'control,adherence,screening,complications', 'scored on measures for the condition');
  r = await call('POST', `/api/org/runs/${orr.id}/coach`, ADMIN, {}); ok(r.s === 200 && (r.j.suggestions.length === 0 || r.j.suggestions[0].draft.kind === 'outcomes_programme'), 'Coach searches better bands');
  ok((await call('POST', '/api/org/assets', ADMIN, { kind: 'outcomes_programme', name: 'bad', data: { condition: 'x' } })).s === 422, 'a programme without bands is refused');
  ok((await call('POST', '/api/org/runs', FIN, { scenario: 'outcomes_based_care', params: {} })).s === 422, 'fintechs do not run it');

  section('Plans, trial expiry and caps');
  const raw = orgs.raw(orgId); raw.trialEndsAt = new Date(Date.now() - 5 * 86400000).toISOString(); ok((await call('GET', '/api/org', ADMIN)).j.org.status === 'grace', 'after trial: grace');
  ok((await call('POST', '/api/org/assets', BUILD, { kind: 'product', name: 'p', data: {} })).s === 201, 'still writable in grace');
  raw.trialEndsAt = new Date(Date.now() - 45 * 86400000).toISOString(); ok((await call('GET', '/api/org', ADMIN)).j.org.status === 'read_only', 'after grace: read-only');
  ok((await call('POST', '/api/org/assets', BUILD, { kind: 'product', name: 'q', data: {} })).s === 402, 'read-only blocks writes'); ok((await call('GET', '/api/org/assets', BUILD)).s === 200, 'but reading still works');
  r = await plat('PATCH', `/orgs/${orgId}/plan`, { extendDays: 30 }); ok(r.j.status === 'active' && r.j.plan === 'extended_trial', 'extending a trial reopens the workspace');
  r = await plat('PATCH', `/orgs/${orgId}/plan`, { plan: 'paid' }); ok(r.j.plan === 'paid' && r.j.daysLeft === null && r.j.limits.members === 50, 'switch to paid');
  for (const o of (await plat('GET', '/orgs')).j) if (o.name === 'Kasapreko Bank' || o.name === 'Payly Fintech') orgs.removeOrg(o.id); await plat('PATCH', '/config', { maxFreeOrgs: 1 }); r = await plat('POST', '/orgs', { name: 'Free A', adminEmail: 'a@a.test' }); ok(r.s === 201, 'one free org fits under the cap'); r = await plat('POST', '/orgs', { name: 'Free B', adminEmail: 'b@b.test' }); ok(r.s === 402, 'free-org cap enforced');
  ok((await plat('POST', '/orgs', { name: 'Paying C', adminEmail: 'c@c.test', plan: 'paid' })).s === 201, 'paid orgs ignore the free cap');

  srv.close(); hnnStub.close(); atStub.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
