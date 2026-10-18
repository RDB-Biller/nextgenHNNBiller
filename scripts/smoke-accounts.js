'use strict';
// Smoke test for partner sign-up with approval and the Master Control account directory (deactivate, clearances).
//   node scripts/smoke-accounts.js
process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const express = require('express');
const store = require('../src/store');
const accounts = require('../src/services/patientAccounts');
const partners = require('../src/services/partners');
const ctl = require('../src/services/accountControl');
const { authTenant } = require('../src/middleware/auth');
const { authPlatform } = require('../src/middleware/access');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const rej = (p) => p.then(() => null, (e) => e);

(async () => {
  await store.init?.();
  // ---- sign-up needs approval
  let e = await rej(partners.signup({ name: 'Dr A', org: 'Korle Bu', role: 'doctor', password: 'longenough1' })); ok(e && e.status === 422, 'sign-up needs an email or a phone');
  e = await rej(partners.signup({ name: 'Dr A', org: 'Korle Bu', role: 'wizard', email: 'a@k.com', password: 'longenough1' })); ok(e && e.status === 422, 'sign-up needs a known role');
  e = await rej(partners.signup({ name: 'Dr A', org: 'Korle Bu', role: 'doctor', email: 'a@k.com', password: 'short' })); ok(e && e.status === 422, 'sign-up needs a real password');
  const r = await partners.signup({ name: 'Dr Ama Mensah', org: 'Korle Bu Teaching Hospital', role: 'doctor', email: 'Ama@Korlebu.org', phone: '0244555000', password: 'longenough1' }, '1.1.1.1');
  ok(r.status === 'pending', 'sign-up is recorded as pending');
  e = await rej(partners.login({ handle: 'ama@korlebu.org', password: 'longenough1' })); ok(e && e.status === 403 && /waiting for approval/.test(e.message), 'a pending request cannot sign in by email');
  e = await rej(partners.login({ handle: '0244555000', password: 'longenough1' })); ok(e && e.status === 403, 'nor by phone');
  e = await rej(partners.signup({ name: 'Dup', org: 'X', role: 'nurse', email: 'ama@korlebu.org', password: 'longenough1' })); ok(e && e.status === 409, 'the same email cannot sign up twice');
  const list = await partners.list(); const pend = list.find((p) => p.status === 'pending');
  ok(pend && pend.role === 'doctor' && pend.roleLabel === 'Doctor' && pend.sector === 'health', 'role maps to the health sector');
  const ap = await partners.approve(pend.id, { view: 'all' }); ok(ap.status === 'active' && ap.view === 'all', 'Master Control approves');
  let s = await partners.login({ handle: 'ama@korlebu.org', password: 'longenough1' }); ok(!!s.token && s.account.sectorLabel === 'Health', 'after approval the person signs in with their own password (no forced change)');
  s = await partners.login({ handle: '0244555000', password: 'longenough1' }); ok(!!s.token, 'and by phone');
  e = await rej(partners.approve(pend.id, {})); ok(e && e.status === 409, 'cannot approve twice');
  await partners.signup({ name: 'Mr B', org: 'Fly Bank', role: 'banker', phone: '0200000001', password: 'longenough1' }, '2.2.2.2');
  const bk = (await partners.list()).find((p) => p.org === 'Fly Bank'); ok(bk.sector === 'finance' && bk.lines.length === 6, 'bankers get the banking and lending sector across every line');
  await partners.reject(bk.id, { reason: 'Not a partner' }); e = await rej(partners.login({ handle: '0200000001', password: 'longenough1' })); ok(e && e.status === 403 && /not approved/.test(e.message), 'a rejected request cannot sign in');
  await accounts.setAuthConfig({ requirePhone: true }); e = await rej(partners.signup({ name: 'C', org: 'Org', role: 'nurse', email: 'c@x.com', password: 'longenough1' }, '3.3.3.3')); ok(e && e.status === 422 && /mobile/.test(e.message), 'the "require mobile phone" switch applies to partner sign-up too');
  await accounts.setAuthConfig({ requirePhone: false });

  // ---- directory
  await accounts.register({ first_name: 'Kofi', last_name: 'P', phone: '+233241119999', password: 'secret1' }); const kofi = await accounts.byPhone('+233241119999');
  const dir = await ctl.directory({});
  ok(['patient', 'partner', 'facility', 'insurer', 'emr_provider', 'staff'].every((k) => dir.kinds.find((x) => x.key === k)), 'directory covers every kind of account');
  ok(dir.kinds.find((k) => k.key === 'patient').total >= 1 && dir.kinds.find((k) => k.key === 'facility').total >= 2 && dir.kinds.find((k) => k.key === 'insurer').total >= 2, 'with counts per kind');
  ok((await ctl.directory({ kind: 'partner', q: 'korle' })).rows.length === 1, 'search by name, organisation or contact');
  ok((await ctl.directory({ kind: 'partner', status: 'rejected' })).rows.length === 1, 'filter by state');

  // ---- deactivate
  await ctl.update('patient', kofi._id, { disabled: true, reason: 'fraud review' }, 'tester');
  const ps = await accounts.login({ phone: '+233241119999', password: 'secret1' }).then(() => null, (x) => x); ok(ps && ps.status === 403, 'a deactivated patient cannot sign in');
  await ctl.update('patient', kofi._id, { disabled: false }, 'tester'); ok(!!(await accounts.login({ phone: '+233241119999', password: 'secret1' })).tokens, 'and can again once reactivated');
  const tok = (await partners.login({ handle: 'ama@korlebu.org', password: 'longenough1' })).token;
  await ctl.update('partner', ap.id, { disabled: true }, 'tester');
  e = await rej(partners.authenticate(`Bearer ${tok}`)); ok(e && e.status === 401, 'a deactivated partner loses the session at once');
  e = await rej(partners.login({ handle: 'ama@korlebu.org', password: 'longenough1' })); ok(e && e.status === 403, 'and cannot sign in');
  e = await rej(ctl.update('patient', kofi._id, { grants: { goLive: true } })); ok(e && e.status === 422, 'a clearance that does not apply to the kind is refused');
  e = await rej(ctl.update('patient', 'nope', { disabled: true })); ok(e && e.status === 404, 'unknown accounts are refused');

  // ---- middleware: facility key and staff clearances
  const app = express(); app.get('/tenant', authTenant, (req, res) => res.json({ ok: req.tenant.id }));
  const plat = express.Router(); plat.use((req, res) => res.json({ ok: true })); app.use('/api/platform', authPlatform, plat);
  const srv = app.listen(0); await new Promise((r2) => setTimeout(r2, 50)); const base = `http://127.0.0.1:${srv.address().port}`;
  let res = await fetch(`${base}/tenant`, { headers: { 'x-api-key': 'emr_demo_key_123' } }); ok(res.status === 200, 'a facility key works');
  await ctl.update('facility', 'tenant_euracare', { disabled: true }, 'tester');
  res = await fetch(`${base}/tenant`, { headers: { 'x-api-key': 'emr_demo_key_123' } }); ok(res.status === 403, 'a deactivated facility is refused at the API');
  await store.users.save({ id: 'usr_staff1', apiKey: 'staff_key_1', role: 'platform_admin', orgType: 'platform', orgId: 'hnn', status: 'active', name: 'Staff One' });
  const H = { 'x-platform-key': 'staff_key_1', 'content-type': 'application/json' };
  res = await fetch(`${base}/api/platform/products`, { headers: H }); ok(res.status === 200, 'staff may use Product Lab by default');
  await ctl.update('staff', 'usr_staff1', { grants: { productLab: false } }, 'tester');
  res = await fetch(`${base}/api/platform/products`, { headers: H }); ok(res.status === 403 && (await res.json()).error === 'clearance_required', 'Product Lab clearance can be taken away');
  res = await fetch(`${base}/api/platform/operating-mode`, { headers: H }); ok(res.status === 200, 'reading the operating mode is still allowed');
  res = await fetch(`${base}/api/platform/operating-mode`, { method: 'PUT', headers: H, body: '{}' }); ok(res.status === 200, 'staff may switch sandbox and live by default');
  await ctl.update('staff', 'usr_staff1', { grants: { goLive: false } }, 'tester');
  res = await fetch(`${base}/api/platform/operating-mode`, { method: 'PUT', headers: H, body: '{}' }); ok(res.status === 403, 'the go-live clearance can be taken away');
  res = await fetch(`${base}/api/platform/operating-mode`, { method: 'PUT', headers: { 'x-platform-key': 'platform_demo_key_123', 'content-type': 'application/json' }, body: '{}' }); ok(res.status === 200, 'the Master Control superkey is never restricted');
  await ctl.update('staff', 'usr_staff1', { disabled: true }, 'tester'); res = await fetch(`${base}/api/platform/products`, { headers: H }); ok(res.status === 403, 'a deactivated staff account is refused');
  srv.close();
  console.log(`\n${a} assertions${process.exitCode ? ' — WITH FAILURES' : ' — all passed'}`);
})().catch((x) => { console.error(x); process.exit(1); });
