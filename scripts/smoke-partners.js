'use strict';
// Smoke test for partner logins (the ER HEAT partner console): Master Control issues logins, each sector sees only its
// own lines, partners see only requests that name their phones unless granted "all", universal needs approval,
// voucher redemption is limited to voucher sectors, sessions end on reset or suspension.
//   node scripts/smoke-partners.js
process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const express = require('express');
const store = require('../src/store');
const messaging = require('../src/services/messaging');
const operatingMode = require('../src/services/operatingMode');
const messagingAccount = require('../src/services/messagingAccount');
const accounts = require('../src/services/patientAccounts');
const erheat = require('../src/services/erheat');
const partners = require('../src/services/partners');
const routes = require('../src/routes/partners');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const rej = (p) => p.then(() => null, (e) => e);
const sms = [];
messaging._setRequestImplForTests(async (url, opts) => {
  const f = new URLSearchParams(opts.body); sms.push({ to: f.get('to'), message: f.get('message') });
  return { status: 201, body: JSON.stringify({ SMSMessageData: { Recipients: [{ number: f.get('to'), status: 'Success', messageId: `ATXid_${sms.length}` }] } }) };
});
const lastTo = (to) => [...sms].reverse().find((s) => s.to === to);
const tokenIn = (m) => /erheat\/v\/([a-z0-9]+)/.exec(m)[1];

(async () => {
  await store.init?.();
  await operatingMode.set({ settlement: { sandbox: true }, messaging: { sandbox: false } });
  await messagingAccount.set({ provider: 'africastalking', credentials: { apiKey: 'k', username: 'sandbox' }, active: true });
  await accounts.register({ first_name: 'Ama', last_name: 'Test', phone: '+233241110001', password: 'secret1' }); const ama = await accounts.byPhone('+233241110001');
  await erheat.setConfig({ enabled: true, requireVerifiedPhone: false, lines: { energy: { enabled: true } } });

  // two requests: rent (landlord 0302111222) and energy (station 0302000111)
  const rent = await erheat.apply(ama, { line: 'rent', amount: 300, purpose: 'rent', payee: { name: 'Kofi Landlord', phone: '0302111222' }, verifier: { name: 'Kofi Landlord', phone: '0302111222' }, evidence: { monthlyRent: 600, dueDate: '2026-11-01', address: '12 Palm St' } });
  const en = await erheat.apply(ama, { line: 'energy', amount: 200, purpose: 'fuel', payee: { name: 'Shell Station', phone: '0302000111' }, verifier: { phone: '0302000111' }, evidence: { kind: 'fuel', invoiceAmount: 220 } });
  await erheat.verifierRespond(tokenIn(lastTo('+233302000111').message), { decision: 'confirm', accountName: 'Shell Station' });
  await erheat.consent(ama, en.id, { agree: true }); const ens = await erheat.recordDecision({ applicationNo: en.appNo, decision: 'approved' });
  const otp = /One-time code: (\d{6})/.exec([...sms].reverse().find((x) => x.to === '+233241110001' && /One-time code/.test(x.message)).message)[1];

  // Master Control issues logins
  let e = await rej(partners.create({ name: 'X', handle: 'x@y.com', sector: 'nonsense' })); ok(e && e.status === 422, 'unknown sector is refused');
  const landlord = await partners.create({ name: 'Kofi Mensah', org: 'Palm Estates', handle: 'Kofi@Palm.com', sector: 'real_estate', phones: '0302111222' });
  ok(landlord.temporaryPassword.length === 10 && landlord.account.handle === 'kofi@palm.com' && landlord.account.phones[0] === '+233302111222' && landlord.account.mustChange, 'login issued with a one-time temporary password and a normalised handle');
  ok(!JSON.stringify(landlord.account).includes('passwordHash'), 'the password hash never leaves the service');
  e = await rej(partners.create({ name: 'Dup', handle: 'kofi@palm.com', sector: 'health' })); ok(e && e.status === 409, 'a handle can only have one login');
  const station = await partners.create({ name: 'Ama Boateng', org: 'Shell Madina', handle: '0302000999', sector: 'energy', phones: ['0302000111'], sendSms: true });
  ok(station.sms && station.sms.ok && /Temporary password: /.test(lastTo('+233302000999').message), 'credentials can be sent by SMS');
  const clinic = await partners.create({ name: 'Dr Ofori', handle: 'dr@clinic.com', sector: 'health', phones: ['0302777888'] });
  ok((await partners.list()).length === 3, 'Master Control lists every partner');

  // sign in
  e = await rej(partners.login({ handle: 'kofi@palm.com', password: 'wrong' })); ok(e && e.status === 401, 'wrong password refused');
  const s1 = await partners.login({ handle: 'KOFI@palm.com', password: landlord.temporaryPassword }); ok(s1.token && s1.account.mustChange && s1.account.sector === 'real_estate' && s1.account.lines.join() === 'rent', 'sign in works; account carries only its sector lines');
  const L = await partners.authenticate(`Bearer ${s1.token}`);
  e = await rej(partners.changePassword(L, { current: landlord.temporaryPassword, password: 'short' })); ok(e && e.status === 422, 'weak new password refused');
  const s2 = await partners.changePassword(L, { current: landlord.temporaryPassword, password: 'a-better-pass1' }); ok(!s2.account.mustChange, 'password changed');
  e = await rej(partners.authenticate(`Bearer ${s1.token}`)); ok(e && e.status === 401, 'the old session ends when the password changes');

  // what each sector sees
  const LA = await partners.authenticate(`Bearer ${s2.token}`); let r = await partners.requests(LA);
  ok(r.total === 1 && r.rows[0].appNo === rent.appNo && r.rows[0].line === 'rent' && r.rows[0].named && r.rows[0].borrower === 'Ama' && /\d{4}$/.test(r.rows[0].phone) && !JSON.stringify(r).includes('233241110001'), 'real estate sees only the rent request that names them, borrower masked');
  ok(r.rows[0].fields.some((f) => f.label === 'Property address'), 'the evidence the landlord already confirmed is shown');
  const SA = await partners.authenticate(`Bearer ${(await partners.login({ handle: '0302000999', password: station.temporaryPassword })).token}`); r = await partners.requests(SA);
  ok(r.total === 1 && r.rows[0].line === 'energy' && r.rows[0].voucher && !r.rows[0].voucher.redeemed && !JSON.stringify(r).includes(ens.voucher.code), 'energy sees only energy, and never the voucher code');
  const CA = await partners.authenticate(`Bearer ${(await partners.login({ handle: 'dr@clinic.com', password: clinic.temporaryPassword })).token}`); r = await partners.requests(CA); ok(r.total === 0 && r.lines[0].key === 'health', 'health sees nothing that does not name them');
  await partners.update(clinic.account.id, { view: 'all' }); r = await partners.requests(await partners.authenticate(`Bearer ${(await partners.login({ handle: 'dr@clinic.com', password: clinic.temporaryPassword })).token}`)); ok(r.scope === 'all' && r.total === 0, 'view "all" widens within the line only (no rent or energy leaks)');
  await partners.update(landlord.account.id, { view: 'all' }); r = await partners.requests(await partners.authenticate(`Bearer ${s2.token}`)); ok(r.rows.every((x) => x.line === 'rent'), 'view "all" stays inside the partner line');

  // redemption
  e = await rej(partners.redeem(LA, { code: ens.voucher.code, otp })); ok(e && e.status === 403, 'real estate has no voucher redemption');
  e = await rej(partners.redeem(SA, { code: ens.voucher.code, otp, phone: '0244000000' })); ok(e && e.status === 403, 'a phone not registered to the partner cannot be used');
  const red = await partners.redeem(SA, { code: ens.voucher.code, otp }); ok(red.ok && red.amount === 200, 'energy partner redeems the voucher with the customer\'s one-time code');
  r = await partners.requests(SA); ok(r.rows[0].status === 'payee_paid' && r.rows[0].voucher.redeemed, 'the console reflects the redemption');

  // universal
  const req1 = await partners.requestUniversal(LA); ok(req1.universalRequested && !req1.universal && req1.lines.join() === 'rent', 'asking for universal access does not grant it');
  const up = await partners.setUniversal(landlord.account.id, true); ok(up.universal && up.lines.length === 6 && up.tools.includes('redeem') && !up.universalRequested, 'Master Control approves universal access');
  r = await partners.requests(await partners.authenticate(`Bearer ${s2.token}`)); ok(r.total === 2 && r.lines.length === 6, 'a universal account sees every line');
  ok((await partners.setUniversal(landlord.account.id, false)).lines.join() === 'rent', 'universal access can be withdrawn');
  const uni = await partners.create({ name: 'Ops', handle: 'ops@hnn.com', universal: true }); ok(uni.account.universal && uni.account.lines.length === 6, 'Master Control can create a universal account directly');

  // suspension and reset end sessions
  await partners.update(station.account.id, { status: 'suspended' }); e = await rej(partners.authenticate(`Bearer ${(await partners.login({ handle: '0302000999', password: station.temporaryPassword }).catch((x) => ({ token: 'x', x }))).token}`)); ok(e && e.status === 401, 'a suspended partner cannot sign in or keep a session');
  const rp = await partners.resetPassword(clinic.account.id); e = await rej(partners.login({ handle: 'dr@clinic.com', password: clinic.temporaryPassword })); ok(e && e.status === 401 && (await partners.login({ handle: 'dr@clinic.com', password: rp.temporaryPassword })).token, 'reset issues a new temporary password and retires the old one');

  // HTTP
  const app = express(); app.use('/partner-api', routes.api); app.use('/pm', (req, res, next) => { req.principal = { id: 'test' }; next(); }, routes.admin);
  const srv = app.listen(0); await new Promise((r2) => setTimeout(r2, 50)); const base = `http://127.0.0.1:${srv.address().port}`; const J = { 'Content-Type': 'application/json' };
  let res = await fetch(`${base}/partner-api/requests`); ok(res.status === 401, 'HTTP: console needs a login');
  res = await fetch(`${base}/partner-api/login`, { method: 'POST', headers: J, body: JSON.stringify({ handle: 'ops@hnn.com', password: uni.temporaryPassword }) }); let j = await res.json(); ok(res.status === 200 && j.token, 'HTTP: sign in');
  res = await fetch(`${base}/partner-api/requests`, { headers: { Authorization: `Bearer ${j.token}` } }); j = await res.json(); ok(res.status === 200 && j.lines.length === 6, 'HTTP: universal sees six lines');
  res = await fetch(`${base}/pm`, { headers: J }); j = await res.json(); ok(res.status === 200 && j.sectors.length === 8 && j.partners.length === 4, 'HTTP: Master Control lists sectors and partners');
  res = await fetch(`${base}/pm`, { method: 'POST', headers: J, body: JSON.stringify({ name: 'School', handle: 'bursar@school.edu', sector: 'education' }) }); j = await res.json(); ok(res.status === 201 && j.temporaryPassword, 'HTTP: Master Control issues a login');
  srv.close(); console.log(`\n${a} assertions`); process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
