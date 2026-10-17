'use strict';
// Smoke test for ERHEAT Health sync with the Biller: facility directory, pending bills, bill-backed requests, history.
//   node scripts/smoke-erheat-health.js
process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const express = require('express');
const store = require('../src/store');
const messaging = require('../src/services/messaging');
const operatingMode = require('../src/services/operatingMode');
const messagingAccount = require('../src/services/messagingAccount');
const accounts = require('../src/services/patientAccounts');
const erheat = require('../src/services/erheat');
const routes = require('../src/routes/erheat');
const { createBill } = require('../src/services/billing');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const rej = (p) => p.then(() => null, (e) => e);
const sms = [];
messaging._setRequestImplForTests(async (url, opts) => { const f = new URLSearchParams(opts.body); sms.push({ to: f.get('to'), message: f.get('message') }); return { status: 201, body: JSON.stringify({ SMSMessageData: { Recipients: [{ number: f.get('to'), status: 'Success', messageId: `ATXid_${sms.length}` }] } }) }; });

(async () => {
  await store.init?.();
  await operatingMode.set({ settlement: { sandbox: true }, messaging: { sandbox: false } });
  await messagingAccount.set({ provider: 'africastalking', credentials: { apiKey: 'k', username: 'sandbox' }, active: true });
  await erheat.setConfig({ enabled: true, requireVerifiedPhone: false });
  const mk = async (phone, name) => { await accounts.register({ first_name: name, last_name: 'Test', phone, password: 'secret1' }); return accounts.byPhone(phone); };
  const ama = await mk('+233241110001', 'Ama'); const kofi = await mk('+233241110002', 'Kofi');
  const tenants = await store.tenants.all(); const eura = tenants.find((t) => t.id === 'tenant_euracare');

  const fac = await erheat.healthFacilities();
  ok(fac.length >= 2 && fac.every((f) => f.id && f.name) && fac.find((f) => f.id === 'tenant_euracare').canConfirm, 'facility directory lists the Biller tenants');
  ok(!JSON.stringify(fac).includes('0302000000') && !JSON.stringify(fac).includes('302000000'), 'facility phones are masked in the directory');

  ok((await erheat.healthPending(ama)).items.length === 0, 'no bills, nothing pending');
  const mkBill = async (phone, cost, tenantId = 'tenant_euracare') => { const b = createBill({ provider: 'Euracare Hospital', patient: { name: 'Ama Test', phone }, items: [{ name: 'Malaria treatment', cost }] }); b.tenantId = tenantId; await store.bills.insert(b); return b; };
  const bill = await mkBill('0241110001', 240); await mkBill('0241110002', 150);
  const p = await erheat.healthPending(ama);
  ok(p.items.length === 1 && p.items[0].billId === bill.id && p.items[0].facility.name === 'Euracare Hospital' && p.items[0].amount === 240 && /Malaria/.test(p.items[0].note), 'only the borrower\'s own open bill is pending, with details from the Biller');

  let e = await rej(erheat.apply(ama, { line: 'health', billId: bill.id, amount: 300 })); ok(e && e.status === 422 && /240/.test(e.message), 'cannot borrow more than the bill');
  e = await rej(erheat.apply(kofi, { line: 'health', billId: bill.id, amount: 100 })); ok(e && e.status === 404, 'someone else cannot use this bill');
  const before = sms.length;
  const r = await erheat.apply(ama, { line: 'health', billId: bill.id, amount: 240 });
  ok(r.status === 'verified' && r.verifiedAmount === 240 && r.payee.name === 'Euracare Hospital' && r.evidence.facility === 'Euracare Hospital', 'bill-backed request is confirmed by the Biller record, no manual details');
  ok(sms.length === before, 'no verifier SMS is sent for a bill-backed request');
  ok((await erheat.healthPending(ama)).items.length === 0, 'the bill leaves the pending list once requested');
  e = await rej(erheat.apply(ama, { line: 'health', billId: bill.id, amount: 100 })); ok(e && e.status === 409, 'one request per bill');

  const cr = await erheat.consent(ama, r.id, { agree: true, ip: '1.1.1.1' }); ok(cr && ['submitted', 'verified'].includes(cr.status || 'submitted'), 'consent proceeds from a verified bill-backed request');
  const hu = await erheat.hookUrls('http://x'); ok(!!hu.decision, 'hook urls available');
  ok((await erheat.awardedHistory(ama)).items.length === 0, 'history is empty before an award');
  await erheat.recordDecision({ applicationNo: r.appNo, decision: 'approved', approvedAmount: 240, reference: 'L1' });
  await erheat.recordPaid({ applicationNo: r.appNo, reference: 'P1' });
  await erheat.recordRepayment({ applicationNo: r.appNo, amount: 100, reference: 'R1', outstanding: 140 });
  const h = await erheat.awardedHistory(ama);
  ok(h.items.length === 1 && h.totals.borrowed === 240 && h.totals.repaid === 100 && h.items[0].status === 'repaying', 'history shows the award with totals borrowed and repaid');
  ok((await erheat.awardedHistory(kofi)).items.length === 0, 'history is private to the borrower');

  // directory pick without a bill still needs the facility's confirmation by SMS
  await mkBill('0241110002', 90, 'tenant_nyaho');
  const k = await erheat.apply(kofi, { line: 'health', facilityId: 'tenant_nyaho', amount: 80, evidence: { note: 'Dental' } });
  ok(k.status === 'needs_verification' && k.payee.name === 'Nyaho Medical Centre' && sms.some((s) => s.to === '+233302111111'), 'facility picked from the directory is sent the confirmation link');
  const yaw = await mk('+233241110003', 'Yaw');
  e = await rej(erheat.apply(yaw, { line: 'health', facilityId: 'nope', amount: 80 })); ok(e && e.status === 404, 'unknown facility is refused');

  // profile
  let pr = await erheat.saveProfile(yaw, { lines: { energy: { evidence: { reference: '12345', junk: 'x' }, payee: { name: 'ECG Vendor', phone: '0244000999' } }, nope: { evidence: { a: '1' } } } });
  ok(pr.lines.energy && Object.keys(pr.lines.energy.evidence).every((k) => k !== 'junk') && pr.lines.energy.payee.phone === '+233244000999' && !pr.lines.nope, 'profile saves only known fields for known lines');
  e = await rej(erheat.saveProfile(yaw, { lines: { energy: { payee: { name: 'Me', phone: yaw.phone } } } })); ok(e && e.status === 422, 'a saved contact cannot be the owner');
  ok((await erheat.getProfile(ama)).updatedAt === null, 'profiles are private per account');
  pr = await erheat.saveProfile(yaw, { lines: { energy: null } }); ok(!pr.lines.energy, 'a saved line can be cleared');
  // HTTP
  const app = express(); app.use('/erheat/api', routes.api); const srv = app.listen(0); await new Promise((r2) => setTimeout(r2, 50)); const base = `http://127.0.0.1:${srv.address().port}`;
  const sess = await accounts.login({ phone: '+233241110001', password: 'secret1' }); const bearer = { Authorization: `Bearer ${sess.tokens[0].token}` };
  let res = await fetch(`${base}/erheat/api/health/facilities`); let j = await res.json(); ok(res.status === 200 && j.result.length >= 2, 'HTTP: facilities are public');
  res = await fetch(`${base}/erheat/api/health/pending`); ok(res.status === 401, 'HTTP: pending needs sign-in');
  res = await fetch(`${base}/erheat/api/health/pending`, { headers: bearer }); j = await res.json(); ok(res.status === 200 && Array.isArray(j.result.items), 'HTTP: pending');
  res = await fetch(`${base}/erheat/api/history`, { headers: bearer }); j = await res.json(); ok(res.status === 200 && j.result.totals.count === 1, 'HTTP: history');
  res = await fetch(`${base}/erheat/api/profile`, { method: 'PUT', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: { energy: { evidence: { reference: '777' } } } }) }); j = await res.json(); ok(res.status === 200 && j.result.lines.energy.evidence.reference === '777', 'HTTP: save profile');
  res = await fetch(`${base}/erheat/api/profile`, { headers: bearer }); j = await res.json(); ok(j.result.lines.energy.evidence.reference === '777', 'HTTP: read profile');
  srv.close();
  console.log(`\n${a} assertions${process.exitCode ? ' — WITH FAILURES' : ' — all passed'}`);
})().catch((x) => { console.error(x); process.exit(1); });
