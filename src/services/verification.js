'use strict';

const crypto = require('crypto');
const store = require('../store');
const config = require('../config');
const messaging = require('./messaging');
const { notifyPatientVerification, notifyVerificationOutcome } = require('./notifications');

/**
 * Patient bill verification — a secure-link "portal" record, one per bill, in the
 * same shape as claims/reports. Created unconditionally the moment a bill exists so
 * the patient can confirm the charges are correct. This never blocks or delays bill
 * creation or routing; a payer that has opted into `requirePatientVerification`
 * (see services/claims.js authorize()) is the only place this record's status is
 * ever enforced, and only at the point of authorising the A2A transfer.
 *
 * By default the patient only gets the link (in the in-app notification feed
 * today — see services/notifications.js). A clinic can additionally turn on real
 * SMS and/or WhatsApp delivery (tenant.verificationChannels, set from Master
 * Control) so the patient gets a text too, with a one-time code they can reply
 * with instead of opening the link — see `dispatchChannels` and
 * `handleInboundReply` below.
 */
async function createForBill(bill) {
  const phone = bill.patient?.phone || null;
  const v = {
    id: `vfy_${crypto.randomBytes(8).toString('hex')}`,
    billId: bill.id, tenantId: bill.tenantId,
    status: 'pending', // pending -> verified | disputed
    token: crypto.randomBytes(24).toString('base64url'),
    patientName: bill.patient?.name || null,
    provider: bill.provider,
    amount: bill.totals?.net ?? null, currency: bill.currency,
    phone, phoneNormalized: phone ? (messaging.normalizePhone(phone) || null) : null,
    channelsSent: [],
    createdAt: new Date().toISOString(),
    verifiedAt: null, disputedAt: null, disputeReason: null,
  };
  v.link = `/verify/?token=${v.token}`;
  await store.verifications.insert(v);
  await notifyPatientVerification(v, bill);
  const tenant = bill.tenantId ? await store.tenants.get(bill.tenantId) : null;
  if (tenant) await dispatchChannels(v, bill, tenant);
  return v;
}

const getByToken = (token) => store.verifications.byToken(token);
const forBill = (billId) => store.verifications.byBill(billId);

async function confirm(id, { via } = {}) {
  const v = await store.verifications.get(id);
  if (!v) { const e = new Error('verification_not_found'); e.status = 404; throw e; }
  if (v.status !== 'pending') { const e = new Error(`verification_not_pending: ${v.status}`); e.status = 409; throw e; }
  v.status = 'verified';
  v.verifiedAt = new Date().toISOString();
  v.verifiedBy = 'patient';
  v.verifiedVia = via || 'web'; // 'web' | 'sms' | 'whatsapp'
  v.otpCode = null; v.otpExpiresAt = null; // burn the code once it's done its job
  await store.verifications.update(v);
  return v;
}

/**
 * Re-send the SAME verification link — for the hospital ("resend to patient" on the
 * billing screen) or the payer (when their dashboard shows it's still pending). A
 * disputed record gets reset to pending first, so the patient gets a fresh look —
 * useful once the hospital has corrected whatever they flagged. If SMS/WhatsApp
 * channels are on for this clinic, this also sends a FRESH code — the old one
 * stops working the moment this runs (see dispatchChannels).
 *
 * `opts` passes straight through to dispatchChannels — see its own comment.
 * Omit it for the plain "resend" button (tenant's configured default
 * channels, patient's phone on file); pass `{ channels, to }` for an explicit
 * one-channel, admin-triggered send.
 */
async function reissue(id, opts = {}) {
  const v = await store.verifications.get(id);
  if (!v) { const e = new Error('verification_not_found'); e.status = 404; throw e; }
  if (v.status === 'verified') { const e = new Error('verification_not_pending: verified'); e.status = 409; throw e; }
  if (v.status === 'disputed') { v.status = 'pending'; v.disputedAt = null; v.disputeReason = null; }
  v.remindersSent = (v.remindersSent || 0) + 1;
  v.lastRemindedAt = new Date().toISOString();
  await store.verifications.update(v);
  const bill = await store.bills.get(v.billId);
  if (bill) {
    await notifyPatientVerification(v, bill);
    const tenant = bill.tenantId ? await store.tenants.get(bill.tenantId) : null;
    if (tenant || opts.channels) await dispatchChannels(v, bill, tenant, opts);
  }
  return v;
}

/**
 * The PAYER marks a bill verified without the patient having used their own link —
 * they looked at the claim themselves, called the hospital, or the member already
 * had a prior approval on file (pass priorApprovalId; the caller is responsible for
 * validating it belongs to them and matches the member before calling this). Kept
 * to a single verification record per bill, same as everywhere else in this feature —
 * on a split bill routed to more than one payer, one payer's override (like the
 * patient's own confirm) satisfies the shared bill-level record for all of them.
 */
async function overrideVerify(id, { by, reason, priorApprovalId } = {}) {
  const v = await store.verifications.get(id);
  if (!v) { const e = new Error('verification_not_found'); e.status = 404; throw e; }
  if (v.status === 'verified') { const e = new Error('verification_not_pending: verified'); e.status = 409; throw e; }
  v.status = 'verified';
  v.verifiedAt = new Date().toISOString();
  v.verifiedBy = priorApprovalId ? 'prior_approval' : 'payer_override';
  v.overrideReason = reason ? String(reason).slice(0, 300) : null;
  v.overridePriorApprovalId = priorApprovalId || null;
  v.overrideByPayerId = by || null;
  v.disputedAt = null; v.disputeReason = null;
  v.otpCode = null; v.otpExpiresAt = null;
  await store.verifications.update(v);
  return v;
}

async function dispute(id, reason) {
  const v = await store.verifications.get(id);
  if (!v) { const e = new Error('verification_not_found'); e.status = 404; throw e; }
  if (v.status !== 'pending') { const e = new Error(`verification_not_pending: ${v.status}`); e.status = 409; throw e; }
  v.status = 'disputed';
  v.disputedAt = new Date().toISOString();
  v.disputeReason = reason || null;
  await store.verifications.update(v);
  const bill = await store.bills.get(v.billId);
  if (bill) await notifyVerificationOutcome(v, bill, 'disputed');
  return v;
}

// ---------------------------------------------------------------------------
// SMS / WhatsApp delivery (optional, opt-in per clinic) + the two-way reply
// ---------------------------------------------------------------------------

/** First few line-item names, for clinics that opt into itemised texts (see below). */
function treatmentSummary(bill) {
  const names = (bill.lineItems || []).map((i) => i.name).filter(Boolean);
  if (!names.length) return '';
  const shown = names.slice(0, 4).join(', ');
  return names.length > 4 ? `${shown} + ${names.length - 4} more` : shown;
}

/**
 * tenant.verificationChannels.includeTreatmentDetail defaults OFF on purpose:
 * this codebase's own compliance note (README "Before production" #3) is "No
 * PHI over email/WhatsApp — notifications carry references and links only."
 * Line-item names (drug names, procedures) are exactly the kind of detail that
 * note warns about, since SMS/WhatsApp are unencrypted and visible to anyone
 * with the patient's phone. The capability is here because it was asked for,
 * but a clinic has to consciously turn it on per bill-of-rights/consent in
 * their own context rather than get it by default.
 */
function buildMessageBody(bill, v, { includeTreatmentDetail }) {
  const amount = `${bill.currency} ${(bill.totals?.net ?? 0).toFixed(2)}`;
  const items = includeTreatmentDetail ? treatmentSummary(bill) : '';
  const what = items ? ` for ${items}` : '';
  const link = `${config.messaging.publicBaseUrl}${v.link}`;
  return `${bill.provider}: bill of ${amount}${what}. Reply YES or ${v.otpCode} to confirm you received `
    + `treatment, or see details / dispute: ${link}`;
}

/**
 * Generates a fresh OTP, sends it (and the link) over every channel this
 * tenant has turned on, and records what went out. Best-effort: a messaging
 * failure never throws past this point (see messaging.send docstring) — the
 * link-based flow keeps working regardless.
 *
 * `opts.channels`, when given, overrides tenant.verificationChannels entirely
 * — a staff member explicitly picking "send via WhatsApp" for one message
 * should do exactly that, regardless of what the clinic has pre-configured as
 * its default. `opts.to` likewise overrides the recipient for this one send
 * only; it is never persisted onto the verification record.
 */
async function dispatchChannels(v, bill, tenant, opts = {}) {
  const channels = opts.channels || tenant?.verificationChannels || {};
  const wantSms = !!channels.sms;
  const wantWhatsapp = !!channels.whatsapp;
  if (!wantSms && !wantWhatsapp) return v;
  const phone = opts.to || v.phone;
  if (!phone) return v;

  v.otpCode = messaging.genOtp();
  v.otpExpiresAt = new Date(Date.now() + config.messaging.otpTtlMinutes * 60000).toISOString();
  v.otpAttempts = 0;
  v.otpLocked = false;

  const body = buildMessageBody(bill, v, { includeTreatmentDetail: !!channels.includeTreatmentDetail });
  v.lastMessageBody = body; // kept for support/audit ("what did we actually tell this patient?")
  const sent = [];
  if (wantSms) {
    const r = await messaging.send({ channel: 'sms', to: phone, body, tenant });
    if (r.ok) { sent.push('sms'); v.smsSentAt = r.sentAt; v.smsMessageId = r.providerMessageId; v.smsError = null; }
    else v.smsError = r.error || null;
  }
  if (wantWhatsapp) {
    const r = await messaging.send({ channel: 'whatsapp', to: phone, body, tenant });
    if (r.ok) { sent.push('whatsapp'); v.whatsappSentAt = r.sentAt; v.whatsappMessageId = r.providerMessageId; v.whatsappError = null; }
    else v.whatsappError = r.error || null;
  }
  v.channelsSent = sent;
  await store.verifications.update(v);
  return v;
}

const LOCKED_MSG = 'Too many wrong codes. Ask the clinic or payer to resend your verification message.';
const EXPIRED_MSG = 'That code has expired. Ask the clinic or payer to resend your verification message.';
const YES_WORDS = new Set(['YES', 'Y', 'CONFIRM', 'CONFIRMED', 'OK', 'OKAY']);

/** A 4-8 digit run in the reply text, treated as an OTP guess. Null otherwise. */
function looksLikeCode(text) {
  const digits = String(text || '').replace(/\D/g, '');
  return digits.length >= 4 && digits.length <= 8 ? digits : null;
}

async function finalizeCodeMatch(v, channel) {
  if (v.otpLocked) return { outcome: 'locked', verification: v, reply: LOCKED_MSG };
  if (!v.otpExpiresAt || new Date(v.otpExpiresAt) < new Date()) {
    return { outcome: 'expired', verification: v, reply: EXPIRED_MSG };
  }
  const confirmed = await confirm(v.id, { via: channel });
  return { outcome: 'confirmed', verification: confirmed, reply: `Thanks — confirmed. Ref ${confirmed.billId}.` };
}

async function recordWrongCode(v) {
  if (v.otpLocked) return { outcome: 'locked', verification: v, reply: LOCKED_MSG };
  v.otpAttempts = (v.otpAttempts || 0) + 1;
  if (v.otpAttempts >= config.messaging.otpMaxAttempts) v.otpLocked = true;
  await store.verifications.update(v);
  return {
    outcome: v.otpLocked ? 'locked' : 'wrong_code', verification: v,
    reply: v.otpLocked ? LOCKED_MSG : 'That code is not right. Check the message and try again, or use the link.',
  };
}

/**
 * Handles one inbound SMS/WhatsApp reply. Deliberately scoped to confirming —
 * there's no reply-to-dispute path (free text is too unreliable to capture a
 * dispute reason from); a patient who wants to flag a problem uses the link.
 *
 * Matching rule (the reason OTP exists at all): a bare "YES" only confirms
 * when exactly one verification is pending for that phone number — with two
 * visits in flight for the same patient, "yes" alone can't say which one they
 * mean, so a specific code is required instead. A code is checked against
 * that phone's pending verifications only (never across phone numbers), so
 * confirming one patient's bill always takes something only they received.
 */
async function handleInboundReply({ from, text, channel }) {
  const phoneNormalized = messaging.normalizePhone(from);
  const replyText = String(text || '').trim();
  const upper = replyText.toUpperCase();
  const candidates = phoneNormalized ? await store.verifications.listPendingByPhone(phoneNormalized) : [];

  const codeGuess = looksLikeCode(replyText);
  if (codeGuess) {
    const match = candidates.find((v) => v.otpCode === codeGuess);
    if (match) return finalizeCodeMatch(match, channel);
    if (candidates.length === 1) return recordWrongCode(candidates[0]);
    return {
      outcome: 'no_match', verification: null,
      reply: "We couldn't match that code to a bill. Check the message for the right one, or use the link.",
    };
  }

  if (YES_WORDS.has(upper)) {
    if (candidates.length === 0) {
      return { outcome: 'no_match', verification: null, reply: "We don't have a bill awaiting your confirmation right now." };
    }
    if (candidates.length > 1) {
      return {
        outcome: 'ambiguous', verification: null,
        reply: `You have ${candidates.length} bills awaiting confirmation — reply with the code from the specific message instead of YES.`,
      };
    }
    const confirmed = await confirm(candidates[0].id, { via: channel });
    return { outcome: 'confirmed', verification: confirmed, reply: `Thanks — confirmed. Ref ${confirmed.billId}.` };
  }

  return {
    outcome: 'unrecognized', verification: null,
    reply: 'Reply YES or the code from your verification message to confirm, or use the link we sent you.',
  };
}

module.exports = {
  createForBill, getByToken, forBill, confirm, dispute, reissue, overrideVerify,
  handleInboundReply,
};
