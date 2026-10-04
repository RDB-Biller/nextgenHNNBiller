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
 *
 * `body` is a plain string for an ordinary text message — every caller in
 * this codebase today. Africa's Talking's WhatsApp adapter additionally
 * accepts a handful of richer shapes (media, template, interactive buttons/
 * list) for whenever a caller wants them — see sendViaAfricasTalking's own
 * comment below for the exact shapes.
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
 * Africa's Talking — SMS and WhatsApp.
 *
 * SMS is high confidence (confirmed against the official Python SDK's own
 * source: POST {base}/version1/messaging, header `apiKey: <key>`, form body
 * username/to/message/from, sandbox app -> api.sandbox.africastalking.com,
 * else api.africastalking.com). creds: { apiKey, username, from?, waNumber? }.
 *
 * WhatsApp is now implemented, confirmed against Africa's Talking's own
 * WhatsApp API reference (supplied directly rather than guessed — the gap
 * the comment here used to flag): POST
 * https://chat.africastalking.com/whatsapp/message/send, header
 * `apikey: <key>`, JSON body { username, waNumber, phoneNumber, body }.
 * waNumber is the account's own WhatsApp-enabled sender number, set once in
 * Master Control — separate from the SMS `from` sender ID, since the two
 * products use different sender identities. `body` on send() stays a plain
 * string for an ordinary text message, matching every existing caller.
 * Pass an object instead to reach the richer message types the API also
 * offers (nothing in this codebase uses these yet, but the shapes are
 * confirmed and ready for whenever something does):
 *   { mediaType: 'Image' | 'Video', url, caption? }            - media message
 *   { templateId, headerValue?, bodyValues?: [...] }           - template message
 *   { buttons: [{ id, title }, ...], text, header?, footer? }  - interactive buttons
 *   { list: { button, sections: [...] }, text, header?, footer? } - interactive list
 * The supplied API reference shows request shapes only, no example success
 * response body, so sendAfricasTalkingWhatsApp (below) trusts the HTTP
 * status for ok/fail and extracts a message id on a best-effort basis, the
 * same posture sendViaHubtel already takes for the same reason. And like
 * Hubtel, this environment's egress is allowlisted to package registries and
 * GitHub only, so this has been built and tested against the documented
 * request shape but not exercised against a real AT account from here — see
 * README "SMS / WhatsApp verification".
 */
async function sendViaAfricasTalking(creds, { channel, to, body }) {
  const { apiKey, username, from, waNumber } = creds || {};
  if (!apiKey || !username) return { ok: false, error: 'provider_credentials_incomplete' };
  if (channel === 'whatsapp') return sendAfricasTalkingWhatsApp({ apiKey, username, waNumber }, { to, body });
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
 * Maps this codebase's generic `body` (a plain string, or one of the rich
 * shapes documented on sendViaAfricasTalking above) onto the exact `body`
 * object Africa's Talking's WhatsApp API expects for each message kind.
 * Returns null for a shape that matches none of the documented variants, so
 * the caller fails cleanly instead of sending something the API would
 * reject.
 */
function mapWhatsAppBody(body) {
  if (typeof body === 'string') return { message: body };
  if (!body || typeof body !== 'object') return null;
  if (body.mediaType) {
    if (!body.url) return null;
    return { url: body.url, mediaType: body.mediaType, ...(body.caption ? { caption: body.caption } : {}) };
  }
  if (body.templateId) {
    return {
      templateId: body.templateId,
      ...(body.headerValue !== undefined ? { headerValue: body.headerValue } : {}),
      ...(body.bodyValues ? { bodyValues: body.bodyValues } : {}),
    };
  }
  if (body.buttons) {
    return {
      action: { buttons: body.buttons },
      body: { text: body.text },
      ...(body.header ? { header: { text: body.header } } : {}),
      ...(body.footer ? { footer: { text: body.footer } } : {}),
    };
  }
  if (body.list) {
    return {
      action: body.list,
      body: { text: body.text },
      ...(body.header ? { header: { text: body.header } } : {}),
      ...(body.footer ? { footer: { text: body.footer } } : {}),
    };
  }
  return null;
}

/** See sendViaAfricasTalking's own comment above for the confirmed request shape. */
async function sendAfricasTalkingWhatsApp({ apiKey, username, waNumber }, { to, body }) {
  if (!waNumber) return { ok: false, error: 'provider_sender_not_configured' };
  const mapped = mapWhatsAppBody(body);
  if (!mapped) return { ok: false, error: 'invalid_whatsapp_body' };
  const json = JSON.stringify({ username, waNumber, phoneNumber: to, body: mapped });
  let res;
  try {
    res = await _request('https://chat.africastalking.com/whatsapp/message/send', {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'content-type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
      },
      body: json,
    });
  } catch (e) { return { ok: false, error: e.message || 'network_error' }; }
  let parsed = {};
  try { parsed = JSON.parse(res.body || '{}'); } catch (_e) { /* non-JSON error page */ }
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, providerMessageId: parsed.id || parsed.messageId || null, sentAt: new Date().toISOString() };
  }
  return { ok: false, error: parsed.message || parsed.error || parsed.description || `africastalking_whatsapp_http_${res.status}` };
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
 *   'supported'   — implemented, confirmed against stable public docs
 *                   (Twilio; Africa's Talking, once its own WhatsApp API
 *                   reference was supplied directly)
 *   'unverified'  — the provider offers it, but this codebase couldn't confirm
 *                   the request shape from public docs; sending returns a
 *                   clear error rather than guessing (no provider wired in
 *                   today needs this label, but it's here for the next one)
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
    label: "Africa's Talking", whatsapp: 'supported',
    fields: [
      { name: 'username', label: 'Username ("sandbox" for a trial app)', secret: false },
      { name: 'apiKey', label: 'API Key', secret: true },
      { name: 'from', label: 'SMS sender ID (optional)', secret: false, optional: true },
      { name: 'waNumber', label: 'WhatsApp sender number, e.g. +254711XXXYYY (optional — only needed for WhatsApp sends)', secret: false, optional: true },
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
  if (own?.useOwnCredentials && own.encrypted && own.provider) {
    return { provider: own.provider, creds: credentials.decrypt(own.encrypted), source: 'tenant' };
  }
  const platformAccount = await messagingAccount.resolve();
  return platformAccount ? { ...platformAccount, source: 'platform_test_account' } : null;
}

/**
 * channel: 'sms' | 'whatsapp'. Never throws for an expected/operational
 * reason (no recipient, nothing configured, provider rejection) — callers
 * treat messaging as best-effort and must not let a send failure block
 * billing or verification.
 */
async function send({ channel, to, body, tenant } = {}) {
  if (!to) return { ok: false, error: 'no_recipient' };
  // A rich (object) body only means anything to the WhatsApp adapters that
  // document one (Africa's Talking — see its own comment above); catching a
  // mismatched shape here, before dispatch, means a caller mistake fails
  // clearly in every mode (sandbox or live) instead of silently stringifying
  // an object into a provider's plain-text field.
  const richBody = body !== null && typeof body === 'object';
  const bodyForLog = () => (richBody ? JSON.stringify(body) : body);
  if (richBody && channel !== 'whatsapp') return { ok: false, error: 'rich_body_requires_whatsapp' };
  if (await isSandbox()) {
    const providerMessageId = `SBX-MSG-${crypto.randomBytes(6).toString('hex')}`;
    const sentAt = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.log(`[messaging:sandbox] ${channel} -> ${to}: ${bodyForLog()}`);
    return { ok: true, sandbox: true, channel, providerMessageId, sentAt };
  }
  const resolved = await resolveSender(tenant);
  if (!resolved) {
    // Real sending is allowed on this deployment, but nothing usable is
    // configured yet (no tenant credentials, no active platform test
    // account) — log it the same way sandbox does so nothing downstream
    // breaks, but say plainly that nothing actually went out.
    // eslint-disable-next-line no-console
    console.log(`[messaging:unconfigured] ${channel} -> ${to}: ${bodyForLog()}`);
    return { ok: false, sandbox: false, channel, error: 'messaging_provider_not_configured' };
  }
  const adapter = ADAPTERS[resolved.provider];
  if (!adapter) return { ok: false, sandbox: false, channel, error: 'unknown_provider' };
  if (richBody && resolved.provider !== 'africastalking') {
    return { ok: false, sandbox: false, channel, error: 'rich_whatsapp_body_not_supported_by_provider' };
  }
  try {
    const r = await adapter(resolved.creds, { channel, to, body });
    return { ...r, channel, sandbox: false, source: resolved.source };
  } catch (e) {
    return { ok: false, sandbox: false, channel, error: e.message || 'provider_send_failed' };
  }
}

/**
 * Bulk SMS. Africa's Talking has a dedicated JSON endpoint
 * (POST /version1/messaging/bulk: { username, message, senderId?, phoneNumbers[] })
 * returning SMSMessageData.Recipients[] -- one request for the whole list
 * instead of N. Every other provider (and sandbox) is a per-recipient loop over
 * send(), so behaviour (sandbox/live, tenant vs platform credentials) is
 * identical to every other send in the product.
 * Returns { ok, results: [{ to, ok, providerMessageId?, error?, cost? }] }.
 */
async function sendBulkViaAfricasTalking(creds, { to, body }) {
  const { apiKey, username, from } = creds || {};
  if (!apiKey || !username) return { ok: false, error: 'provider_credentials_incomplete' };
  const sandboxAccount = String(username).toLowerCase() === 'sandbox';
  const base = sandboxAccount ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const payload = { username, message: body, phoneNumbers: to };
  if (from) payload.senderId = from;
  const json = JSON.stringify(payload);
  let res;
  try {
    res = await _request(`${base}/version1/messaging/bulk`, {
      method: 'POST',
      headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
      body: json,
    });
  } catch (e) { return { ok: false, error: e.message || 'network_error' }; }
  let parsed = null;
  try { parsed = JSON.parse(res.body || '{}'); } catch (_e) { /* non-JSON error body: never throw */ }
  const recipients = parsed?.SMSMessageData?.Recipients;
  if (!Array.isArray(recipients)) {
    return { ok: false, error: parsed?.SMSMessageData?.Message || (parsed ? '' : 'non_json_response_') + `africastalking_http_${res.status}` };
  }
  const byNumber = new Map(recipients.map((r) => [String(r.number), r]));
  return {
    ok: true,
    results: to.map((n) => {
      const r = byNumber.get(String(n));
      if (r && [100, 101, 102].includes(Number(r.statusCode))) {
        return { to: n, ok: true, providerMessageId: r.messageId, cost: r.cost || null };
      }
      return { to: n, ok: false, error: (r && r.status) || 'no_recipient_result' };
    }),
  };
}

async function sendBulk({ to, body, tenant } = {}) {
  const list = (Array.isArray(to) ? to : []).filter(Boolean);
  if (!list.length) return { ok: false, error: 'no_recipients', results: [] };
  if (typeof body !== 'string' || !body.trim()) return { ok: false, error: 'empty_message', results: [] };
  if (await isSandbox()) {
    const sentAt = new Date().toISOString();
    return { ok: true, sandbox: true, sentAt, results: list.map((n) => ({ to: n, ok: true,
      providerMessageId: `SBX-MSG-${crypto.randomBytes(6).toString('hex')}` })) };
  }
  const resolved = await resolveSender(tenant);
  if (!resolved) return { ok: false, sandbox: false, error: 'messaging_provider_not_configured', results: [] };
  const sentAt = new Date().toISOString();
  if (resolved.provider === 'africastalking') {
    const r = await sendBulkViaAfricasTalking(resolved.creds, { to: list, body });
    if (!r.ok) return { ok: false, sandbox: false, error: r.error, results: [] };
    return { ok: true, sandbox: false, sentAt, source: resolved.source, results: r.results };
  }
  const results = [];
  for (const n of list) {
    const r = await send({ channel: 'sms', to: n, body, tenant });
    results.push({ to: n, ok: !!r.ok, providerMessageId: r.providerMessageId, error: r.ok ? undefined : r.error });
  }
  return { ok: true, sandbox: false, sentAt, source: resolved.source, results };
}

module.exports = {
  sendBulk,
  send, genOtp, normalizePhone, resolveSender, isSandbox, PROVIDER_NAMES, PROVIDER_META,
  get PROVIDER() { return config.messaging.provider; },
  _setRequestImplForTests,
};
