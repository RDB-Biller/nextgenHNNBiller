'use strict';
// Encrypts customer-supplied storage credentials at rest (AES-256-GCM). Set DRYRUN_SECRET_KEY in production.
const crypto = require('crypto');
const key = () => crypto.createHash('sha256').update(process.env.DRYRUN_SECRET_KEY || 'dryrun-dev-key-change-me').digest();
function seal(obj) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.'); }
function open(s) { const [iv, tag, enc] = String(s).split('.').map((x) => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8')); }
module.exports = { seal, open };
