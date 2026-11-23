'use strict';
/** Outgoing email through the Resend HTTP API (no extra packages). Set RESEND_API_KEY and EMAIL_FROM to turn it on. Never throws. */
const configured = () => !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
async function send({ to, subject, text }) {
  if (!configured()) return { ok: false, notConfigured: true, error: 'Email sending is not set up on this service.' };
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text }) });
    let j = {}; try { j = await r.json(); } catch { /* none */ }
    return r.ok ? { ok: true } : { ok: false, error: j.message || j.error || `The email service answered ${r.status}.` };
  } catch (e) { return { ok: false, error: `Could not reach the email service: ${e.message}` }; }
}
module.exports = { configured, send };
