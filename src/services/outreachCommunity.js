'use strict';

/**
 * Community layer of the outreach engine: the "army of fans" that fills the gaps the team cannot.
 *
 *  - contributions: anyone identifies themselves, gives a public source and a contact for an organisation or one of its
 *    offices. It waits in a review queue; the operator opens the source, verifies, and approves or rejects. Approved
 *    contacts carry their provenance (who found it, where, who verified, when) and credit the contributor's referral code.
 *  - the gap board: organisations in a group with no contact yet, so contributors know where help is needed.
 *  - the invite widget API: "do you know anyone who should explore this platform?" with an identified referrer.
 *  - Ghana healthcare group, multinational offices for held geographies, channel status and test sends.
 */
const crypto = require('crypto');
const store = require('../store');
const outreach = require('./outreach');
const email = require('./email');
const messaging = require('./messaging');
const countries = require('../data/countries');
const ghana = require('../data/ghanaHealthSeed');
const groupOffices = require('../data/groupOffices');

const X = outreach._x;
const { err, rid, now, normName } = X;
const SUB = 'out:sub:';
const URL_RE = /^https?:\/\/[^\s]+\.[^\s]+$/i;
const PHONE_SPLIT = /[,;\n]+/;

// --------------------------------------------------------------- owner alerts
/** Tell the operator something needs attention. FormSubmit (EMAIL notice to ONE fixed inbox, set in FORMSUBMIT_TO) or the configured email provider. Never throws. */
async function notifyOwner(subject, message) {
  if (require('../store').inScratch()) return { ok: true, demo: true };
  try {
    const to = process.env.FORMSUBMIT_TO;
    if (to && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      const r = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(to), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ _subject: subject, message, _template: 'table' }) });
      return { ok: r.ok, via: 'formsubmit' };
    }
    const cfg = await outreach.getConfig();
    if (cfg.replyTo && email.configured()) { const r = await email.send({ to: cfg.replyTo, subject, text: message }); return { ok: !!r.ok, via: 'email' }; }
  } catch (_e) { /* best effort */ }
  return { ok: false, via: 'none' };
}

// --------------------------------------------------------------- contributions
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
async function submitContribution(b = {}) {
  const who = b.submitter || {};
  const name = clean(who.name, 100); if (!name) throw err(422, 'Please tell us your name.');
  const em = clean(who.email, 160).toLowerCase(); if (!X.EMAIL_RE.test(em)) throw err(422, 'Please give a valid email so we can credit and reach you.');
  if (!b.attest || b.attest === 'false') throw err(422, 'Please confirm that these details come from a public source and are business contact details.');
  const source = clean(b.source, 300); if (!URL_RE.test(source)) throw err(422, 'Please paste the public page (starting with http) where you found the contact.');
  const t = b.target || {};
  const orgName = clean(t.orgName, 120); if (!orgName && !t.orgId) throw err(422, 'Which organisation is this for?');
  const cEmail = clean(t.email, 160).toLowerCase();
  if (cEmail) {
    if (!X.EMAIL_RE.test(cEmail)) throw err(422, 'The contact email does not look valid.');
    if (X.FREE_MAIL.has(cEmail.split('@')[1])) throw err(422, 'Personal mailboxes (gmail, yahoo ...) are not accepted. Please give a work or team address such as info@company.com.');
    if (await outreach.isSuppressed(cEmail)) throw err(409, 'That address cannot be accepted.');
  }
  const phones = (Array.isArray(t.phones) ? t.phones : String(t.phones || '').split(PHONE_SPLIT)).map((x) => clean(x, 30)).filter(Boolean).slice(0, 4);
  for (const p of phones) { const n = X.canonPhone(p); if (!X.validPhone(n)) throw err(422, `The phone number "${p}" is not valid. Please include the country code, for example +233...`); if (await outreach.isSuppressed(n)) throw err(409, 'That number cannot be accepted.'); }
  const linkedin = clean(t.linkedin, 200);
  if (linkedin && !/^https:\/\/([\w-]+\.)?linkedin\.com\//i.test(linkedin)) throw err(422, 'LinkedIn must be a linkedin.com address.');
  if (!cEmail && !phones.length && !linkedin) throw err(422, 'Give at least a work email, a public phone number or a LinkedIn page.');
  const day = now().slice(0, 10); let mine = 0;
  for (const k of await store.settings.keys(SUB)) { const x = await store.settings.get(k); if (x && x.submitter.email === em && x.at.slice(0, 10) === day) mine++; }
  if (mine >= 30) throw err(429, 'That is plenty for today, thank you. Please come back tomorrow.');
  const partner = await outreach.ensurePartner({ name, email: em, org: clean(who.org, 120) });
  const rec = {
    id: rid('sub'), status: 'pending', at: now(), submitter: { name, email: em, org: clean(who.org, 120), relation: clean(who.relation, 80), code: partner.code },
    target: { orgId: clean(t.orgId, 40), orgName, type: outreach.TYPES.includes(t.orgType) ? t.orgType : '', country: clean(t.country, 60), officeCc: clean(t.officeCountry, 60), city: clean(t.city, 60), name: clean(t.name, 100), role: clean(t.role, 100), purpose: clean(t.purpose, 40), email: cEmail, phones, linkedin },
    source, review: null,
  };
  await store.settings.set(SUB + rec.id, rec);
  notifyOwner('New outreach contribution to verify', `${name} (${em}) submitted a contact for ${orgName}. Source: ${source}`);
  return { ok: true, id: rec.id, code: partner.code };
}
async function listContributions({ status = 'pending' } = {}) {
  const out = []; for (const k of await store.settings.keys(SUB)) { const x = await store.settings.get(k); if (x && (!status || x.status === status)) out.push(x); }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
async function reviewContribution(id, { action, note, by } = {}) {
  const rec = await store.settings.get(SUB + id); if (!rec) throw err(404, 'submission_not_found');
  if (rec.status !== 'pending') throw err(409, 'already_reviewed');
  if (action === 'reject') { rec.status = 'rejected'; rec.review = { by: by || null, at: now(), note: clean(note, 300) }; await store.settings.set(SUB + id, rec); return rec; }
  if (action !== 'approve') throw err(422, 'action must be approve or reject');
  const t = rec.target; const orgs = await X.allOrgs();
  let org = t.orgId ? orgs.find((o) => o.id === t.orgId) : orgs.find((o) => normName(o.name) === normName(t.orgName));
  if (!org) org = await outreach.addOrg({ name: t.orgName, type: t.type || outreach.classifyName(t.orgName), country: t.country, note: 'added from a verified community contribution' });
  let officeCc = '';
  if (t.officeCc) {
    const og = countries.find(t.officeCc); if (!og) throw err(422, 'unknown office country');
    if (og.code !== org.cc) { const cur = (await X.allOrgs()).find((o) => o.id === org.id); if (!(cur.offices || []).some((f) => f.cc === og.code)) await outreach.addOffice(org.id, { cc: og.code, city: t.city, role: 'regional' }); officeCc = og.code; }
  }
  const con = await outreach.addContact({ orgId: org.id, officeCc: officeCc || undefined, name: t.name, role: t.role, purpose: t.purpose, email: t.email, phones: t.phones, linkedin: t.linkedin, source: rec.source }, { by: 'contribution:' + rec.submitter.code });
  await outreach.stampContact(con.id, { contributedBy: rec.submitter.code, contributionId: rec.id, verifiedBy: by || 'operator', verifiedAt: now() });
  await outreach.creditReferrer(rec.submitter.code, { kind: 'contribution', name: rec.submitter.name, orgName: org.name, ref: rec.id });
  rec.status = 'approved'; rec.contactId = con.id; rec.orgId = org.id; rec.review = { by: by || null, at: now(), note: clean(note, 300) };
  await store.settings.set(SUB + id, rec); return rec;
}

// --------------------------------------------------------------- gap board
/** Organisations in a group (or country / type) that have no contact yet: where contributors can help. Names only. */
async function gapBoard({ list, cc, type, limit = 60 } = {}) {
  const orgs = await X.allOrgs(); const have = new Set(); for (const k of await store.settings.keys('out:con:')) { const c = await store.settings.get(k); if (c) have.add(c.orgId); }
  let a = orgs.filter((o) => !have.has(o.id));
  if (list) a = a.filter((o) => (o.lists || []).includes(list)); if (cc) a = a.filter((o) => o.cc === String(cc).toUpperCase()); if (type) a = a.filter((o) => o.type === type);
  const total = a.length; return { total, rows: a.slice(0, Math.min(200, +limit || 60)).map((o) => ({ id: o.id, name: o.name, type: o.type, country: o.country, cc: o.cc, offices: (o.offices || []).map((f) => ({ cc: f.cc, city: f.city })) })) };
}
async function leaderboard(limit = 20) {
  const ov = await outreach.referralOverview();
  return ov.referrers.filter((r) => r.points > 0).slice(0, limit).map((r) => ({ name: String(r.name).split(/\s+/)[0], org: r.org, points: r.points, tier: r.tier ? r.tier.label : '' }));
}

// --------------------------------------------------------------- groups & offices
async function seedGhanaHealth() {
  const cur = await X.allOrgs(); const idx = new Map(cur.map((o) => [normName(o.name), o])); let added = 0, tagged = 0;
  const g = countries.find('GH');
  for (const r of ghana.rows) {
    let o = idx.get(normName(r.name));
    if (!o) { o = { id: rid('org'), name: r.name, type: r.type, country: g.name, cc: g.code, lang: g.langs[0], lists: [], website: '', note: `${r.city}, Ghana (starter; verify against the public site)`, tier: 'ghana-healthcare', status: 'new', createdAt: now() }; cur.push(o); idx.set(normName(r.name), o); added++; }
    if (!o.lists.includes(ghana.GROUP)) { o.lists = [...o.lists, ghana.GROUP, 'ghana-health-finance'].filter((v, i, arr) => arr.indexOf(v) === i); tagged++; }
  }
  await X.saveOrgs(cur); return { added, tagged, inGroup: cur.filter((o) => (o.lists || []).includes(ghana.GROUP)).length };
}
/** Attach the known foreign offices of multinational groups to the organisations already loaded, so held countries can be reached through other offices. */
async function seedGroupOffices() {
  const cur = await X.allOrgs(); let orgsTouched = 0, offices = 0;
  for (const o of cur) {
    const n = normName(o.name); const m = groupOffices.find((x) => n.startsWith(normName(x.prefix)));
    if (!m) continue; const before = (o.offices || []).length; o.offices = o.offices || [];
    for (const f of m.offices) {
      if (f.cc === o.cc) continue; if (o.offices.some((x) => x.cc === f.cc && x.city.toLowerCase() === f.city.toLowerCase())) continue;
      if (o.offices.length >= 40) break; o.offices.push(X.cleanOffice(f)); offices++;
    }
    if (o.offices.length !== before) orgsTouched++;
  }
  await X.saveOrgs(cur); return { orgsTouched, offices };
}
/** Organisations whose country is held, with the offices that are open: the "reach them elsewhere" list. */
async function heldWithOpenOffices() {
  const cfg = await outreach.getConfig(); const orgs = await X.allOrgs(); const out = [];
  for (const o of orgs) {
    if (!X.reachOf(o, cfg).held) continue;
    const open = (o.offices || []).filter((f) => !X.reachOf({ cc: f.cc }, cfg).held);
    out.push({ id: o.id, name: o.name, country: o.country, type: o.type, openOffices: open.map((f) => ({ id: f.id, cc: f.cc, city: f.city, role: f.role })), contacts: 0 });
  }
  const cons = new Map(); for (const k of await store.settings.keys('out:con:')) { const c = await store.settings.get(k); if (c) cons.set(c.orgId, (cons.get(c.orgId) || 0) + 1); }
  for (const r of out) r.contacts = cons.get(r.id) || 0;
  return { total: out.length, withOpenOffice: out.filter((r) => r.openOffices.length).length, rows: out.sort((a, b) => b.openOffices.length - a.openOffices.length).slice(0, 200) };
}

// --------------------------------------------------------------- invite widget
async function baseUrl() { return String((await outreach.getConfig()).publicBaseUrl || '').replace(/\/$/, ''); }
async function widgetMe(b = {}) {
  const p = await outreach.ensurePartner({ name: b.name, email: b.email, org: b.org }); const base = await baseUrl();
  return { code: p.code, name: p.name, link: `${base}/o/r/${p.code}`, page: `${base}/o/refer/${p.code}` };
}
async function widgetInvite(b = {}) {
  const r = await outreach.getReferrer(b.code); if (!r) throw err(404, 'Please identify yourself first.');
  if (!b.attest || b.attest === 'false') throw err(422, 'Please confirm that you know this person.');
  const name = clean(b.name, 100); if (!name) throw err(422, 'Their name, please.');
  const base = await baseUrl(); const link = `${base}/o/r/${r.code}`;
  const text = `Hi ${name.split(/\s+/)[0]}, I think you should look at this: a free sandbox for embedded savings, micro-credit and claims adjudication. Have a look: ${link}`;
  const share = { text, link, mailto: `mailto:${encodeURIComponent(clean(b.email, 160))}?subject=${encodeURIComponent('Worth a look')}&body=${encodeURIComponent(text)}`, sms: b.phone ? `sms:${encodeURIComponent(clean(b.phone, 30))}?body=${encodeURIComponent(text)}` : '', whatsapp: `https://wa.me/${String(b.phone || '').replace(/[^\d]/g, '')}?text=${encodeURIComponent(text)}` };
  const cfg = await outreach.getConfig(); const em = clean(b.email, 160).toLowerCase();
  if (cfg.referral.enabled && em && clean(b.org, 120)) {
    try { const r2 = await outreach.introduce(r.code, { name, role: b.role, email: em, org: b.org, country: b.country, attest: 'yes' }); return { mode: 'invited', already: !!r2.already, share }; }
    catch (e) { if (![409, 422].includes(e.status)) throw e; return { mode: 'personal', reason: e.message, share }; }
  }
  return { mode: 'personal', reason: em && !clean(b.org, 120) ? 'Add their organisation and we will send the invitation for you.' : 'We send invitations to work email addresses; use one of the buttons to send yours personally.', share };
}

// --------------------------------------------------------------- channels
async function channelStatus() {
  const sandbox = await messaging.isSandbox(); const sender = await messaging.resolveSender(null).catch(() => null);
  const cfg = await outreach.getConfig();
  return {
    email: { configured: email.configured(), provider: process.env.EMAIL_PROVIDER || '', from: process.env.EMAIL_FROM || '', howTo: 'Set EMAIL_PROVIDER (resend or sendgrid), EMAIL_API_KEY and EMAIL_FROM in Railway Variables; the sender domain must be verified at the provider.' },
    sms: { sandbox, providerReady: !!sender, provider: sender ? sender.provider : '', howTo: "Master Control > Messaging: add an Africa's Talking (or Twilio / Hubtel) account, then switch messaging out of sandbox in Operating mode." },
    whatsapp: { sandbox, providerReady: !!sender, optInOnly: true },
    formsubmit: { configured: !!process.env.FORMSUBMIT_TO, note: 'FormSubmit forwards form messages to ONE inbox (FORMSUBMIT_TO). It is used for alerts to you, not for sending to third parties.' },
    outreach: { enabled: cfg.enabled, readyToSend: (await outreach.publicConfig()).readyToSend },
  };
}
/** Send ONE test message to an address or number the operator owns, through the live channel (respects sandbox). */
async function testSend({ channel, to } = {}) {
  const cfg = await outreach.getConfig(); const body = `Test from ${cfg.senderOrg}: your outreach channel works. Referral link: ${await baseUrl()}/o/refer`;
  if (channel === 'email') { if (!X.EMAIL_RE.test(String(to || ''))) throw err(422, 'email_invalid'); return email.send({ to, subject: 'Outreach channel test', text: body }); }
  if (channel === 'sms' || channel === 'whatsapp') { const n = X.canonPhone(to); if (!X.validPhone(n)) throw err(422, 'phone_invalid'); return messaging.send({ channel, to: n, body, tenant: null }); }
  throw err(422, 'channel must be email, sms or whatsapp');
}

module.exports = { notifyOwner, submitContribution, listContributions, reviewContribution, gapBoard, leaderboard, seedGhanaHealth, seedGroupOffices, heldWithOpenOffices, widgetMe, widgetInvite, channelStatus, testSend, GHANA_GROUP: ghana.GROUP };
