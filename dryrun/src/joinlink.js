'use strict';
/**
 * One general join link for the whole team. An administrator copies it into any email or chat. Whoever opens it types their email (and
 * optionally their phone); Dry Run then sends THEIR OWN personal sign-in link by text and, when email sending is set up, by email.
 * The personal link is never shown on the page. For someone who is already a member it goes only to the email and phone on file, so a
 * stranger who knows an address cannot take over that account. Admins choose the role, allowed email domains, a cap and an expiry,
 * and can switch the link off or replace it at any time.
 */
const orgs = require('./orgs');
const reg = require('./registry');
const plans = require('./plans');
const audit = require('./audit');
const email = require('./email');
const messaging = require('./messaging');
const einv = require('./emailinvite');
const { err, iso, newKey } = require('./util');

const hits = new Map(); // key -> [timestamps]
function limit(key, max, ms) { const now = Date.now(); const h = (hits.get(key) || []).filter((t) => now - t < ms); if (h.length >= max) throw err(429, 'Too many tries. Please wait a little and try again.'); h.push(now); hits.set(key, h); }
const url = (site, orgId, tok) => `${site}/app?join=${encodeURIComponent(`${orgId}.${tok}`)}`;
const cleanDomains = (d) => [...new Set((Array.isArray(d) ? d : String(d || '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase().replace(/^@/, '')).filter((x) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)))].slice(0, 20);
const view = (o, site) => { const j = o.joinLink; return j && j.on ? { on: true, url: url(site, o.id, j.token), role: j.role, domains: j.domains || [], max: j.max || 0, joins: j.joins || 0, expiresAt: j.exp ? new Date(j.exp).toISOString() : null, expired: !!(j.exp && Date.now() > j.exp), emailReady: email.configured() } : { on: false, role: (j && j.role) || 'builder', domains: (j && j.domains) || [], max: (j && j.max) || 0, emailReady: email.configured() }; };

function get(orgId, site) { return view(orgs.raw(orgId), site); }
async function set(orgId, actor, site, b = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); plans.assertNotDemo(o, 'The general join link'); const prev = o.joinLink || {};
  if (b.off) { if (o.joinLink) o.joinLink.on = false; reg.save(); await audit.log(orgId, actor, 'team.join_link_off', {}); return view(o, site); }
  const role = b.role || prev.role || 'builder'; if (!orgs.ROLES.includes(role) || role === 'contributor') throw err(422, 'Choose admin, builder, approver or viewer.');
  const max = Math.max(0, Math.min(1000, parseInt(b.max, 10) || 0)); const days = Math.max(0, Math.min(365, parseInt(b.days, 10) || 0));
  o.joinLink = { on: true, token: b.rotate || !prev.token ? newKey('j').slice(2, 30) : prev.token, role, domains: cleanDomains(b.domains), max, joins: b.rotate ? 0 : prev.joins || 0, exp: days ? Date.now() + days * 86400000 : 0, at: iso(), by: actor.name };
  reg.save(); await audit.log(orgId, actor, b.rotate ? 'team.join_link_rotate' : 'team.join_link', { role, max, days }); return view(o, site);
}
function find(token) {
  const [orgId, tok] = String(token || '').split('.'); let o; try { o = orgs.raw(orgId); } catch { throw err(404, 'This join link is not valid. Ask for a new one.'); }
  const j = o.joinLink; if (!j || !j.on || !tok || tok !== j.token) throw err(404, 'This join link is not valid or has been switched off. Ask for a new one.');
  if (j.exp && Date.now() > j.exp) throw err(410, 'This join link has expired. Ask for a new one.');
  return { o, j };
}
function info(token) { const { o, j } = find(token); return { organisation: o.name, role: j.role, domains: j.domains || [], emailReady: email.configured(), full: !!(j.max && j.joins >= j.max) }; }

/**
 * Phone first, email optional, and no error messages: whatever the person typed, we reach them through what is usable and always answer
 * "on its way". Unusable details are quietly skipped. (Limits and rate limits still apply, silently for the person asking.)
 */
async function request(token, { email: em, phone, name } = {}, site, ip = '') {
  limit('ip:' + ip, 15, 3600000); const { o, j } = find(token); plans.assertWritable(o);
  const done = { ok: true };
  const ph = messaging.validPhone(String(phone || '')) ? String(phone).trim() : ''; const dial = ph ? messaging.toDialable(ph) : '';
  let e = String(em || '').trim().toLowerCase(); if (!einv.validEmail(e)) e = '';
  if (!ph && !e) return done;
  try { limit('c:' + (dial || e), 3, 3600000); } catch { return done; }
  const canEmail = email.configured(); if (!ph && !canEmail) return done; // nothing we could send with
  if (j.domains && j.domains.length && !(e && j.domains.includes(e.split('@')[1]))) return done;
  const members = Object.values(o.members);
  let m = members.find((x) => (e && x.email.toLowerCase() === e) || (dial && x.phone && messaging.toDialable(x.phone) === dial)); const existing = !!m;
  if (m && m.role === 'contributor') return done;
  if (!m) {
    if (j.max && (j.joins || 0) >= j.max) return done;
    const login = e || `${dial.replace(/\D/g, '')}@phone.join`;
    try { const a = orgs.addMember(o.id, { name: String(name || '').trim().slice(0, 60) || (e ? einv.nameFrom(e) : 'New teammate'), email: login, phone: ph, role: j.role }, 'Join link'); m = o.members[a.id]; } catch (x) { if (process.env.JL_DEBUG) console.log('addMember', x.message); return done; }
    m.mustChange = false; j.joins = (j.joins || 0) + 1;
  }
  const link = einv.issue(o.id, m, 'a join link', site); const first = m.name.split(' ')[0];
  const toPhone = existing ? m.phone : ph; // someone already in: only the contact we already hold
  const toEmail = existing ? (/@phone\.join$/.test(m.email) ? '' : m.email) : e;
  const text = `Hello ${first}, here is your personal Dry Run link for ${o.name}: ${link}\nIt works once and expires in 7 days. Only you should use it.`;
  if (toPhone) await messaging.deliver({ phone: toPhone, channels: { sms: true }, text, orgId: o.id, orgName: o.name, who: 'join link', purpose: 'join link', toName: m.name });
  if (canEmail && toEmail) { const s = await email.send({ to: toEmail, subject: `Your personal link to ${o.name} on Dry Run`, text: `${text}\n` }); messaging.record({ ok: s.ok, channel: 'email', to: toEmail, toName: m.name, orgId: o.id, orgName: o.name, who: 'join link', purpose: 'join link', text, ...(s.ok ? {} : { error: s.error }) }); }
  reg.save(); await audit.log(o.id, { id: m.id, name: m.name }, existing ? 'team.join_link_resend' : 'team.join_link_used', { role: m.role }); return done;
}
module.exports = { get, set, info, request };
