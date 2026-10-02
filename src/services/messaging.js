'use strict';
const crypto = require('crypto');
const https = require('https');
const config = require('../config');
const credentials = require('./credentials');
const messagingAccount = require('./messagingAccount');
const operatingMode = require('./operatingMode');

/**
 * Generic, swappable SMS/WhatsApp gateway. `send()` is the single seam: every
 * caller in this codebase goes through it and never knows or cares which
 * provider ends up handling a given message.
 *
 * The Messaging rail's sandbox/live state is a runtime switch controlled by
 * Master Control (services/operatingMode.js) — MESSAGING_SANDBOX only seeds
 * its starting value the first time it's read with nothing saved yet; once
 * Master Control has saved anything there, that record governs. While it's
 * sandboxed, nothing is ever dispatched for real, no matter what's configured
 * underneath. Once it's live, each send resolves its own credentials per
 * tenant (see resolveSender): a client's own "bring your own" provider
 * account first (tenant.messagingCredentials, set from Master Control), else
 * the platform's shared test account (services/messagingAccount.js,
 * activated/deactivated from Master Control), else it logs instead of
 * sending — the exact same safety net sandbox mode always provided, just
 * reached for a different reason (nothing configured yet, rather than the
 * rail being sandboxed).
 *
 * Three real adapters are wired in: Twilio, Africa's Talking, Hubtel. Their
 * confidence levels differ — see each function's own comment and the
 * "SMS / WhatsApp verification" section of README.md — because this
 * environment's egress is allowlisted to package registries and GitHub only,
 * so none of the three has been exercised against a real account from here.
 * Adding a fourth provider only means adding one function and a line in
 * ADAPTERS; nothing else in the codebase changes.
 */
async function isSandbox() { return operatingMode.isMessagingSandbox(); }

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

// ---------------------------------------------------------------------------
// HTTP transport — a tiny wrapper so adapters don't each reimplement it, and
// tests can substitute a fake instead of reaching the real network.
// ---------------------------------------------------------------------------

function httpRequest(url, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search || ''}`,
      method, headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Test-only seam (see test/smoke suite) — never used by a real code path.
let _request = httpRequest;
function _setRequestImplForTests(fn) { _request = fn || httpRequest; }

// ---------------------------------------------------------------------------
// Provider adapters. Each takes decrypted creds + { channel, to, body } and
// returns { ok, providerMessageId?, sentAt?, error? } — never throws for an
// ordinary send failure (bad creds, provider rejection); messaging is always
// best-effort and must never block billing or verification.
// ---------------------------------------------------------------------------

/**
 * Twilio — high confidence. The Messages resource is Twilio's oldest, most
 * stable API; SMS and WhatsApp share the exact same endpoint and only differ
 * by a "whatsapp:" prefix on From/To. creds: { accountSid, authToken, from,
 * whatsappFrom? } — whatsappFrom falls back to `from` if not set separately
 * (useful once out of the WhatsApp sandbox, where the two numbers differ).
 */
async function sendViaTwilio(creds, { channel, to, body }) {
  const { accountSid, authToken } = creds || {};
  if (!accountSid || !authToken) return { ok: false, error: 'provider_credentials_incomplete' };
  const isWa = channel === 'whatsapp';
  const rawFrom = isWa ? (creds.whatsappFrom || creds.from) : creds.from;
  if (!rawFrom) return { ok: false, error: 'provider_sender_not_configured' };
  const From = isWa && !String(rawFrom).startsWith('whatsapp:') ? `whatsapp:${rawFrom}` : rawFrom;
  const To = isWa && !String(to).startsWith('whatsapp:') ? `whatsapp:${to}` : to;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const form = new URLSearchParams({ To, From, Body: body }).toString();
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  let res;
  try {
    res = await _request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form),
        Authorization: `Basic ${auth}`,
      },
      body: form,
    });
  } catch (e) { return { ok: false, error: e.message || 'network_error' }; }
  let parsed = {};
  try { parsed = JSON.parse(res.body || '{}'); } catch (_e) { /* non-JSON error page */ }
  if (res.status >= 200 && res.status < 300 && parsed.sid) {
    return { ok: true, providerMessageId: parsed.sid, sentAt: new Date().toISOString() };
  }
  return { ok: false, error: parsed.message || `twilio_http_${res.status}` };
}

/**
 * Africa's Talking — SMS is high confidence (confirmed against the official
 * Python SDK's own source: POST {base}/version1/messaging, header
 * `apiKey: <key>`, form body username/to/message/from, sandbox app ->
 * api.sandbox.africastalking.com, else api.africastalking.com). creds:
 * { apiKey, username, from? }.
 *
 * WhatsApp is NOT implemented. Africa's Talking does offer a WhatsApp
 * product, but this codebase could not confirm its request shape from
 * public documentation (it reads as newer/less stable than their SMS API,
 * and may need separate product activation on the account). Rather than
 * guess an endpoint that would silently fail against a real account, this
 * returns a clear, honest error instead — see README.
 */
async function sendViaAfricasTalking(creds, { channel, to, body }) {
  if (channel === 'whatsapp') return { ok: false, error: 'provider_whatsapp_not_verified' };
  const { apiKey, username, from } = creds || {};
  if (!apiKey || !username) return { ok: false, error: 'provider_credentials_incomplete' };
  const sandboxAccount = String(username).toLowerCase() === 'sandbox';
  const base = sandboxAccount ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const params = { username, to, message: body };
  if (from) params.from = from;
  const form = new URLSearchParams(params).toString();
  let res;
  try {
    res = await _request(`${base}/version1/messaging`, {
      method: 'POST',
      headers: {
        apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form),
      },
      body: form,
    });
  } catch (e) { return { ok: false, error: e.message || 'network_error' }; }
  let parsed = {};
  try { parsed = JSON.parse(res.body || '{}'); } catch (_e) { /* ignore */ }
  const recipient = parsed?.SMSMessageData?.Recipients?.[0];
  if (res.status >= 200 && res.status < 300 && recipient && /Success/i.test(recipient.status || '')) {
    return { ok: true, providerMessageId: recipient.messageId, sentAt: new Date().toISOString() };
  }
  return { ok: false, error: (recipient && recipient.status) || parsed?.SMSMessageData?.Message || `africastalking_http_${res.status}` };
}

/**
 * Hubtel — medium-high confidence for SMS (confirmed Basic Auth scheme —
 * base64 of clientId:clientSecret — and the POST /v1/messages/send JSON
 * shape {From,To,Content} from Hubtel's own docs; the exact domain,
 * sms.hubtel.com, is well triangulated but not independently confirmed from
 * this environment, so treat it as "verify once you have a real account"
 * rather than certain). creds: { clientId, clientSecret, from }.
 *
 * WhatsApp is NOT offered by Hubtel as far as this codebase could find —
 * they publish SMS, USSD and mobile-money/payments products, no WhatsApp
 * Business API. Returns a clear error rather than pretending otherwise.
 */
async function sendViaHubtel(creds, { channel, to, body }) {
  if (channel === 'whatsapp') return { ok: false, error: 'provider_whatsapp_not_supported' };
  const { clientId, clientSecret, from } = creds || {};
  if (!clientId || !clientSecret || !from) return { ok: false, error: 'provider_credentials_incomplete' };
  const payload = JSON.stringify({ From: from, To: to, Content: body });
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let res;
  try {
    res = await _request('https://sms.hubtel.com/v1/messages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Basic ${auth}`,
      },
      body: payload,
    });
  } catch (e) { return { ok: false, error: e.message || 'network_error' }; }
  let parsed = {};
  try { parsed = JSON.parse(res.body || '{}'); } catch (_e) { /* ignore */ }
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, providerMessageId: parsed.MessageId || parsed.messageId || null, sentAt: new Date().toISOString() };
  }
  return { ok: false, error: parsed.Message || parsed.message || `hubtel_http_${res.status}` };
}

const ADAPTERS = { twilio: sendViaTwilio, africastalking: sendViaAfricasTalking, hubtel: sendViaHubtel };
const PROVIDER_NAMES = Object.keys(ADAPTERS);

/**
 * Drives both the credential-entry form (Master Control) and an honest
 * confidence/availability label per provider+channel — see each sendVia*
 * function's own comment for why. `whatsapp` is one of:
 *   'supported'   — implemented, confirmed against stable public docs (Twilio)
 *   'unverified'  — the provider offers it, but this codebase couldn't confirm
 *                   the request shape from public docs; sending returns a
 *                   clear error rather than guessing (Africa's Talking)
 *   'unsupported' — the provider doesn't offer WhatsApp at all (Hubtel)
 */
const PROVIDER_META = {
  twilio: {
    label: 'Twilio', whatsapp: 'supported',
    fields: [
      { name: 'accountSid', label: 'Account SID', secret: false },
      { name: 'authToken', label: 'Auth Token', secret: true },
      { name: 'from', label: 'SMS sender number', secret: false },
      { name: 'whatsappFrom', label: 'WhatsApp sender number (optional — defaults to the SMS number)', secret: false, optional: true },
    ],
  },
  africastalking: {
    label: "Africa's Talking", whatsapp: 'unverified',
    fields: [
      { name: 'username', label: 'Username ("sandbox" for a trial app)', secret: false },
      { name: 'apiKey', label: 'API Key', secret: true },
      { name: 'from', label: 'Sender ID (optional)', secret: false, optional: true },
    ],
  },
  hubtel: {
    label: 'Hubtel', whatsapp: 'unsupported',
    fields: [
      { name: 'clientId', label: 'Client ID', secret: false },
      { name: 'clientSecret', label: 'Client Secret', secret: true },
      { name: 'from', label: 'Sender ID', secret: false },
    ],
  },
};

/**
 * Which credentials a send for this tenant should actually use, decrypted —
 * or null if nothing usable is configured (caller falls back to logging).
 * Tenant's own "bring your own" setup wins when it's turned on and
 * configured; otherwise the platform's shared test account, if active.
 */
async function resolveSender(tenant) {
  const own = tenant?.messagingCredentials;
  // eslint-disable-next-line no-console
  console.log(`[messaging:debug] resolveSender: checking tenant credentials (useOwn=${!!own?.useOwnCredentials}, hasEncrypted=${!!own?.encrypted}, provider=${own?.provider || 'none'})`);
  if (own?.useOwnCredentials && own.encrypted && own.provider) {
    // eslint-disable-next-line no-console
    console.log(`[messaging:debug] resolveSender: using tenant credentials, provider=${own.provider}`);
    return { provider: own.provider, creds: credentials.decrypt(own.encrypted), source: 'tenant' };
  }
  // eslint-disable-next-line no-console
  console.log('[messaging:debug] resolveSender: calling messagingAccount.resolve()');
  const platformAccount = await messagingAccount.resolve();
  // eslint-disable-next-line no-console
  console.log(`[messaging:debug] resolveSender: platform account ${platformAccount ? `resolved, provider=${platformAccount.provider}` : 'not available'}`);
  return platformAccount ? { ...platformAccount, source: 'platform_test_account' } : null;
}

/**
 * channel: 'sms' | 'whatsapp'. Never throws for an expected/operational
 * reason (no recipient, nothing configured, provider rejection) — callers
 * treat messaging as best-effort and must not let a send failure block
 * billing or verification.
 */
async function send({ channel, to, body, tenant } = {}) {
  // eslint-disable-next-line no-console
  console.log(`[messaging:debug] send() called: channel=${channel}, to=${to}`);
  if (!to) return { ok: false, error: 'no_recipient' };
  const sandboxed = await isSandbox();
  // eslint-disable-next-line no-console
  console.log(`[messaging:debug] mode: ${sandboxed ? 'sandboxed' : 'live'}`);
  if (sandboxed) {
    const providerMessageId = `SBX-MSG-${crypto.randomBytes(6).toString('hex')}`;
    const sentAt = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.log(`[messaging:sandbox] ${channel} -> ${to}: ${body}`);
    return { ok: true, sandbox: true, channel, providerMessageId, sentAt };
  }
  const resolved = await resolveSender(tenant);
  if (!resolved) {
    // Real sending is allowed on this deployment, but nothing usable is
    // configured yet (no tenant credentials, no active platform test
    // account) — log it the same way sandbox does so nothing downstream
    // breaks, but say plainly that nothing actually went out.
    // eslint-disable-next-line no-console
    console.log(`[messaging:unconfigured] ${channel} -> ${to}: ${body}`);
    return { ok: false, sandbox: false, channel, error: 'messaging_provider_not_configured' };
  }
  // eslint-disable-next-line no-console
  console.log(`[messaging:debug] using provider=${resolved.provider}, source=${resolved.source}`);
  const adapter = ADAPTERS[resolved.provider];
  if (!adapter) {
    // eslint-disable-next-line no-console
    console.log(`[messaging:debug] error: unknown_provider (${resolved.provider})`);
    return { ok: false, sandbox: false, channel, error: 'unknown_provider' };
  }
  try {
    const r = await adapter(resolved.creds, { channel, to, body });
    // eslint-disable-next-line no-console
    console.log(`[messaging:debug] result: ok=${!!r.ok}${r.error ? `, error=${r.error}` : ''}`);
    return { ...r, channel, sandbox: false, source: resolved.source };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[messaging:debug] error: ${e.message || 'provider_send_failed'}`);
    return { ok: false, sandbox: false, channel, error: e.message || 'provider_send_failed' };
  }
}

module.exports = {
  send, genOtp, normalizePhone, resolveSender, isSandbox, PROVIDER_NAMES, PROVIDER_META,
  get PROVIDER() { return config.messaging.provider; },
  _setRequestImplForTests,
};
