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

let countryRows;
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

  // ---- role / team mailboxes and phone line types
  const fnb = await outreach.addOrg({ name: 'First National Bank Ghana', type: 'bank', country: 'Ghana', website: 'https://fnb.test' });
  const hl = await outreach.addContact({ orgId: fnb.id, email: 'ghanahomeloans@fnb.test', phones: ['+233 30 222 4444', '024 111 3333'], purpose: 'home loans', source: 'https://fnb.test/contact' });
  ok(hl.kind === 'role' && hl.persona === 'general' && /First National Bank Ghana/.test(hl.name), 'a product team mailbox (ghanahomeloans@) is stored as a role contact without a person name');
  ok(hl.phone === '+233241113333' && hl.landline === '+233302224444' && hl.phones.find((p) => p.number === '+233302224444').type === 'landline', 'Ghana mobile vs landline are told apart');
  const sales = await outreach.addContact({ orgId: fnb.id, email: 'Sales@fnb.test', source: 'https://fnb.test/contact' });
  ok(sales.kind === 'role' && sales.persona === 'sales' && sales.purpose === 'sales', 'sales@ maps to the sales persona');
  const comms = await outreach.addContact({ orgId: fnb.id, email: 'communications@fnb.test', source: 'https://fnb.test/contact' });
  ok(comms.persona === 'comms', 'communications@ maps to the comms persona');
  for (const bad of ['careers@fnb.test', 'no-reply@fnb.test', 'privacy@fnb.test', 'hr@fnb.test']) { e = await rej(outreach.addContact({ orgId: fnb.id, email: bad, source: 's' })); ok(e && /not_a_business_enquiry_mailbox/.test(e.message), `${bad} is refused`); }
  e = await rej(outreach.addContact({ orgId: fnb.id, email: 'info@gmail.com', source: 's' })); ok(e && /free-mail/.test(e.message), 'free-mail team mailbox still refused');
  const cl = outreach.classifyPhone;
  ok(cl('+2348031234567') === 'mobile' && cl('+27821234567') === 'mobile' && cl('+27111234567') === 'landline' && cl('+254201234567') === 'landline' && cl('+254712345678') === 'mobile' && cl('+27800123456') === 'tollfree' && cl('+15551234567') === 'unknown', 'classifier: Nigeria/SA/Kenya mobile, landline, toll-free, unknown');
  const sw = await outreach.addContact({ orgId: fnb.id, name: 'Head office switchboard', persona: 'general', landline: '+233 30 222 5555', source: 'https://fnb.test/contact' });
  ok(sw.phone === '' && sw.landline === '+233302225555', 'landline-only contact has no SMS number');
  const fixed = await outreach.patchContact(sw.id, { phoneType: { number: '+233302225555', type: 'mobile' } });
  ok(fixed.phone === '+233302225555', 'line type can be corrected by hand');
  await outreach.patchContact(sw.id, { phoneType: { number: '+233302225555', type: 'landline' } });
  const mp = await outreach.preview(hl.id, 'switchboard', 0);
  ok(/^Dear team,/.test(mp.body) && /not the right team/.test(mp.body), 'team mailbox email greets the team and asks to forward');
  await outreach.enroll({ contactIds: [sw.id, hl.id], sequenceId: 'switchboard' });
  const bump = async (id) => { const c = await store.settings.get('out:con:' + id); c.seq.nextAt = new Date(Date.now() - 1000).toISOString(); await store.settings.set('out:con:' + id, c); };
  await outreach.setConfig({ caps: { email: 500, sms: 50, whatsapp: 50 } }, 't');
  await bump(sw.id); await bump(hl.id); await outreach.runDue({ dryRun: false });   // step 1: email (sw has none -> skipped)
  await bump(sw.id); await bump(hl.id); r = await outreach.runDue({ dryRun: true });
  ok(r.results.filter((x) => x.channel === 'call').length === 2 && r.results.every((x) => x.result !== 'would_send' || x.channel !== 'sms'), 'switchboard sequence plans phone-call tasks for numbers');
  await bump(sw.id); await bump(hl.id); r = await outreach.runDue({ dryRun: false });
  const callTasks = (await outreach.listTasks()).filter((t) => t.kind === 'call');
  ok(callTasks.length === 2 && callTasks.some((t) => t.phone === '+233302224444' && t.phoneType === 'landline') && /Ask for/.test(callTasks[0].text), 'call tasks carry the number, its line type and a script (landline preferred over mobile)');
  const smsOnly = await outreach.addContact({ orgId: fnb.id, name: 'Landline Larry', landline: '+233 30 222 6666', source: 'https://fnb.test/team' });
  await outreach.enroll({ contactIds: [smsOnly.id], sequenceId: 'standard' }); await bump(smsOnly.id);
  // advance Larry to the SMS step
  let L = await store.settings.get('out:con:' + smsOnly.id); L.seq.step = 3; L.seq.nextAt = new Date(Date.now() - 1000).toISOString(); await store.settings.set('out:con:' + smsOnly.id, L);
  r = await outreach.runDue({ dryRun: false });
  ok(r.results.some((x) => x.name === 'Landline Larry' && x.channel === 'sms' && x.result === 'skipped' && x.reason === 'no_mobile_number'), 'SMS never goes to a non-mobile number');
  const ov2 = await outreach.overview();
  ok(ov2.roleMailboxes >= 3 && ov2.nonMobileNumbers >= 2, 'overview counts team mailboxes and non-mobile numbers');
  const stopSw = await outreach.handleInboundText('0241113333', 'STOP');
  ok(stopSw.outcome === 'outreach_opt_out' && await outreach.isSuppressed('+233302224444') && await outreach.isSuppressed('ghanahomeloans@fnb.test'), 'STOP from the mobile suppresses the whole team contact (email and landline too)');

  // ---- referral programme
  let ro = await fetch(`${base}/refer`); ok(ro.status === 404, 'referral pages are closed while the programme is OFF');
  e = await rej(outreach.introduce('p000', { attest: true })); ok(e && e.status === 404, 'introductions refused while OFF');
  await outreach.setConfig({ referral: { enabled: true, maxIntrosPerDay: 2, terms: 'Recognition only, no cash.', tiers: [{ at: 1, label: 'Founding Referrer', reward: 'Named thank-you' }, { at: 3, label: 'Champion', reward: 'Early access' }] } }, 't');
  const refEmail = await outreach.preview(sales.id, 'standard', 0);
  ok(/\/o\/refer\/c/.test(refEmail.body), 'emails carry the recipient personal referral link when ON');
  const esiCode = 'c' + (await store.settings.get('out:con:' + c3.id)).token;
  res = await fetch(`${base}/r/${esiCode}`, { redirect: 'manual' });
  ok(res.status === 302 && /ref=c/.test(res.headers.get('location')), 'share link redirects to the sandbox with the referral code attached');
  let st = await outreach.referralStats(esiCode); ok(st.clicks === 1 && st.points === 0 && st.name === 'Esi', 'link visit counted for the referrer');
  res = await fetch(`${base}/refer/${esiCode}`); const html2 = await res.text(); ok(res.status === 200 && /Introduce a colleague/.test(html2) && /Recognition only/.test(html2) && !/esi@hospital\.test/.test(html2), 'referrer page renders with terms and no email addresses');
  e = await rej(outreach.introduce(esiCode, { name: 'Kwame Mensah', email: 'kwame@rival.test', org: 'Rival Bank' })); ok(e && e.status === 422, 'introduction without the "I know this person" confirmation is refused');
  e = await rej(outreach.introduce(esiCode, { attest: true, name: 'X', email: 'x@gmail.com', org: 'Rival Bank' })); ok(e && /free-mail/.test(e.message), 'introducing a free-mail address is refused');
  const iv = await outreach.introduce(esiCode, { attest: true, name: 'Kwame Mensah', role: 'CTO', email: 'kwame@rival.test', org: 'Rival Bank', orgType: 'bank' });
  const kw = (await outreach.listContacts({ q: 'Kwame' })).rows[0];
  ok(iv.ok && kw.seq && kw.seq.id === 'referral' && /Introduced by Esi/.test(kw.source) && kw.lawfulBasis === 'legitimate_interest_b2b', 'introduction creates a sourced contact enrolled in the referral sequence');
  const rp = await outreach.preview(kw.id, 'referral', 0);
  ok(/Esi suggested we get in touch/.test(rp.subject) && /Esi/.test(rp.body) && /Unsubscribe in one click/.test(rp.body), 'introduction email names the referrer and carries the opt-out');
  ok((await outreach.introduce(esiCode, { attest: true, name: 'Kwame', email: 'kwame@rival.test', org: 'Rival Bank' })).already, 'introducing someone already known is a polite no-op');
  await outreach.introduce(esiCode, { attest: true, name: 'Abena', email: 'abena@rival.test', org: 'Rival Bank' });
  e = await rej(outreach.introduce(esiCode, { attest: true, name: 'Third', email: 'third@rival.test', org: 'Rival Bank' })); ok(e && e.status === 429, 'daily introduction limit enforced per referrer');
  res = await fetch(`${base}/refer/${esiCode}/intro`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=Z&email=z%40rival.test&org=Rival+Bank&attest=yes' }); ok(res.status === 429, 'form post also hits the limit');
  await outreach.setContactStatus(kw.id, 'sandbox'); st = await outreach.referralStats(esiCode);
  ok(st.points === 1 && st.tier && st.tier.label === 'Founding Referrer' && st.next.label === 'Champion' && st.intros.length === 2, 'points follow what the referred person does (sandbox = 1) and set the tier');
  await outreach.setContactStatus(kw.id, 'meeting'); await outreach.updateOrg(kw.orgId, { status: 'partner' });
  st = await outreach.referralStats(esiCode); ok(st.points === 10 && st.tier.label === 'Champion', 'partner organisation earns the partner points');
  const partner = await outreach.addPartnerByAdmin({ name: 'Ama Consultant', email: 'ama@consult.test', org: 'Consult Ltd' });
  ok(/^p/.test(partner.code) && (await outreach.publicConfig()).referral.enabled, 'admin can create a referral partner link');
  await outreach.addReward(esiCode, 'Named in launch post', 'admin');
  const ovr = await outreach.referralOverview(); ok(ovr.referrers[0].code === esiCode && ovr.referrers[0].rewards.length === 1 && ovr.totals.intros === 2 && ovr.totals.meetings === 2, 'overview ranks referrers and tracks rewards given');
  res = await fetch(`${base}/refer`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=Self+Signup&email=s%40x.test&org=X', redirect: 'manual' }); ok(res.status === 302 && /\/o\/refer\/p/.test(res.headers.get('location')), 'public sign-up as a referral partner returns a personal page');
  await outreach.eraseContact(c3.id); ok(!(await store.settings.get('out:ref:' + esiCode)), 'erasing a person also removes their referrer record');

  // ---- country and index lists
  const cs1 = await outreach.seedCountries({ commonwealth: true });
  ok(cs1.added > 300 && (await outreach.seedCountries({ commonwealth: true })).added === 0, `Commonwealth lists load (${cs1.added} organisations) and repeat loads add nothing`);
  const gh = await outreach.listOrgs({ cc: 'GH', pageSize: 200 });
  ok(gh.total >= 60 && gh.rows.every((o) => o.lang === 'en') && gh.rows.some((o) => /Acacia Health Insurance/.test(o.name)) && gh.rows.some((o) => /Mahama Cares/.test(o.name)), 'Ghana domestic list includes banks, health insurers/TPAs and hospitals');
  ok((await outreach.listOrgs({ list: 'ghana-club-100' })).total >= 1 || (await outreach.seedCountries({ packs: ['ghana-club-100'] })).added >= 0, 'Ghana Club 100 pack is available');
  await outreach.seedCountries({ packs: ['ghana-club-100', 'fortune500', 'ftse100', 'cac40', 'psi', 'francophone', 'lusophone', 'arabic', 'asia'] });
  ok((await outreach.listOrgs({ list: 'fortune500' })).total >= 50 && (await outreach.listOrgs({ list: 'cac40' })).total >= 5 && (await outreach.listOrgs({ list: 'psi' })).total >= 2, 'Fortune 500, CAC 40 and PSI starter packs load');
  ok((await outreach.listOrgs({ cc: 'US', pageSize: 200 })).rows.every((o) => o.reach.sms === false), 'US organisations: cold SMS never offered');
  const frOrg = (await outreach.listOrgs({ cc: 'FR', type: 'bank' })).rows[0];
  ok(frOrg.lang === 'fr' && frOrg.reach.held && /legal review/.test(frOrg.reach.reason), 'French organisations default to French and are held pending legal review');
  const frc = await outreach.addContact({ orgId: frOrg.id, name: 'Claire Dupont', persona: 'cto', email: 'claire@fr-bank.test', source: 'https://fr-bank.test/team' });
  ok(frc.lang === 'fr', 'a contact inherits the organisation language');
  let en = await outreach.enroll({ contactIds: [frc.id], sequenceId: 'email-only' }); ok(en.enrolled === 0 && en.held === 1, 'enrolment holds contacts in a country awaiting legal review');
  await outreach.setConfig({ approvedCountries: ['FR'] }, 't'); en = await outreach.enroll({ contactIds: [frc.id], sequenceId: 'email-only' }); ok(en.enrolled === 1, 'ticking the country as reviewed releases it');
  e = await rej(outreach.setConfig({ approvedCountries: ['ZZ'] })); ok(e && e.status === 422, 'unknown country code refused');
  const imp2 = await outreach.importList({ listId: 'ghana-club-100', country: 'Ghana', text: '1. Newmont Ghana Gold\n2. Scancom PLC\n3, GCB Bank\n"4"|Stanbic Bank Ghana|Banking\n5 Ghana Medical Hospital\n7. Star Assurance\n\nnot a rank 12345' });
  ok(imp2.read >= 6 && imp2.known >= 3 && imp2.tagged >= 1 && imp2.added >= 1, 'pasted ranking is imported: ranks stripped, known organisations tagged, new ones added');
  ok(outreach.classifyName('Acme Life Assurance') === 'insurer' && outreach.classifyName('First Savings Bank') === 'bank' && outreach.classifyName('Korle Clinic') === 'hospital' && outreach.classifyName('Newmont Gold') === 'other', 'sector is detected from the name');
  const imp3 = await outreach.importList({ listId: 'fortune500', country: 'USA', text: 'Costco\nNew Employer Inc' }); ok(imp3.added === 1 && imp3.tagged === 0 && imp3.read === 2, 'Fortune 500 import recognises names already on the list and adds only new ones');
  const packs = await outreach.listPacks(); ok(packs.find((p) => p.id === 'fortune500').loaded >= 50 && packs.find((p) => p.id === 'commonwealth').starterSize > 100, 'pack list shows starter size and loaded count');
  ok((await outreach.listOrgs({ commonwealth: true, pageSize: 5 })).total > 200 && (await outreach.listOrgs({ lang: 'pt' })).total > 10, 'filter by Commonwealth and by language');
  ok(!JSON.stringify(countryRows = await outreach.countryTable()).includes('@') && countryRows.find((c) => c.code === 'DE').level === 'review' && countryRows.find((c) => c.code === 'FR').approved, 'country table reports level and approval');

  // ---- The Africa Report 2024 as its own campaign group
  const ar = await outreach.seedAfricaReport();
  ok(ar.inGroup >= 280 && ar.insurers >= 95 && ar.banks >= 180 && (await outreach.seedAfricaReport()).added === 0, `Africa Report group: ${ar.inGroup} organisations (${ar.banks} banks, ${ar.insurers} insurers); loading twice adds nothing`);
  ok((await outreach.listOrgs({ list: 'africa-report-2024-bank-groups' })).total >= 25 && (await outreach.listOrgs({ list: 'africa-report-2024-insurers' })).total >= 95, 'the banking-group, bank and insurer sub-lists are separate groups');
  const arIns = (await outreach.listOrgs({ list: 'africa-report-2024-insurers', cc: 'NG' })).rows[0];
  const arCon = await outreach.addContact({ orgId: arIns.id, name: 'Tunde Ade', persona: 'claims', email: 'tunde@ng-insurer.test', source: 'https://ng-insurer.test/team' });
  const otherCon = await outreach.addContact({ orgId: hOrg.id, name: 'Not In Group', email: 'nig@hospital2.test', source: 'https://hospital2.test' });
  const arPv = await outreach.preview(arCon.id, 'email-only', 0);
  ok(/The Africa Report's 2024 ranking of Africa's insurers/.test(arPv.body) && /^Dear Tunde,/.test(arPv.body), 'first email to a ranked insurer opens with the Africa Report reference');
  ok(!/Africa Report/.test((await outreach.preview(otherCon.id, 'email-only', 0)).body), 'organisations outside the group do not get that line');
  const enr = await outreach.enroll({ list: 'africa-report-2024-insurers', campaign: 'africa-report-insurers', sequenceId: 'email-only' });
  const arAfter = (await outreach.listContacts({ campaign: 'africa-report-insurers' })).rows;
  ok(enr.enrolled >= 1 && arAfter.some((c) => c.id === arCon.id) && !arAfter.some((c) => c.id === otherCon.id), 'a campaign can target just one group');
  ok((await outreach.overview()).contactsByCampaign['africa-report-insurers'] >= 1 && (await outreach.listContacts({ list: 'africa-report-2024-insurers' })).rows.some((c) => c.id === arCon.id), 'campaign counts and per-group contact lists');

  // ---- Core banking top 15 with regional offices
  const cb = await outreach.seedCoreBanking();
  ok(cb.inGroup === 15 && cb.offices > 40 && (await outreach.seedCoreBanking()).offices === 0, `core banking group: ${cb.inGroup} vendors, ${cb.offices} offices; repeat is a no-op`);
  const tem = (await outreach.listOrgs({ list: 'core-banking-top15', q: 'Temenos' })).rows[0];
  const offs = await outreach.officesReach(tem.id);
  ok(offs.find((f) => f.cc === 'ZA').reach.held && !offs.find((f) => f.cc === 'US').reach.held && offs.find((f) => f.cc === 'US').reach.sms === false, 'South Africa office is held while the USA office is open (and has no cold SMS)');
  const zaCon = await outreach.addContact({ orgId: tem.id, officeCc: 'ZA', name: '', email: 'sales@za.temenos.test', source: 'https://temenos.test/contact' });
  const usCon = await outreach.addContact({ orgId: tem.id, officeCc: 'US', name: '', email: 'sales@us.temenos.test', source: 'https://temenos.test/contact' });
  e = await rej(outreach.addContact({ orgId: tem.id, officeCc: 'BR', email: 'x@br.temenos.test', source: 'https://x.test' })); ok(e && e.status === 422, 'an office the vendor does not have is refused');
  const cbEn = await outreach.enroll({ list: 'core-banking-top15', campaign: 'core-banking', sequenceId: 'email-only' });
  const cbRows = (await outreach.listContacts({ campaign: 'core-banking' })).rows;
  ok(cbEn.enrolled >= 1 && cbEn.held >= 1 && cbRows.some((c) => c.id === usCon.id) && !cbRows.some((c) => c.id === zaCon.id), 'enrolment holds the South Africa office contact but reaches the USA office contact');
  ok((await outreach.listContacts({ officeCc: 'US', list: 'core-banking-top15' })).rows.some((c) => c.id === usCon.id) && !(await outreach.listContacts({ officeCc: 'US' })).rows.some((c) => c.id === zaCon.id), 'contacts filter by office country');
  const addO = await outreach.addOffice(tem.id, { cc: 'GH', city: 'Accra', role: 'africa' }); ok(addO.offices.some((f) => f.cc === 'GH'), 'an office can be added');
  e = await rej(outreach.addOffice(tem.id, { cc: 'GH', city: 'Accra' })); ok(e && e.status === 409, 'duplicate office refused');
  const rm = await outreach.removeOffice(tem.id, addO.offices.find((f) => f.cc === 'GH').id); ok(!rm.offices.some((f) => f.cc === 'GH'), 'an office can be removed');

  srv.close();
  console.log(`\n${a} assertions${process.exitCode ? ' — WITH FAILURES' : ' — all passed'}`);
})().catch((x) => { console.error(x); process.exit(1); });
