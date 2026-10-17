'use strict';
// Smoke test: Master Control outreach (B2B prospecting): seed orgs, consent/compliance gates, sequences across
// email/SMS/WhatsApp/LinkedIn-task, opt-out + suppression, tracking, feedback.   node scripts/smoke-outreach.js
process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const express = require('express');
const store = require('../src/store');
const outreach = require('../src/services/outreach');
const i18n = require('../src/services/i18n');
const email = require('../src/services/email');
const messaging = require('../src/services/messaging');
const operatingMode = require('../src/services/operatingMode');
const messagingAccount = require('../src/services/messagingAccount');
const routes = require('../src/routes/outreach');

let a = 0;
const ok = (c, l) => { a++; if (!c) { console.error(`FAIL #${a}: ${l}`); process.exitCode = 1; } else console.log(`ok  : ${l}`); };
const rej = async (p) => { try { await p; return null; } catch (e) { return e; } };

const sent = { email: [], sms: [] };
process.env.EMAIL_PROVIDER = 'resend'; process.env.EMAIL_API_KEY = 'k'; process.env.EMAIL_FROM = 'a@b.test';
email._setRequestImplForTests(async (url, o) => { const j = JSON.parse(o.body); sent.email.push(j); return { status: 200, body: JSON.stringify({ id: 'e' + sent.email.length }) }; });
messaging._setRequestImplForTests(async (url, o) => { const f = new URLSearchParams(o.body); sent.sms.push({ to: f.get('to'), message: f.get('message') }); return { status: 201, body: JSON.stringify({ SMSMessageData: { Recipients: [{ number: f.get('to'), status: 'Success', messageId: 'x' + sent.sms.length }] } }) }; });
i18n._setRequestImplForTests(async (m, url, body) => url.endsWith('/languages') ? { status: 200, body: [{ code: 'en' }, { code: 'fr' }] } : { status: 200, body: { translatedText: `[fr] ${body.q}` } });

(async () => {
  await store.init?.();
  await operatingMode.set({ settlement: { sandbox: true }, messaging: { sandbox: false } });
  await messagingAccount.set({ provider: 'africastalking', credentials: { apiKey: 'k', username: 'sandbox' }, active: true });

  const s = await outreach.seedOrgs();
  ok(s.added > 300 && (await outreach.seedOrgs()).added === 0, `seeded ${s.added} organisations; seeding twice adds none`);
  const ov = await outreach.overview();
  ok(ov.orgsByType.bank >= 100 && ov.orgsByType.insurer >= 80 && ov.orgsByType.core_banking >= 17 && ov.orgsByType.ehr >= 10 && ov.orgsByType.adjudication >= 10, 'banks, insurers, core banking, EHR and adjudication organisations present');
  ok((await outreach.listOrgs({ q: 'temenos' })).rows[0].type === 'core_banking', 'Temenos is in the list');
  ok(!JSON.stringify(await outreach.listOrgs({ pageSize: 200 })).includes('@'), 'seed holds no personal data (no email addresses)');
  const bankOrg = (await outreach.listOrgs({ type: 'bank', q: 'zenith bank ghana' })).rows[0] || (await outreach.listOrgs({ type: 'bank' })).rows[0];
  const insOrg = (await outreach.listOrgs({ type: 'insurer' })).rows[0];
  const hOrg = await outreach.addOrg({ name: 'Test Hospital', type: 'hospital', country: 'Ghana' });

  // consent gates
  let e = await rej(outreach.addContact({ orgId: bankOrg.id, name: 'Ama CTO', email: 'ama@bank.test', persona: 'cto' }));
  ok(e && /source_required/.test(e.message), 'a contact without a public source is refused');
  e = await rej(outreach.addContact({ orgId: bankOrg.id, name: 'Kofi', email: 'kofi@gmail.com', source: 'https://bank.test/team' }));
  ok(e && /free-mail/.test(e.message), 'free-mail addresses refused for cold outreach');
  e = await rej(outreach.addContact({ orgId: 'nope', name: 'X', email: 'x@y.test', source: 's' }));
  ok(e && e.status === 422, 'unknown organisation refused');
  const c1 = await outreach.addContact({ orgId: bankOrg.id, name: 'Ama Boateng', role: 'CTO', persona: 'cto', email: 'Ama@Bank.Test', phone: '024 111 2222', linkedin: 'https://www.linkedin.com/in/ama', source: 'https://bank.test/leadership', lang: 'fr' });
  ok(c1.email === 'ama@bank.test' && c1.phone === '+233241112222' && c1.lawfulBasis === 'legitimate_interest_b2b', 'contact stored with normalised email/phone and lawful basis');
  e = await rej(outreach.addContact({ orgId: bankOrg.id, name: 'Dup', email: 'ama@bank.test', source: 's' }));
  ok(e && e.status === 409, 'duplicate refused');
  const c2 = await outreach.addContact({ orgId: insOrg.id, name: 'Yaw Claims', persona: 'claims', email: 'yaw@insurer.test', phone: '+233200000009', source: 'https://insurer.test/contact', waOptIn: false });
  const c3 = await outreach.addContact({ orgId: hOrg.id, name: 'Esi', persona: 'ceo', email: 'esi@hospital.test', phone: '+233200000010', source: 'public site', waOptIn: true });
  const imp = await outreach.importContacts([{ org: 'Test Hospital', name: 'Imported', email: 'imp@hospital.test', source: 'src' }, { org: 'Test Hospital', name: 'Bad', email: 'bad@gmail.com', source: 'src' }, { org: 'Nope Org', name: 'Z', email: 'z@z.test', source: 's' }]);
  ok(imp.added === 1 && imp.rejected.length === 2, 'CSV/JSON import adds valid rows and reports rejections');

  // preview: identity + opt-out present
  const cfg0 = await outreach.publicConfig();
  ok(!cfg0.enabled && !cfg0.readyToSend && cfg0.missing.length >= 2, 'outreach is OFF by default and not ready until identity/address are set');
  await i18n.setConfig({ url: 'http://lt.test' }, 't');
  const pv = await outreach.preview(c1.id, 'standard', 0);
  ok(/Unsubscribe in one click/.test(pv.body) && /public page/.test(pv.body) && pv.translated && /\[fr\]/.test(pv.body), 'email preview carries source note + unsubscribe, and is translated for a French contact');
  ok(pv.subject.includes(bankOrg.name) || pv.subject.includes('{org}') === false, 'subject personalised');

  // sending gates
  await outreach.enroll({ sequenceId: 'standard' });
  let r = await outreach.runDue({ dryRun: false });
  ok(r.skipped === 'outreach_disabled', 'nothing sends while outreach is switched off');
  r = await outreach.runDue({ dryRun: true });
  ok(r.dryRun && r.results.length >= 3 && r.results.every((x) => x.result === 'would_send') && sent.email.length === 0, 'dry-run lists what would go and sends nothing');
  await outreach.setConfig({ enabled: true, hours: { from: 0, to: 24 } }, 't');
  r = await outreach.runDue({ dryRun: false });
  ok(r.skipped === 'missing_settings', 'refuses to send without sender identity and postal address');
  await outreach.setConfig({ senderName: 'Elvis Forson', senderRole: 'Founder', postalAddress: 'Accra, Ghana', publicBaseUrl: 'https://hnnbiller.example', paceMs: 0, caps: { email: 2, sms: 5, whatsapp: 5 } }, 't');
  e = await rej(outreach.setConfig({ sandboxUrl: 'ftp://x' }));
  ok(e && e.status === 422, 'bad URL setting refused');

  r = await outreach.runDue({ dryRun: false });
  ok(r.results.filter((x) => x.channel === 'email' && x.result === 'sent').length === 2 && r.results.some((x) => x.result === 'deferred' && x.reason === 'daily_cap'), 'daily email cap enforced (2 sent, rest deferred)');
  ok(sent.email.length === 2 && /unsubscribe/i.test(sent.email[0].text) && /hnnbiller\.example\/o\/u\//.test(sent.email[0].text), 'live email carries the one-click unsubscribe link');
  const ev = (await outreach.listContacts({})).rows.find((c) => c.id === c1.id);
  ok(ev.status === 'contacted' && ev.seq.step === 1, 'contact advances to step 2 after step 1');

  // later steps: LinkedIn task, SMS, WhatsApp opt-in
  const future = async () => { for (const k of await store.settings.keys('out:con:')) { const c = await store.settings.get(k); if (c && c.seq) { c.seq.nextAt = new Date(Date.now() - 1000).toISOString(); await store.settings.set(k, c); } } };
  await future(); r = await outreach.runDue({ dryRun: false });
  await outreach.setConfig({ caps: { email: 50, sms: 5, whatsapp: 5 } }, 't');
  ok(r.results.some((x) => x.channel === 'linkedin' && x.result === 'task_created') && sent.email.length === 2, 'LinkedIn step creates a manual task, never sends automatically');
  const tasks = await outreach.listTasks();
  ok(tasks.length === 1 && tasks[0].profile.includes('linkedin.com') && tasks[0].text.length <= 290, 'LinkedIn task has the profile link and short text');
  await outreach.completeTask(tasks[0].id);
  ok((await outreach.listTasks()).length === 0, 'task can be completed');
  await future(); await outreach.runDue({ dryRun: false }); await future(); r = await outreach.runDue({ dryRun: false });
  const smsRes = r.results.filter((x) => x.channel === 'sms');
  ok(sent.sms.some((x) => x.to === '+233241112222' && /Reply STOP/.test(x.message)), 'SMS step sends with a STOP instruction');
  // WhatsApp gate
  await outreach.enroll({ contactIds: [c3.id], sequenceId: 'warm' }).catch(() => null);
  const waOk = await outreach.runDue({ dryRun: true });
  const c2b = await outreach.addContact({ orgId: insOrg.id, name: 'Cold WA', phone: '+233200000077', source: 'public', persona: 'sales' });
  await outreach.enroll({ contactIds: [c2b.id], sequenceId: 'warm' });
  r = await outreach.runDue({ dryRun: false });
  ok(r.results.some((x) => x.name === 'Cold WA' && x.result === 'skipped' && x.reason === 'whatsapp_requires_opt_in'), 'cold WhatsApp is skipped unless the contact opted in');

  // opt-out / suppression
  const smsIn = await outreach.handleInboundText('0241112222', 'stop');
  ok(smsIn && smsIn.outcome === 'outreach_opt_out', 'SMS STOP is recognised');
  ok(await outreach.isSuppressed('+233241112222') && await outreach.isSuppressed('ama@bank.test'), 'phone AND email of that contact are suppressed');
  e = await rej(outreach.addContact({ orgId: bankOrg.id, name: 'Ama again', email: 'ama@bank.test', source: 's' }));
  ok(e && /suppressed/.test(e.message), 'a suppressed person cannot be re-added');
  const cNow = (await outreach.listContacts({ q: 'Ama Boateng' })).rows[0];
  ok(cNow.status === 'declined' && !cNow.seq, 'their sequence stops');

  // public pages + tracking + feedback
  const app = express(); app.use('/o', routes.pub); const srv = app.listen(0); await new Promise((r2) => setTimeout(r2, 50));
  const base = `http://127.0.0.1:${srv.address().port}/o`;
  const token = (await store.settings.get('out:con:' + c3.id)).token;
  let res = await fetch(`${base}/t/${token}`, { redirect: 'manual' });
  ok(res.status === 302 && /hnnbiller\.xchangeinsure\.com/.test(res.headers.get('location')), 'tracked sandbox link redirects to the sandbox');
  const c3n = (await outreach.listContacts({ q: 'Esi' })).rows[0];
  ok(c3n.status === 'sandbox' && (await outreach.listOrgs({ q: 'Test Hospital' })).rows[0].status === 'sandbox', 'click moves contact and organisation to "sandbox"');
  res = await fetch(`${base}/feedback?t=${token}`); const html = await res.text();
  ok(res.status === 200 && /What would you want added/.test(html), 'feedback page renders');
  res = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${token}&name=Esi&wants=${encodeURIComponent('Add Twi SMS receipts <b>please</b>')}` });
  ok(res.status === 200, 'feedback accepted');
  const fb = await outreach.listFeedback();
  ok(fb.length === 1 && fb[0].wants.includes('Twi') && fb[0].contactId === c3.id, 'feedback stored and linked to the contact');
  const c4 = await outreach.addContact({ orgId: hOrg.id, name: 'Unsub Me', email: 'u@hospital.test', source: 's' });
  const t4 = (await store.settings.get('out:con:' + c4.id)).token;
  res = await fetch(`${base}/u/${t4}`); ok((await res.text()).includes('unsubscribed') && await outreach.isSuppressed('u@hospital.test'), 'one-click unsubscribe works');
  res = await fetch(`${base}/u/bogus`); ok(/not recognised/.test(await res.text()), 'unknown unsubscribe link handled');

  // erase
  const er = await outreach.eraseContact(c2.id);
  ok(er.erased && await outreach.isSuppressed('yaw@insurer.test') && !(await outreach.listContacts({ q: 'Yaw Claims' })).rows.length, 'erase removes the person and keeps only a hash on the suppression list');
  ok(!JSON.stringify(await store.settings.keys('out:sup:')).includes('yaw'), 'suppression keys hold no plain address');

  srv.close();
  console.log(`\n${a} assertions${process.exitCode ? ' — WITH FAILURES' : ' — all passed'}`);
})().catch((x) => { console.error(x); process.exit(1); });
