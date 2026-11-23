'use strict';
/**
 * Outgoing email over an HTTP API (no extra packages). Set EMAIL_FROM plus either BREVO_API_KEY (free: 300 a day) or RESEND_API_KEY.
 * EMAIL_FROM may be "Dry Run <hello@yourdomain.com>" or just an address. Never throws.
 */
const provider = () => (!process.env.EMAIL_FROM ? null : process.env.BREVO_API_KEY ? 'brevo' : process.env.RESEND_API_KEY ? 'resend' : null);
const configured = () => !!provider();
function sender() { const f = String(process.env.EMAIL_FROM || '').trim(); const m = /^(.*?)\s*<([^>]+)>$/.exec(f); return m ? { name: m[1].replace(/^"|"$/g, '') || 'Dry Run', email: m[2].trim() } : { name: 'Dry Run', email: f }; }
async function send({ to, subject, text }) {
  const p = provider(); if (!p) return { ok: false, notConfigured: true, error: 'Email sending is not set up on this service.' };
  try {
    const r = p === 'brevo'
      ? await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sender: sender(), to: [{ email: to }], subject, textContent: text }) })
      : await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text }) });
    let j = {}; try { j = await r.json(); } catch { /* none */ }
    return r.ok ? { ok: true } : { ok: false, error: j.message || j.error || `The email service answered ${r.status}.` };
  } catch (e) { return { ok: false, error: `Could not reach the email service: ${e.message}` }; }
}
module.exports = { configured, provider, send };
