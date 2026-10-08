'use strict';

const crypto = require('crypto');
const store = require('../store');
const config = require('../config');
const messaging = require('./messaging');
const metricsLibrary = require('./metricsLibrary');
const observations = require('./observations');

/**
 * Patient self-report, phase 2 of the Product Development Environment's
 * clinical-indicator intake (see services/observations.js for the full list
 * of sources). This is the piece that makes "manual_patient" and
 * "patient_sms" possible: a lightweight, OTP-verified binding of a phone
 * number to one payer+member, good for the self-entry web portal
 * (routes/clinicalPortal.js) and for attributing inbound SMS/WhatsApp
 * readings (routes/webhooks.js) to the right member with no bill or EMR feed
 * in play.
 *
 * Deliberately NOT a password/session system: requesting a link always
 * (re-)issues a fresh OTP challenge, and only a *confirmed* code mints a
 * bearer token (`activeToken`) — returned exactly once, in the confirm
 * response, the same discipline services/credentials.js applies to secrets.
 * A clinic can also kick this off on a patient's behalf during a visit
 * (routes/clinical.js, createdBy:'hospital') — the patient still has to
 * confirm the code themselves before anything can be submitted.
 *
 * This is the one place in the app that accepts clinical data over SMS —
 * directly in tension with the "no PHI over SMS/WhatsApp" stance elsewhere
 * (README "Before production"). The OTP gate is this feature's version of
 * the same explicit opt-in `includeTreatmentDetail` already uses for bill-
 * verification texts: nothing is accepted from a number until its holder has
 * proven they hold it, and STOP always works, immediately, from anyone.
 */

const TYPE_CONDITION = { blood_pressure: 'hypertension', hba1c: 'diabetes', ldl: 'dyslipidemia' };
const LOCKED_MSG = 'Too many wrong codes. Ask the clinic, or request a fresh code on the web portal.';
const EXPIRED_MSG = 'That code has expired. Request a fresh one from the clinic or the web portal.';

function err(status, message, detail) {
  const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e;
}

/** A 4-8 digit run in the reply text — same shape verification.js looks for. */
function looksLikeCode(text) {
  const digits = String(text || '').replace(/\D/g, '');
  return digits.length >= 4 && digits.length <= 8 ? digits : null;
}

/**
 * A condition-specific metric type (BP/HbA1c/LDL) always tags itself — a
 * reading means the same thing regardless of which program the patient
 * happens to be linked under. Only the condition-agnostic counters
 * (complication, followup_visit) fall back to the link's own `condition`,
 * which is why that field matters for a patient who'll ever text those in.
 */
function conditionForType(type, link) {
  return TYPE_CONDITION[type] || link.condition || null;
}

/**
 * Recognises a clinical check-in SMS/WhatsApp message. Returns
 * `{kind:'command', command}`, `{kind:'reading', type, value?, systolic?,
 * diastolic?}`, or null when the text doesn't match anything here at all
 * (the caller then tries it as a bill-verification reply instead — see
 * handleInboundReply below and routes/webhooks.js).
 *
 * Deliberately a short list of keyword-led, number-only formats rather than
 * free text: easy for a patient to learn, unambiguous to parse, and safe to
 * log/audit. A fourth clinical keyword only ever means adding one line here.
 */
function parseClinicalMessage(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^stop$/i.test(t)) return { kind: 'command', command: 'STOP' };
  if (/^help$/i.test(t)) return { kind: 'command', command: 'HELP' };

  let m = t.match(/^(?:bp|blood\s*pressure)\s+(\d{2,3})\s*(?:\/|-|\s)\s*(\d{2,3})\b/i);
  if (m) return { kind: 'reading', type: 'blood_pressure', systolic: Number(m[1]), diastolic: Number(m[2]) };
  m = t.match(/^(?:bp|blood\s*pressure)\s+(\d{2,3})\b/i);
  if (m) return { kind: 'reading', type: 'blood_pressure', systolic: Number(m[1]), diastolic: null };

  m = t.match(/^(?:hba1c|a1c)\s+(\d{1,2}(?:\.\d{1,2})?)/i);
  if (m) return { kind: 'reading', type: 'hba1c', value: Number(m[1]) };

  m = t.match(/^ldl\s+(\d{2,3}(?:\.\d{1,2})?)/i);
  if (m) return { kind: 'reading', type: 'ldl', value: Number(m[1]) };

  if (/^complication\b/i.test(t)) return { kind: 'reading', type: 'complication' };
  if (/^(?:followup|follow-up|follow up|visit)\b/i.test(t)) return { kind: 'reading', type: 'followup_visit' };
  if (/^screening\b/i.test(t)) return { kind: 'reading', type: 'screening_completed' };
  if (/^(?:wellness|spa)\b/i.test(t)) return { kind: 'reading', type: 'wellness_visit' };

  return null;
}

function confirmationText(parsed) {
  if (parsed.type === 'blood_pressure') {
    return `Got it — BP ${parsed.systolic}${parsed.diastolic != null ? `/${parsed.diastolic}` : ''} recorded. Thank you.`;
  }
  if (parsed.type === 'hba1c') return `Got it — HbA1c ${parsed.value}% recorded. Thank you.`;
  if (parsed.type === 'ldl') return `Got it — LDL ${parsed.value} recorded. Thank you.`;
  if (parsed.type === 'complication') return 'Recorded — sorry to hear that. Your care team may follow up.';
  if (parsed.type === 'followup_visit') return 'Thanks — follow-up visit recorded.';
  if (parsed.type === 'screening_completed') return 'Thanks — screening completion recorded.';
  if (parsed.type === 'wellness_visit') return 'Thanks — wellness visit recorded.';
  return 'Recorded. Thank you.';
}

/**
 * (Re-)issue an OTP challenge binding `phone` to `payerId`+`memberId`. Safe
 * to call repeatedly: an existing row for the exact same phone+payer+member
 * (pending OR already active) is reused and re-challenged with a fresh code
 * rather than piling up duplicates — the same flow covers first-time
 * enrollment, a lost/forgotten bearer token, and a new device. Until the
 * fresh code is confirmed, any previous `activeToken` stops working.
 */
async function request({ payerId, memberId, phone, condition, tenantId, createdBy, channel } = {}) {
  if (!payerId) throw err(422, 'payerId_required');
  if (!memberId) throw err(422, 'memberId_required');
  if (!phone) throw err(422, 'phone_required');
  if (condition != null && !metricsLibrary.CONDITIONS.some((c) => c.id === condition)) {
    throw err(422, 'invalid_condition', `must be one of ${metricsLibrary.CONDITIONS.map((c) => c.id).join(', ')}`);
  }
  const payer = await store.payers.get(payerId);
  if (!payer) throw err(404, 'unknown_payer');
  const phoneNormalized = messaging.normalizePhone(phone);
  if (!phoneNormalized || phoneNormalized.length < 7) throw err(422, 'invalid_phone');

  const mine = (l) => l.payerId === payerId && l.memberId === String(memberId);
  const existing = [
    ...(await store.clinicalLinks.listActiveByPhone(phoneNormalized)),
    ...(await store.clinicalLinks.listPendingByPhone(phoneNormalized)),
  ].find(mine);

  const link = existing || {
    id: `clk_${crypto.randomBytes(8).toString('hex')}`,
    payerId, memberId: String(memberId), condition: condition || null,
    createdAt: new Date().toISOString(), consentedAt: null, lastUsedAt: null, revokedAt: null,
    createdBy: createdBy || 'patient_web', tenantId: tenantId || null, channelsSent: [],
    activeToken: null,
  };
  link.phone = phone;
  link.phoneNormalized = phoneNormalized;
  if (condition) link.condition = condition;
  link.status = 'pending';
  link.activeToken = null; // a fresh challenge invalidates any previous bearer token immediately
  link.otpCode = messaging.genOtp();
  link.otpExpiresAt = new Date(Date.now() + config.messaging.otpTtlMinutes * 60000).toISOString();
  link.otpAttempts = 0;
  link.otpLocked = false;

  const sendChannel = channel === 'whatsapp' ? 'whatsapp' : 'sms';
  const body = `HNN Biller: your code to confirm clinical check-ins by text is ${link.otpCode}. `
    + 'Reply with this code, or enter it on the page. Ignore this if you did not request it.';
  // A hospital-initiated link texts through that hospital's own sender when it has one.
  const tenant = link.tenantId ? await store.tenants.get(link.tenantId).catch(() => null) : null;
  const r = await messaging.send({ channel: sendChannel, to: phone, body, tenant });
  link.channelsSent = r.ok ? [sendChannel] : [];
  if (!r.ok) link.lastSendError = r.error || null; else delete link.lastSendError;

  await (existing ? store.clinicalLinks.update(link) : store.clinicalLinks.insert(link));
  return link;
}

/** Re-send a fresh code for a still-pending link (web "resend" button). */
async function resend(linkId) {
  const link = await store.clinicalLinks.get(linkId);
  if (!link) throw err(404, 'link_not_found');
  if (link.status !== 'pending') throw err(409, `link_not_pending: ${link.status}`);
  return request({
    payerId: link.payerId, memberId: link.memberId, phone: link.phone,
    condition: link.condition, tenantId: link.tenantId, createdBy: link.createdBy,
  });
}

/** Pure outcome, never throws — used by both the web confirm route and the SMS handler. */
async function finalizeLinkCode(link, code) {
  if (link.status === 'revoked') {
    return { outcome: 'revoked', link, reply: 'This check-in was opted out. Start again on the web portal.' };
  }
  if (link.status === 'active') return { outcome: 'already_active', link, reply: "You're already confirmed." };
  if (link.otpLocked) return { outcome: 'locked', link, reply: LOCKED_MSG };
  if (!link.otpExpiresAt || new Date(link.otpExpiresAt) < new Date()) {
    return { outcome: 'expired', link, reply: EXPIRED_MSG };
  }
  if (String(code || '') !== String(link.otpCode)) {
    link.otpAttempts = (link.otpAttempts || 0) + 1;
    if (link.otpAttempts >= config.messaging.otpMaxAttempts) link.otpLocked = true;
    await store.clinicalLinks.update(link);
    return {
      outcome: link.otpLocked ? 'locked' : 'wrong_code', link,
      reply: link.otpLocked ? LOCKED_MSG : 'That code is not right. Check the message and try again.',
    };
  }
  link.status = 'active';
  link.consentedAt = new Date().toISOString();
  link.activeToken = crypto.randomBytes(18).toString('base64url');
  link.otpCode = null;
  link.otpExpiresAt = null;
  link.lastUsedAt = new Date().toISOString();
  await store.clinicalLinks.update(link);
  return {
    outcome: 'confirmed', link,
    reply: 'Thanks — confirmed. You can now text in readings any time, e.g. "BP 130/85". Reply STOP to opt out.',
  };
}

/** Web route backing function — throws with an HTTP status, unlike finalizeLinkCode. */
async function confirmById(linkId, code) {
  const link = await store.clinicalLinks.get(linkId);
  if (!link) throw err(404, 'link_not_found');
  const result = await finalizeLinkCode(link, code);
  if (result.outcome === 'confirmed' || result.outcome === 'already_active') return result.link;
  const statusByOutcome = { wrong_code: 422, locked: 423, expired: 410, revoked: 409 };
  throw err(statusByOutcome[result.outcome] || 422, result.outcome, result.reply);
}

/** Record one observation against an already-active link (web portal or SMS). */
async function recordForLink(link, input = {}, source = 'manual_patient') {
  const condition = conditionForType(input.type, link);
  const o = await observations.recordManual(
    {
      payerId: link.payerId, memberId: link.memberId, condition, type: input.type,
      value: input.value, systolic: input.systolic, diastolic: input.diastolic,
      unit: input.unit, note: input.note, recordedAt: input.recordedAt,
    },
    { source, recordedBy: { linkId: link.id } },
  );
  link.lastUsedAt = new Date().toISOString();
  await store.clinicalLinks.update(link);
  return o;
}

/** All active/pending links for a phone revoked at once — the universal STOP. */
async function revokeByPhone(phoneNormalized) {
  const links = [
    ...(await store.clinicalLinks.listActiveByPhone(phoneNormalized)),
    ...(await store.clinicalLinks.listPendingByPhone(phoneNormalized)),
  ];
  if (!links.length) return false;
  for (const l of links) {
    l.status = 'revoked';
    l.revokedAt = new Date().toISOString();
    l.activeToken = null;
    l.otpCode = null;
    await store.clinicalLinks.update(l);
  }
  return true;
}

/**
 * One inbound SMS/WhatsApp message, tried BEFORE bill verification (routes/
 * webhooks.js). Returns null for anything that isn't clinical-shaped, or
 * that is but has no matching link for this phone — the caller then falls
 * through to verification.handleInboundReply completely unchanged, so a
 * phone that has never touched this feature sees zero behaviour change.
 */
async function handleInboundReply({ from, text, channel }) {
  const phoneNormalized = messaging.normalizePhone(from);
  const parsed = parseClinicalMessage(text);

  if (parsed?.kind === 'command' && parsed.command === 'STOP') {
    const revoked = await revokeByPhone(phoneNormalized);
    return {
      outcome: revoked ? 'revoked' : 'no_match', link: null,
      reply: revoked
        ? 'You will no longer receive or be able to submit clinical check-ins by text.'
        : "We don't have an active clinical check-in for this number.",
    };
  }

  if (parsed?.kind === 'reading') {
    const active = await store.clinicalLinks.listActiveByPhone(phoneNormalized);
    const link = active[0];
    if (!link) return null; // not enrolled — let verification.js have the message instead
    const obs = await recordForLink(link, parsed, 'patient_sms');
    return { outcome: 'recorded', link, observation: obs, reply: confirmationText(parsed) };
  }

  if (parsed?.kind === 'command' && parsed.command === 'HELP') {
    const active = await store.clinicalLinks.listActiveByPhone(phoneNormalized);
    if (!active.length) return null; // don't advertise the feature to a number that never opted in
    return {
      outcome: 'help', link: active[0],
      reply: 'Clinical check-in: text e.g. "BP 130/85", "HBA1C 6.8", "LDL 110", "COMPLICATION", or "FOLLOWUP". Reply STOP to opt out.',
    };
  }

  const code = looksLikeCode(text);
  if (code) {
    const pending = await store.clinicalLinks.listPendingByPhone(phoneNormalized);
    const match = pending.find((l) => l.otpCode === code);
    if (match) return finalizeLinkCode(match, code);
    // No exact match. Only count this as a WRONG clinical attempt (and so only
    // apply to it) when clinical is the one unambiguous thing this phone could be
    // replying to — exactly one clinical link pending, and no bill verification
    // pending at all. Otherwise defer entirely to verification.js, which applies
    // this same "exactly one candidate" rule to ITS OWN pending set — so a wrong
    // guess always counts against lockout somewhere, never silently nowhere, and
    // never against the wrong flow when only one flow is actually in play.
    if (pending.length === 1) {
      const otherPending = await store.verifications.listPendingByPhone(phoneNormalized);
      if (!otherPending.length) return finalizeLinkCode(pending[0], code);
    }
  }
  return null; // not clinical-shaped, or ambiguous/no pending link — try bill verification next
}

module.exports = {
  request, resend, confirmById, recordForLink, revokeByPhone, handleInboundReply,
  parseClinicalMessage, conditionForType,
};
