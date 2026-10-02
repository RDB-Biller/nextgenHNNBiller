'use strict';
// Smoke test for manual + SMS/WhatsApp clinical-indicator entry:
// services/clinicalLinks.js (OTP phone<->member binding, SMS/WhatsApp
// parsing + dispatch) and services/observations.js's recordManual() path
// (manual_hospital / manual_patient / patient_sms sources), against the
// in-memory store. Run: node scripts/smoke-clinical-entry.js

const store = require('../src/store');
const config = require('../src/config');
const observations = require('../src/services/observations');
const clinicalLinks = require('../src/services/clinicalLinks');

let a = 0;
const ok = (cond, label) => {
  a++;
  if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else { console.log(`ok  : ${label}`); }
};

const PAYER = 'pay_vbc_clinical';
const CLINIC = 'ten_clinic_manual';
const PHONE_A = '0241110001';
const PHONE_B = '0241110002';
const PHONE_UNENROLLED = '0241110099';

async function seed() {
  await store.payers.save({ id: PAYER, kind: 'insurer', name: 'Clinical-Entry Test Insurer' });
  await store.tenants.save({ id: CLINIC, name: 'Manual-Entry Test Clinic' });
}

// ---- 1. request() validation -------------------------------------------
async function requestValidationChecks() {
  let threw = null;
  try { await clinicalLinks.request({ memberId: 'mem_1', phone: PHONE_A }); } catch (e) { threw = e; }
  ok(threw && threw.status === 422 && threw.message === 'payerId_required', 'request() rejects a missing payerId');

  threw = null;
  try { await clinicalLinks.request({ payerId: PAYER, phone: PHONE_A }); } catch (e) { threw = e; }
  ok(threw && threw.status === 422 && threw.message === 'memberId_required', 'request() rejects a missing memberId');

  threw = null;
  try { await clinicalLinks.request({ payerId: PAYER, memberId: 'mem_1' }); } catch (e) { threw = e; }
  ok(threw && threw.status === 422 && threw.message === 'phone_required', 'request() rejects a missing phone');

  threw = null;
  try { await clinicalLinks.request({ payerId: 'pay_nonexistent', memberId: 'mem_1', phone: PHONE_A }); } catch (e) { threw = e; }
  ok(threw && threw.status === 404, 'request() rejects an unknown payer');

  threw = null;
  try { await clinicalLinks.request({ payerId: PAYER, memberId: 'mem_1', phone: PHONE_A, condition: 'not_a_condition' }); } catch (e) { threw = e; }
  ok(threw && threw.status === 422 && threw.message === 'invalid_condition', 'request() rejects an unrecognised condition');
}

// ---- 2. OTP enroll + confirm (web path) --------------------------------
let linkA = null;
async function enrollAndConfirmWeb() {
  linkA = await clinicalLinks.request({ payerId: PAYER, memberId: 'mem_1', phone: PHONE_A, condition: 'hypertension', createdBy: 'patient_web' });
  ok(linkA.status === 'pending' && /^\d{6}$/.test(linkA.otpCode), 'request() creates a pending link with a 6-digit code');
  ok(linkA.channelsSent.includes('sms'), 'request() sends the code by SMS (sandbox mode)');

  let threw = null;
  try { await clinicalLinks.confirmById(linkA.id, '000000'); } catch (e) { threw = e; }
  ok(threw && threw.status === 422 && threw.message === 'wrong_code', 'confirmById() rejects the wrong code');

  linkA = await clinicalLinks.confirmById(linkA.id, linkA.otpCode);
  ok(linkA.status === 'active' && linkA.otpCode == null, 'confirmById() activates on the right code and burns it');
  ok(typeof linkA.activeToken === 'string' && linkA.activeToken.length > 10, 'confirmById() mints a bearer token on activation');
}

// ---- 3. SMS/WhatsApp readings on the now-active link -------------------
async function smsReadingChecks() {
  let r = await clinicalLinks.handleInboundReply({ from: PHONE_A, text: 'BP 130/85', channel: 'sms' });
  ok(r && r.outcome === 'recorded' && r.observation.type === 'blood_pressure'
    && r.observation.systolic === 130 && r.observation.diastolic === 85
    && r.observation.condition === 'hypertension' && r.observation.source === 'patient_sms',
  'a "BP 130/85" text is parsed, tagged hypertension, and recorded as patient_sms');

  r = await clinicalLinks.handleInboundReply({ from: PHONE_A, text: 'hba1c 6.8', channel: 'sms' });
  ok(r && r.outcome === 'recorded' && r.observation.type === 'hba1c' && r.observation.value === 6.8
    && r.observation.condition === 'diabetes',
  'an "hba1c 6.8" text auto-tags diabetes regardless of the link\'s own hypertension condition');

  r = await clinicalLinks.handleInboundReply({ from: PHONE_A, text: 'LDL 110', channel: 'whatsapp' });
  ok(r && r.observation.type === 'ldl' && r.observation.value === 110 && r.observation.condition === 'dyslipidemia',
    'an "LDL 110" text auto-tags dyslipidemia');

  r = await clinicalLinks.handleInboundReply({ from: PHONE_A, text: 'COMPLICATION kidney issue', channel: 'sms' });
  ok(r && r.observation.type === 'complication' && r.observation.condition === 'hypertension',
    'a condition-agnostic "COMPLICATION" text falls back to the link\'s own condition');

  r = await clinicalLinks.handleInboundReply({ from: PHONE_A, text: 'follow-up', channel: 'sms' });
  ok(r && r.observation.type === 'followup_visit', 'a "follow-up" text records a followup_visit');

  const mine = await store.observations.listByMember(PAYER, 'mem_1');
  ok(mine.length === 5, 'all five SMS readings landed in clinical_observations for this member');
  ok(mine.every((o) => o.source === 'patient_sms' && o.recordedBy && o.recordedBy.linkId === linkA.id),
    'every row is tagged source:patient_sms with recordedBy.linkId');
}

// ---- 4. Unenrolled phones fall through untouched ------------------------
async function fallthroughChecks() {
  const r = await clinicalLinks.handleInboundReply({ from: PHONE_UNENROLLED, text: 'BP 130/85', channel: 'sms' });
  ok(r === null, 'a clinical-shaped text from an unenrolled phone returns null (falls through to bill verification)');

  const help = await clinicalLinks.handleInboundReply({ from: PHONE_UNENROLLED, text: 'help', channel: 'sms' });
  ok(help === null, 'HELP from an unenrolled phone returns null rather than advertising the feature');

  const stop = await clinicalLinks.handleInboundReply({ from: PHONE_UNENROLLED, text: 'STOP', channel: 'sms' });
  ok(stop && stop.outcome === 'no_match', 'STOP from a phone with no link at all gets a clear no_match reply (not swallowed silently)');
}

// ---- 5. HELP on an active link ------------------------------------------
async function helpCheck() {
  const r = await clinicalLinks.handleInboundReply({ from: PHONE_A, text: 'HELP', channel: 'sms' });
  ok(r && r.outcome === 'help', 'HELP on an enrolled, active phone returns the command list');
}

// ---- 6. STOP revokes, and readings stop working afterwards --------------
async function stopChecks() {
  const r = await clinicalLinks.handleInboundReply({ from: PHONE_A, text: 'stop', channel: 'sms' });
  ok(r && r.outcome === 'revoked', 'STOP revokes an active link');

  const after = await store.clinicalLinks.get(linkA.id);
  ok(after.status === 'revoked' && after.activeToken == null, 'the revoked link record has no usable bearer token left');

  const reading = await clinicalLinks.handleInboundReply({ from: PHONE_A, text: 'BP 120/80', channel: 'sms' });
  ok(reading === null, 'a reading from a revoked phone falls through (no longer silently recorded)');
}

// ---- 7. OTP lockout + expiry ---------------------------------------------
async function lockoutAndExpiryChecks() {
  let linkB = await clinicalLinks.request({ payerId: PAYER, memberId: 'mem_2', phone: PHONE_B, condition: 'diabetes' });
  // Drive wrong attempts via the SMS bare-code path (the phone has a pending
  // link, so a bare numeric guess is tried against it).
  let lastOutcome = null;
  for (let i = 0; i < config.messaging.otpMaxAttempts; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await clinicalLinks.handleInboundReply({ from: PHONE_B, text: '999999', channel: 'sms' });
    lastOutcome = r && r.outcome;
  }
  ok(lastOutcome === 'locked', `after ${config.messaging.otpMaxAttempts} wrong codes the link locks (got: ${lastOutcome})`);

  linkB = await store.clinicalLinks.get(linkB.id);
  let threw = null;
  try { await clinicalLinks.confirmById(linkB.id, linkB.otpCode); } catch (e) { threw = e; }
  ok(threw && threw.status === 423, 'a locked link rejects even the RIGHT code (423)');

  // Expiry: fresh link, manually backdate otpExpiresAt, confirm should report expired.
  let linkC = await clinicalLinks.request({ payerId: PAYER, memberId: 'mem_3', phone: '0241110003', condition: 'dyslipidemia' });
  linkC.otpExpiresAt = new Date(Date.now() - 1000).toISOString();
  await store.clinicalLinks.update(linkC);
  threw = null;
  try { await clinicalLinks.confirmById(linkC.id, linkC.otpCode); } catch (e) { threw = e; }
  ok(threw && threw.status === 410, 'an expired code is rejected with 410');
}

// ---- 8. Confirm-by-SMS (bare code reply, not the web button) ------------
async function confirmBySmsChecks() {
  const link = await clinicalLinks.request({ payerId: PAYER, memberId: 'mem_4', phone: '0241110004', condition: 'hypertension' });
  const r = await clinicalLinks.handleInboundReply({ from: '0241110004', text: link.otpCode, channel: 'sms' });
  ok(r && r.outcome === 'confirmed', 'replying with the bare OTP code (no keyword) confirms the link over SMS too');
  const after = await store.clinicalLinks.get(link.id);
  ok(after.status === 'active', 'the link is active after SMS-only confirmation');
}

// ---- 9. Resend ------------------------------------------------------------
async function resendCheck() {
  const link = await clinicalLinks.request({ payerId: PAYER, memberId: 'mem_5', phone: '0241110005', condition: 'hypertension' });
  const oldCode = link.otpCode;
  const resent = await clinicalLinks.resend(link.id);
  ok(resent.id === link.id && resent.otpCode !== oldCode, 'resend() issues a different code for the same pending link');

  let threw = null;
  try { await clinicalLinks.resend('clk_does_not_exist'); } catch (e) { threw = e; }
  ok(threw && threw.status === 404, 'resend() 404s for an unknown link id');
}

// ---- 10. Hospital-initiated enrollment + lost-token re-request ----------
async function hospitalAndReRequestChecks() {
  const link = await clinicalLinks.request({
    payerId: PAYER, memberId: 'mem_6', phone: '0241110006', condition: 'diabetes',
    createdBy: 'hospital', tenantId: CLINIC,
  });
  ok(link.createdBy === 'hospital' && link.tenantId === CLINIC, 'a clinic can initiate enrollment on a patient\'s behalf');

  const confirmed = await clinicalLinks.confirmById(link.id, link.otpCode);
  const tokenBefore = confirmed.activeToken;
  ok(confirmed.status === 'active' && tokenBefore, 'hospital-initiated link still requires the patient\'s own code to activate');

  // Re-request (e.g. a lost token) reuses the same row and invalidates the old token.
  const reRequested = await clinicalLinks.request({ payerId: PAYER, memberId: 'mem_6', phone: '0241110006' });
  ok(reRequested.id === link.id && reRequested.status === 'pending' && reRequested.activeToken == null,
    're-requesting an already-active link re-pends it with a fresh code and clears the old token');
}

// ---- 11. recordForLink() direct call + observations.recordManual() source tagging
async function recordManualChecks() {
  const o = await observations.recordManual(
    { payerId: PAYER, memberId: 'mem_7', condition: 'hypertension', type: 'blood_pressure', systolic: 118, diastolic: 76, tenantId: CLINIC },
    { source: 'manual_hospital', recordedBy: { tenantId: CLINIC } },
  );
  ok(o.source === 'manual_hospital' && o.tenantId === CLINIC && o.systolic === 118, 'recordManual() tags a hospital manual entry correctly');

  let threw = null;
  try { await observations.recordManual({ payerId: PAYER, memberId: 'mem_7', type: 'not_a_type' }, { source: 'manual_hospital' }); } catch (e) { threw = e; }
  ok(threw && threw.status === 422, 'recordManual() rejects an unknown type exactly like record() does');

  threw = null;
  try { await observations.recordManual({ payerId: 'pay_nope', memberId: 'mem_7', type: 'blood_pressure' }, { source: 'manual_hospital' }); } catch (e) { threw = e; }
  ok(threw && threw.status === 404, 'recordManual() rejects an unknown payer exactly like record() does');

  // A forged/unknown source string is never trusted verbatim onto the stored row.
  const o2 = await observations.recordManual(
    { payerId: PAYER, memberId: 'mem_7', type: 'ldl', value: 95 },
    { source: 'not_a_real_source' },
  );
  ok(o2.source === 'emr', 'an unrecognised source value falls back to the safe default rather than being stored verbatim');
}

async function main() {
  await store.init();
  await seed();
  await requestValidationChecks();
  await enrollAndConfirmWeb();
  await smsReadingChecks();
  await fallthroughChecks();
  await helpCheck();
  await stopChecks();
  await lockoutAndExpiryChecks();
  await confirmBySmsChecks();
  await resendCheck();
  await hospitalAndReRequestChecks();
  await recordManualChecks();
  console.log(`\n${a - (process.exitCode ? 1 : 0)}/${a} assertions passed${process.exitCode ? ' — SEE FAILURES ABOVE' : ''}`);
}

main().catch((e) => { console.error('Smoke test crashed:', e); process.exitCode = 1; });
