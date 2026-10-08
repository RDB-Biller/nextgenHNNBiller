'use strict';

const https = require('https');
const operatingMode = require('./operatingMode');

/**
 * Outbound email -- the missing half of "messaging".
 *
 * Until now the platform could text but not email: notify() wrote a log row
 * for every email-channel notification and nothing left the building. This is
 * a small, provider-agnostic transport over HTTPS JSON APIs (no SMTP, no new
 * dependency), configured by environment:
 *
 *   EMAIL_PROVIDER   resend | sendgrid
 *   EMAIL_API_KEY    the provider's API key (keep it in Railway Variables)
 *   EMAIL_FROM       a sender address the provider has verified
 *
 * It follows the SAME sandbox/live switch as SMS (Master Control -> operating
 * mode -> messaging): in sandbox an email is only logged, so enabling it never
 * surprises anyone. With nothing configured, send() says so plainly
 * ("email_provider_not_configured") instead of pretending it was delivered.
 *
 * Like messaging.send, it never throws for an operational failure -- email is
 * best-effort and must never block billing or a loan application.
 *
 * Not exercised against a real Resend/SendGrid account from the environment it
 * was written in (outbound network there is allowlisted); the request shapes
 * follow each provider's public docs and are covered by a mocked HTTP layer.
 */

const env = () => ({
  provider: String(process.env.EMAIL_PROVIDER || '').toLowerCase(),
  apiKey: process.env.EMAIL_API_KEY || '',
  from: process.env.EMAIL_FROM || '',
});

function httpRequest(url, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search || ''}`, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.setTimeout(12000, () => req.destroy(new Error('request_timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
let _request = httpRequest;
function _setRequestImplForTests(fn) { _request = fn || httpRequest; }

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;
const isEmail = (v) => typeof v === 'string' && EMAIL_RE.test(v.trim());

function configured() {
  const c = env();
  return !!(['resend', 'sendgrid'].includes(c.provider) && c.apiKey && c.from);
}

async function viaResend(c, { to, subject, text }) {
  const json = JSON.stringify({ from: c.from, to: [to], subject, text });
  const res = await _request('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    body: json,
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body || '{}'); } catch (_e) { /* non-JSON error page */ }
  if (res.status >= 200 && res.status < 300 && parsed.id) return { ok: true, providerMessageId: parsed.id };
  return { ok: false, error: parsed.message || `resend_http_${res.status}` };
}

async function viaSendgrid(c, { to, subject, text }) {
  const json = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }], from: { email: c.from }, subject,
    content: [{ type: 'text/plain', value: text }],
  });
  const res = await _request('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    body: json,
  });
  // SendGrid answers 202 with an empty body on success.
  if (res.status === 202 || res.status === 200) return { ok: true, providerMessageId: (res.headers && res.headers['x-message-id']) || null };
  let parsed = {};
  try { parsed = JSON.parse(res.body || '{}'); } catch (_e) { /* ignore */ }
  return { ok: false, error: parsed?.errors?.[0]?.message || `sendgrid_http_${res.status}` };
}

/** { to, subject, text } -> { ok, sandbox?, providerMessageId?, error? } -- never throws. */
async function send({ to, subject, text } = {}) {
  if (!isEmail(to)) return { ok: false, error: 'invalid_recipient_email' };
  if (!subject || !text) return { ok: false, error: 'empty_message' };
  if (await operatingMode.isMessagingSandbox()) {
    // eslint-disable-next-line no-console
    console.log(`[email:sandbox] -> ${to}: ${subject}`);
    return { ok: true, sandbox: true, sentAt: new Date().toISOString() };
  }
  if (!configured()) {
    // eslint-disable-next-line no-console
    console.log(`[email:unconfigured] -> ${to}: ${subject}`);
    return { ok: false, sandbox: false, error: 'email_provider_not_configured' };
  }
  const c = env();
  try {
    const r = c.provider === 'resend' ? await viaResend(c, { to: to.trim(), subject, text }) : await viaSendgrid(c, { to: to.trim(), subject, text });
    return { ...r, sandbox: false, sentAt: new Date().toISOString() };
  } catch (e) { return { ok: false, sandbox: false, error: e.message || 'email_send_failed' }; }
}

module.exports = { send, configured, isEmail, _setRequestImplForTests };
