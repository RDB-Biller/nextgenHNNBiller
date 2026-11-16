'use strict';
/** Usernames, temporary passwords (stored only as salted scrypt hashes), and short-lived sign-in sessions. */
const crypto = require('crypto');
const ALPHA = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const genPassword = (n = 10) => Array.from(crypto.randomBytes(n), (b) => ALPHA[b % ALPHA.length]).join('');
function hashPassword(pw) { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`; }
function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored || '').split('$'); if (!salt || !hash) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32); const b = Buffer.from(hash, 'hex'); return b.length === h.length && crypto.timingSafeEqual(b, h);
}
const slug = (s, n) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')[0].slice(0, n || 12) || 'user';
function makeUsername(name, orgName, taken) {
  const base = `${slug(name, 14)}.${slug(orgName, 12)}`; let u = base, i = 2; while (taken.has(u)) u = `${base}${i++}`; return u;
}
const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'live.com', 'proton.me', 'protonmail.com', 'aol.com']);
/** dryrun.<their domain> if the admin's email is on a company domain. */
function subdomainHint(email) { const d = String(email || '').split('@')[1]; return d && !FREE_MAIL.has(d.toLowerCase()) && /\./.test(d) ? `dryrun.${d.toLowerCase()}` : null; }
function passwordProblem(pw) { if (String(pw || '').length < 10) return 'Use at least 10 characters.'; if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number.'; return null; }
module.exports = { genPassword, hashPassword, verifyPassword, makeUsername, subdomainHint, passwordProblem };
