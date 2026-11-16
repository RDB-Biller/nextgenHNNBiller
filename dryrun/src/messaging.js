'use strict';
/**
 * Sends sign-in details by SMS and WhatsApp through Africa's Talking (the same provider HNN Biller uses).
 * Set AT_API_KEY and AT_USERNAME (use "sandbox" to test). Optional: AT_SENDER_ID, AT_WA_NUMBER (your WhatsApp-enabled sender).
 * Every attempt is logged WITHOUT the message text, so keys never sit in the log.
 */
const reg = require('./registry');
const { iso } = require('./util');

const cfg = () => ({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME, from: process.env.AT_SENDER_ID, waNumber: process.env.AT_WA_NUMBER,
  smsUrl: process.env.AT_SMS_URL || (String(process.env.AT_USERNAME || '').toLowerCase() === 'sandbox' ? 'https://api.sandbox.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging'),
  waUrl: process.env.AT_WA_URL || 'https://chat.africastalking.com/whatsapp/message/send' });
const status = () => { const c = cfg(); return { sms: !!(c.apiKey && c.username), whatsapp: !!(c.apiKey && c.username && c.waNumber) }; };

/** Ghanaian numbers typed locally (024…) become +233…; international numbers pass through. */
function toDialable(raw) {
  const s = String(raw || '').trim(); if (!s) return '';
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  let d = s.replace(/\D/g, ''); if (d.startsWith('233')) d = d.slice(3); else if (d.startsWith('0')) d = d.slice(1); else return '+' + d;
  return d.length === 9 ? `+233${d}` : '';
}
const validPhone = (raw) => /^\+\d{8,15}$/.test(toDialable(raw));
const mask = (p) => { const d = toDialable(p); return d ? d.slice(0, 4) + '•••' + d.slice(-3) : ''; };

async function post(url, headers, body) {
  let r; try { r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(12000) }); } catch (e) { return { ok: false, error: e.message || 'network_error' }; }
  let j = {}; try { j = await r.json(); } catch {} return { r, j };
}
async function sendSms(to, text) {
  const c = cfg(); if (!c.apiKey || !c.username) return { ok: false, error: 'SMS is not set up on this service (AT_API_KEY and AT_USERNAME).' };
  const p = new URLSearchParams({ username: c.username, to, message: text }); if (c.from) p.set('from', c.from);
  const { r, j, ok, error } = await post(c.smsUrl, { apiKey: c.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, p.toString()); if (error) return { ok, error };
  const rec = j && j.SMSMessageData && j.SMSMessageData.Recipients && j.SMSMessageData.Recipients[0];
  if (r.ok && rec && /Success/i.test(rec.status || '')) return { ok: true };
  return { ok: false, error: (rec && rec.status) || (j.SMSMessageData && j.SMSMessageData.Message) || `Africa's Talking answered ${r.status}` };
}
async function sendWhatsApp(to, text) {
  const c = cfg(); if (!c.apiKey || !c.username || !c.waNumber) return { ok: false, error: 'WhatsApp is not set up on this service (AT_WA_NUMBER).' };
  const { r, j, ok, error } = await post(c.waUrl, { apikey: c.apiKey, 'content-type': 'application/json' }, JSON.stringify({ username: c.username, waNumber: c.waNumber, phoneNumber: to, body: { message: text } })); if (error) return { ok, error };
  return r.ok ? { ok: true } : { ok: false, error: j.message || j.error || j.description || `Africa's Talking WhatsApp answered ${r.status}` };
}
function logIt(entry) { const r = reg.load(); r.messages = r.messages || []; r.messages.unshift({ at: iso(), ...entry }); r.messages.length = Math.min(r.messages.length, 500); reg.save(); }

/** Send one message on the chosen channels. Returns one result per channel; never throws. */
async function deliver({ phone, channels, text, orgId, orgName, who, purpose }) {
  const to = toDialable(phone); const out = [];
  for (const ch of ['sms', 'whatsapp']) {
    if (!channels || !channels[ch]) continue;
    const res = !to ? { ok: false, error: 'That phone number does not look right. Use 024… or +233….' } : ch === 'sms' ? await sendSms(to, text) : await sendWhatsApp(to, text);
    logIt({ orgId, orgName, who, purpose, channel: ch, to: mask(phone), ok: res.ok, error: res.ok ? null : res.error }); out.push({ channel: ch, ok: res.ok, error: res.ok ? null : res.error });
  }
  return out;
}
const history = (orgId, limit = 100) => (reg.load().messages || []).filter((m) => !orgId || m.orgId === orgId).slice(0, limit);
const adminText = (org, url, key) => `Dry Run: you have been appointed admin of ${org}. Open ${url} and sign in with this key: ${key}  Keep it private. You can add your team from the Team page.`;
const memberText = (org, by, role, url, key) => `Dry Run: ${by} added you to ${org} as ${role}. Open ${url} and sign in with this key: ${key}  Keep it private.`;
module.exports = { status, toDialable, validPhone, mask, deliver, history, adminText, memberText };
