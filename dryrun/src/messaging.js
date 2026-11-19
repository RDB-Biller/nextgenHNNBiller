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
async function deliver({ phone, channels, text, orgId, orgName, who, purpose, regarding }) {
  const to = toDialable(phone); const out = [];
  for (const ch of ['sms', 'whatsapp']) {
    if (!channels || !channels[ch]) continue;
    const res = !to ? { ok: false, error: 'That phone number does not look right. Use 024… or +233….' } : ch === 'sms' ? await sendSms(to, text) : await sendWhatsApp(to, text);
    logIt({ orgId, orgName, who, purpose, regarding: regarding || undefined, channel: ch, to: mask(phone), ok: res.ok, error: res.ok ? null : res.error }); out.push({ channel: ch, ok: res.ok, error: res.ok ? null : res.error });
  }
  return out;
}
const history = (orgId, limit = 100) => (reg.load().messages || []).filter((m) => !orgId || m.orgId === orgId).slice(0, limit);
const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
const tail = (inviteUrl, teamUrl) => `
Welcome aboard! Bring your colleagues in too. Share this link and they can ask to join your team: ${teamUrl}
Know another organisation that would love Dry Run? Invite them to try it free: ${inviteUrl}`;
/** Welcome message for an admin the platform owner appoints. */
const adminText = ({ name, org, username, password, url, adminUrl }) =>
  `Welcome to Dry Run, ${first(name)}. You are now admin of Dry Run for ${org}.\nUsername: ${username}\nPassword: ${password} (change it when you sign in)\nInterface: ${url}\nAdmin console: ${adminUrl}. You can add team mates by clicking on Team when you sign in and enter their mobile phone number and optionally email.`;
/** Welcome message for a teammate an admin adds. No admin console, no domain offer. */
const memberText = ({ name, by, org, role, username, password, url, inviteUrl, teamUrl }) =>
  `Hi ${first(name)}, ${by} added you to Dry Run for ${org} as ${role}.\nUsername: ${username}\nPassword: ${password} (change it when you sign in)\nSign in: ${url}` + tail(inviteUrl, teamUrl);
const surveyText = ({ org, url, inviteUrl }) => `${org} would like your views (2 minutes): ${url}\nGet Dry Run for your organisation: ${inviteUrl}`;
/** Short SMS that carries only the team-invite link; the person taps it and fills in their details to apply. */
const quickInviteText = ({ by, org, url }) => `${by} invites you to join the ${org} team on Dry Run. Tap to accept — you will enter a few details to join: ${url}`;
/** Team notifications. Every text carries a link back onto the platform. */
const teamTexts = {
  pending: ({ org, name, job, by, url }) => `Dry Run: ${name}${job ? ` (${job})` : ''} asked to join the ${org} team${by ? `, invited by ${by}` : ''}. Review and decide: ${url}`,
  addedLead: ({ org, name, role, actor, url }) => `Dry Run: ${actor} added ${name} to the ${org} team as ${role}. Their sign-in details were sent. Manage your team: ${url}`,
  declinedLead: ({ org, name, actor, url }) => `Dry Run: ${actor} declined ${name}'s request to join the ${org} team. See all requests: ${url}`,
  declinedApplicant: ({ name, org, reason, url }) => `Hi ${first(name)}, your request to join the ${org} team on Dry Run was not approved${reason ? `: ${reason}` : ''}. Please speak to your team admin if you think this is a mistake. Dry Run: ${url}`,
  addedInviter: ({ name, invitee, org, url, teamUrl }) => `Good news ${first(name)}: ${invitee}, who you invited, has been added to the ${org} team on Dry Run. Open the platform: ${url}${teamUrl ? `\nKeep the momentum. Invite more colleagues with your link: ${teamUrl}` : ''}`,
};
module.exports = { teamTexts, surveyText, quickInviteText, status, toDialable, validPhone, mask, deliver, history, adminText, memberText };
