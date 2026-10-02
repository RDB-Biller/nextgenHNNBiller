'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * Generic, swappable SMS/WhatsApp gateway. No real provider is wired in today —
 * by design (see README "Patient verification by SMS/WhatsApp"): this runs in
 * sandbox mode until MESSAGING_PROVIDER names a real adapter and its credentials
 * are set, exactly like the Stanbic SBG integration runs under SBG_SANDBOX until
 * live bank credentials are supplied. In sandbox, a send is logged (and handed
 * back to the caller) instead of dispatched over the network, so the whole
 * opt-in / OTP / two-way-reply flow can be built, tested and demoed with no
 * provider account and no real phone.
 *
 * Swapping in a real provider (Twilio, Africa's Talking, Hubtel, Meta's WhatsApp
 * Cloud API, ...) only touches the `send()` branch below and the inbound-payload
 * parsing in routes/webhooks.js — nothing else in the codebase knows or cares
 * which one is in use.
 */
const SANDBOX = config.messaging.sandbox || config.messaging.provider === 'sandbox';

function genOtp() {
  // 6 digits, zero-padded — never starts with a letter, easy to read back over a
  // call, 1-in-a-million collision odds within the short TTL window.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Keep only digits, then compare the last 9 — a Ghanaian subscriber number
 * without its leading 0 or country code — so "0241234567", "+233241234567",
 * "233241234567" and a provider's "whatsapp:+233241234567" all resolve to the
 * same patient regardless of which format the clinic typed in or the channel
 * echoed back on an inbound reply.
 */
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.slice(-9);
}

/**
 * channel: 'sms' | 'whatsapp'. Never throws for an expected/operational reason
 * (no recipient, provider not configured) — callers treat messaging as
 * best-effort and must not let a send failure block billing or verification.
 */
async function send({ channel, to, body }) {
  if (!to) return { ok: false, error: 'no_recipient' };
  if (SANDBOX) {
    const providerMessageId = `SBX-MSG-${crypto.randomBytes(6).toString('hex')}`;
    const sentAt = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.log(`[messaging:sandbox] ${channel} -> ${to}: ${body}`);
    return { ok: true, sandbox: true, channel, providerMessageId, sentAt };
  }
  // A real adapter goes here once one is chosen. Left unimplemented on purpose
  // rather than guessing a provider's request shape; see README for the seam.
  return { ok: false, error: 'messaging_provider_not_configured' };
}

module.exports = { send, genOtp, normalizePhone, SANDBOX, get PROVIDER() { return config.messaging.provider; } };
