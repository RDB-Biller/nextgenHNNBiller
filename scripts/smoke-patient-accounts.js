'use strict';
// Smoke test for the Afriyie patient-account API served by the Biller (/patient-api/v1):
// register, SMS verification through the Biller's provider, login, profile, password change/reset,
// budgets and vitals, and the error paths. In-memory store, SMS faked.   node scripts/smoke-patient-accounts.js

process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const express = require('express');
const store = require('../src/store');
const messaging = require('../src/services/messaging');
const operatingMode = require('../src/services/operatingMode');
const messagingAccount = require('../src/services/messagingAccount');
const sav = require('../src/services/savingsPlans');
const patientApi = require('../src/routes/patientApi');
const accounts = require('../src/services/patientAccounts');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const sms = [];
messaging._setRequestImplForTests(async (url, opts) => {
  const f = new URLSearchParams(opts.body); sms.push({ to: f.get('to'), message: f.get('message') });
  return { status: 201, body: JSON.stringify({ SMSMessageData: { Recipients: [{ number: f.get('to'), status: 'Success', messageId: `ATXid_${sms.length}` }] } }) };
});
const lastCode = () => /\b(\d{6})\b/.exec(sms[sms.length - 1].message)[1];

(async () => {
  await store.init?.();
  await operatingMode.set({ settlement: { sandbox: true }, messaging: { sandbox: false } }); // live messaging: texts go to the provider
  await messagingAccount.set({ provider: 'africastalking', credentials: { apiKey: 'at-sandbox-key', username: 'sandbox' }, active: true });
  const app = express(); app.use(express.json()); app.use('/patient-api/v1', patientApi);
  const server = app.listen(0); await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${server.address().port}/patient-api/v1`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // register
  let r = await call('POST', '/patient/register', { first_name: 'Ama', last_name: 'Mensah', phone: '+233241234567', password: 'secret1' });
  ok(r.status === 201 && r.body.result.phone === '+233241234567' && !r.body.result.passwordHash && !('budgets' in r.body.result), 'register creates the account and exposes no hash');
  r = await call('POST', '/patient/register', { first_name: 'Ama', last_name: 'Mensah', phone: '0241234567', password: 'secret1' });
  ok(r.status === 409 && /already exists/.test(r.body.error), 'a local-format duplicate phone is refused');
  r = await call('POST', '/patient/register', { first_name: 'X', last_name: 'Y', phone: '12', password: 'secret1' });
  ok(r.status === 422, 'invalid phone refused');
  r = await call('POST', '/patient/register', { first_name: 'X', last_name: 'Y', phone: '+233200000001', password: '123' });
  ok(r.status === 422 && /6 characters/.test(r.body.error), 'short password refused');

  // language preference localises SMS
  r = await call('POST', '/patient/register', { first_name: 'Awa', last_name: 'Diallo', phone: '+233200000777', password: 'secret1', language: 'fr' });
  ok(r.status === 201 && r.body.result.language === 'fr', 'register stores the preferred language');
  await call('PATCH', '/patient/forgot_password', { phone: '+233200000777' });
  ok(/Votre code de réinitialisation/.test(sms[sms.length - 1].message), 'password-reset SMS is sent in the account language');
  await call('POST', '/patient/send_verification_code', { phone: '+233200000778', lang: 'es' });
  ok(/Su código de verificación/.test(sms[sms.length - 1].message), 'verification SMS honours the requested language');

  // login
  r = await call('POST', '/patient/login', { phone: '+233241234567', password: 'wrong' });
  ok(r.status === 401 && r.body.error, 'wrong password refused');
  r = await call('POST', '/patient/login', { phone: '0241234567', password: 'secret1' });
  const token = r.body.result?.tokens?.[0]?.token; const id = r.body.result?._id;
  ok(r.status === 200 && token && id && r.body.result.phoneVerified === false, 'login (local phone format) returns _id and tokens[0].token');

  // verification through the Biller's SMS provider, then receipt -> verify_phone
  const n0 = sms.length;
  const sent = await call('POST', '/patient/send_verification_code', { phone: '+233241234567' });
  ok(sent.status === 200 && sent.body.sent && sms.length === n0 + 1 && sms[n0].to === '+233241234567', 'verification code is texted via the biller provider (Africa\'s Talking)');
  const chk = await sav.verifyAndReceipt('+233241234567', lastCode());
  r = await call('PATCH', '/patient/verify_phone', { phone: '+233241234567', code: 'x', ...chk });
  ok(r.status === 200 && r.body.result.phoneVerified === true && r.body.result.tokens?.[0]?.token, 'verify_phone accepts the signed receipt, marks verified and returns a session');
  r = await call('PATCH', '/patient/verify_phone', { phone: '+233241234567', verifiedAt: chk.verifiedAt, receipt: 'f'.repeat(64) });
  ok(r.status === 401, 'a forged receipt is refused');
  r = await call('PATCH', '/patient/verify_phone', { phone: '+233241234567', verifiedAt: new Date(Date.now() - 3600000).toISOString(), receipt: chk.receipt });
  ok(r.status === 401, 'a stale receipt is refused');

  // profile
  r = await call('GET', '/patient/me');
  ok(r.status === 401, 'me needs a token');
  r = await call('GET', '/patient/me', null, token);
  ok(r.status === 200 && r.body.result.user.first_name === 'Ama', 'me returns result.user');
  r = await call('PATCH', '/patient/update', { first_name: 'Ama', last_name: 'Mensah', city: 'Accra', email: 'ama@example.com', ghana_card: 'GHA-1', passwordHash: 'hack', phone: '+233999' }, token);
  ok(r.status === 200 && r.body.result.user.city === 'Accra', 'profile update saves allowed fields');
  r = await call('GET', '/patient/me', null, token);
  ok(r.body.result.user.phone === '+233241234567' && r.body.result.user.passwordHash === undefined, 'phone and hash cannot be changed through update');
  r = await call('GET', '/patient/me', null, token + 'x');
  ok(r.status === 401, 'a tampered token is refused');

  // budgets
  r = await call('POST', '/budget/add_budget', { budget_type: 'Delivery', budget_date: '2026-11-01', description: 'deposit', amount: '500' }, token);
  ok(r.status === 201 && r.body.result.amount === 500, 'budget added');
  r = await call('POST', '/budget/add_budget', { budget_type: 'Delivery', budget_date: '2026-11-01', amount: -4 }, token);
  ok(r.status === 422, 'negative budget refused');
  r = await call('GET', '/budget/patient_budgets', null, token);
  ok(r.status === 200 && r.body.result.length === 1 && r.body.result[0].budget_type === 'Delivery', 'budgets listed');

  // vitals
  r = await call('POST', '/vital/add_vital', { vital_type: 'BP', value: '120/80', description: 'clinic' }, token);
  ok(r.status === 201 && r.body.result.vital_type === 'BP', 'blood pressure recorded');
  const lmp = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  r = await call('POST', '/vital/add_vital', { vital_type: 'GE', value: '', first_day_of_last_circle: lmp }, token);
  ok(r.status === 201 && r.body.result.due_in_days > 150 && r.body.result.due_in_days < 200 && r.body.result.full_term_date, 'pregnancy entry computes due date and days to go');
  r = await call('POST', '/vital/add_vital', { vital_type: 'XX', value: '1' }, token);
  ok(r.status === 422, 'unknown vital type refused');
  r = await call('GET', '/vital/patient_vitals', null, token);
  ok(r.body.result.length === 2, 'vitals listed');
  r = await call('GET', '/vital', null, token);
  ok(r.status === 200 && r.body.result.length === 2, 'GET /vital works as the app calls it');

  // password change and reset
  r = await call('PATCH', '/patient/change_password', { old_password: 'nope', password: 'newpass1' }, token);
  ok(r.status === 401, 'change password needs the current password');
  r = await call('PATCH', '/patient/change_password', { old_password: 'secret1', password: 'newpass1' }, token);
  ok(r.status === 200, 'password changed');
  r = await call('POST', '/patient/login', { phone: '+233241234567', password: 'newpass1' });
  ok(r.status === 200, 'new password works');

  const before = sms.length;
  r = await call('PATCH', '/patient/forgot_password', { phone: '+233241234567' });
  ok(r.status === 200 && sms.length === before + 1 && /reset code/.test(sms[sms.length - 1].message), 'reset code texted via the biller provider');
  const resetCode = lastCode();
  r = await call('PATCH', '/patient/forgot_password', { phone: '+233200009999' });
  ok(r.status === 200 && sms.length === before + 1, 'unknown phone gets the same answer and no text (no account enumeration)');
  r = await call('PATCH', `/patient/reset_password?code=000000`, { password: 'again123' });
  ok(r.status === 401, 'wrong reset code refused');
  r = await call('PATCH', `/patient/reset_password?code=${resetCode}`, { password: 'again123' });
  ok(r.status === 200, 'reset code sets a new password');
  r = await call('PATCH', `/patient/reset_password?code=${resetCode}`, { password: 'third123' });
  ok(r.status === 401, 'reset code is single use');
  r = await call('POST', '/patient/login', { phone: '+233241234567', password: 'again123' });
  ok(r.status === 200, 'login with the reset password');

  // second patient cannot see the first one's data
  await call('POST', '/patient/register', { first_name: 'Kofi', last_name: 'Boateng', phone: '+233201112223', password: 'kofipass' });
  const k = (await call('POST', '/patient/login', { phone: '+233201112223', password: 'kofipass' })).body.result.tokens[0].token;
  r = await call('GET', '/budget/patient_budgets', null, k);
  ok(r.status === 200 && r.body.result.length === 0, 'accounts are isolated from each other');


  // appointments
  const soon = new Date(Date.now() + 10 * 3600000);
  const day = (d) => d.toISOString().slice(0, 10); const hm = (d) => d.toISOString().slice(11, 16);
  r = await call('POST', '/appointment/add_appointment', { title: 'Antenatal visit', date: day(soon), time: hm(soon), hospital: 'Euracare', doctor: 'Dr Owusu' }, token);
  const apptId = r.body.result?._id;
  ok(r.status === 201 && apptId && r.body.result.status === 'upcoming', 'appointment saved');
  r = await call('POST', '/appointment/add_appointment', { title: '', date: '2026-12-01' }, token);
  ok(r.status === 422, 'appointment needs a title');
  r = await call('POST', '/appointment/add_appointment', { title: 'Scan', date: '2027-01-15', time: '9am' }, token);
  ok(r.status === 422, 'bad time format refused');
  await call('POST', '/appointment/add_appointment', { title: 'Later visit', date: '2027-03-01', time: '10:00' }, token);
  r = await call('GET', '/appointment/patient_appointments', null, token);
  ok(r.body.result.length === 2 && r.body.result[0].title === 'Antenatal visit', 'appointments listed soonest first');
  r = await call('PATCH', `/appointment/update/${apptId}`, { notes: 'bring ID' }, token);
  ok(r.status === 200 && r.body.result.notes === 'bring ID' && r.body.result.title === 'Antenatal visit', 'appointment updated without losing other fields');
  r = await call('GET', `/appointment/${apptId}`, null, token);
  ok(r.status === 200, 'appointment fetched by id');
  r = await call('GET', `/appointment/${apptId}`, null, k);
  ok(r.status === 404, "another patient cannot read someone else's appointment");

  // SMS reminder within 24h, once only, to the verified phone
  const smsBefore = sms.length;
  let rem = await accounts.runAppointmentReminders();
  ok(rem.sent === 1 && sms.length === smsBefore + 1 && /Reminder: Antenatal visit/.test(sms[sms.length - 1].message) && sms[sms.length - 1].to === '+233241234567', 'appointment reminder is texted via the biller provider');
  rem = await accounts.runAppointmentReminders();
  ok(rem.sent === 0, 'the reminder is sent only once');

  // notifications
  r = await call('GET', '/notification/me', null, token);
  const kinds = r.body.result.map((n) => n.kind);
  ok(r.status === 200 && kinds.includes('welcome') && kinds.includes('appointment') && kinds.includes('reminder') && r.body.unread >= 3, 'welcome, appointment-saved and coming-up notices exist');
  const nid = r.body.result[0]._id;
  r = await call('PATCH', `/notification/read_notification/${nid}`, {}, token);
  ok(r.status === 200 && r.body.result.find((n) => n._id === nid).read === true, 'a notification can be marked read');
  r = await call('PATCH', '/notification/read_notification/all', {}, token);
  ok(r.body.result.every((n) => n.read), 'all can be marked read');

  r = await call('DELETE', `/appointment/delete/${apptId}`, null, token);
  ok(r.status === 200, 'appointment deleted');
  r = await call('GET', '/appointment/patient_appointments', null, token);
  ok(r.body.result.length === 1, 'deleted appointment is gone');

  // vault
  const pdf = Buffer.from('%PDF-1.4 test file').toString('base64');
  r = await call('POST', '/vault/add_file', { name: 'Scan report.pdf', type: 'application/pdf', data: `data:application/pdf;base64,${pdf}`, category: 'Scans' }, token);
  const fid = r.body.result?._id;
  ok(r.status === 201 && fid && r.body.result.size > 0 && !('data' in r.body.result), 'file stored; list metadata carries no content');
  r = await call('POST', '/vault/add_file', { name: 'x.exe', type: 'application/x-msdownload', data: pdf }, token);
  ok(r.status === 422, 'executables refused');
  r = await call('POST', '/vault/add_file', { name: 'big.pdf', type: 'application/pdf', data: Buffer.alloc(1100 * 1024, 1).toString('base64') }, token);
  ok(r.status === 413, 'files over 1 MB refused');
  r = await call('GET', '/vault/patient_files', null, token);
  ok(r.body.result.length === 1 && r.body.result[0].category === 'Scans', 'vault listed');
  r = await call('GET', `/vault/${fid}`, null, token);
  ok(r.status === 200 && Buffer.from(r.body.result.data, 'base64').toString().startsWith('%PDF'), 'file content comes back intact');
  r = await call('GET', `/vault/${fid}`, null, k);
  ok(r.status === 404, "another patient cannot read someone else's file");
  r = await call('PATCH', `/vault/update_file/${fid}`, { name: 'Scan 12 weeks.pdf', note: 'first scan' }, token);
  ok(r.status === 200 && r.body.result.name === 'Scan 12 weeks.pdf', 'file renamed');
  r = await call('DELETE', `/vault/delete/${fid}`, null, token);
  ok(r.status === 200, 'file deleted');
  r = await call('GET', `/vault/${fid}`, null, token);
  ok(r.status === 404, 'deleted file cannot be fetched');

  // CORS preflight for the browser app
  const pre = await fetch(base + '/patient/login', { method: 'OPTIONS' });
  ok(pre.status === 204 && /Authorization/.test(pre.headers.get('access-control-allow-headers') || ''), 'CORS preflight allows the Authorization header');

  server.close();
  console.log(`\nPATIENT ACCOUNTS CHECK: ${a} assertions ${process.exitCode ? 'WITH FAILURES' : 'passed'}`);
})().catch((e) => { console.error(e); process.exit(1); });
