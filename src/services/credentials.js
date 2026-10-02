'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * Third-party SMS/WhatsApp provider credentials (a Twilio Auth Token, an
 * Africa's Talking apiKey, a Hubtel clientSecret, ...) are the only real
 * third-party secrets this app ever stores in its own database. Everything
 * else secret (Stanbic bank credentials, the collection/messaging webhook
 * shared secrets) lives in env vars only — see config.js's own header
 * comment: "Everything secret comes from env vars." Letting a client "bring
 * its own" provider account, or the platform hold a shared test account,
 * breaks that rule unless the stored value is protected on its own terms —
 * so every credential blob saved here is encrypted at rest with a server-
 * held key (CREDENTIAL_ENCRYPTION_KEY, env-only, never in the database) and
 * is never echoed back in full by any API response. Callers only ever get
 * back mask()'d data: provider, whether something is configured, and a
 * last-4 hint — never the secret itself, once saved.
 *
 * If CREDENTIAL_ENCRYPTION_KEY isn't set, encrypt()/decrypt() throw rather
 * than silently falling back to storing plaintext.
 */

const ALGO = 'aes-256-gcm';

function keyBuffer() {
  const raw = config.credentialEncryptionKey;
  if (!raw) {
    const e = new Error('credential_encryption_not_configured');
    e.code = 'credential_encryption_not_configured';
    e.status = 422;
    throw e;
  }
  // Derive a fixed 32-byte key from whatever passphrase length is set, so
  // operators don't have to hand-generate an exact-length secret.
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

/** Encrypts a plain object (e.g. { accountSid, authToken, from }) to an opaque base64 blob. */
function encrypt(obj) {
  const key = keyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj || {}), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Reverses encrypt(). Returns null for a null/empty blob instead of throwing. */
function decrypt(blob) {
  if (!blob) return null;
  const key = keyBuffer();
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

/**
 * A short, one-way display hint ("…1234") so an admin can tell two saved
 * credentials apart in the UI without the secret ever being readable again.
 */
function hint(secret) {
  const s = String(secret || '');
  if (!s) return null;
  return s.length > 4 ? `…${s.slice(-4)}` : '…';
}

/** True if CREDENTIAL_ENCRYPTION_KEY is set, without exposing its value. */
function isConfigured() {
  return !!config.credentialEncryptionKey;
}

module.exports = { encrypt, decrypt, hint, isConfigured };
