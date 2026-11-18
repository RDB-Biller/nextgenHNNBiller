'use strict';
const path = require('path');
const express = require('./mini');
const orgs = require('./orgs');
const assets = require('./assets');
const engine = require('./engine');
const audit = require('./audit');
const packs = require('./packs');
const plans = require('./plans');
const store = require('./store');
const hnn = require('./connectors/hnn');
const messaging = require('./messaging');
const surveys = require('./surveys');
const live = require('./live');
const eng = require('./engagements');
const requests = require('./requests');
const proposals = require('./proposals');
const lab = require('./lab');
const labcoach = require('./labcoach');
const demo = require('./demo');
const wr = require('./workroom');
const bench = require('./bench');
const { err, wrap } = require('./util');

const app = express();
app.use(express.json({ limit: '25mb' })); app.use(express.text({ type: 'text/csv', limit: '25mb' }));
const PUBLIC = path.join(__dirname, '..', 'public');
const ALIAS = { '/app': '/app.html', '/join': '/join.html', '/innovations': '/innovations.html', '/ai': '/innovations.html' };
for (const [from, file] of Object.entries(ALIAS)) { app.get(from, (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(require('fs').readFileSync(path.join(PUBLIC, file))); }); app.get(from + '/', (req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(require('fs').readFileSync(path.join(PUBLIC, file))); }); }
app.use(express.static(PUBLIC));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'dry-run', hnnConnected: hnn.configured() }));
app.get('/api/packs', (req, res) => res.json(packs.list()));
app.get('/api/packs/:key', (req, res) => res.json(packs.detail(req.params.key)));


const siteUrl = (req) => (process.env.DRYRUN_PUBLIC_URL || `${req.get('x-forwarded-proto') || 'http'}://${req.get('host')}`).replace(/\/$/, '');
const teamUrl = (req, orgId, byMemberId) => `${siteUrl(req)}/join?team=${require('./requests').teamToken(orgId).token}${byMemberId ? `&by=${encodeURIComponent(byMemberId)}` : ''}`;
/** SMS to people in an organisation. Never throws, never blocks the action that triggered it. Skips demos and people without a number. */
async function smsTo(o, members, text, purpose) {
  if (o.plan === 'demo') return;
  const seen = new Set();
  for (const m of members) { if (!m || !m.phone || seen.has(m.id)) continue; seen.add(m.id); try { await messaging.deliver({ phone: m.phone, channels: { sms: true }, text, orgId: o.id, orgName: o.name, who: m.role, purpose }); } catch { /* logged inside deliver */ } }
}
const leadsOf = (o) => Object.values(o.members).filter((m) => m.role === 'admin');
const joinUrl = (req, orgId) => `${siteUrl(req)}/join${orgId ? '?ref=' + orgs.refCode(orgId) : ''}`;
/** Send sign-in details on the chosen channels. Never throws; the username and password are still returned so nothing is lost if a send fails. */
async function sendCreds(req, { orgId, member, username, password, role, by, deliver, adminAppointment }) {
  const channels = { sms: !!(deliver && deliver.sms), whatsapp: !!(deliver && deliver.whatsapp) };
  if (!channels.sms && !channels.whatsapp) return [];
  const o = orgs.raw(orgId); plans.assertNotDemo(o, 'Sending messages'); const mid = member.id || (Object.values(o.members).find((x) => x.username === username) || {}).id; const base = `${siteUrl(req)}/app`; const url = `${base}?u=${encodeURIComponent(username)}`;
  const text = adminAppointment
    ? messaging.adminText({ name: member.name, org: o.name, username, password, url, adminUrl: `${url}&go=admin`, subdomain: require('./creds').subdomainHint(member.email), inviteUrl: joinUrl(req, orgId), teamUrl: teamUrl(req, orgId, mid) })
    : messaging.memberText({ name: member.name, by, org: o.name, role, username, password, url, inviteUrl: joinUrl(req, orgId), teamUrl: teamUrl(req, orgId, mid) });
  return messaging.deliver({ phone: member.phone, channels, text, orgId, orgName: o.name, who: role, purpose: adminAppointment ? 'admin appointment' : 'team invite' });
}
/** What a message would look like, with the password hidden. */
function previewTexts(req, { org = 'XYZ Insurance', name = 'Ama Mensah', email = 'ama@xyz-insurance.com', by = 'Ama Mensah', role = 'builder' } = {}) {
  const url = `${siteUrl(req)}/app`; const inv = `${siteUrl(req)}/join?ref=abc12345`, tm = `${siteUrl(req)}/join?team=tm_9f2c41d07a`; const un = require('./creds').makeUsername(name, org, new Set());
  return { admin: messaging.adminText({ name, org, username: un, password: '••••••••••', url, adminUrl: `${url}?go=admin`, subdomain: require('./creds').subdomainHint(email), inviteUrl: inv, teamUrl: tm }), teammate: messaging.memberText({ name: 'Kofi Asante', by, org, role, username: require('./creds').makeUsername('Kofi Asante', org, new Set()), password: '••••••••••', url, inviteUrl: inv, teamUrl: tm }) };
}

// ---- public: sign in, request an account, demo ------------------------------------------------------------------------------------
const clientIp = (req) => String(req.get('x-forwarded-for') || req.headers.host || 'x').split(',')[0].trim();
app.post('/api/login', (req, res) => res.json(orgs.login(req.body.username, req.body.password)));
app.post('/api/public/forgot-password', wrap(async (req, res) => {
  const r = orgs.forgotPassword((req.body || {}).username);
  if (r.found && r.hasPhone) {
    const o = orgs.raw(r.orgId); const url = `${siteUrl(req)}/app?u=${encodeURIComponent(r.username)}`;
    const text = `Dry Run: your new temporary password is ${r.password}. Sign in at ${url} and change it. If you did not ask for this, tell your admin.`;
    await messaging.deliver({ phone: r.member.phone, channels: { sms: true }, text, orgId: o.id, orgName: o.name, who: 'member', purpose: 'password reset' });
  }
  res.json({ message: 'If that username exists and has a mobile number on file, a new temporary password has just been sent by SMS. It can take a minute to arrive.' });
}));
app.post('/api/public/request-account', wrap(async (req, res) => {
  const r = requests.submit(req.body || {}, clientIp(req));
  if (r.request && process.env.NOTIFY_PHONE) messaging.deliver({ phone: process.env.NOTIFY_PHONE, channels: { sms: true }, text: `Dry Run: new account request from ${r.request.organisation} (${r.request.sector}). Review: ${siteUrl(req)}/app`, orgName: 'platform', who: 'owner', purpose: 'new request' }).catch(() => {});
  res.status(201).json({ received: true });
}));
app.get('/api/public/team-invite/:token', wrap(async (req, res) => { const o = requests.orgFromTeamToken(req.params.token); if (!o) throw err(404, 'This invite link is no longer active.'); res.json({ org: o.name }); }));
app.post('/api/public/request-team', wrap(async (req, res) => {
  const r = requests.submitTeam(req.body || {}, clientIp(req));
  if (r.request) { const o = orgs.raw(r.request.orgId); await smsTo(o, leadsOf(o), messaging.teamTexts.pending({ org: o.name, name: r.request.contactName, job: r.request.jobTitle, by: r.request.invitedBy && r.request.invitedBy.name, url: `${siteUrl(req)}/app?go=admin` }), 'team request pending'); }
  res.status(201).json({ received: true, org: r.org });
}));
app.post('/api/public/demo', wrap(async (req, res) => res.status(201).json(await demo.create(clientIp(req)))));

// ---- public: survey pages (no sign-in) ------------------------------------------------------------------------------------------
app.get('/api/public/survey/:token', wrap(async (req, res) => res.json(await surveys.publicView(req.params.token))));
app.post('/api/public/survey/:token', wrap(async (req, res) => res.status(201).json(await surveys.submit(req.params.token, (req.body || {}).answers, req.get('x-forwarded-for') || req.headers.host || 'x'))));

// ---- platform owner ------------------------------------------------------------------------------------------------------------
const platformOnly = (req, res, next) => { const a = orgs.authenticate(req); if (!a.platform) throw err(403, 'Platform owner only.'); next(); };
const P = express.Router(); P.use(platformOnly);
P.get('/orgs', (req, res) => res.json(orgs.list()));
P.post('/orgs', wrap(async (req, res) => {
  const r = orgs.create(req.body, packs);
  const delivery = await sendCreds(req, { orgId: r.org.id, member: { name: r.admin.name, email: r.admin.email, phone: req.body.adminPhone }, username: r.admin.username, password: r.admin.password, role: 'admin', deliver: req.body.deliver, adminAppointment: true });
  res.status(201).json({ ...r, delivery, signInUrl: `${siteUrl(req)}/app?u=${encodeURIComponent(r.admin.username)}` });
}));
P.get('/directory', (req, res) => res.json(orgs.directory()));
P.get('/messaging', (req, res) => res.json({ configured: messaging.status(), recent: messaging.history(null, 50) }));
P.post('/orgs/:id/members/:mid/resend', wrap(async (req, res) => {
  const o = orgs.raw(req.params.id); const m = orgs.memberRaw(req.params.id, req.params.mid);
  if (req.body && req.body.phone) { if (!messaging.validPhone(req.body.phone)) throw err(422, 'That phone number does not look right. Use 024… or +233….'); m.phone = String(req.body.phone).trim(); require('./registry').save(); }
  if (!m.phone) throw err(422, 'This person has no phone number on file.');
  const k = orgs.resetPassword(req.params.id, m.id);
  const delivery = await sendCreds(req, { orgId: o.id, member: m, username: k.username, password: k.password, role: m.role, by: 'the platform owner', deliver: req.body.deliver || { sms: true }, adminAppointment: m.role === 'admin' });
  res.json({ ...k, delivery });
}));
P.patch('/orgs/:id/members/:mid', (req, res) => {
  const m = orgs.memberRaw(req.params.id, req.params.mid); const b = req.body || {};
  if (b.phone !== undefined) { if (b.phone && !messaging.validPhone(b.phone)) throw err(422, 'That phone number does not look right. Use 024… or +233….'); m.phone = String(b.phone || '').trim(); }
  if (b.email) m.email = String(b.email).trim();
  require('./registry').save(); res.json({ ok: true });
});
// Free-text message from the platform owner to one person, the org's admins, or everyone in the org.
P.post('/orgs/:id/message', wrap(async (req, res) => {
  const o = orgs.raw(req.params.id); plans.assertNotDemo(o, 'Sending messages'); const b = req.body || {};
  const text = String(b.text || '').trim(); if (!text) throw err(422, 'Write the message first.'); if (text.length > 480) throw err(422, 'Keep it under 480 characters.');
  const channels = { sms: !(b.deliver && b.deliver.sms === false), whatsapp: !!(b.deliver && b.deliver.whatsapp) };
  const all = Object.values(o.members);
  const to = b.memberId ? all.filter((m) => m.id === b.memberId) : b.to === 'admins' ? all.filter((m) => m.role === 'admin') : all;
  if (!to.length) throw err(404, 'Nobody to send to.');
  const results = [];
  for (const m of to) {
    if (!m.phone) { results.push({ name: m.name, ok: false, error: 'No phone number on file.' }); continue; }
    const d = await messaging.deliver({ phone: m.phone, channels, text, orgId: o.id, orgName: o.name, who: m.role, purpose: 'platform message' });
    results.push({ name: m.name, ok: d.length > 0 && d.every((x) => x.ok), error: (d.find((x) => !x.ok) || {}).error || null });
  }
  res.json({ results, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
}));
P.post('/message-preview', (req, res) => res.json(previewTexts(req, req.body || {})));
P.get('/proposals', (req, res) => res.json(proposals.listAll()));
P.patch('/proposals/:pid', (req, res) => res.json(proposals.platformUpdate(req.params.pid, req.body || {})));
P.get('/requests', (req, res) => res.json({ pending: requests.pending(), requests: requests.list() }));
P.post('/requests/:id/decline', (req, res) => res.json(requests.decline(req.params.id, req.body.reason)));
P.post('/requests/:id/approve', wrap(async (req, res) => {
  const { request, created } = requests.approve(req.params.id, req.body); const r = created;
  const delivery = await sendCreds(req, { orgId: r.org.id, member: { name: r.admin.name, email: r.admin.email, phone: request.phone }, username: r.admin.username, password: r.admin.password, role: 'admin', deliver: request.phone ? (req.body.deliver || { sms: true, whatsapp: true }) : {}, adminAppointment: true });
  res.json({ ...r, delivery, signInUrl: `${siteUrl(req)}/app?u=${encodeURIComponent(r.admin.username)}`, request });
}));
P.patch('/orgs/:id/domain', (req, res) => { const o = orgs.raw(req.params.id); o.domainRequest = { ...(o.domainRequest || {}), ...(req.body.status ? { status: req.body.status } : {}), ...(req.body.note !== undefined ? { note: String(req.body.note).slice(0, 300) } : {}) }; require('./registry').save(); res.json(o.domainRequest); });

P.get('/orgs/:id', (req, res) => res.json(orgs.get(req.params.id)));
P.patch('/orgs/:id/plan', (req, res) => res.json(orgs.setPlan(req.params.id, req.body)));
P.get('/config', (req, res) => res.json(orgs.platformConfig()));
P.patch('/config', (req, res) => res.json(orgs.setPlatformConfig(req.body)));
P.get('/engagements', (req, res) => res.json(eng.listAll()));
P.patch('/engagements/:id', (req, res) => res.json(eng.setShare(req.params.id, req.body.platformSharePct)));
P.get('/engagements/:id/statement', wrap(async (req, res) => res.json(await eng.statement(null, req.params.id, 'platform'))));
P.patch('/orgs/:id/partner', (req, res) => res.json(eng.setPartnerProfile(req.params.id, req.body)));
P.get('/live', wrap(async (req, res) => res.json(await live.all())));
P.patch('/live/:orgId/:id', wrap(async (req, res) => res.json(await live.setTerms(req.params.orgId, req.params.id, req.body))));
app.use('/api/platform', P);

// ---- an organisation's own workspace -------------------------------------------------------------------------------------------
const O = express.Router();
O.use((req, res, next) => {
  const a = orgs.authenticate(req); if (a.platform) throw err(403, 'Use a member key for workspace routes. The platform owner manages organisations under /api/platform.');
  if (a.via === 'session' && a.member.mustChange && !['/', '/password'].includes(req.url.split('?')[0])) { const e = err(403, 'Choose a new password before you continue.'); e.code = 'must_change_password'; throw e; }
  req.org = a.org; req.actor = { id: a.member.id, name: a.member.name, role: a.member.role, mustChange: !!a.member.mustChange && a.via === 'session' }; req.role = a.member.role; next();
});
const need = (action) => (req, res, next) => { if (!orgs.can(req.role, action)) throw err(403, `Your role (${req.role}) cannot do this.`); next(); };
const oid = (req) => req.org.id;

O.post('/password', (req, res) => res.json(orgs.changePassword(oid(req), req.actor.id, req.body.current, req.body.next)));
O.get('/', (req, res) => res.json({ demo: plans.isDemo(req.org), me: req.actor, org: orgs.get(oid(req)), pack: packs.detail(req.org.pack) }));
O.get('/team', need('read'), (req, res) => res.json(orgs.members(oid(req))));
O.post('/team', need('team'), wrap(async (req, res) => {
  const m = orgs.addMember(oid(req), req.body, req.actor.name);
  const deliver = req.body.deliver || (req.body.phone ? { sms: true, whatsapp: true } : {});
  const delivery = req.body.phone ? await sendCreds(req, { orgId: oid(req), member: { name: m.name, email: m.email, phone: req.body.phone }, username: m.username, password: m.password, role: m.role, by: req.actor.name, deliver }) : [];
  res.status(201).json({ ...m, delivery });
}));
O.get('/team-invite', need('team'), (req, res) => { const t = requests.teamToken(oid(req)); res.json({ on: t.on, url: teamUrl(req, oid(req)), pending: requests.teamPending(oid(req)) }); });
O.post('/team-invite/rotate', need('team'), (req, res) => { plans.assertNotDemo(req.org, 'Team invite links'); requests.teamToken(oid(req), true); res.json({ on: true, url: teamUrl(req, oid(req)) }); });
O.post('/team-invite/off', need('team'), (req, res) => { requests.teamInviteOff(oid(req)); res.json({ on: false }); });
O.post('/team-invite/on', need('team'), (req, res) => { requests.teamInviteOn(oid(req)); res.json({ on: true, url: teamUrl(req, oid(req)) }); });
// Quick Invite: text the team-invite link to up to 5 mobile numbers by SMS, so an admin can forward it without copy-paste.
const qiCount = new Map();
O.post('/team-invite/send', need('read'), wrap(async (req, res) => {
  const o = orgs.raw(oid(req)); plans.assertNotDemo(o, 'Quick Invite'); plans.assertWritable(o);
  const t = requests.teamToken(oid(req)); if (!t.on) throw err(422, 'Turn the team link on first, then send.');
  const url = teamUrl(req, oid(req), req.actor.id);
  const day = new Date().toISOString().slice(0, 10); const used = (qiCount.get(req.actor.id + day) || 0);
  let phones = req.body && req.body.phones; if (typeof phones === 'string') phones = phones.split(/[\n,;]+/);
  phones = [...new Set((phones || []).map((p) => String(p || '').trim()).filter(Boolean))].slice(0, 5);
  if (!phones.length) throw err(422, 'Add at least one mobile number.');
  if (used + phones.length > 25) throw err(429, 'You have reached today\'s limit of 25 invitations. Try again tomorrow.');
  qiCount.set(req.actor.id + day, used + phones.length);
  const text = messaging.quickInviteText({ by: req.actor.name, org: o.name, url });
  const results = [];
  for (const phone of phones) {
    if (!messaging.validPhone(phone)) { results.push({ to: phone, ok: false, error: 'That number does not look right. Use 024… or +233….' }); continue; }
    const d = await messaging.deliver({ phone, channels: { sms: true }, text, orgId: o.id, orgName: o.name, who: 'invite', purpose: 'quick invite' });
    const r0 = d[0] || { ok: false, error: 'Not sent.' };
    results.push({ to: messaging.mask(phone), ok: r0.ok, error: r0.ok ? null : r0.error });
  }
  res.json({ sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results });
}));
O.get('/team-requests', need('team'), (req, res) => res.json(requests.teamList(oid(req))));
O.post('/team-requests/:rid/decline', need('team'), wrap(async (req, res) => {
  const r = requests.teamDecline(oid(req), req.params.rid, req.body && req.body.reason, req.actor.name); const o = orgs.raw(oid(req)); const url = `${siteUrl(req)}/app?go=admin`;
  if (r.phone) await smsTo(o, [{ id: 'applicant', phone: r.phone, role: 'applicant' }], messaging.teamTexts.declinedApplicant({ name: r.contactName, org: o.name, reason: r.reason, url: `${siteUrl(req)}/join` }), 'team request declined');
  await smsTo(o, leadsOf(o), messaging.teamTexts.declinedLead({ org: o.name, name: r.contactName, actor: req.actor.name, url }), 'team request declined (lead)');
  res.json(r);
}));
O.post('/team-requests/:rid/approve', need('team'), wrap(async (req, res) => {
  const { request, member } = requests.teamApprove(oid(req), req.params.rid, req.body && req.body.role, req.actor.name);
  const deliver = request.phone ? ((req.body && req.body.deliver) || { sms: true, whatsapp: true }) : {};
  const delivery = request.phone ? await sendCreds(req, { orgId: oid(req), member: { name: member.name, email: member.email, phone: request.phone }, username: member.username, password: member.password, role: member.role, by: req.actor.name, deliver }) : [];
  const o = orgs.raw(oid(req)); const url = `${siteUrl(req)}/app?go=admin`;
  await smsTo(o, leadsOf(o), messaging.teamTexts.addedLead({ org: o.name, name: member.name, role: member.role, actor: req.actor.name, url }), 'team request approved (lead)');
  const inv = request.invitedBy && o.members[request.invitedBy.id];
  if (inv && !leadsOf(o).some((l) => l.id === inv.id)) await smsTo(o, [inv], messaging.teamTexts.addedInviter({ name: inv.name, invitee: member.name, org: o.name, url: `${siteUrl(req)}/app`, teamUrl: teamUrl(req, oid(req), inv.id) }), 'team invite accepted');
  res.json({ ...member, delivery });
}));
O.get('/partner-code', need('read'), (req, res) => res.json({ code: orgs.refCode(oid(req)) }));
O.get('/proposals', need('read'), (req, res) => res.json(proposals.listFor(oid(req))));
O.post('/proposals/suggest', need('write'), wrap(async (req, res) => res.json(await proposals.suggest(oid(req), req.body || {}))));
O.post('/proposals', need('write'), wrap(async (req, res) => {
  const p = await proposals.create(oid(req), req.actor, req.role, req.body || {});
  if (p.toOrgId) { const t = orgs.raw(p.toOrgId); for (const m of Object.values(t.members)) if (m.role === 'admin' && m.phone) messaging.deliver({ phone: m.phone, channels: { sms: true }, text: `Dry Run: ${p.fromName} sent you a proposal: ${p.title}. Review: ${siteUrl(req)}/app`, orgId: t.id, orgName: t.name, who: 'admin', purpose: 'proposal' }).catch(() => {}); }
  res.status(201).json(p);
}));
O.post('/proposals/:pid/respond', need('read'), wrap(async (req, res) => res.json(await proposals.respond(oid(req), req.actor, req.role, req.params.pid, req.body || {}))));
O.get('/lab/archetypes', need('read'), (req, res) => res.json(lab.archetypes(oid(req))));
O.post('/lab/coach', need('read'), (req, res) => res.json({ reply: labcoach.reply({ message: req.body && req.body.message, pack: packs.detail(req.org.pack) }) }));
O.post('/lab/preview', need('read'), (req, res) => res.json(lab.preview(oid(req), req.body.archetype, req.body.params)));
O.post('/lab/generate', need('write'), wrap(async (req, res) => res.status(201).json(await lab.generate(oid(req), req.actor, req.role, req.body || {}))));
O.post('/lab/assets/:id/regenerate', need('write'), wrap(async (req, res) => res.json(await lab.regenerate(oid(req), req.actor, req.role, req.params.id, (req.body || {}).params, (req.body || {}).note))));
O.post('/lab/assets/:id/variation', need('write'), wrap(async (req, res) => res.status(201).json(await lab.variation(oid(req), req.actor, req.role, req.params.id, req.body || {}))));
O.get('/lab/assets/:id/family', need('read'), wrap(async (req, res) => res.json(await lab.family(oid(req), req.params.id))));
O.post('/lab/compare', need('run'), wrap(async (req, res) => res.json(await lab.compareProducts(oid(req), req.actor, req.role, (req.body || {}).assetIds, (req.body || {}).params))));
O.get('/lab/ideas', need('read'), wrap(async (req, res) => res.json(await lab.ideas(oid(req), req.actor.id))));
O.post('/lab/ideas', need('write'), wrap(async (req, res) => res.status(201).json(await lab.addIdea(oid(req), req.actor, req.body || {}))));
O.post('/lab/ideas/:id/vote', need('read'), wrap(async (req, res) => res.json(await lab.vote(oid(req), req.actor, req.params.id))));
O.post('/lab/ideas/:id/promote', need('write'), wrap(async (req, res) => res.json(await lab.promote(oid(req), req.actor, req.role, req.params.id, req.body || {}))));
O.post('/lab/ideas/:id/close', need('write'), wrap(async (req, res) => res.json(await lab.closeIdea(oid(req), req.actor, req.params.id))));
O.get('/messaging', need('read'), (req, res) => res.json({ configured: messaging.status(), recent: messaging.history(oid(req), 30) }));
O.patch('/team/:mid', need('team'), (req, res) => res.json(orgs.setRole(oid(req), req.params.mid, req.body.role)));
O.delete('/team/:mid', need('team'), (req, res) => res.json(orgs.removeMember(oid(req), req.params.mid)));
O.post('/team/:mid/rotate-key', need('team'), (req, res) => res.json(orgs.rotateKey(oid(req), req.params.mid)));
O.post('/team/:mid/reset-password', need('team'), wrap(async (req, res) => {
  const m = orgs.memberRaw(oid(req), req.params.mid); const k = orgs.resetPassword(oid(req), m.id);
  const delivery = m.phone && req.body && req.body.deliver ? await sendCreds(req, { orgId: oid(req), member: m, username: k.username, password: k.password, role: m.role, by: req.actor.name, deliver: req.body.deliver, adminAppointment: false }) : [];
  res.json({ ...k, delivery });
}));
O.post('/team/preview', need('team'), (req, res) => res.json({ teammate: previewTexts(req, { org: req.org.name, by: req.actor.name, role: req.body.role || 'builder' }).teammate }));
O.post('/domain-request', need('settings'), (req, res) => {
  plans.assertNotDemo(req.org, 'Using your own address'); const d = String(req.body.domain || '').trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw err(422, 'Enter an address such as dryrun.yourcompany.com.');
  req.org.domainRequest = { domain: d, status: 'requested', requestedAt: new Date().toISOString(), requestedBy: req.actor.name }; require('./registry').save(); res.json(req.org.domainRequest);
});
O.patch('/settings', need('settings'), (req, res) => res.json(orgs.settings(oid(req), req.body)));
O.get('/storage', need('read'), (req, res) => res.json(store.describe(req.org.storage)));
O.put('/storage', need('settings'), wrap(async (req, res) => { plans.assertNotDemo(req.org, 'Moving your data'); res.json(await orgs.setStorage(oid(req), req.body)); }));

O.get('/assets', need('read'), wrap(async (req, res) => res.json(await assets.list(oid(req), req.query.kind))));
O.post('/assets', need('write'), wrap(async (req, res) => res.status(201).json(await assets.create(oid(req), req.actor, req.body))));
O.get('/assets/:id', need('read'), wrap(async (req, res) => res.json(await assets.detail(oid(req), req.params.id, { withData: req.query.data === '1' }))));
O.post('/assets/:id/versions', need('write'), wrap(async (req, res) => res.status(201).json(await assets.addVersion(oid(req), req.actor, req.params.id, req.body))));
O.post('/assets/:id/promote', need('promote'), wrap(async (req, res) => res.json(await assets.promote(oid(req), req.actor, req.role, req.params.id, req.body.version, req.body.to, req.body.note))));
O.get('/assets/:id/export', need('read'), wrap(async (req, res) => res.json(await assets.exportApproved(oid(req), req.actor, req.params.id))));
O.post('/upload', need('write'), wrap(async (req, res) => res.status(201).json(await assets.upload(oid(req), req.actor, req.body))));

O.post('/runs', need('run'), wrap(async (req, res) => { const run = await engine.run(oid(req), req.actor, req.role, req.body); const pa = req.body && req.body.inputs && req.body.inputs.product && req.body.inputs.product.assetId; if (pa) await wr.postRun(oid(req), run, pa); res.status(201).json(run); }));
O.get('/runs', need('read'), wrap(async (req, res) => res.json(await engine.listRuns(oid(req), req.query.scenario))));
O.get('/runs/:id', need('read'), wrap(async (req, res) => res.json(await engine.getRun(oid(req), req.params.id))));
O.post('/compare', need('read'), wrap(async (req, res) => res.json(await engine.compare(oid(req), req.body.runIds))));
O.post('/runs/:id/coach', need('run'), wrap(async (req, res) => res.json(await engine.coach(oid(req), req.actor, req.role, req.params.id, req.body || {}))));
O.post('/runs/:id/coach/apply', need('write'), wrap(async (req, res) => res.status(201).json(await engine.applyCoach(oid(req), req.actor, req.role, req.params.id, Number(req.body && req.body.index) || 0))));

O.get('/pace', need('read'), (req, res) => res.json(engine.pace(oid(req))));
O.put('/pace/:scenario/:step', need('write'), (req, res) => res.json(orgs.tickChecklist(oid(req), req.params.scenario, Number(req.params.step), req.body.done !== false)));
O.get('/audit', need('read'), wrap(async (req, res) => res.json(await audit.list(oid(req), Number(req.query.limit) || 200))));

O.get('/regulatory-rules', need('read'), (req, res) => res.json(require('./regulatory').merge(req.org.regulatoryRules)));
O.put('/regulatory-rules', need('settings'), (req, res) => res.json(orgs.setRegulatoryRules(oid(req), req.body)));
O.post('/assets/:id/regulator', need('approve'), wrap(async (req, res) => res.json(await assets.recordRegulator(oid(req), req.actor, req.role, req.params.id, req.body.version, req.body))));

O.get('/surveys', need('read'), wrap(async (req, res) => res.json(await surveys.list(oid(req)))));
O.post('/surveys', need('write'), wrap(async (req, res) => res.status(201).json({ ...(await surveys.create(oid(req), req.actor, req.body)), } )));
O.get('/surveys/:id/results', need('read'), wrap(async (req, res) => res.json(await surveys.results(oid(req), req.params.id))));
O.post('/surveys/:id/status', need('write'), wrap(async (req, res) => res.json(await surveys.setStatus(oid(req), req.actor, req.params.id, req.body.status))));
O.post('/surveys/:id/invite', need('write'), wrap(async (req, res) => { const s = (await surveys.list(oid(req))).find((x) => x.id === req.params.id); if (!s) throw err(404, 'Unknown survey.'); res.json(await surveys.invite(oid(req), req.actor, req.params.id, `${siteUrl(req)}/s.html?t=${encodeURIComponent(s.token)}`, req.body, joinUrl(req, oid(req)))); }));

O.get('/live', need('read'), wrap(async (req, res) => res.json(await live.list(oid(req)))));
O.post('/live', need('approve'), wrap(async (req, res) => res.status(201).json(await live.create(oid(req), req.actor, req.role, req.body))));
O.get('/live/:id', need('read'), wrap(async (req, res) => res.json(await live.get(oid(req), req.params.id))));
O.post('/live/:id/status', need('approve'), wrap(async (req, res) => res.json(await live.setStatus(oid(req), req.actor, req.role, req.params.id, req.body.status, req.body.note))));
O.post('/live/:id/actuals', need('write'), wrap(async (req, res) => res.json(await live.addActuals(oid(req), req.actor, req.role, req.params.id, req.body.periods || req.body))));
O.post('/live/:id/notes', need('write'), wrap(async (req, res) => res.json(await live.addNote(oid(req), req.actor, req.role, req.params.id, req.body.note))));

// ---- partner network: engagements and scoped work ------------------------------------------------------------------------------------
const mine = (req) => ({ id: req.actor.id, name: req.actor.name });
const W = (role, write) => (req, res, next) => {
  if (write && !orgs.can(req.role, 'write')) throw err(403, 'Your role cannot do this.');
  const a = eng.access(oid(req), mine(req), req.params.eid, role); req.work = a; next();
};
O.get('/partners', need('read'), (req, res) => res.json(eng.partners()));
O.get('/engagements', need('read'), (req, res) => res.json(eng.listFor(oid(req))));
O.post('/engagements', need('settings'), (req, res) => { plans.assertNotDemo(req.org, 'Engaging partners'); return res.status(201).json(eng.create(oid(req), req.actor, req.body)); });
O.post('/engagements/:eid/:action', need('settings'), (req, res) => res.json(eng.respond(oid(req), req.actor, req.params.eid, req.params.action)));
O.get('/engagements/:eid/statement', need('read'), wrap(async (req, res) => { const e = eng.listFor(oid(req)).find((x) => x.id === req.params.eid); if (!e) throw err(404, 'Unknown engagement.'); res.json(await eng.statement(oid(req), req.params.eid, e.side)); }));
O.get('/engagements/:eid/work/info', need('read'), W(), wrap(async (req, res) => { const c = orgs.raw(req.work.clientId); res.json({ client: req.work.clientName, role: req.work.e.role, scope: req.work.e.scope, surveyTemplates: (packs.get(c.pack) || {}).surveyTemplates || [] }); }));
// researcher
O.get('/engagements/:eid/work/surveys', need('read'), W('researcher'), wrap(async (req, res) => res.json((await surveys.list(req.work.clientId)).filter((s) => eng.inScope(req.work.e, 'surveyIds', s.id)))));
O.post('/engagements/:eid/work/surveys', W('researcher', true), wrap(async (req, res) => { const s = await surveys.create(req.work.clientId, req.work.actor, req.body); eng.addScope(req.work.e, 'surveyIds', s.id); res.status(201).json(s); }));
const sv = (req) => { if (!eng.inScope(req.work.e, 'surveyIds', req.params.id)) throw err(403, 'The client has not given you access to this survey.'); return req.params.id; };
O.get('/engagements/:eid/work/surveys/:id/results', need('read'), W('researcher'), wrap(async (req, res) => res.json(await surveys.results(req.work.clientId, sv(req)))));
O.post('/engagements/:eid/work/surveys/:id/status', W('researcher', true), wrap(async (req, res) => res.json(await surveys.setStatus(req.work.clientId, req.work.actor, sv(req), req.body.status))));
O.post('/engagements/:eid/work/surveys/:id/invite', W('researcher', true), wrap(async (req, res) => { const s = (await surveys.list(req.work.clientId)).find((x) => x.id === sv(req)); res.json(await surveys.invite(req.work.clientId, req.work.actor, s.id, `${siteUrl(req)}/s.html?t=${encodeURIComponent(s.token)}`, req.body, joinUrl(req, oid(req)))); }));
// operator
const lv = (req) => { if (!eng.inScope(req.work.e, 'liveIds', req.params.id)) throw err(403, 'The client has not given you access to this programme.'); return req.params.id; };
O.get('/engagements/:eid/work/live', need('read'), W('operator'), wrap(async (req, res) => res.json((await live.list(req.work.clientId)).filter((p) => eng.inScope(req.work.e, 'liveIds', p.id)))));
O.get('/engagements/:eid/work/live/:id', need('read'), W('operator'), wrap(async (req, res) => res.json(await live.get(req.work.clientId, lv(req)))));
O.post('/engagements/:eid/work/live/:id/actuals', W('operator', true), wrap(async (req, res) => res.json(await live.addActuals(req.work.clientId, req.work.actor, 'builder', lv(req), req.body.periods || req.body))));
O.post('/engagements/:eid/work/live/:id/notes', W('operator', true), wrap(async (req, res) => res.json(await live.addNote(req.work.clientId, req.work.actor, 'builder', lv(req), req.body.note))));
O.post('/engagements/:eid/work/live/:id/status', W('operator', true), wrap(async (req, res) => { if (req.body.status !== 'paused') throw err(403, 'Operators can pause a programme. Starting or going live is the client\'s decision.'); res.json(await live.setStatus(req.work.clientId, req.work.actor, 'approver', lv(req), 'paused', req.body.note)); }));

// guests: a partner sees only the rooms a client opened for it
O.get('/engagements/:eid/work/rooms', need('read'), W(), wrap(async (req, res) => res.json(await wr.guestRooms(req.work.clientId, req.params.eid))));
O.get('/engagements/:eid/work/rooms/:rid', need('read'), W(), wrap(async (req, res) => res.json(await wr.thread(req.work.clientId, req.work.actor, req.params.rid, { guestEid: req.params.eid }))));
O.post('/engagements/:eid/work/rooms/:rid/messages', W(undefined, true), wrap(async (req, res) => { const r = await wr.post(req.work.clientId, req.work.actor, 'builder', req.params.rid, { text: (req.body || {}).text, guestEid: req.params.eid }); res.status(201).json(r.message); }));
// ---- Workroom ----------------------------------------------------------------------------------------------------------------------
const roomUrl = (req, roomId) => `${siteUrl(req)}/app?room=${encodeURIComponent(roomId)}`;
const memberOf = (req, id) => req.org.members[id];
const snip = (t, n = 90) => { const s2 = String(t || '').replace(/\s+/g, ' ').trim(); return s2.length > n ? s2.slice(0, n - 1) + '…' : s2; };
O.get('/workroom/rooms', need('read'), wrap(async (req, res) => res.json(await wr.rooms(oid(req), req.actor))));
O.get('/workroom/mine', need('read'), wrap(async (req, res) => res.json({ ...(await wr.mine(oid(req), req.actor, req.role)), digest: !!(memberOf(req, req.actor.id) || {}).digest })));
O.patch('/workroom/me', need('read'), (req, res) => { const m = memberOf(req, req.actor.id); m.digest = !!(req.body && req.body.digest); require('./registry').save(); res.json({ digest: m.digest }); });
O.post('/workroom/digest/now', need('read'), wrap(async (req, res) => {
  plans.assertNotDemo(req.org, 'Sending messages'); const m = memberOf(req, req.actor.id); if (!m.phone) throw err(422, 'Add your phone number first (ask an admin to save it for you).');
  const d = await wr.digestFor(oid(req), m); if (!d) return res.json({ sent: false, message: 'Nothing is waiting for you.' });
  await smsTo(req.org, [m], `Dry Run: you have ${d}. Open the Workroom: ${siteUrl(req)}/app?room=${wr.GENERAL}`, 'workroom digest'); res.json({ sent: true, message: d });
}));
O.get('/workroom/decisions', need('read'), wrap(async (req, res) => res.json(await wr.decisions(oid(req), req.query.q))));
O.get('/workroom/rooms/:rid', need('read'), wrap(async (req, res) => res.json(await wr.thread(oid(req), req.actor, req.params.rid))));
O.post('/workroom/rooms/:rid/messages', need('read'), wrap(async (req, res) => {
  const r = await wr.post(oid(req), req.actor, req.role, req.params.rid, req.body || {});
  await smsTo(req.org, r.mentioned.filter((i) => i !== req.actor.id).map((i) => memberOf(req, i)), `Dry Run: ${req.actor.name} mentioned you in ${r.room.name}: "${snip(r.message.text)}" Open: ${roomUrl(req, r.room.id)}`, 'workroom mention');
  let coach = null; if (r.coach) coach = await wr.coachReply(oid(req), req.actor, req.role, req.params.rid, { text: r.message.text, pack: packs.detail(req.org.pack) });
  res.status(201).json({ message: r.message, coach });
}));
O.post('/workroom/rooms/:rid/approvals', need('promote'), wrap(async (req, res) => {
  const r = await wr.requestApproval(oid(req), req.actor, req.role, req.params.rid, req.body || {}); const a = r.message.approval;
  await smsTo(req.org, r.approvers, `Dry Run: ${req.actor.name} asks you to approve "${a.assetName}" v${a.version} to ${a.to.replace('_', ' ')}. Decide: ${roomUrl(req, r.room.id)}`, 'approval requested'); res.status(201).json(r.message);
}));
O.post('/workroom/approvals/:mid/decide', need('approve'), wrap(async (req, res) => {
  const r = await wr.decideApproval(oid(req), req.actor, req.role, req.params.mid, req.body || {}); const a = r.message.approval;
  if (r.requester && r.requester.id !== req.actor.id) await smsTo(req.org, [r.requester], a.status === 'approved' ? `Dry Run: ${req.actor.name} approved "${a.assetName}" v${a.version} to ${a.to.replace('_', ' ')}. Open: ${roomUrl(req, r.roomId)}` : `Dry Run: ${req.actor.name} sent "${a.assetName}" v${a.version} back: "${snip(a.decisionNote)}" Open: ${roomUrl(req, r.roomId)}`, 'approval decided');
  res.json(r.message);
}));
O.post('/workroom/rooms/:rid/decisions', need('read'), wrap(async (req, res) => res.status(201).json(await wr.addDecision(oid(req), req.actor, req.role, req.params.rid, req.body || {}))));
O.post('/workroom/rooms/:rid/tasks', need('read'), wrap(async (req, res) => {
  const r = await wr.addTask(oid(req), req.actor, req.role, req.params.rid, req.body || {});
  if (r.assignee.id !== req.actor.id) await smsTo(req.org, [r.assignee], `Dry Run: ${req.actor.name} gave you a task: "${snip(r.task.text)}"${r.task.due ? ` (due ${r.task.due})` : ''}. Open: ${roomUrl(req, r.room.id)}`, 'task assigned');
  res.status(201).json(r.task);
}));
O.post('/workroom/tasks/:tid', need('read'), wrap(async (req, res) => {
  const r = await wr.setTask(oid(req), req.actor, req.role, req.params.tid, !(req.body && req.body.done === false));
  if (r.task.status === 'done' && r.creator && r.creator.id !== req.actor.id) await smsTo(req.org, [r.creator], `Dry Run: ${req.actor.name} finished "${snip(r.task.text)}". Open: ${roomUrl(req, r.task.roomId)}`, 'task done');
  res.json(r.task);
}));
O.post('/workroom/guest-rooms', need('settings'), wrap(async (req, res) => res.status(201).json(await wr.createGuestRoom(oid(req), req.actor, req.role, req.body || {}))));
// ---- test bench (inside a product's room) ---------------------------------------------------------------------------------------
O.get('/workroom/bench/:aid/constraints', need('read'), wrap(async (req, res) => res.json(await bench.constraints(oid(req), req.params.aid))));
O.post('/workroom/bench/:aid/rules', need('read'), wrap(async (req, res) => res.status(201).json(await bench.addRule(oid(req), req.actor, req.role, req.params.aid, req.body))));
O.delete('/workroom/bench/:aid/rules/:rid', need('read'), wrap(async (req, res) => res.json(await bench.removeRule(oid(req), req.role, req.params.aid, req.params.rid))));
O.post('/workroom/bench/:aid/sheets', need('read'), wrap(async (req, res) => res.status(201).json(await bench.addSheet(oid(req), req.actor, req.role, req.params.aid, req.body))));
O.delete('/workroom/bench/:aid/sheets/:sid', need('read'), wrap(async (req, res) => res.json(await bench.removeSheet(oid(req), req.role, req.params.aid, req.params.sid))));
O.get('/workroom/bench/:aid/plan', need('read'), wrap(async (req, res) => res.json(await bench.plan(oid(req), req.params.aid))));
O.get('/workroom/bench/:aid/history', need('read'), wrap(async (req, res) => res.json(await bench.history(oid(req), req.params.aid))));
O.post('/workroom/bench/:aid/run', need('read'), wrap(async (req, res) => res.status(201).json(await bench.run(oid(req), req.actor, req.role, req.params.aid, req.body || {}))));
// The one door to HNN Biller. Read-only.
O.get('/hnn/price-books', need('read'), wrap(async (req, res) => res.json(await hnn.listPriceBooks())));
O.post('/hnn/import', need('write'), wrap(async (req, res) => {
  const b = await hnn.readPriceBook(req.body.priceBookId);
  const items = (b.items || []).map((i) => ({ code: i.code, name: i.name || i.description || i.code, unit: i.unit || '', category: i.category || '', price: Number(i.price ?? i.amount) })).filter((i) => i.code && Number.isFinite(i.price));
  const data = { currency: b.currency || 'GHS', items, source: { system: 'HNN Biller', priceBookId: b.id, importedAt: new Date().toISOString() } };
  const a = req.body.assetId ? await assets.addVersion(oid(req), req.actor, req.body.assetId, { data, note: `Imported from HNN Biller: ${b.name}` }) : await assets.create(oid(req), req.actor, { kind: 'price_book', name: `HNN: ${b.name}`, data, description: 'Imported from HNN Biller', note: 'Imported from HNN Biller' });
  res.status(201).json({ asset: a, items: items.length });
}));
app.use('/api/org', O);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((e, req, res, next) => { const s = e.status || 500; if (s === 500) console.error(e); res.status(s).json({ error: s === 500 ? 'Something went wrong on our side.' : e.message, ...(e.code ? { code: e.code } : {}) }); });

module.exports = app;
/** Once a day, around DRYRUN_DIGEST_HOUR (UTC, default 7), text each member who turned the digest on what is waiting for them. */
async function sendDigests() {
  const now = new Date(); if (now.getUTCHours() !== Number(process.env.DRYRUN_DIGEST_HOUR || 7)) return; const day = now.toISOString().slice(0, 10); const reg2 = require('./registry');
  const site = (process.env.DRYRUN_PUBLIC_URL || '').replace(/\/$/, ''); if (!site) return;
  for (const o of Object.values(reg2.load().orgs)) {
    if (o.plan === 'demo' || o.suspended || o.workroomDigestDay === day) continue; o.workroomDigestDay = day; reg2.save();
    for (const m of Object.values(o.members)) { if (!m.digest || !m.phone) continue; const d = await wr.digestFor(o.id, m).catch(() => null); if (d) await smsTo(o, [m], `Dry Run: good morning ${String(m.name).split(' ')[0]}, you have ${d}. Open the Workroom: ${site}/app?room=${wr.GENERAL}`, 'workroom digest'); }
  }
}
if (require.main === module) { const port = process.env.PORT || 4100; app.listen(port, () => console.log(`Dry Run listening on ${port}`)); setInterval(() => demo.sweep().catch(() => {}), 15 * 60 * 1000).unref(); if (!process.env.DRYRUN_MEMORY) setInterval(() => sendDigests().catch(() => {}), 30 * 60 * 1000).unref(); }
