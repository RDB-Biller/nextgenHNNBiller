'use strict';
/**
 * Service-layer smoke test for patient bill verification: the payer
 * verification gate, dashboard pending-queue, reissue/override/prior-approval,
 * and 2-way SMS/WhatsApp OTP confirmation. No server, no network, no
 * node_modules beyond what `src/` itself needs — calls straight into the
 * same service functions the routes call, in-process, against the in-memory
 * store (no DATABASE_URL needed). Run with `npm run smoke:verification`.
 */
const store = require('../src/store');
const { createBill } = require('../src/services/billing');
const verification = require('../src/services/verification');
const priorApproval = require('../src/services/priorApproval');

let failed = 0;
function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); failed++; } else console.log('ok  :', msg); }

async function main() {
  await store.init();

  // 1. Creating a bill and immediately creating its verification (mirrors bills.js POST /).
  const bill = createBill({
    provider: 'Euracare Hospital', patient: { name: 'Ama Mensah', phone: '0244000000' },
    items: [{ name: 'Consultation', cost: 200 }], insurance: { payerId: 'acacia', memberId: 'NHIS-1' },
  });
  bill.tenantId = 'tenant_euracare';
  await store.bills.insert(bill);
  const v1 = await verification.createForBill(bill);
  assert(v1.status === 'pending', 'verification created in pending state');
  assert(v1.link === `/verify/?token=${v1.token}`, 'verification link shaped correctly');
  assert((await verification.getByToken(v1.token)).id === v1.id, 'lookup by token works');
  assert((await verification.forBill(bill.id)).id === v1.id, 'lookup by bill works');

  const storedBill = await store.bills.get(bill.id);
  assert(storedBill.patientVerification === undefined, 'verification NOT persisted onto the bill (single source of truth kept)');

  const notifs1 = await store.notifications.listByTenant('tenant_euracare');
  const sentToPatient = notifs1.find(n => n.billId === bill.id && n.party === 'patient' && n.subject === 'Please verify your bill');
  assert(!!sentToPatient, 'patient was notified immediately on bill creation');
  assert(sentToPatient.body.includes(v1.link), 'notification body includes the verification link');

  // 2. Route to Acacia (gate currently OFF - default) and authorize should succeed
  //    even though unverified.
  const claims = require('../src/services/claims');
  const { claim: claim1 } = await claims.routeToPayer(bill, 'acacia');
  const payerAcacia = await store.payers.get('acacia');
  assert(payerAcacia.requirePatientVerification !== true, 'gate defaults off for acacia');
  const authorized1 = await claims.authorize(claim1.id);
  assert(['authorized', 'settled'].includes(authorized1.status), `authorize succeeds with gate off (status=${authorized1.status})`);

  // 3. Second bill: turn the gate ON for acacia, confirm authorize is now BLOCKED.
  const bill2 = createBill({
    provider: 'Euracare Hospital', patient: { name: 'Kojo Boateng', phone: '0244000001' },
    items: [{ name: 'X-Ray', cost: 300 }], insurance: { payerId: 'acacia', memberId: 'NHIS-2' },
  });
  bill2.tenantId = 'tenant_euracare';
  await store.bills.insert(bill2);
  const v2 = await verification.createForBill(bill2);

  payerAcacia.requirePatientVerification = true;
  await store.payers.save(payerAcacia);

  const { claim: claim2 } = await claims.routeToPayer(bill2, 'acacia');
  let blockedErr = null;
  try { await claims.authorize(claim2.id); } catch (e) { blockedErr = e; }
  assert(!!blockedErr, 'authorize throws while gate is on and patient unverified');
  assert(blockedErr && blockedErr.message === 'patient_verification_pending', `error message is patient_verification_pending (got ${blockedErr && blockedErr.message})`);
  assert(blockedErr && blockedErr.status === 409, `error status is 409 (got ${blockedErr && blockedErr.status})`);

  const claim2AfterBlock = await store.claims.get(claim2.id);
  assert(claim2AfterBlock.status === 'pending', `blocked claim stays pending, not stuck mid-flight (status=${claim2AfterBlock.status})`);

  // 4. Patient confirms -> authorize now succeeds.
  const confirmed = await verification.confirm(v2.id);
  assert(confirmed.status === 'verified' && !!confirmed.verifiedAt, 'confirm() flips to verified with timestamp');
  const authorized2 = await claims.authorize(claim2.id);
  assert(['authorized', 'settled'].includes(authorized2.status), `authorize succeeds once verified (status=${authorized2.status})`);

  // 5. Re-confirming an already-verified record is rejected (no silent double-fire).
  let doubleErr = null;
  try { await verification.confirm(v2.id); } catch (e) { doubleErr = e; }
  assert(!!doubleErr && doubleErr.status === 409, 'double-confirm rejected with 409');

  // 6. Dispute path on a third bill, with the gate on: notifies the provider, and
  //    authorize stays blocked (disputed != verified).
  const bill3 = createBill({
    provider: 'Euracare Hospital', patient: { name: 'Efua Owusu' }, items: [{ name: 'Lab test', cost: 90 }],
    insurance: { payerId: 'acacia', memberId: 'NHIS-3' },
  });
  bill3.tenantId = 'tenant_euracare';
  await store.bills.insert(bill3);
  const v3 = await verification.createForBill(bill3);
  const disputed = await verification.dispute(v3.id, 'I was not given a lab test');
  assert(disputed.status === 'disputed' && disputed.disputeReason === 'I was not given a lab test', 'dispute() records reason');

  const notifs3 = await store.notifications.listByTenant('tenant_euracare');
  const disputeNotif = notifs3.find(n => n.billId === bill3.id && n.subject === `Patient disputed bill ${bill3.id}`);
  assert(!!disputeNotif, 'provider notified when patient disputes');
  assert(disputeNotif.body.includes('I was not given a lab test'), 'dispute notification includes the reason');

  const { claim: claim3 } = await claims.routeToPayer(bill3, 'acacia');
  let disputedBlockErr = null;
  try { await claims.authorize(claim3.id); } catch (e) { disputedBlockErr = e; }
  assert(!!disputedBlockErr && disputedBlockErr.message === 'patient_verification_pending', 'disputed (not verified) still blocks authorize when gate is on');

  // 7. Unrelated payer (no gate set) must be unaffected — payer-scoping sanity check.
  const bill4 = createBill({
    provider: 'Nyaho Medical Centre', patient: { name: 'Yaw' }, items: [{ name: 'Consult', cost: 50 }],
    insurance: { payerId: 'savanna', memberId: 'SAV-1' },
  });
  bill4.tenantId = 'tenant_nyaho';
  await store.bills.insert(bill4);
  await verification.createForBill(bill4); // patient never verifies
  const { claim: claim4 } = await claims.routeToPayer(bill4, 'savanna');
  const authorized4 = await claims.authorize(claim4.id);
  assert(['authorized', 'settled'].includes(authorized4.status), `unrelated payer (savanna, gate never touched) unaffected by acacia's gate (status=${authorized4.status})`);

  console.log(failed ? `\nSMOKE TEST: ${failed} FAILURE(S) ABOVE` : '\nSMOKE TEST: ALL PASSED');
  process.exitCode = failed ? 1 : 0;
}

// ---- dashboard: pending-verification tracking ----
async function dashboardCheck() {
  let failed2 = 0;
  const assert2 = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failed2++; } else console.log('ok  :', msg); };

  const listed = await store.verifications.listByTenant('tenant_euracare');
  assert2(listed.length === 3, `listByTenant returns exactly euracare's 3 verifications, not nyaho's (got ${listed.length})`);
  assert2(listed.every(v => v.tenantId === 'tenant_euracare'), 'listByTenant is properly tenant-scoped');
  // chronological ascending, like bills/claims listByTenant.
  const ascending = listed.every((v, i) => i === 0 || new Date(listed[i - 1].createdAt) <= new Date(v.createdAt));
  assert2(ascending, 'listByTenant returns oldest first');

  // Mirror dashboard.js's own filter/shape logic against real data.
  const pending = listed.filter(v => v.status !== 'verified');
  assert2(pending.some(v => v.status === 'disputed'), 'disputed bill (Efua/lab test) shows up in the pending queue');
  assert2(!pending.some(v => v.patientName === 'Kojo Boateng'), 'Kojo (confirmed earlier) is correctly excluded now he is verified');
  const nyahoListed = await store.verifications.listByTenant('tenant_nyaho');
  assert2(nyahoListed.length === 1 && nyahoListed[0].patientName === 'Yaw', 'nyaho tenant only sees its own (Yaw), not euracare\'s');

  console.log(failed2 ? `\nDASHBOARD CHECK: ${failed2} FAILURE(S) ABOVE` : '\nDASHBOARD CHECK: ALL PASSED');
  if (failed2) process.exitCode = 1;
}

// ---- reissue / payer override / prior approvals ----
async function reissueOverrideCheck() {
  let f = 0;
  const a = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); f++; } else console.log('ok  :', msg); };

  // reissue(): disputed -> pending, reminder counter increments, link unchanged.
  const bill5 = createBill({ provider: 'Euracare Hospital', patient: { name: 'Abena' }, items: [{ name: 'Scan', cost: 120 }], insurance: { payerId: 'acacia', memberId: 'NHIS-5' } });
  bill5.tenantId = 'tenant_euracare'; await store.bills.insert(bill5);
  const v5 = await verification.createForBill(bill5);
  await verification.dispute(v5.id, 'wrong amount');
  const reissued1 = await verification.reissue(v5.id);
  a(reissued1.status === 'pending', 'reissue() resets a disputed record back to pending');
  a(reissued1.disputeReason === null && reissued1.disputedAt === null, 'reissue() clears the old dispute reason/timestamp');
  a(reissued1.token === v5.token && reissued1.link === v5.link, 'reissue() keeps the same token/link (not a new one)');
  a(reissued1.remindersSent === 1, `reissue() counts reminders (got ${reissued1.remindersSent})`);
  const reissued2 = await verification.reissue(v5.id);
  a(reissued2.remindersSent === 2, `second reissue() increments again (got ${reissued2.remindersSent})`);
  const notifs5 = await store.notifications.listByTenant('tenant_euracare');
  a(notifs5.filter(n => n.billId === bill5.id && n.subject === 'Please verify your bill').length === 3, 'each reissue re-notifies the patient (1 original + 2 reminders)');
  await verification.confirm(v5.id);
  let reissueAfterVerifiedErr = null;
  try { await verification.reissue(v5.id); } catch (e) { reissueAfterVerifiedErr = e; }
  a(!!reissueAfterVerifiedErr && reissueAfterVerifiedErr.status === 409, 'reissue() rejects an already-verified record');

  // overrideVerify() by reason (no prior approval): payer marks verified themselves.
  const bill6 = createBill({ provider: 'Euracare Hospital', patient: { name: 'Kwame' }, items: [{ name: 'Consult', cost: 80 }], insurance: { payerId: 'acacia', memberId: 'NHIS-6' } });
  bill6.tenantId = 'tenant_euracare'; await store.bills.insert(bill6);
  const v6 = await verification.createForBill(bill6);
  const overridden1 = await verification.overrideVerify(v6.id, { by: 'acacia', reason: 'Called the hospital and confirmed' });
  a(overridden1.status === 'verified', 'overrideVerify() flips status to verified');
  a(overridden1.verifiedBy === 'payer_override', `verifiedBy is payer_override with no priorApprovalId (got ${overridden1.verifiedBy})`);
  a(overridden1.overrideReason === 'Called the hospital and confirmed', 'override reason recorded');
  a(overridden1.overrideByPayerId === 'acacia', 'override attributed to the payer who did it');
  let overrideAfterVerifiedErr = null;
  try { await verification.overrideVerify(v6.id, { by: 'acacia' }); } catch (e) { overrideAfterVerifiedErr = e; }
  a(!!overrideAfterVerifiedErr && overrideAfterVerifiedErr.status === 409, 'overrideVerify() rejects an already-verified record');

  // priorApproval service: create / effectiveStatus / activeForMember / markUsed / revoke.
  const pa = await priorApproval.create('acacia', { memberId: 'NHIS-9', description: 'Elective surgery', amountCap: 500, patientName: 'Yaa' });
  a(pa.status === 'active' && priorApproval.effectiveStatus(pa) === 'active', 'prior approval created active');
  a(pa.timesUsed === 0 && pa.lastUsedAt === null, 'prior approval starts unused');
  const listedPA = await priorApproval.listByPayer('acacia');
  a(listedPA.some(x => x.id === pa.id && x.effectiveStatus === 'active'), 'listByPayer includes the new approval with a computed effectiveStatus');
  const matches = await priorApproval.activeForMember('acacia', 'NHIS-9');
  a(matches.length === 1 && matches[0].id === pa.id, 'activeForMember finds it by payer+member');
  a((await priorApproval.activeForMember('acacia', 'NHIS-does-not-exist')).length === 0, 'activeForMember returns nothing for a non-matching member');
  a((await priorApproval.activeForMember('cosmopolitan', 'NHIS-9')).length === 0, 'activeForMember is payer-scoped (another payer cannot see it)');

  // overrideVerify() referencing a prior approval end-to-end, mirroring what the
  // route does: look up + validate ownership, markUsed, then overrideVerify.
  const bill7 = createBill({ provider: 'Euracare Hospital', patient: { name: 'Yaa' }, items: [{ name: 'Surgery', cost: 450 }], insurance: { payerId: 'acacia', memberId: 'NHIS-9' } });
  bill7.tenantId = 'tenant_euracare'; await store.bills.insert(bill7);
  const v7 = await verification.createForBill(bill7);
  await priorApproval.markUsed(pa.id, 'claim_fake_7');
  const overridden2 = await verification.overrideVerify(v7.id, { by: 'acacia', priorApprovalId: pa.id });
  a(overridden2.verifiedBy === 'prior_approval', `verifiedBy is prior_approval when one is referenced (got ${overridden2.verifiedBy})`);
  a(overridden2.overridePriorApprovalId === pa.id, 'override links back to the prior approval used');
  const paAfterUse = await store.priorApprovals.get(pa.id);
  a(paAfterUse.timesUsed === 1 && paAfterUse.lastUsedClaimId === 'claim_fake_7', 'markUsed records the usage trail on the prior approval');

  // revoke(): only the owning payer can revoke; revoked drops out of activeForMember.
  let revokeWrongPayerErr = null;
  try { await priorApproval.revoke(pa.id, 'cosmopolitan'); } catch (e) { revokeWrongPayerErr = e; }
  a(!!revokeWrongPayerErr && revokeWrongPayerErr.status === 404, 'revoke() refuses a payer that does not own the approval');
  const revoked = await priorApproval.revoke(pa.id, 'acacia');
  a(revoked.status === 'revoked' && priorApproval.effectiveStatus(revoked) === 'revoked', 'revoke() by the owning payer works');
  a((await priorApproval.activeForMember('acacia', 'NHIS-9')).length === 0, 'a revoked approval no longer matches activeForMember');

  // Expiry is computed, not a stored transition.
  const paExpired = await priorApproval.create('acacia', { memberId: 'NHIS-10', description: 'old approval', expiresAt: '2020-01-01T00:00:00.000Z' });
  a(priorApproval.effectiveStatus(paExpired) === 'expired', 'a past expiresAt computes to expired even though status column stays active');
  a((await priorApproval.activeForMember('acacia', 'NHIS-10')).length === 0, 'an expired approval does not match activeForMember');

  console.log(f ? `\nREISSUE/OVERRIDE/PRIOR-APPROVAL CHECK: ${f} FAILURE(S) ABOVE` : '\nREISSUE/OVERRIDE/PRIOR-APPROVAL CHECK: ALL PASSED');
  if (f) process.exitCode = 1;
}

// ---- SMS/WhatsApp patient verification + OTP reply matching (sandbox mode) ----
async function smsWhatsappVerificationCheck() {
  let f = 0;
  const a = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); f++; } else console.log('ok  :', msg); };
  const messaging = require('../src/services/messaging');
  const nextWrongCode = (real) => String((parseInt(real, 10) + 1) % 1000000).padStart(6, '0'); // never equals `real`

  // Turn SMS + WhatsApp on for euracare (mirrors PUT /api/platform/clients/:id/verification-channels).
  const tenant = await store.tenants.get('tenant_euracare');
  tenant.verificationChannels = { sms: true, whatsapp: true, includeTreatmentDetail: false };
  await store.tenants.save(tenant);

  // 1. Bill creation dispatches both channels with a fresh OTP; default message has no item names.
  const billA = createBill({
    provider: 'Euracare Hospital', patient: { name: 'Adjoa', phone: '0244000111' },
    items: [{ name: 'Consultation', cost: 60 }, { name: 'Malaria test', cost: 40 }],
  });
  billA.tenantId = 'tenant_euracare'; await store.bills.insert(billA);
  const vA = await verification.createForBill(billA);
  a(Array.isArray(vA.channelsSent) && vA.channelsSent.includes('sms') && vA.channelsSent.includes('whatsapp'),
    `both channels dispatched (got ${JSON.stringify(vA.channelsSent)})`);
  a(/^\d{6}$/.test(vA.otpCode || ''), `a 6-digit OTP was generated (got ${vA.otpCode})`);
  a(new Date(vA.otpExpiresAt) > new Date(), 'OTP expiry is in the future');
  a(!vA.lastMessageBody.includes('Consultation') && !vA.lastMessageBody.includes('Malaria'),
    'line items withheld by default (no PHI over SMS/WhatsApp, matching README "before production" #3)');
  a(vA.lastMessageBody.includes(vA.otpCode), 'the code sent is the one stored');

  // 2. includeTreatmentDetail: on -> item names DO appear (opt-in only, see verification.js buildMessageBody).
  tenant.verificationChannels.includeTreatmentDetail = true;
  await store.tenants.save(tenant);
  const billB = createBill({ provider: 'Euracare Hospital', patient: { name: 'Nana', phone: '0244000112' }, items: [{ name: 'Wound dressing', cost: 35 }] });
  billB.tenantId = 'tenant_euracare'; await store.bills.insert(billB);
  const vB = await verification.createForBill(billB);
  a(vB.lastMessageBody.includes('Wound dressing'), 'includeTreatmentDetail=true lists the treatment in the message');
  tenant.verificationChannels.includeTreatmentDetail = false;
  await store.tenants.save(tenant); // back off for the rest of this check

  // 3. Wrong code -> stays pending, attempt counted; right code (even embedded in a
  //    sentence) -> confirmed, channel + patient attribution tracked, code burned.
  const wrong = await verification.handleInboundReply({ from: '+233244000111', text: nextWrongCode(vA.otpCode), channel: 'sms' });
  a(wrong.outcome === 'wrong_code', `wrong code reports wrong_code (got ${wrong.outcome})`);
  const afterWrong = await store.verifications.get(vA.id);
  a(afterWrong.otpAttempts === 1, `wrong attempt recorded (got ${afterWrong.otpAttempts})`);
  a(afterWrong.status === 'pending', 'still pending after one wrong guess');

  const right = await verification.handleInboundReply({ from: '0244000111', text: `the code is ${vA.otpCode} thanks`, channel: 'sms' });
  a(right.outcome === 'confirmed', `correct code confirms (got ${right.outcome})`);
  a(right.verification.verifiedBy === 'patient' && right.verification.verifiedVia === 'sms', 'confirmed via sms, attributed to the patient');
  a(right.verification.otpCode === null, 'the code is burned once used');

  // 4. Phone-format independence: "0244...", "+233244...", "233244..." must resolve to the same patient.
  a(messaging.normalizePhone('0244000111') === messaging.normalizePhone('+233244000111')
    && messaging.normalizePhone('0244000111') === messaging.normalizePhone('233244000111'),
    'local/international phone formats normalize to the same value');

  // 5. Two bills pending for the same phone: bare YES is ambiguous; the right code
  //    confirms only the one it belongs to, the other is untouched; once only one
  //    is left pending, a bare yes (any case) resolves unambiguously.
  const billC1 = createBill({ provider: 'Euracare Hospital', patient: { name: 'Esi', phone: '0244000222' }, items: [{ name: 'Checkup', cost: 70 }] });
  billC1.tenantId = 'tenant_euracare'; await store.bills.insert(billC1);
  const vC1 = await verification.createForBill(billC1);
  const billC2 = createBill({ provider: 'Euracare Hospital', patient: { name: 'Esi', phone: '0244000222' }, items: [{ name: 'Follow-up', cost: 30 }] });
  billC2.tenantId = 'tenant_euracare'; await store.bills.insert(billC2);
  const vC2 = await verification.createForBill(billC2);

  const ambiguous = await verification.handleInboundReply({ from: '0244000222', text: 'YES', channel: 'whatsapp' });
  a(ambiguous.outcome === 'ambiguous', `bare YES with two pending bills is ambiguous (got ${ambiguous.outcome})`);
  a((await store.verifications.get(vC1.id)).status === 'pending' && (await store.verifications.get(vC2.id)).status === 'pending',
    'neither bill was confirmed by the ambiguous YES');

  const specific = await verification.handleInboundReply({ from: '0244000222', text: vC2.otpCode, channel: 'whatsapp' });
  a(specific.outcome === 'confirmed' && specific.verification.id === vC2.id, 'the specific code confirms only the matching bill');
  a((await store.verifications.get(vC1.id)).status === 'pending', 'the OTHER pending bill for the same phone is untouched');

  const nowUnambiguous = await verification.handleInboundReply({ from: '0244000222', text: 'yes', channel: 'sms' });
  a(nowUnambiguous.outcome === 'confirmed' && nowUnambiguous.verification.id === vC1.id,
    'with only one pending left, a bare yes (any case) confirms it');

  // 6. Reissue invalidates the old code and sends a new one.
  const billD = createBill({ provider: 'Euracare Hospital', patient: { name: 'Kofi', phone: '0244000333' }, items: [{ name: 'Suture removal', cost: 20 }] });
  billD.tenantId = 'tenant_euracare'; await store.bills.insert(billD);
  const vD = await verification.createForBill(billD);
  const oldCode = vD.otpCode;
  const reissuedD = await verification.reissue(vD.id);
  a(reissuedD.otpCode !== oldCode, 'reissue() generates a fresh code, different from the old one');
  const oldCodeAttempt = await verification.handleInboundReply({ from: '0244000333', text: oldCode, channel: 'sms' });
  a(oldCodeAttempt.outcome === 'wrong_code', 'the OLD code no longer works after reissue');
  const newCodeAttempt = await verification.handleInboundReply({ from: '0244000333', text: reissuedD.otpCode, channel: 'sms' });
  a(newCodeAttempt.outcome === 'confirmed', 'the NEW code from reissue works');

  // 7. Lockout after too many wrong attempts -- even the correct code is then refused,
  //    and the record stays pending rather than being silently confirmed.
  const billE = createBill({ provider: 'Euracare Hospital', patient: { name: 'Adwoa', phone: '0244000444' }, items: [{ name: 'Vaccination', cost: 25 }] });
  billE.tenantId = 'tenant_euracare'; await store.bills.insert(billE);
  const vE = await verification.createForBill(billE);
  const wrongForE = nextWrongCode(vE.otpCode);
  let lastOutcome;
  for (let i = 0; i < 5; i++) {
    lastOutcome = (await verification.handleInboundReply({ from: '0244000444', text: wrongForE, channel: 'sms' })).outcome;
  }
  a(lastOutcome === 'locked', `the 5th wrong attempt locks the record (got ${lastOutcome})`);
  const lockedThenRight = await verification.handleInboundReply({ from: '0244000444', text: vE.otpCode, channel: 'sms' });
  a(lockedThenRight.outcome === 'locked', 'the CORRECT code is still refused once locked');
  a((await store.verifications.get(vE.id)).status === 'pending', 'a locked record stays pending, not silently confirmed');

  // 8. Unrecognised text and a phone with nothing pending are both handled gracefully.
  const nothingPending = await verification.handleInboundReply({ from: '0200999999', text: 'YES', channel: 'sms' });
  a(nothingPending.outcome === 'no_match', 'a phone with no pending verification gets no_match, not a crash');
  const gibberish = await verification.handleInboundReply({ from: '0244000111', text: 'what is this bill about', channel: 'sms' });
  a(gibberish.outcome === 'unrecognized', 'free text that is neither YES nor a code is unrecognized, not mis-matched');

  // 9. A clinic with channels OFF never dispatches or generates a code (status quo unaffected).
  const billF = createBill({ provider: 'Nyaho Medical Centre', patient: { name: 'Kwabena', phone: '0244000555' }, items: [{ name: 'Consult', cost: 50 }] });
  billF.tenantId = 'tenant_nyaho'; await store.bills.insert(billF);
  const vF = await verification.createForBill(billF);
  a((vF.channelsSent || []).length === 0, 'nyaho never enabled channels, so nothing is dispatched');
  a(vF.otpCode === undefined || vF.otpCode === null, 'no OTP generated when channels are off');

  console.log(f ? `\nSMS/WHATSAPP VERIFICATION CHECK: ${f} FAILURE(S) ABOVE` : '\nSMS/WHATSAPP VERIFICATION CHECK: ALL PASSED');
  if (f) process.exitCode = 1;
}

main().then(() => dashboardCheck()).then(() => reissueOverrideCheck()).then(() => smsWhatsappVerificationCheck())
  .catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(1); });
