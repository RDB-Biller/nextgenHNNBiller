'use strict';
// Smoke test for ERHEAT Shield (emergency micro-loans): catalogue, caps and ladder, apply, verifier confirmation,
// consent and lender push, lender hooks, vouchers, repayment, passport, fraud flags and the HTTP surfaces.
//   node scripts/smoke-erheat.js
process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const express = require('express');
const store = require('../src/store');
const messaging = require('../src/services/messaging');
const operatingMode = require('../src/services/operatingMode');
const messagingAccount = require('../src/services/messagingAccount');
const accounts = require('../src/services/patientAccounts');
const outreach = require('../src/services/outreach');
const erheat = require('../src/services/erheat');
const routes = require('../src/routes/erheat');

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
  const mk = async (phone, name) => { await accounts.register({ first_name: name, last_name: 'Test', phone, password: 'secret1' }); return accounts.byPhone(phone); };
  const ama = await mk('+233241110001', 'Ama'); const kofi = await mk('+233241110002', 'Kofi');

  let e = await rej(erheat.apply(ama, { line: 'rent', amount: 300 })); ok(e && e.status === 404, 'closed until the operator opens it');
  await erheat.setConfig({ enabled: true });
  e = await rej(erheat.apply(ama, { line: 'rent', amount: 100 })); ok(e && e.status === 403 && /verify your phone/.test(e.message), 'an unverified phone cannot borrow');
  await erheat.setConfig({ requireVerifiedPhone: false });
  const cat = await erheat.lines(ama.phone);
  ok(cat.lines.length === 6 && cat.lines.find((l) => l.key === 'rent').enabled && cat.lines.find((l) => l.key === 'health').enabled && !cat.lines.find((l) => l.key === 'education').enabled && cat.lines.find((l) => l.key === 'education').comingSoon, 'six lines; Rent and Health open, the rest coming soon');
  ok(cat.lines.find((l) => l.key === 'rent').cap === 500 && cat.passport.level === 'new', 'a new borrower starts at the ladder cap (GHS 500)');
  e = await rej(erheat.setConfig({ ladder: { new: 5000 } })); ok(e && e.status === 422, 'ladder can never exceed the hard cap of GHS 2,000');

  const goodRent = { line: 'rent', amount: 300, payee: { name: 'Mr Boateng', phone: '0244000111' }, verifier: { name: 'Mr Boateng', phone: '0244000111' }, evidence: { monthlyRent: 200, dueDate: '2026-11-01', address: 'Kasoa' } };
  e = await rej(erheat.apply(ama, { ...goodRent, amount: 600 })); ok(e && e.status === 422 && /GHS 500/.test(e.message), 'amount above the borrower limit is refused');
  e = await rej(erheat.apply(ama, { ...goodRent, amount: 700, evidence: { ...goodRent.evidence } })); ok(e && e.status === 422, 'rent loan cannot exceed three months of rent (and the limit)');
  e = await rej(erheat.apply(ama, { ...goodRent, verifier: { phone: ama.phone } })); ok(e && e.status === 422 && /own number/.test(e.message), 'the verifier cannot be the borrower');
  e = await rej(erheat.apply(ama, { ...goodRent, evidence: { monthlyRent: 200 } })); ok(e && e.status === 422, 'required evidence is enforced');
  await outreach.suppress('+233244999999', 'test');
  e = await rej(erheat.apply(ama, { ...goodRent, verifier: { phone: '0244999999' } })); ok(e && e.status === 409, 'a person who opted out cannot be named as verifier');

  const app1 = await erheat.apply(ama, goodRent);
  ok(app1.status === 'needs_verification' && /^ERH-\d{6}$/.test(app1.appNo) && app1.payee.phone.endsWith('0111') && !JSON.stringify(app1).includes('+233244000111'), 'application created; phones are masked in the borrower view');
  const vsms = lastTo('+233244000111'); ok(vsms && /confirm or decline/.test(vsms.message) && /ERHEAT/.test(vsms.message), 'verifier receives an SMS with a one-time link');
  e = await rej(erheat.apply(ama, goodRent)); ok(e && e.status === 409, 'only one open request per line');
  const tok = tokenIn(vsms.message);
  const vv = await erheat.verifierView(tok); ok(vv.open && vv.amount === 300 && vv.askAccountName && !JSON.stringify(vv).includes('233241110001'), 'verifier view shows the request but not the borrower phone');
  await erheat.verifierRespond(tok, { decision: 'confirm', confirmedAmount: 250, accountName: 'Completely Different Person' });
  const a1 = await erheat.getMine(ama, app1.id);
  ok(a1.status === 'verified' && a1.verifiedAmount === 250 && a1.flagsCount === 2, 'verifier confirmed a lower amount; amount lowered and payee-name mismatch are flagged');
  e = await rej(erheat.verifierRespond(tok, { decision: 'confirm' })); ok(e && e.status === 409, 'a verifier link works once');

  const posts = []; erheat._setPostImplForTests(async (url, body, headers) => { posts.push({ url, body, headers }); return { status: 200 }; });
  await erheat.setConfig({ lender: { name: 'ConfirmU', pushUrl: 'https://lender.example/apps' } });
  e = await rej(erheat.consent(kofi, app1.id, { agree: true })); ok(e && e.status === 404, 'another borrower cannot touch this request');
  e = await rej(erheat.consent(ama, app1.id, {})); ok(e && e.status === 422, 'consent is required');
  const sub = await erheat.consent(ama, app1.id, { agree: true, ip: '1.2.3.4' });
  ok(sub.status === 'submitted' && posts.length === 1 && /^sha256=[0-9a-f]{64}$/.test(posts[0].headers['x-erheat-signature']) && posts[0].body.packet.amountVerified === 250 && posts[0].body.packet.confirmations.length === 1 && posts[0].body.callbacks.decision.includes('/erheat-hooks/'), 'packet is pushed to the lender, signed, with callback URLs and the verified amount');
  const pk = await erheat.packetByAppNo(app1.appNo); ok(pk.packet.paymentInstruction.includes('never the borrower') && pk.packet.payee.name === 'Mr Boateng', 'lender can fetch the packet; instruction is to pay the payee');

  e = await rej(erheat.recordDecision({ applicationNo: app1.appNo, decision: 'approved', approvedAmount: 400 })); ok(e && e.status === 422, 'approval above the verified amount is refused');
  const ap = await erheat.recordDecision({ applicationNo: app1.appNo, decision: 'approved', approvedAmount: 250, reference: 'L-1' });
  ok(ap.status === 'approved' && ap.approvedAmount === 250 && ap.voucher === null, 'lender decision recorded (rent is paid by the lender to the payee, no voucher)');
  await erheat.recordPaid({ applicationNo: app1.appNo, reference: 'P-1' }); ok((await erheat.getMine(ama, app1.id)).status === 'payee_paid', 'lender confirms the payee was paid');
  const r1 = await erheat.recordRepayment({ applicationNo: app1.appNo, amount: 100, reference: 'R-1', outstanding: 150 });
  const r1b = await erheat.recordRepayment({ applicationNo: app1.appNo, amount: 100, reference: 'R-1', outstanding: 150 });
  ok(r1.status === 'repaying' && r1b.repayments.length === 1, 'repayments are idempotent on the lender reference');
  const r2 = await erheat.recordRepayment({ applicationNo: app1.appNo, amount: 150, reference: 'R-2', outstanding: 0 }); ok(r2.status === 'closed', 'loan closes when nothing is outstanding');
  const pass = await erheat.passport(ama.phone); ok(pass.level === 'trusted' && pass.ceiling === 1000 && pass.repaid === 1, 'repaying raises the Trust Passport and the limit');
  const cat2 = await erheat.lines(ama.phone); ok(cat2.lines.find((l) => l.key === 'rent').cap === 1000, 'the catalogue shows the higher limit');

  // voucher line (energy), co-verifier on rent, decline, expiry
  await erheat.setConfig({ lines: { energy: { enabled: true } } });
  const en = await erheat.apply(kofi, { line: 'energy', amount: 200, payee: { name: 'Shell Station', phone: '0302000111' }, verifier: { phone: '0302000111' }, evidence: { kind: 'fuel', invoiceAmount: 220 } });
  const etok = tokenIn(lastTo('+233302000111').message); await erheat.verifierRespond(etok, { decision: 'confirm', accountName: 'Shell Station' });
  const enb = await erheat.getMine(kofi, en.id); ok(enb.status === 'verified' && enb.flagsCount === 0, 'matching payee name leaves no flag');
  await erheat.consent(kofi, en.id, { agree: true });
  const ens = await erheat.recordDecision({ applicationNo: en.appNo, decision: 'approved' });
  const vm = [...sms].reverse().find((x) => x.to === '+233241110002' && /One-time code/.test(x.message)); const code = ens.voucher.code; const otp = /One-time code: (\d{6})/.exec(vm.message)[1];
  ok(ens.status === 'approved' && /^[A-Z0-9]{8}$/.test(code) && !JSON.stringify(ens).includes(otp), 'voucher issued; the one-time code goes only to the borrower by SMS');
  e = await rej(erheat.redeem({ code, otp, phone: '0244555666' })); ok(e && e.status === 403, 'a different vendor cannot redeem');
  e = await rej(erheat.redeem({ code, otp: '000000', phone: '0302000111' })); ok(e && e.status === 422, 'wrong one-time code refused');
  const red = await erheat.redeem({ code, otp, phone: '0302000111' }); ok(red.ok && red.amount === 200 && (await erheat.getMine(kofi, en.id)).status === 'payee_paid', 'vendor redeems with code + one-time code; request becomes payee_paid');
  e = await rej(erheat.redeem({ code, otp, phone: '0302000111' })); ok(e && e.status === 404, 'a voucher works once');

  const co = await erheat.apply(kofi, { ...goodRent, payee: { name: 'Landlady', phone: '0244777001' }, verifier: { phone: '0244777001' }, coVerifier: { phone: '0244777002', name: 'Flatmate' } });
  ok(co.verifiers.length === 2, 'rent supports a co-tenant as a second required verifier');
  await erheat.verifierRespond(tokenIn(lastTo('+233244777001').message), { decision: 'confirm' });
  ok((await erheat.getMine(kofi, co.id)).status === 'needs_verification', 'still waiting for the co-tenant');
  await erheat.verifierRespond(tokenIn(lastTo('+233244777002').message), { decision: 'decline' });
  ok((await erheat.getMine(kofi, co.id)).status === 'declined', 'a decline by any required verifier ends the request');

  const sim = await erheat.apply(ama, { ...goodRent, amount: 100, payee: { name: 'Landlady', phone: '0244777001' }, verifier: { phone: '0244777001' } });
  const adm = await erheat.adminGet(sim.id); ok(adm.verifiers[0].token && !adm.voucher, 'operator view includes the request detail');
  await erheat.verifierRespond(tokenIn(lastTo('+233244777001').message), { decision: 'confirm' }); await erheat.consent(ama, sim.id, { agree: true });
  const sm = await erheat.simulate(sim.id, { action: 'approve' }); ok(sm.status === 'approved', 'operator can rehearse the lender in sandbox mode');
  await operatingMode.set({ settlement: { sandbox: false }, confirm: 'LIVE' }); e = await rej(erheat.simulate(sim.id, { action: 'paid' })); ok(e && e.status === 403, 'simulation is refused outside sandbox mode'); await operatingMode.set({ settlement: { sandbox: true } });

  const old = await store.settings.get('erheat:app:' + (await erheat.myApps(kofi)).find((x) => x.status === 'declined').id);
  const exp = await erheat.apply(ama, { line: 'health', amount: 100, payee: { name: 'Korle Pharmacy', phone: '0302555000' }, verifier: { phone: '0302555000' }, evidence: { facility: 'Korle Pharmacy' } });
  const raw = await store.settings.get('erheat:app:' + exp.id); raw.expiresAt = new Date(Date.now() - 1000).toISOString(); await store.settings.set('erheat:app:' + exp.id, raw);
  const sw = await erheat.sweep(); ok(sw.expired >= 1 && (await erheat.getMine(ama, exp.id)).status === 'expired' && old, 'unanswered requests expire');
  e = await rej(erheat.verifierRespond(tokenIn(lastTo('+233302555000').message), { decision: 'confirm' })); ok(e && e.status === 409, 'an expired request cannot be confirmed');

  // HTTP surfaces
  const app = express(); app.use('/erheat/api', routes.api); app.use('/erheat', routes.pages); app.use('/erheat-hooks', routes.hooks);
  const srv = app.listen(0); await new Promise((r) => setTimeout(r, 50)); const base = `http://127.0.0.1:${srv.address().port}`;
  const sess = await accounts.login({ phone: '+233241110002', password: 'secret1' }); const bearer = { Authorization: `Bearer ${sess.tokens[0].token}`, 'Content-Type': 'application/json' };
  let res = await fetch(`${base}/erheat/api/lines`, { headers: bearer }); let j = await res.json(); ok(res.status === 200 && j.result.lines.length === 6, 'HTTP: catalogue');
  res = await fetch(`${base}/erheat/api/apps`); ok(res.status === 401, 'HTTP: borrower endpoints need a signed-in account');
  res = await fetch(`${base}/erheat/api/apply`, { method: 'POST', headers: bearer, body: JSON.stringify({ line: 'health', amount: 100, payee: { name: 'Clinic', phone: '0302999111' }, verifier: { phone: '0302999111' }, evidence: { facility: 'Clinic' } }) }); j = await res.json();
  ok(res.status === 201 && j.result.status === 'needs_verification', 'HTTP: apply');
  const vt = tokenIn(lastTo('+233302999111').message);
  res = await fetch(`${base}/erheat/v/${vt}`); let html = await res.text(); ok(res.status === 200 && /Yes, confirm/.test(html) && /Clinic/.test(html) && !/233241110002/.test(html), 'HTTP: verifier page renders without the borrower phone');
  res = await fetch(`${base}/erheat/v/${vt}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'decision=confirm&accountName=Clinic' }); html = await res.text(); ok(res.status === 200 && /Your confirmation is recorded/.test(html), 'HTTP: verifier confirms');
  res = await fetch(`${base}/erheat/v/bogus`); ok(res.status === 404, 'HTTP: unknown verifier link');
  const hu = await erheat.hookUrls(base); const secretPath = hu.decision.replace(base, '').replace('/decision', '');
  res = await fetch(`${base}/erheat-hooks/wrongsecret/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); ok(res.status === 404, 'HTTP: lender hook with a wrong secret is 404');
  res = await fetch(`${base}${secretPath}/applications/${j.result.appNo}`); const pj = await res.json(); ok(res.status === 200 && pj.packet.appNo === j.result.appNo, 'HTTP: lender fetches the packet with the secret');
  res = await fetch(`${base}/erheat/redeem`); ok(res.status === 200 && /Redeem an ERHEAT voucher/.test(await res.text()), 'HTTP: vendor redemption page');
  srv.close();
  console.log(`\n${a} assertions${process.exitCode ? ' — WITH FAILURES' : ' — all passed'}`);
})().catch((x) => { console.error(x); process.exit(1); });
