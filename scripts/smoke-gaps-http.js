'use strict';
// HTTP-level smoke for the SMS Dashboard and Solutions surfaces, against a
// RUNNING server (like scripts/smoke.js): start it with `npm start`, then
//   node scripts/smoke-gaps-http.js        (BASE_URL / PLATFORM_KEY override defaults)
// The service logic itself is covered offline by scripts/smoke-gaps-solutions.js;
// this checks routing, auth, the public webhooks and the public patient surface.

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const PKEY = process.env.PLATFORM_KEY || 'platform_demo_key_123';
let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const call = async (method, path, { body, headers = {}, form } = {}) => {
  const h = { ...headers };
  let b;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; b = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers: h, body: b });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_e) { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
};
const P = { 'x-platform-key': PKEY };

(async () => {
  // ---- auth
  ok((await call('GET', '/api/platform/sms/overview')).status === 401, 'SMS dashboard API requires the platform key');
  ok((await call('GET', '/api/platform/solutions/modules')).status === 401, 'solutions admin API requires the platform key');

  // ---- SMS dashboard over HTTP
  const ov = await call('GET', '/api/platform/sms/overview', { headers: P });
  ok(ov.status === 200 && /\/sms-hooks\/[0-9a-f]{36}\/delivery$/.test(ov.json.hookUrls.delivery), 'overview returns callback URLs with a secret');
  const parse = await call('POST', '/api/platform/sms/parse', { headers: P, body: { numbers: '0244000001\n+233 20 123 4567\nbad' } });
  ok(parse.json.valid === 2 && parse.json.invalid.length === 1, 'parse endpoint counts valid/invalid');
  const send = await call('POST', '/api/platform/sms/send', { headers: P, body: { numbers: '0244000001,0244000002', message: 'HTTP smoke' } });
  ok(send.status === 200 && send.json.accepted === 2, 'bulk send over HTTP (sandbox unless the rail is live)');
  const bad = await call('POST', '/api/platform/sms/send', { headers: P, body: { numbers: '0244000001', message: '' } });
  ok(bad.status === 422, 'empty message -> 422');
  const logs = await call('GET', '/api/platform/sms/logs?q=HTTP%20smoke&pageSize=1', { headers: P });
  ok(logs.json.total >= 2 && logs.json.data.length === 1 && logs.json.pages >= 2, 'log search + pagination over HTTP');
  const csv = await call('GET', '/api/platform/sms/logs.csv', { headers: P });
  ok((csv.headers.get('content-type') || '').startsWith('text/csv') && csv.text.includes('HTTP smoke'), 'CSV export streams text/csv');

  // ---- public callbacks (AT form-encoded, secret in path)
  const urls = ov.json.hookUrls;
  const path = (u) => new URL(u).pathname;
  const providerId = logs.json.data[0].providerMessageId;
  ok((await call('POST', path(urls.delivery).replace(/\/[0-9a-f]{36}\//, '/wrongsecret/'), { form: { id: providerId, status: 'Success' } })).status === 404, 'callback with a wrong secret is a bare 404');
  const d = await call('POST', path(urls.delivery), { form: { id: providerId, status: 'Success', phoneNumber: '+233244000001', networkCode: '62002' } });
  ok(d.status === 200 && d.json.matched === true, 'delivery-report callback (form-encoded) updates the message');
  const i = await call('POST', path(urls.inbox), { form: { from: '+233244000001', to: '20880', text: 'hi from phone', id: 'ATXid_http', date: '2026-10-04 12:00:00' } });
  ok(i.status === 200 && i.json.ok === true, 'inbox callback stores an inbound message');
  ok((await call('GET', '/api/platform/sms/inbox?q=hi%20from', { headers: P })).json.total >= 1, 'inbound message visible in the inbox API');
  ok((await call('POST', path(urls.optout), { form: { senderId: 'HNN', phoneNumber: '+233244000002' } })).json.ok === true, 'opt-out callback records the number');
  const after = await call('POST', '/api/platform/sms/send', { headers: P, body: { numbers: '0244000002', message: 'after opt-out' } });
  ok(after.json.skippedOptOut === 1 && after.json.accepted === 0, 'opted-out number is skipped on the next send');
  await call('DELETE', '/api/platform/sms/optouts/0244000002', { headers: P });

  // ---- solutions over HTTP: Master Control -> patient / hospital / payer
  const mods = await call('GET', '/api/platform/solutions/modules', { headers: P });
  ok(mods.json.modules.length === 8, 'module registry served to Master Control');

  // a classified pharmacy needs real bills; create two via the hospital API if possible, else skip data assertions
  const create = await call('POST', '/api/platform/products', { headers: P, body: { payerId: 'acacia', type: 'solution', name: 'HTTP pharmacy compare',
    config: { module: 'pharmacy_compare', title: 'Cheapest pharmacy', surfaces: ['patient', 'hospital', 'payer'] } } });
  ok(create.status === 201 || create.status === 200, 'solution product created through the generic Product Lab route');
  const id = create.json.id;
  ok((await call('GET', `/solutions/api/${id}`)).status === 404, 'draft solution is not public');
  await call('POST', `/api/platform/products/${id}/status`, { headers: P, body: { status: 'sandbox' } });
  ok((await call('GET', `/solutions/api/${id}`)).status === 404, 'sandbox solution is still not public');
  const tryIt = await call('POST', `/api/platform/solutions/${id}/run`, { headers: P, body: { input: { items: 'Amoxicillin' } } });
  ok(tryIt.status === 200 && tryIt.json.dryRun === true, 'Master Control can try a sandbox solution (dry-run)');
  const live = await call('POST', `/api/platform/products/${id}/status`, { headers: P, body: { status: 'live' } });
  ok(live.status === 200, 'solution goes live');
  const view = await call('GET', `/solutions/api/${id}`);
  ok(view.status === 200 && view.json.title === 'Cheapest pharmacy' && view.json.inputs[0].key === 'items', 'live solution is public with its input schema');
  ok(!JSON.stringify(view.json).includes('payerId'), 'public view does not leak internal ids');
  const run = await call('POST', `/solutions/api/${id}/run`, { body: { input: { items: 'Amoxicillin\nParacetamol' } } });
  ok(run.status === 200 && run.json.dryRun === false && run.json.result.items.length === 2, 'patient can run a live solution without any key');
  ok((await call('POST', `/solutions/api/${id}/run`, { body: { input: {} } })).status === 422, 'patient run without items -> 422');
  ok((await call('GET', '/solutions/api')).json.data.some((s) => s.id === id), 'patient directory lists it');
  const page = await call('GET', '/solutions/');
  ok(page.status === 200 && page.text.includes('solutions-ui.js'), 'public patient page is served');

  const hosp = await call('GET', '/api/v1/solutions', { headers: { 'x-api-key': 'emr_demo_key_123' } });
  ok(hosp.status === 200 && hosp.json.data.some((s) => s.id === id), 'hospital surface lists it (tenant key)');
  ok((await call('GET', '/api/v1/solutions')).status === 401, 'hospital surface requires a tenant key');
  const hrun = await call('POST', `/api/v1/solutions/${id}/run`, { headers: { 'x-api-key': 'emr_demo_key_123' }, body: { input: { items: 'Amoxicillin' } } });
  ok(hrun.status === 200, 'hospital can run it');
  const prun = await call('POST', `/api/payer/solutions/${id}/run`, { headers: { 'x-payer-key': 'payer_acacia_key' }, body: { input: { items: 'Amoxicillin' } } });
  ok(prun.status === 200, 'owning payer can run it');
  ok((await call('POST', `/api/payer/solutions/${id}/run`, { headers: { 'x-payer-key': 'payer_cosmopolitan_key' }, body: { input: { items: 'x' } } })).status === 404, 'another payer gets 404');
  ok((await call('GET', '/api/payer/solutions', { headers: { 'x-payer-key': 'payer_acacia_key' } })).json.data.length >= 1, 'payer lists its own solutions');

  // policy-type solution applies on live and reverts, visible through the real payer API
  const thr = await call('POST', '/api/platform/products', { headers: P, body: { payerId: 'cosmopolitan', type: 'solution', name: 'HTTP threshold',
    config: { module: 'auth_threshold', params: { thresholdMaxAmount: 175 } } } });
  await call('POST', `/api/platform/products/${thr.json.id}/status`, { headers: P, body: { status: 'sandbox' } });
  await call('POST', `/api/platform/products/${thr.json.id}/status`, { headers: P, body: { status: 'live' } });
  const payers = await call('GET', '/api/platform/payers', { headers: P });
  const cosmo = (payers.json.data || payers.json).find((p) => p.id === 'cosmopolitan');
  ok(JSON.stringify(cosmo).includes('175'), 'live threshold solution shows in the payer record');
  await call('POST', `/api/platform/products/${thr.json.id}/status`, { headers: P, body: { status: 'sandbox' } });
  const payers2 = await call('GET', '/api/platform/payers', { headers: P });
  const cosmo2 = (payers2.json.data || payers2.json).find((p) => p.id === 'cosmopolitan');
  ok(!JSON.stringify(cosmo2).includes('175'), 'pausing it reverts the payer record');

  console.log(`\n${a} assertions${process.exitCode ? ' — FAILURES ABOVE' : ' passed'}`);
})().catch((e) => { console.error(e); process.exit(1); });
