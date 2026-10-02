'use strict';

/**
 * Central configuration. Everything secret comes from env vars.
 * Never hardcode bank credentials in source (the sample Postman collection
 * shipped a live-looking password in plaintext — do not repeat that pattern).
 */
const config = {
  port: parseInt(process.env.PORT || '4000', 10),

  // When true, the SBG client returns deterministic mock responses instead of
  // calling Stanbic. Lets you run the whole platform with no bank creds.
  sandbox: process.env.SBG_SANDBOX !== 'false',

  sbg: {
    baseUrl: process.env.SBG_BASE_URL || 'https://api.marketplaceuat.stanbic.com.gh',
    // Marketplace gateway: '/api/sbg-transfer'. Direct smartapp host: '' (endpoints at /v1/...).
    pathPrefix: process.env.SBG_PATH_PREFIX != null ? process.env.SBG_PATH_PREFIX : '/api/sbg-transfer',
    username: process.env.SBG_USERNAME || '',
    password: process.env.SBG_PASSWORD || '',
    // Disbursements settle FROM this funding/wallet account on the platform side.
    // Source-account semantics depend on your Stanbic marketplace contract.
  },

  // Optional default routing of platform notifications. PHI should never leave
  // the platform over email/WhatsApp in production — see README "Compliance".
  notifications: {
    fallbackEmail: process.env.FALLBACK_EMAIL || 'hnnspprt@gmail.com',
  },

  // Outbound SMS/WhatsApp for patient bill verification (src/services/messaging.js).
  // No real provider is wired in — by design, until one is chosen (Twilio,
  // Africa's Talking, Hubtel, Meta's WhatsApp Cloud API, ...). Sandbox mode logs
  // the message instead of sending it, exactly like SBG_SANDBOX does for the bank
  // rail, so the whole opt-in/OTP/reply flow can be built and demoed without
  // real credentials or a real phone.
  messaging: {
    sandbox: process.env.MESSAGING_SANDBOX !== 'false',
    provider: process.env.MESSAGING_PROVIDER || 'sandbox',
    // Absolute origin used to build the link inside an SMS/WhatsApp body (unlike
    // the in-app notification feed and the hosted pages, a text message can't
    // rely on a relative path).
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://nextgenhnnbiller-production-bdf1.up.railway.app',
    webhookSecret: process.env.MESSAGING_WEBHOOK_SECRET || 'dev-secret',
    otpTtlMinutes: parseInt(process.env.VERIFICATION_OTP_TTL_MINUTES || '60', 10),
    otpMaxAttempts: parseInt(process.env.VERIFICATION_OTP_MAX_ATTEMPTS || '5', 10),
  },
};

module.exports = config;
