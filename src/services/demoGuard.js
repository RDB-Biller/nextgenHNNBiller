'use strict';

/**
 * Guard rails for the demo experience (the public dummy login and any "evaluator" account).
 * They explore the real screens but cannot hurt or leak anything:
 *   - every visitor works on a private scratch copy (see store.scratchFor): their changes show for them alone and never reach real data;
 *   - nothing goes out: messages, money movement and AI calls are simulated inside a scratch copy;
 *   - secrets (keys, tokens, passwords, hook URLs) are removed from everything they are sent;
 *   - phone numbers and email addresses are masked.
 */
const SECRET_KEY = /(api[-_]?key|apikey|secret|token|password|passwd|hash|credential|authorization|bearer|private|signing|hook|^key$|_key$)/i;
const PHONE_KEY = /(phone|mobile|msisdn|whatsapp)/i;
const MASK = '••••••••';
const maskPhone = (s) => { const d = String(s); return d.length <= 4 ? d : `${'•'.repeat(Math.max(0, d.replace(/\s/g, '').length - 4))}${d.replace(/\s/g, '').slice(-4)}`; };
const maskEmail = (s) => String(s).replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1•••@$2');

function clean(v, key) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => clean(x, key));
  if (typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = clean(x, k); return o; }
  if (typeof v === 'string') {
    if (key && SECRET_KEY.test(key) && v) return MASK;
    if (key && PHONE_KEY.test(key) && /\d{6,}/.test(v)) return maskPhone(v);
    if (/^\+?\d{9,15}$/.test(v.replace(/[\s()-]/g, '')) && /^[+0]/.test(v.trim())) return maskPhone(v);
    if (v.includes('@')) return maskEmail(v);
    if (/\/erheat-hooks\/[A-Za-z0-9]+/.test(v)) return v.replace(/\/erheat-hooks\/[A-Za-z0-9]+/g, '/erheat-hooks/••••');
  }
  return v;
}
const DEMO_NOTE = 'Demo mode: this is your private practice copy. Your own account works on real data.';
module.exports = { clean, DEMO_NOTE, MASK };
