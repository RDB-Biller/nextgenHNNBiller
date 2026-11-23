'use strict';
/**
 * Invite by email link. An administrator enters email addresses; each person gets a personal link. Opening it signs them straight in (no
 * username or password to type) and then asks for their mobile number and a password of their own. Links work once and expire after 7 days.
 * Opening a link only shows who it is for; signing in needs a deliberate click, so mail scanners that open links cannot use it up.
 * If email sending is not set up, the links are returned so they can be shared by hand, with a ready-made mailto: for each.
 */
const orgs = require('./orgs');
const reg = require('./registry');
const plans = require('./plans');
const audit = require('./audit');
const email = require('./email');
const messaging = require('./messaging');
const creds = require('./creds');
const { err, iso, sha, newKey } = require('./util');

const TTL = 7 * 86400000, MAX = 20;
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 160;
const nameFrom = (e) => e.split('@')[0].replace(/[._+-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim().slice(0, 60) || 'Teammate';
const link = (site, orgId, mid, tok) => `${site}/app?invite=${encodeURIComponent(`${orgId}.${mid}.${tok}`)}`;
function parse(token) {
  const [orgId, mid, tok] = String(token || '').split('.'); let o; try { o = orgs.raw(orgId); } catch { throw err(404, 'This invite link is not valid. Ask for a new one.'); }
  const m = o.members[mid]; if (!m || !m.emailInvite || !tok || sha(tok) !== m.emailInvite.hash) throw err(404, 'This invite link is not valid. Ask for a new one.');
  return { o, m };
}
function body({ name, org, role, by, url, note }) {
  return `Hello ${name.split(' ')[0]},\n\n${by} has invited you to join ${org} on Dry Run as ${role === 'admin' ? 'an admin' : `a ${role}`}.${note ? `\n\n"${note}"` : ''}\n\nOpen this link to sign in. There is no password to type; you will be asked for your mobile number, and to choose a password for next time:\n${url}\n\nThe link works once and expires in 7 days.\n`;
}
async function invite(orgId, actor, site, { emails, role = 'builder', note = '' } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); plans.assertNotDemo(o, 'Email invites');
  const list = [...new Set((Array.isArray(emails) ? emails : String(emails || '').split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))]; if (!list.length) throw err(422, 'Enter at least one email address.'); if (list.length > MAX) throw err(422, `Up to ${MAX} at a time.`);
  if (!orgs.ROLES.includes(role) || role === 'contributor') throw err(422, 'Choose admin, builder, approver or viewer.');
  const out = [];
  for (const e of list) {
    if (!validEmail(e)) { out.push({ email: e, ok: false, problem: 'That does not look like an email address.' }); continue; }
    try {
      let m = Object.values(o.members).find((x) => x.email.toLowerCase() === e);
      if (m && m.role === 'contributor') { out.push({ email: e, ok: false, problem: 'That is the platform seat.' }); continue; }
      if (!m) { const a = orgs.addMember(orgId, { name: nameFrom(e), email: e, role }, `${actor.name} (email invite)`); m = o.members[a.id]; m.mustChange = false; }
      const tok = newKey('i').slice(2, 34); m.emailInvite = { hash: sha(tok), exp: Date.now() + TTL, at: iso(), by: actor.name }; reg.save();
      const url = link(site, orgId, m.id, tok); const subject = `${actor.name} invited you to ${o.name} on Dry Run`; const text = body({ name: m.name, org: o.name, role: m.role, by: actor.name, url, note: String(note || '').slice(0, 300) });
      const sent = await email.send({ to: e, subject, text });
      messaging.record({ ok: sent.ok, channel: 'email', to: e, toName: m.name, orgId, orgName: o.name, who: 'invite', purpose: 'email invite', text: text.replace(url, '[sign-in link hidden]'), ...(sent.ok ? {} : { error: sent.error }) });
      out.push({ email: e, ok: true, name: m.name, role: m.role, link: url, emailed: sent.ok, emailProblem: sent.ok ? null : sent.notConfigured ? null : sent.error, mailto: `mailto:${e}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`, expires: new Date(Date.now() + TTL).toISOString() });
    } catch (x) { out.push({ email: e, ok: false, problem: x.message }); }
  }
  await audit.log(orgId, actor, 'team.email_invite', { count: out.filter((x) => x.ok).length }); return { results: out, emailReady: email.configured() };
}
function info(token) { const { o, m } = parse(token); if (m.emailInvite.usedAt) throw err(410, 'This link has already been used. Sign in as usual, or ask for a new link.'); if (Date.now() > m.emailInvite.exp) throw err(410, 'This link has expired. Ask for a new one.'); return { organisation: o.name, name: m.name, email: m.email, role: m.role, invitedBy: m.emailInvite.by }; }
function accept(token) {
  const { o, m } = parse(token); const i = info(token); m.emailInvite.usedAt = iso(); m.mustChange = false; m.passwordPending = true; m.joinedAt = m.joinedAt || iso(); const key = orgs.openSession(o.id, m.id); reg.save();
  return { key, ...i, needsPhone: !m.phone };
}
/** Make a fresh personal sign-in link for an existing member (used by the general join link). */
function issue(orgId, m, byName, site) { const tok = newKey('i').slice(2, 34); m.emailInvite = { hash: sha(tok), exp: Date.now() + TTL, at: iso(), by: byName }; reg.save(); return link(site, orgId, m.id, tok); }
module.exports = { invite, info, accept, validEmail, issue, nameFrom };
