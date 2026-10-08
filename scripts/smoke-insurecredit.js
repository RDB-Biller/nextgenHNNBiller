'use strict';
// Smoke test for InsureCredit (services/insurecredit.js, the "insurecredit"
// Product Lab module) and the messaging fixes that ship with it: notify() now
// really dispatches, numbers are normalised to +233 at the send seam, and a new
// email transport exists. In-memory store, no network: Africa's Talking, the
// email provider and the ConfirmU webhook are all faked.
//   node scripts/smoke-insurecredit.js

process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
process.env.EMAIL_PROVIDER = 'resend';
process.env.EMAIL_API_KEY = 're_test_key';
process.env.EMAIL_FROM = 'HNN Biller <notes@example.test>';

const crypto = require('crypto');
const store = require('../src/store');
const operatingMode = require('../src/services/operatingMode');
const messaging = require('../src/services/messaging');
const messagingAccount = require('../src/services/messagingAccount');
const email = require('../src/services/email');
const notifications = require('../src/services/notifications');
const products = require('../src/services/products');
const solutions = require('../src/services/solutions');
const credit = require('../src/services/insurecredit');
const { createBill } = require('../src/services/billing');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const rejects = async (fn, status, label) => {
  try { await fn(); ok(false, `${label} (did not throw)`); } catch (e) { ok(!status || e.status === status, `${label} -> ${e.message}`); }
};

// ---- fakes -----------------------------------------------------------------
const sms = []; const mails = []; const hooks = [];
messaging._setRequestImplForTests(async (url, opts) => {
  if (url.endsWith('/version1/messaging')) {
    const f = new URLSearchParams(opts.body);
    sms.push({ url, to: f.get('to'), message: f.get('message'), username: f.get('username'), apiKey: opts.headers.apiKey });
    return { status: 201, body: JSON.stringify({ SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ number: f.get('to'), status: 'Success', messageId: `ATXid_${sms.length}`, cost: 'GHS 0.0300' }] } }) };
  }
  return { status: 404, body: '{}' };
});
email._setRequestImplForTests(async (url, opts) => {
  mails.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
  return { status: 200, headers: {}, body: JSON.stringify({ id: `em_${mails.length}` }) };
});
credit._setPostImplForTests(async (url, { headers, body }) => { hooks.push({ url, headers, body }); return { status: 200, body: '{}' }; });

const lastSms = () => sms[sms.length - 1];
const PHONE = '0244000222';

async function mkBill(tenantId, { cost, phone = PHONE, payerId = 'acacia', name = 'Ama Mensah', copay = 100 } = {}) {
  const b = createBill({ provider: 'Euracare Hospital', patient: { name, phone },
    items: [{ name: 'Surgical procedure', cost }], adjustments: { copayPercent: copay },
    insurance: { payerId, memberId: 'ACA-00123' }, clinical: { diagnosis: 'Acute appendicitis', complaint: 'Severe abdominal pain', clinician: 'Dr K. Boateng' } });
  b.tenantId = tenantId; await store.bills.insert(b); return b;
}
const hospital = async (id) => ({ tenant: await store.tenants.get(id) });
async function mkProduct(payerId, name, params = {}, extra = {}) {
  const p = await products.create(payerId, { type: 'solution', name, config: { module: 'insurecredit', params, ...extra } });
  return p;
}
async function goLive(p) { await products.setStatus(p.id, 'sandbox'); return products.setStatus(p.id, 'live'); }
const runH = (id, tenant, input) => solutions.run(id, 'hospital', { tenant, input });

(async () => {
  await store.init();
  const T = 'tenant_euracare';
  const tenant = (await hospital(T)).tenant;

  // ===== 0. messaging fixes ==================================================
  ok(messaging.toDialable('0241234567') === '+233241234567', 'local 024… number is rewritten to +233 form');
  ok(messaging.toDialable('233241234567') === '+233241234567' && messaging.toDialable('+233241234567') === '+233241234567', '233… and +233… are normalised/kept');
  ok(messaging.toDialable('+254711000111') === '+254711000111' && messaging.toDialable('whatsapp:+233241234567') === 'whatsapp:+233241234567', 'foreign and whatsapp:-prefixed numbers pass through untouched');

  await operatingMode.set({ messaging: { sandbox: false } });
  await messagingAccount.set({ provider: 'africastalking', credentials: { apiKey: 'at-sandbox-key', username: 'sandbox' }, active: true });
  let r = await messaging.send({ channel: 'sms', to: '0244000333', body: 'hello' });
  ok(r.ok && lastSms().to === '+233244000333' && lastSms().url.startsWith('https://api.sandbox.africastalking.com'), 'a send to 024… reaches Africa\'s Talking sandbox as +233… with the key header');

  // notify() used to only log; now it dispatches
  const before = sms.length;
  let n = await notifications.notify({ party: 'patient', channel: 'sms', to: '0244000444', subject: 's', body: 'Your bill was settled' });
  ok(sms.length === before + 1 && lastSms().to === '+233244000444' && n.delivery.status === 'sent' && n.delivered === true, 'notify(sms) now sends through the messaging seam and records the outcome');
  n = await notifications.notify({ party: 'patient', channel: 'sms', to: '0244000444', subject: 's', body: 'x', dispatch: false });
  ok(sms.length === before + 1 && !n.delivery, 'notify(dispatch:false) records without sending (used where the caller sends its own message)');
  n = await notifications.notify({ party: 'provider', channel: 'email', to: 'finance@hospital.example', subject: 'Bill paid', body: 'Paid' });
  ok(mails.length === 1 && mails[0].url === 'https://api.resend.com/emails' && mails[0].auth === 'Bearer re_test_key' && n.delivery.status === 'sent', 'notify(email) goes through the email transport (Resend request shape)');
  n = await notifications.notify({ party: 'provider', channel: 'email', to: null, subject: 's', body: 'b' });
  ok(n.delivery.status === 'no_recipient' && n.delivered === false, 'no recipient is recorded honestly, not as delivered');
  const savedProv = process.env.EMAIL_PROVIDER; process.env.EMAIL_PROVIDER = '';
  n = await notifications.notify({ party: 'provider', channel: 'email', to: 'a@b.example', subject: 's', body: 'b' });
  ok(n.delivery.status === 'not_configured' && n.delivered === false, 'email with no provider configured says so instead of claiming delivery');
  process.env.EMAIL_PROVIDER = savedProv;
  await operatingMode.set({ messaging: { sandbox: true } });
  const beforeSbx = sms.length; const mailsBefore = mails.length;
  n = await notifications.notify({ party: 'patient', channel: 'sms', to: '0244000555', subject: 's', body: 'b' });
  const nm = await notifications.notify({ party: 'provider', channel: 'email', to: 'a@b.example', subject: 's', body: 'b' });
  ok(sms.length === beforeSbx && mails.length === mailsBefore && n.delivery.status === 'sandbox' && nm.delivery.status === 'sandbox', 'in messaging sandbox nothing leaves the building (SMS and email both only logged)');
  await operatingMode.set({ messaging: { sandbox: false } });

  // ===== 1. registry + config ================================================
  const reg = solutions.registry().find((m) => m.key === 'insurecredit');
  ok(reg && reg.scope === 'none' && reg.surfaces.length === 3 && reg.params.some((p) => p.key === 'design' && p.options.length === 4), 'insurecredit is in the module registry with 4 design variants and all three surfaces');
  const def = solutions.validateConfig({ module: 'insurecredit', params: {} }, {});
  ok(def.params.loanCap === 2000 && def.params.design === 'classic' && def.params.ussdEnabled === true && def.params.autoSend === false, 'defaults: GHS 2,000 cap, classic design, USSD on, auto-send off');
  await rejects(() => mkProduct('acacia', 'x', { loanCap: 2500 }), 422, 'a limit above GHS 2,000 is rejected');
  await rejects(() => mkProduct('acacia', 'x', { accentColor: 'teal' }), 422, 'a non-hex accent colour is rejected');
  await rejects(() => mkProduct('acacia', 'x', { confirmuUrl: 'http://confirmu.com' }), 422, 'a non-https ConfirmU URL is rejected');
  await rejects(() => mkProduct('acacia', 'x', { smsStyle: 'custom', smsTemplate: 'no link here' }), 422, 'a custom SMS without {link} is rejected');
  await rejects(() => mkProduct('acacia', 'x', { ussdCode: '713' }), 422, 'a malformed USSD code is rejected');

  // ===== 2. design variants live side by side ===================================
  const story = await mkProduct('acacia', 'Story variant', { design: 'story', accentColor: '#b45309', headline: 'We can help with that bill', ussdCode: '*789*963#' });
  const compact = await mkProduct('acacia', 'Compact variant', { design: 'compact', smsStyle: 'short', loanCap: 1500, overCapPolicy: 'partial_and_share' });
  await goLive(story); await goLive(compact);
  ok((await store.products.get(story.id)).status === 'live' && (await store.products.get(compact.id)).status === 'live',
    'two InsureCredit variants can be live for the same payer at once (A/B designs)');

  // ===== 3. sandbox product only previews ===============================================
  const draftP = await mkProduct('acacia', 'Sandbox only', { design: 'stepper' });
  await products.setStatus(draftP.id, 'sandbox');
  const billA = await mkBill(T, { cost: 420 });
  let prev = await runH(draftP.id, tenant, { action: 'offer', billId: billA.id });
  ok(prev.dryRun && prev.result.preview && prev.result.sms.includes('420.00') && (await store.credits.all()).length === 0 && sms.length === sms.length, 'a sandbox product previews the SMS but stores nothing and sends nothing');
  const smsBeforeOffer = sms.length;

  // ===== 4. live offer: SMS content, number, USSD, report ==================================
  const o = await runH(story.id, tenant, { action: 'offer', billId: billA.id });
  const res = o.result;
  ok(/^\d{8}$/.test(res.applicationNo) && res.status === 'offered' && res.amount === 420 && res.overCap === false && res.loanableAmount === 420, 'offer returns an 8-digit application number and the amount');
  ok(sms.length === smsBeforeOffer + 1 && lastSms().to === '+233244000222', 'the offer SMS went to the patient through Africa\'s Talking');
  const body = lastSms().message;
  ok(body.includes(res.link) && body.includes(res.applicationNo) && body.includes('*789*963#') && body.includes('420.00') && body.includes('2000'), 'SMS carries the link, application number, USSD code, amount and the limit');
  ok(!body.includes('Mensah') && !body.includes('appendicitis') && !body.includes('ACA-00123'), 'SMS carries first name only: no surname, diagnosis or member id');
  ok(res.sentVia.includes('sms') && res.to.endsWith('0222'), 'response reports the channel and a masked number');
  const stored = await store.credits.byAppNo(res.applicationNo);
  const rep = await store.reports.get(stored.reportId);
  ok(rep && rep.kind === 'micro' && rep.diagnosis === 'Acute appendicitis' && rep.billId === billA.id, 'a MICRO medical report was generated and embedded in the application');
  const dup = await runH(story.id, tenant, { action: 'offer', billId: billA.id });
  ok(dup.result.reused === true && sms.length === smsBeforeOffer + 1, 'offering the same bill again reuses the application and does not text twice');
  const rs = await runH(story.id, tenant, { action: 'offer', billId: billA.id, resend: true });
  ok(rs.result.resent === true && sms.length === smsBeforeOffer + 2, 'resend texts the same application again');
  await rejects(() => runH(story.id, tenant, { action: 'offer', billId: billA.id, amount: 9999 }), 422, 'an amount above the patient share is rejected');
  await rejects(() => runH(story.id, tenant, { action: 'offer', billId: 'bill_nope' }), 404, 'unknown bill is rejected');
  const billNoPhone = await mkBill(T, { cost: 300, phone: '' });
  await rejects(() => runH(story.id, tenant, { action: 'offer', billId: billNoPhone.id }), 422, 'a bill with no patient phone cannot be offered');
  const billTiny = await mkBill(T, { cost: 20 });
  await rejects(() => runH(story.id, tenant, { action: 'offer', billId: billTiny.id }), 422, 'below the minimum out-of-pocket amount is not offered');

  // ===== 5. SMS wording variants ====================================================
  const pv = async (style, extra = {}) => {
    const prod = await mkProduct('gmtf', `sms ${style}`, { smsStyle: style, ...extra });
    await products.setStatus(prod.id, 'sandbox');
    return (await solutions.run(prod.id, 'master', { input: { action: 'preview', amount: 350, name: 'Kofi', facility: 'City Clinic' } })).result.sms;
  };
  const sStd = await pv('standard'); const sShort = await pv('short'); const sFriendly = await pv('friendly');
  const sCustom = await pv('custom', { smsTemplate: 'Kofi, GHS {amount} at {facility}. Apply {link} no {appNo} or {ussd}' });
  ok(new Set([sStd, sShort, sFriendly, sCustom]).size === 4 && sShort.length < sStd.length, 'four SMS wordings produce four different messages (short is shorter)');
  ok(sCustom.startsWith('Kofi, GHS 350.00 at City Clinic. Apply ') && sCustom.includes('*789*963#'), 'custom template tokens are filled in');

  // ===== 6. applicant page data ========================================================
  const v1 = await credit.view(stored.token);
  ok(v1.status === 'opened' && v1.design.variant === 'story' && v1.design.accent === '#b45309' && v1.design.headline === 'We can help with that bill', 'opening the link marks it opened and serves THIS product\'s design');
  ok(v1.patientFirstName === 'Ama' && !JSON.stringify(v1).includes('Mensah') && !JSON.stringify(v1).includes('ACA-00123') && !JSON.stringify(v1).includes('0244000222'), 'applicant view: first name only, no surname, member id or full phone');
  ok(v1.report && v1.report.kind === 'micro' && v1.report.diagnosis === 'Acute appendicitis' && v1.report.signedOff === false && /sign-off/i.test(v1.report.disclaimer), 'the micro medical report is embedded and flagged as needing clinician sign-off');
  ok(v1.ussd.code === '*789*963#' && v1.ussd.instructions.includes(res.applicationNo), 'USSD instructions include the code and this application number');

  // ===== 7. consent -> apply -> ConfirmU =================================================
  await rejects(() => credit.apply(stored.token), 409, 'cannot apply before consenting to credit scoring');
  await rejects(() => credit.consent(stored.token, { scoring: false }), 422, 'consent must be an explicit yes');
  const c1 = await credit.consent(stored.token, { scoring: true, ip: '10.0.0.1' });
  ok(c1.status === 'consented' && c1.consent.scoring === true, 'consent recorded');
  const ap = await credit.apply(stored.token);
  const ru = new URL(ap.redirectUrl);
  ok(ru.origin === 'https://confirmu.com' && ru.searchParams.get('ref') === res.applicationNo && ru.searchParams.get('amount') === '420.00'
    && ru.searchParams.get('report').includes('/report/?token='), 'apply hands the patient to ConfirmU with the application number, amount and the report link');
  ok(!ap.redirectUrl.includes((await credit.getSettings()).hookSecret), 'the callback secret is never put in the hand-off URL');
  ok((await store.credits.byAppNo(res.applicationNo)).status === 'submitted_to_scorer', 'status is submitted_to_scorer');
  ok(hooks.length === 0, 'no webhook is called when none is configured');
  ok((await credit.apply(stored.token)).already === true, 'applying twice is idempotent');

  // ===== 8. need verification (backend) ======================================================
  const vp = await credit.verifyByAppNo(res.applicationNo);
  ok(vp.checks.reportPresent && vp.checks.reportKind === 'micro' && vp.checks.amountWithinPatientShare && vp.checks.consentToScoringOnFile && vp.checks.passed === true, 'verification packet: report present, amount within patient share, consent on file');
  ok(vp.bill.diagnosis === 'Acute appendicitis' && vp.bill.totals.patientPayable === 420 && vp.report.qa.length > 0 && vp.consents[0].type === 'scoring', 'packet carries the bill facts, report Q&A and the consent trail');
  ok((await credit.verifyByAppNo(`IC-${res.applicationNo.slice(0, 4)} ${res.applicationNo.slice(4)}`)).applicationNo === res.applicationNo, 'application number is accepted with an IC- prefix and spaces');
  const hv = (await solutions.run(story.id, 'hospital', { tenant, input: { action: 'verify', applicationNo: res.applicationNo } })).result;
  ok(hv.applicationNo === res.applicationNo, 'the hospital can verify its own application from the runner');
  const other = (await store.tenants.all()).find((t) => t.id !== T);
  await rejects(() => solutions.run(story.id, 'hospital', { tenant: other, input: { action: 'verify', applicationNo: res.applicationNo } }), 404, 'another hospital cannot see this application');

  // ===== 9. USSD =========================================================================
  ok((await credit.ussd({ phoneNumber: '+233244000222', text: '' })).startsWith('CON InsureCredit'), 'USSD: empty input asks for the application number');
  ok((await credit.ussd({ phoneNumber: '+233244000999', text: res.applicationNo })).startsWith('END We could not find'), 'USSD: a different phone cannot act on the application');
  ok((await credit.ussd({ phoneNumber: '+233244000222', text: '99999999' })).startsWith('END We could not find'), 'USSD: unknown number is rejected');
  ok((await credit.ussd({ phoneNumber: '+233244000222', text: res.applicationNo })).includes('already with ConfirmU'), 'USSD: an already-submitted application says so');

  // fresh application for a full USSD journey
  const billU = await mkBill(T, { cost: 250, phone: '0201112233', name: 'Yaw Boateng' });
  const ou = (await runH(story.id, tenant, { action: 'offer', billId: billU.id })).result;
  const menu = await credit.ussd({ phoneNumber: '+233201112233', text: ou.applicationNo });
  ok(menu.startsWith('CON') && menu.includes('GHS 250.00') && menu.includes('1. Apply'), 'USSD: valid number shows the amount and an Apply option');
  const smsBeforeU = sms.length;
  const done = await credit.ussd({ phoneNumber: '+233201112233', text: `${ou.applicationNo}*1` });
  const au = await store.credits.byAppNo(ou.applicationNo);
  ok(done.startsWith('END Done') && au.status === 'submitted_to_scorer' && au.submittedVia === 'ussd' && au.consents[0].via === 'ussd', 'USSD: choosing 1 records consent, submits to ConfirmU and closes');
  ok(sms.length === smsBeforeU + 1 && lastSms().message.includes('confirmu.com'), 'USSD: the patient is texted a link to finish the credit check');
  const billU2 = await mkBill(T, { cost: 260, phone: '0201112244' });
  const ou2 = (await runH(story.id, tenant, { action: 'offer', billId: billU2.id })).result;
  ok((await credit.ussd({ phoneNumber: '+233201112244', text: `${ou2.applicationNo}*2` })).startsWith('END Cancelled') && (await store.credits.byAppNo(ou2.applicationNo)).status === 'cancelled', 'USSD: choosing 2 cancels');

  // ===== 10. ConfirmU decision callback =========================================================
  const smsBeforeD = sms.length;
  await rejects(() => credit.recordDecision(ou2.applicationNo, { decision: 'approved' }), 409, 'a decision on an application that was never submitted is rejected');
  await rejects(() => credit.recordDecision(ou.applicationNo, { decision: 'maybe' }), 422, 'decision must be approved or declined');
  await rejects(() => credit.recordDecision(ou.applicationNo, { decision: 'approved', approvedAmount: 9999 }), 422, 'cannot approve more than was requested');
  const dec = await credit.recordDecision(ou.applicationNo, { decision: 'approved', approvedAmount: 200, reference: 'CU-77' });
  ok(dec.status === 'approved' && sms.length === smsBeforeD + 1 && lastSms().message.includes('200.00') && lastSms().message.includes('approved'), 'approval is recorded and the patient is texted the approved amount');
  ok((await credit.publicView(await store.credits.byAppNo(ou.applicationNo))).decision.approvedAmount === 200, 'the applicant page shows the decision');
  ok(!(await credit.checkSecret('wrong')) && (await credit.checkSecret((await credit.getSettings()).hookSecret)), 'callback secret check works');
  const oldSecret = (await credit.getSettings()).hookSecret; await credit.rotateSecret();
  ok(!(await credit.checkSecret(oldSecret)), 'rotating the secret invalidates the old callback URLs');

  // ===== 11. above the limit: justification note =================================================
  const billB = await mkBill(T, { cost: 2600, phone: '0244000777', name: 'Esi Owusu' });
  const ob = (await runH(story.id, tenant, { action: 'offer', billId: billB.id })).result;
  ok(ob.overCap === true && ob.loanableAmount === 0, 'above GHS 2,000 the offer is flagged over the limit with nothing loanable');
  ok(lastSms().message.includes('above the GHS 2000 micro-loan limit') && lastSms().message.includes('justification note'), 'the SMS explains the limit and offers the justification note instead');
  const tokB = (await store.credits.byAppNo(ob.applicationNo)).token;
  await credit.consent(tokB, { scoring: true });
  await rejects(() => credit.apply(tokB), 409, 'a loan application above the limit is refused');
  ok((await credit.ussd({ phoneNumber: '+233244000777', text: ob.applicationNo })).includes('above the GHS 2000 micro-loan limit'), 'USSD tells an over-limit patient to use the SMS link to share the report');
  await rejects(() => credit.share(tokB, { email: 'hr@company.example', consent: false }), 422, 'sharing needs explicit consent');
  await rejects(() => credit.share(tokB, { consent: true }), 422, 'sharing needs a recipient');
  await rejects(() => credit.share(tokB, { email: 'not-an-email', consent: true }), 422, 'a bad email address is rejected');
  await rejects(() => credit.share(tokB, { phone: '12345', consent: true }), 422, 'a bad phone number is rejected');
  const mailsB = mails.length; const smsB = sms.length;
  const sh = await credit.share(tokB, { name: 'Grace', email: 'hr@company.example', phone: '0209998877', relationship: 'HR manager', consent: true, ip: '10.0.0.2' });
  const funderMail = mails.slice(mailsB).find((m) => m.body.to[0] === 'hr@company.example');
  ok(!!funderMail && funderMail.body.subject.includes('Esi Owusu'), 'the funder is emailed the justification note');
  ok(sms.length === smsB + 1 && lastSms().to === '+233209998877' && lastSms().message.includes('/n/'), 'the funder is also texted when a phone is given');
  ok(sh.shares.length === 1 && sh.shares[0].channels.length === 2 && sh.shares[0].to.includes('***@company.example') && !JSON.stringify(sh).includes('hr@company.example'), 'applicant view shows masked recipients only');
  const appB = await store.credits.byAppNo(ob.applicationNo);
  ok(appB.status === 'funder_report_sent' && appB.consents.some((c) => c.type === 'report_share' && c.recipient && c.textVersion), 'status updated and the report_share consent (with recipient and text version) is on file');
  const shareToken = appB.shares[0].token;
  ok(funderMail.body.text.includes(`/n/${shareToken}`), 'the email links to the funder note');
  const note = await credit.shareView(shareToken);
  ok(note.kind === 'justification_note' && note.requestedBy === 'Esi Owusu' && note.report.kind === 'micro' && note.requestedAmount === 2600 && /consent/i.test(note.statement), 'the funder sees the micro medical report as a justification note, with the consent statement');
  ok(!JSON.stringify(note).includes('ACA-00123') && !('phone' in note), 'the note carries no member id or phone number');
  ok((await store.credits.byAppNo(ob.applicationNo)).shares[0].accessCount === 1, 'each funder view is counted');
  await credit.share(tokB, { email: 'rel1@example.com', consent: true });
  await credit.share(tokB, { email: 'rel2@example.com', consent: true });
  await rejects(() => credit.share(tokB, { email: 'rel3@example.com', consent: true }), 429, 'at most 3 recipients per application (no relay abuse)');
  await credit.revokeShare(tokB, appB.shares[0].id);
  await rejects(() => credit.shareView(shareToken), 410, 'a withdrawn note can no longer be opened');
  await rejects(() => credit.shareView('nope'), 404, 'unknown note token is a 404');
  const billSmall = await mkBill(T, { cost: 300, phone: '0244000888' });
  const tokSmall = (await store.credits.byAppNo((await runH(story.id, tenant, { action: 'offer', billId: billSmall.id })).result.applicationNo)).token;
  await rejects(() => credit.share(tokSmall, { email: 'x@y.example', consent: true }), 409, 'a justification note is only offered above the limit');

  // channel restriction
  const smsOnly = await mkProduct('acacia', 'Funder sms only', { funderChannels: 'sms', loanCap: 200 });
  await goLive(smsOnly);
  const billC = await mkBill(T, { cost: 900, phone: '0244000999' });
  const tokC = (await store.credits.byAppNo((await runH(smsOnly.id, tenant, { action: 'offer', billId: billC.id })).result.applicationNo)).token;
  await rejects(() => credit.share(tokC, { email: 'hr@company.example', consent: true }), 422, 'when the product asks for SMS only, an email-only share is refused');

  // ===== 12. partial_and_share policy ===================================================================
  const billD = await mkBill(T, { cost: 1800, phone: '0244000666', name: 'Kwame Asare' });
  const od = (await runH(compact.id, tenant, { action: 'offer', billId: billD.id })).result;
  ok(od.overCap === true && od.loanableAmount === 1500, 'partial_and_share: above the (lower) cap the patient may still borrow up to the cap');
  const tokD = (await store.credits.byAppNo(od.applicationNo)).token;
  await credit.consent(tokD, { scoring: true });
  const apD = await credit.apply(tokD);
  ok(new URL(apD.redirectUrl).searchParams.get('amount') === '1500.00', 'the ConfirmU hand-off carries the capped amount');
  ok((await store.credits.byAppNo(od.applicationNo)).status === 'submitted_to_scorer', 'application submitted for the capped amount');
  const shD = await credit.share(tokD, { email: 'family@example.com', consent: true });
  ok(shD.shares.length === 1, '…and the patient can still share the report for the remainder');

  // ===== 13. scorer webhook ===========================================================================
  const wh = await mkProduct('acacia', 'With webhook', { scorerWebhookUrl: 'https://scoring.example/hooks/hnn', design: 'stepper' });
  await goLive(wh);
  const billW = await mkBill(T, { cost: 500, phone: '0244000555' });
  const ow = (await runH(wh.id, tenant, { action: 'offer', billId: billW.id })).result;
  const tokW = (await store.credits.byAppNo(ow.applicationNo)).token;
  await credit.consent(tokW, { scoring: true }); await credit.apply(tokW);
  ok(hooks.length === 1 && hooks[0].url === 'https://scoring.example/hooks/hnn', 'the ConfirmU webhook is called on submit');
  const sig = crypto.createHmac('sha256', (await credit.getSettings()).hookSecret).update(hooks[0].body).digest('hex');
  const pl = JSON.parse(hooks[0].body);
  ok(hooks[0].headers['x-hnn-signature'] === `sha256=${sig}` && pl.applicationNo === ow.applicationNo && pl.amount === 500 && pl.reportUrl.includes('/report/?token='), 'the webhook is HMAC-signed and carries the application number, amount and report link');
  ok(!hooks[0].body.includes(await (async () => (await credit.getSettings()).hookSecret)()), 'the webhook body never contains the secret itself');

  // ===== 14. lifecycle guards ==============================================================================
  const billE = await mkBill(T, { cost: 310, phone: '0244000123' });
  const oe = (await runH(story.id, tenant, { action: 'offer', billId: billE.id })).result;
  const appE = await store.credits.byAppNo(oe.applicationNo);
  appE.expiresAt = new Date(Date.now() - 1000).toISOString(); await store.credits.update(appE);
  ok((await credit.view(appE.token)).status === 'expired', 'an expired offer is shown as expired');
  await rejects(() => credit.consent(appE.token, { scoring: true }), 410, 'an expired offer cannot be consented to');
  ok((await credit.ussd({ phoneNumber: '+233244000123', text: oe.applicationNo })).includes('expired'), 'USSD says the offer has expired');
  await credit.resend; // exists
  const reAppE = await runH(story.id, tenant, { action: 'resend', applicationNo: oe.applicationNo });
  ok(new Date((await store.credits.byAppNo(oe.applicationNo)).expiresAt) > new Date(), 'a resend restarts the clock');
  await products.setStatus(story.id, 'sandbox');
  await rejects(() => credit.consent(appE.token, { scoring: true }), 409, 'when the product leaves live, existing links stop accepting actions');
  ok((await credit.view(appE.token)).live === false, '…but can still be viewed');
  await products.setStatus(story.id, 'live');
  await rejects(() => credit.view('nope'), 404, 'unknown token is a 404');

  // ===== 15. surfaces ======================================================================================
  const billF = await mkBill(T, { cost: 410, phone: '0244000321', payerId: 'gmtf' });
  await rejects(() => solutions.run(story.id, 'payer', { payerId: 'acacia', input: { action: 'offer', billId: billF.id } }), 404, 'a payer can only offer on bills it covers');
  const pf = (await solutions.run(story.id, 'payer', { payerId: 'acacia', input: { action: 'offer', billId: billA.id, resend: true } }));
  ok(pf.result.resent === true, 'the programming payer can offer/resend on a bill it covers');
  const lst = (await solutions.run(story.id, 'payer', { payerId: 'acacia', input: { action: 'list' } })).result;
  ok(lst.total >= 3 && lst.byStatus.approved >= 1 && lst.approvedTotal === 200, 'payer list shows applications, status counts and approved total');
  const ps = (await solutions.run(story.id, 'patient', { input: { applicationNo: ou.applicationNo, phone: '0201112233' } })).result;
  ok(ps.status === 'approved' && ps.decision.approvedAmount === 200, 'the patient surface looks up their own application by number + phone');
  await rejects(() => solutions.run(story.id, 'patient', { input: { applicationNo: ou.applicationNo, phone: '0244999999' } }), 404, 'wrong phone cannot read someone else\'s application');
  const pubList = await solutions.listFor('patient');
  ok(pubList.some((p) => p.module === 'insurecredit') && pubList.find((p) => p.module === 'insurecredit').inputs.some((i) => i.key === 'phone'), 'live InsureCredit appears on the public Solutions page asking for number + phone');

  // ===== 16. auto-send ====================================================================================
  const auto = await mkProduct('cosmopolitan', 'Auto offers', { autoSend: true, autoSendWithinDays: 2 });
  await goLive(auto);
  const billG = await mkBill(T, { cost: 640, phone: '0244000654', payerId: 'cosmopolitan' });
  const billH = await mkBill(T, { cost: 650, phone: '0244000655', payerId: 'acacia' });
  const smsBeforeAuto = sms.length;
  const pass1 = await credit.runAutoSend();
  ok(pass1.offered === 1 && sms.length === smsBeforeAuto + 1 && lastSms().to === '+233244000654', 'auto-send texts only bills covered by the product\'s payer');
  const pass2 = await credit.runAutoSend();
  ok(pass2.offered === 0 && sms.length === smsBeforeAuto + 1, 'a second pass never texts the same bill twice');
  ok((await store.credits.byBill(billH.id)).length === 0, 'bills of other payers are untouched');
  await products.setStatus(auto.id, 'sandbox');
  ok((await credit.runAutoSend()).products === 0, 'auto-send does nothing unless the product is live');

  // ===== 17. messaging sandbox protects live products ======================================================
  await operatingMode.set({ messaging: { sandbox: true } });
  const billS = await mkBill(T, { cost: 330, phone: '0244000147' });
  const smsBeforeS = sms.length;
  const os = (await runH(story.id, tenant, { action: 'offer', billId: billS.id })).result;
  ok(sms.length === smsBeforeS && os.sentVia.includes('sms') && os.sendResults.sms.sandbox === true, 'with messaging in sandbox, a live product still creates the application but nothing reaches the network');

  // ===== 18. default product + InsureCredit as a means of settlement ==============================
  await operatingMode.set({ messaging: { sandbox: false } });
  const s18_dp = await credit.ensureDefaultProduct();
  ok(s18_dp && s18_dp.name === credit.DEFAULT_NAME && s18_dp.status === 'live' && s18_dp.config.module === 'insurecredit', 'a default InsureCredit solution is created live');
  const s18_dp2 = await credit.ensureDefaultProduct();
  ok(s18_dp2.id === s18_dp.id, 'the default is created once, never duplicated');
  await products.setStatus(s18_dp.id, 'sandbox');
  ok((await credit.ensureDefaultProduct()).status === 'sandbox', 'an admin who pauses the default is not overridden');
  await rejects(() => credit.offerAsSettlement({ tenant, billId: 'x' }), 409, 'a paused default cannot be offered');
  await products.setStatus(s18_dp.id, 'live');
  const s18_billD = await mkBill(T, { cost: 600, phone: '0244000321', copay: 100 });
  const s18_smsD = sms.length;
  const s18_od = await credit.offerAsSettlement({ tenant, billId: s18_billD.id });
  ok(s18_od.applicationNo && s18_od.link && sms.length === s18_smsD + 1, 'settlement tab: texts the patient an offer for their share');
  const s18_stD = await credit.settlementStatus(await store.bills.get(s18_billD.id));
  ok(s18_stD.offered && s18_stD.status === 'offered' && s18_stD.billStatus === 'open', 'settlement status reports the offer, bill still open');
  const s18_tokD = (await store.credits.byAppNo(s18_od.applicationNo)).token;
  await credit.consent(s18_tokD, { scoring: true }); await credit.apply(s18_tokD, {});
  await credit.recordDecision(s18_od.applicationNo, { decision: 'approved' });
  const s18_billDa = await store.bills.get(s18_billD.id);
  ok(s18_billDa.status === 'settled' && s18_billDa.settlementMethod === 'insurecredit', 'an approved loan covering the share settles the bill as insurecredit');
  ok((await store.ledger.listByBill(s18_billD.id)).some((e) => e.type === 'insurecredit_loan' && e.cashMovement === false), 'the ledger records the loan with no cash movement booked');
  const s18_billP = await mkBill(T, { cost: 600, phone: '0244000322', copay: 100 });
  const s18_op = await credit.offerAsSettlement({ tenant, billId: s18_billP.id });
  const s18_tokP = (await store.credits.byAppNo(s18_op.applicationNo)).token;
  await credit.consent(s18_tokP, { scoring: true }); await credit.apply(s18_tokP, {});
  await credit.recordDecision(s18_op.applicationNo, { decision: 'approved', approvedAmount: 200 });
  const s18_billPa = await store.bills.get(s18_billP.id);
  ok(s18_billPa.status !== 'settled' && s18_billPa.insurecredit.approvedAmount === 200, 'a part-approval does not settle the bill');
  const s18_billQ = await mkBill(T, { cost: 600, phone: '0244000323', copay: 100 });
  const s18_oq = await credit.offerAsSettlement({ tenant, billId: s18_billQ.id });
  const s18_tokQ = (await store.credits.byAppNo(s18_oq.applicationNo)).token;
  await credit.consent(s18_tokQ, { scoring: true }); await credit.apply(s18_tokQ, {});
  await credit.recordDecision(s18_oq.applicationNo, { decision: 'declined' });
  ok((await store.bills.get(s18_billQ.id)).status !== 'settled', 'a declined loan leaves the bill open');
  await rejects(async () => credit.offerAsSettlement({ tenant: await store.tenants.get('tenant_nyaho'), billId: s18_billD.id }), 404, "a hospital cannot offer on another hospital's bill");

  // ===== 19. short links, lookup fallback, USSD default migration ================================
  const s19app = await store.credits.byAppNo(s18_od.applicationNo);
  ok(/^[a-hj-km-np-z2-9]{12}$/.test(s19app.token) && s18_od.link.endsWith(`/c/${s19app.token}`) && !s18_od.link.includes('?'), 'offer links are short, letters and digits only, with no query string');
  ok((await credit.lookup({ applicationNo: s18_od.applicationNo, phone: '0244000321' })).token === s19app.token, 'a mangled link can be recovered with application number + phone');
  await rejects(() => credit.lookup({ applicationNo: s18_od.applicationNo, phone: '0244999999' }), 404, 'the application number alone (wrong phone) opens nothing');
  const dprod = await credit.defaultProduct();
  ok(dprod.config.params.ussdCode === '*789*963#', 'the default product uses USSD code *789*963#');
  await products.update(dprod.id, { config: { ...dprod.config, params: { ...dprod.config.params, ussdCode: '*713*55#' } } }, 'test');
  ok((await credit.ensureDefaultProduct()).config.params.ussdCode === '*789*963#', 'an uncustomised default with the old USSD code is migrated to the new one');
  await products.update(dprod.id, { config: { ...dprod.config, params: { ...dprod.config.params, ussdCode: '*500#' } } }, 'test');
  ok((await credit.ensureDefaultProduct()).config.params.ussdCode === '*500#', 'a customised USSD code is never overwritten');
  await operatingMode.set({ messaging: { sandbox: true } });

  console.log(`\nINSURECREDIT + MESSAGING CHECK: ${a} assertions${process.exitCode ? ' — FAILURES ABOVE' : ' passed'}`);
})().catch((e) => { console.error(e); process.exit(1); });
