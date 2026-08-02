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
};

module.exports = config;
