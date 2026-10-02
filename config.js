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
  // `sandbox` is the deployment-wide kill switch: while true (the default), every
  // send is logged, not dispatched, full stop — no credential configured anywhere
  // can override it. Set MESSAGING_SANDBOX=false to allow real sending on THIS
  // deployment at all; which credentials a given send actually uses is then
  // resolved per-tenant (messaging.js#resolveSender): a client's own provider
  // account (tenant.messagingCredentials, "bring your own", set from Master
  // Control) first, else the platform's own shared test account
  // (services/messagingAccount.js, activated/deactivated from Master Control),
  // else sandbox. Real provider credentials are never env vars — they're entered
  // through Master Control and stored encrypted (CREDENTIAL_ENCRYPTION_KEY below;
  // see services/credentials.js) because, unlike every other secret in this app,
  // they can't be known at deploy time for a client who hasn't signed up yet.
  messaging: {
    sandbox: process.env.MESSAGING_SANDBOX !== 'false',
    // Legacy/default provider name when nothing more specific is configured —
    // superseded in practice by whatever provider the resolved credential record
    // (tenant or platform test account) names.
    provider: process.env.MESSAGING_PROVIDER || 'sandbox',
    // Absolute origin used to build the link inside an SMS/WhatsApp body (unlike
    // the in-app notification feed and the hosted pages, a text message can't
    // rely on a relative path).
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://nextgenhnnbiller-production-bdf1.up.railway.app',
    webhookSecret: process.env.MESSAGING_WEBHOOK_SECRET || 'dev-secret',
    otpTtlMinutes: parseInt(process.env.VERIFICATION_OTP_TTL_MINUTES || '60', 10),
    otpMaxAttempts: parseInt(process.env.VERIFICATION_OTP_MAX_ATTEMPTS || '5', 10),
  },

  // Encrypts the one class of third-party secret this app stores in its own
  // database rather than an env var: real SMS/WhatsApp provider credentials
  // (see services/credentials.js). Unset means encrypt/decrypt simply refuse —
  // nothing is ever stored in plaintext as a fallback.
  credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || null,
};

module.exports = config;
