'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const outreach = require('../services/outreach');
const community = require('../services/outreachCommunity');
const lab = require('../services/labGroups');
const { limiter } = require('../middleware/rateLimit');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (!e.status) console.error('[outreach]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' });
  }
};
const who = (req) => (req.principal && req.principal.id) || 'platform';

/** Master Control (behind authPlatform): /api/platform/outreach */
const admin = express.Router();
admin.use(express.json({ limit: '2mb' }));
admin.get('/overview', wrap(async (_q, res) => res.json(await outreach.overview())));
admin.get('/config', wrap(async (_q, res) => res.json(await outreach.publicConfig())));
admin.put('/config', wrap(async (req, res) => res.json(await outreach.setConfig(req.body || {}, who(req)))));
admin.post('/seed', wrap(async (_q, res) => res.json(await outreach.seedOrgs())));
admin.get('/packs', wrap(async (_q, res) => res.json({ packs: await outreach.listPacks() })));
admin.post('/packs/seed', wrap(async (req, res) => res.json(await outreach.seedCountries(req.body || {}))));
admin.post('/packs/africa-report', wrap(async (_q, res) => res.json(await outreach.seedAfricaReport())));
admin.post('/packs/core-banking', wrap(async (_q, res) => res.json(await outreach.seedCoreBanking())));
admin.get('/orgs/:id/offices', wrap(async (req, res) => res.json({ offices: await outreach.officesReach(req.params.id) })));
admin.post('/orgs/:id/offices', wrap(async (req, res) => res.status(201).json(await outreach.addOffice(req.params.id, req.body || {}))));
admin.delete('/orgs/:id/offices/:oid', wrap(async (req, res) => res.json(await outreach.removeOffice(req.params.id, req.params.oid))));
admin.post('/packs/import', wrap(async (req, res) => res.json(await outreach.importList(req.body || {}))));
admin.get('/countries', wrap(async (_q, res) => res.json({ countries: await outreach.countryTable() })));
admin.get('/orgs', wrap(async (req, res) => res.json(await outreach.listOrgs(req.query))));
admin.post('/orgs', wrap(async (req, res) => res.status(201).json(await outreach.addOrg(req.body || {}))));
admin.patch('/orgs/:id', wrap(async (req, res) => res.json(await outreach.updateOrg(req.params.id, req.body || {}))));
admin.get('/contacts', wrap(async (req, res) => res.json(await outreach.listContacts(req.query))));
admin.post('/contacts', wrap(async (req, res) => res.status(201).json(await outreach.addContact(req.body || {}, { by: who(req) }))));
admin.post('/contacts/import', wrap(async (req, res) => res.json(await outreach.importContacts((req.body || {}).rows, { by: who(req) }))));
admin.patch('/contacts/:id', wrap(async (req, res) => res.json(await outreach.patchContact(req.params.id, req.body || {}))));
admin.post('/contacts/:id/status', wrap(async (req, res) => res.json(await outreach.setContactStatus(req.params.id, (req.body || {}).status, who(req)))));
admin.post('/contacts/:id/pause', wrap(async (req, res) => res.json(await outreach.pause(req.params.id))));
admin.delete('/contacts/:id', wrap(async (req, res) => res.json(await outreach.eraseContact(req.params.id))));
admin.get('/contacts/:id/preview', wrap(async (req, res) => res.json(await outreach.preview(req.params.id, req.query.sequence, +req.query.step || 0))));
admin.get('/sequences', wrap(async (_q, res) => res.json({ sequences: await outreach.listSequences() })));
admin.post('/enroll', wrap(async (req, res) => res.json(await outreach.enroll(req.body || {}))));
admin.post('/run', wrap(async (req, res) => res.json(await outreach.runDue({ dryRun: (req.body || {}).dryRun !== false, force: !!(req.body || {}).force }))));
admin.get('/tasks', wrap(async (req, res) => res.json({ tasks: await outreach.listTasks({ status: req.query.status === 'all' ? '' : 'open' }) })));
admin.post('/tasks/:id/done', wrap(async (req, res) => res.json(await outreach.completeTask(req.params.id, (req.body || {}).status === 'skipped' ? 'skipped' : 'done'))));
admin.get('/referrals', wrap(async (_q, res) => res.json(await outreach.referralOverview())));
admin.put('/referrals/config', wrap(async (req, res) => { await outreach.setConfig({ referral: req.body || {} }, who(req)); res.json((await outreach.referralOverview()).config); }));
admin.post('/referrals/partners', wrap(async (req, res) => res.status(201).json(await outreach.addPartnerByAdmin(req.body || {}))));
admin.post('/referrals/:code/reward', wrap(async (req, res) => res.json({ rewards: await outreach.addReward(req.params.code, (req.body || {}).note, who(req)) })));
admin.post('/packs/ghana-healthcare', wrap(async (_q, res) => res.json(await community.seedGhanaHealth())));
admin.post('/packs/group-offices', wrap(async (_q, res) => res.json(await community.seedGroupOffices())));
admin.get('/held-offices', wrap(async (_q, res) => res.json(await community.heldWithOpenOffices())));
admin.get('/value-proposition/:segment', wrap(async (req, res) => res.json(outreach.valueProposition(req.params.segment))));
admin.post('/packs/nabip', wrap(async (req, res) => res.json(await outreach.setupNabip({ ...(req.body || {}), by: who(req) }))));
admin.post('/contacts/:id/verify', wrap(async (req, res) => res.json(await outreach.verifyContact(req.params.id, { note: (req.body || {}).note, by: who(req) }))));
admin.post('/contacts/:id/send-now', wrap(async (req, res) => res.json(await outreach.sendNow(req.params.id, { ...(req.body || {}), by: who(req) }))));
admin.get('/gaps', wrap(async (req, res) => res.json(await community.gapBoard(req.query))));
admin.get('/contributions', wrap(async (req, res) => res.json({ rows: await community.listContributions({ status: req.query.status === 'all' ? '' : (req.query.status || 'pending') }) })));
admin.post('/contributions/:id/review', wrap(async (req, res) => res.json(await community.reviewContribution(req.params.id, { ...(req.body || {}), by: who(req) }))));
admin.get('/channels', wrap(async (_q, res) => res.json(await community.channelStatus())));
admin.post('/channels/test', wrap(async (req, res) => res.json(await community.testSend(req.body || {}))));
admin.get('/lab/groups', wrap(async (_q, res) => res.json({ groups: await lab.listGroups() })));
admin.post('/lab/groups', wrap(async (req, res) => res.status(201).json(await lab.createGroup(req.body || {}, who(req)))));
admin.get('/lab/groups/:id', wrap(async (req, res) => res.json(await lab.adminView(req.params.id))));
admin.patch('/lab/groups/:id', wrap(async (req, res) => res.json(await lab.updateGroup(req.params.id, req.body || {}))));
admin.patch('/lab/groups/:id/ideas/:iid', wrap(async (req, res) => res.json(await lab.moderateIdea(req.params.id, req.params.iid, req.body || {}))));
admin.delete('/lab/groups/:id/messages/:mid', wrap(async (req, res) => res.json(await lab.removeMessage(req.params.id, req.params.mid))));
admin.get('/classify', wrap(async (req, res) => { const n = String(req.query.phone || ''); res.json({ phone: n, type: outreach.classifyPhone(n.replace(/[^\d+]/g, '')) }); }));
admin.get('/feedback', wrap(async (_q, res) => res.json({ feedback: await outreach.listFeedback() })));
admin.post('/suppress', wrap(async (req, res) => { await outreach.suppress((req.body || {}).value, 'manual'); res.json({ ok: true }); }));

/** Public (no auth): tracked sandbox link, one-click unsubscribe, feedback form. */
const pub = express.Router();
pub.use(express.urlencoded({ extended: false, limit: '50kb' }));
pub.use(express.json({ limit: '50kb' }));
pub.use(limiter(120, 60000));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:8vh auto;padding:0 16px;color:#17202b}textarea,input{width:100%;padding:9px;border:1px solid #cfd6df;border-radius:8px;font:inherit;margin:4px 0 12px}button{padding:10px 16px;border:0;border-radius:8px;background:#0b6e4f;color:#fff;font:inherit;cursor:pointer}</style></head><body>${body}</body></html>`;
pub.get('/t/:token', async (req, res) => {
  try { const to = await outreach.trackClick(req.params.token); res.redirect(to || '/app/biller.html'); } catch (_e) { res.redirect('/app/biller.html'); }
});
pub.get('/u/:token', async (req, res) => {
  const r = await outreach.optOut(req.params.token, 'unsubscribe_link').catch(() => ({ ok: false }));
  res.send(page('Unsubscribed', r.ok ? '<h2>You are unsubscribed</h2><p>We will not contact you again. Sorry for the interruption.</p>' : '<h2>Link not recognised</h2><p>If you still receive messages from us, reply STOP or write to us and we will remove you.</p>'));
});
pub.get('/feedback', (req, res) => res.send(page('What should we add?', `<h2>What would you want added?</h2><p>Tell us what your team needs from the sandbox. Every answer is read by the founders.</p><form method="post" action="/o/feedback"><input type="hidden" name="token" value="${esc(req.query.t || '')}"><label>Your name<input name="name"></label><label>Organisation<input name="org"></label><label>Email (optional)<input name="email" type="email"></label><label>What would you want added or changed?<textarea name="wants" rows="6" required></textarea></label><button>Send</button></form>`)));
pub.post('/feedback', limiter(10, 60000), async (req, res) => {
  try { await outreach.submitFeedback(req.body || {}); res.send(page('Thank you', '<h2>Thank you</h2><p>We have your feedback and will come back to you.</p>')); }
  catch (e) { res.status(e.status || 500).send(page('Could not send', `<h2>Could not send</h2><p>${esc(e.message)}</p>`)); }
});

// ---- referral programme (public; the personal code in the URL is the credential)
const closed = (res) => res.status(404).send(page('Not open', '<h2>The referral programme is not open yet</h2><p>Please check back soon.</p>'));
const STAGE = { introduced: 'Introduced', replied: 'Replied', sandbox: 'Trying the sandbox', meeting: 'In a meeting', partner: 'Partner', declined: 'Declined', removed: 'Removed' };
async function referrerPage(code, flash) {
  const s = await outreach.referralStats(code);
  const tiers = s.tiers.map((t) => `<li><b>${esc(t.label)}</b> from ${t.at} point${t.at === 1 ? '' : 's'}${t.reward ? ': ' + esc(t.reward) : ''}</li>`).join('');
  const rows = s.intros.length ? `<table style="width:100%;border-collapse:collapse">${s.intros.map((i) => `<tr><td>${esc(i.first)} · ${esc(i.org)}</td><td>${esc(STAGE[i.stage] || i.stage)}</td><td>${i.points} pt</td></tr>`).join('')}</table>` : '<p class="m">No introductions yet.</p>';
  return page('Refer a colleague', `<h2>Hello ${esc(s.name)}</h2>${flash ? `<p style="background:#e8f5ee;padding:10px;border-radius:8px">${esc(flash)}</p>` : ''}
<p>Know a bank, insurer, hospital or software team that should see embedded savings, micro-credit and claims adjudication? Share your link or introduce someone.</p>
<p><b>Your share link</b><input readonly value="${esc(s.shareLink)}" onclick="this.select()"></p>
<p><b>${s.points}</b> point${s.points === 1 ? '' : 's'} · ${s.clicks} link visit${s.clicks === 1 ? '' : 's'}${s.tier ? ' · ' + esc(s.tier.label) : ''}${s.next ? ` · next: ${esc(s.next.label)} at ${s.next.at}` : ''}</p>
<h3>Introduce a colleague</h3><form method="post" action="/o/refer/${esc(s.code)}/intro"><label>Their name<input name="name" required></label><label>Their role<input name="role"></label><label>Work email<input name="email" type="email" required></label><label>Organisation<input name="org" required></label>
<label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="attest" value="yes" style="width:auto;margin-top:6px" required> I know this person and a short business introduction from me is welcome.</label><button>Send introduction</button></form>
<p class="m">They receive one short email naming you, with a one-click opt-out. Please only introduce people you know.</p>
<h3>Your introductions</h3>${rows}<h3>Points and tiers</h3><p>${esc(String(s.pointsTable.replied))} for a reply, ${esc(String(s.pointsTable.sandbox))} for trying the sandbox, ${esc(String(s.pointsTable.meeting))} for a meeting, ${esc(String(s.pointsTable.partner))} when their organisation becomes a partner.</p><ul>${tiers}</ul>${s.rewards.length ? `<p>Rewards given: ${s.rewards.map((r) => esc(r.note)).join('; ')}</p>` : ''}${s.terms ? `<h3>Terms</h3><p>${esc(s.terms)}</p>` : ''}`);
}
pub.get('/r/:code', async (req, res) => {
  try { const to = await outreach.trackReferralClick(req.params.code); res.redirect(to || '/app/biller.html'); } catch (_e) { res.redirect('/app/biller.html'); }
});
pub.get('/refer', async (_req, res) => {
  if (!(await outreach.publicConfig()).referral.enabled) return closed(res);
  res.send(page('Join the referral programme', '<h2>Become a referral partner</h2><p>Get a personal link, introduce banks, insurers, hospitals and software teams to the sandbox, and earn recognition as they engage.</p><form method="post" action="/o/refer"><label>Your name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Organisation<input name="org"></label><button>Get my link</button></form>'));
});
pub.post('/refer', limiter(6, 60000), async (req, res) => {
  try { const r = await outreach.joinAsPartner(req.body || {}); res.redirect(`/o/refer/${r.code}`); }
  catch (e) { res.status(e.status || 500).send(page('Could not join', `<h2>Could not join</h2><p>${esc(e.message)}</p>`)); }
});
pub.get('/refer/:code', async (req, res) => {
  try { if (!(await outreach.publicConfig()).referral.enabled) return closed(res); res.send(await referrerPage(req.params.code, req.query.sent ? 'Thank you. Your introduction is queued and goes out in the next sending window.' : '')); }
  catch (e) { res.status(e.status || 500).send(page('Not found', '<h2>Link not recognised</h2>')); }
});
pub.post('/refer/:code/intro', limiter(10, 60000), async (req, res) => {
  try { const r = await outreach.introduce(req.params.code, req.body || {}); res.send(await referrerPage(req.params.code, r.already ? 'That colleague is already in touch with us. Thank you!' : 'Thank you. Your introduction is queued and goes out in the next sending window.')); }
  catch (e) { res.status(e.status || 500).send(page('Could not send', `<h2>Could not send</h2><p>${esc(e.message)}</p><p><a href="/o/refer/${esc(req.params.code)}">Back</a></p>`)); }
});

// ---- community: verified contributions, gap board, leaderboard
const optList = (rows, sel) => rows.map((o) => `<option value="${esc(o.id)}"${o.id === sel ? ' selected' : ''}>${esc(o.name)}${o.country ? ' (' + esc(o.country) + ')' : ''}</option>`).join('');
async function contributePage(q, flash) {
  const gaps = await community.gapBoard({ list: q.list, cc: q.cc, limit: 200 });
  return page('Help us fill a gap', `<h2>Help us fill a gap</h2>${flash ? `<p style="background:#e8f5ee;padding:10px;border-radius:8px">${esc(flash)}</p>` : ''}
<p>Know how to reach a bank, insurer, hospital, pharmacy or software team? Add a <b>public business contact</b> (a team mailbox such as info@, sales@ or enquiries@, a switchboard number, or a named role with a public page). We check every entry against the page you give us before it is used, and we credit you with a personal referral link.</p>
<form method="post" action="/o/contribute"><fieldset style="border:1px solid #cfd6df;border-radius:8px;margin:0 0 12px"><legend>About you</legend>
<label>Your name<input name="sname" required></label><label>Your email (never shown, used to credit and reach you)<input name="semail" type="email" required></label><label>Your organisation (optional)<input name="sorg"></label><label>Your connection to the target (optional)<input name="srelation" placeholder="customer, employee, supplier, student..."></label></fieldset>
<fieldset style="border:1px solid #cfd6df;border-radius:8px;margin:0 0 12px"><legend>The contact</legend>
<label>Organisation from our list<select name="orgId" style="width:100%;padding:9px;margin:4px 0 12px"><option value="">Not in the list (type it below)</option>${optList(gaps.rows, q.org)}</select></label>
<label>or organisation name<input name="orgName"></label><label>Country of the office<input name="country" placeholder="Ghana, South Africa, United States..."></label>
<label>If it is an office abroad: office country and city (optional)<input name="officeCountry" placeholder="United States"><input name="city" placeholder="City"></label>
<label>Name (leave blank for a team mailbox)<input name="cname"></label><label>Role or desk<input name="role" placeholder="sales, enquiries, claims, product..."></label>
<label>Work or team email<input name="cemail" type="email"></label><label>Public phone numbers (with country code, comma-separated)<input name="phones" placeholder="+233 30 222 3333, +233 24 111 2222"></label><label>LinkedIn page (optional)<input name="linkedin"></label></fieldset>
<label>The public page where you found it (required, we will open it)<input name="source" required placeholder="https://..."></label>
<label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="attest" value="yes" style="width:auto;margin-top:6px" required> These are business contact details published on the page above; I am not sharing anyone's private details.</label><button>Submit for verification</button></form>
<p class="m" style="font-size:13px;color:#5b6675">${gaps.total} organisations still have no contact. <a href="/o/community">See the community board</a>.</p>`);
}
pub.get('/contribute', async (req, res) => { try { res.send(await contributePage(req.query || {}, '')); } catch (e) { res.status(500).send(page('Error', '<h2>Something went wrong</h2>')); } });
pub.post('/contribute', limiter(8, 60000), async (req, res) => {
  const b = req.body || {};
  try {
    const r = await community.submitContribution({ submitter: { name: b.sname, email: b.semail, org: b.sorg, relation: b.srelation }, attest: b.attest, source: b.source,
      target: { orgId: b.orgId, orgName: b.orgName, country: b.country, officeCountry: b.officeCountry, city: b.city, name: b.cname, role: b.role, email: b.cemail, phones: b.phones, linkedin: b.linkedin } });
    const base = String((await outreach.publicConfig()).publicBaseUrl || '').replace(/\/$/, '');
    res.send(page('Thank you', `<h2>Thank you</h2><p>Your entry is waiting for verification. Every verified contact earns you recognition.</p><p><b>Your personal link</b><input readonly value="${esc(base)}/o/r/${esc(r.code)}" onclick="this.select()"></p><p><a href="/o/refer/${esc(r.code)}">Your referral page</a> · <a href="/o/contribute">Add another</a></p>`));
  } catch (e) { res.status(e.status || 500).send(page('Could not submit', `<h2>Could not submit</h2><p>${esc(e.message)}</p><p><a href="javascript:history.back()">Back</a></p>`)); }
});
pub.get('/community', async (_req, res) => {
  const [lb, gaps] = await Promise.all([community.leaderboard(15), community.gapBoard({ limit: 40 })]);
  res.send(page('Community board', `<h2>Our community</h2><p>People who help us reach the right teams. <a href="/o/contribute">Add a contact</a> · <a href="/o/refer">Join the referral programme</a></p>
<h3>Top contributors</h3>${lb.length ? `<ol>${lb.map((x) => `<li>${esc(x.name)}${x.org ? ' · ' + esc(x.org) : ''}: ${x.points} point${x.points === 1 ? '' : 's'}${x.tier ? ' · ' + esc(x.tier) : ''}</li>`).join('')}</ol>` : '<p>Be the first.</p>'}
<h3>Where we need help (${gaps.total} without a contact)</h3><ul>${gaps.rows.map((o) => `<li><a href="/o/contribute?org=${encodeURIComponent(o.id)}">${esc(o.name)}</a> <span class="m">${esc(o.country)}</span></li>`).join('')}</ul>`));
});

// ---- invite widget (any page, any allowed origin) and its JSON API
const ORIGINS = () => String(process.env.WIDGET_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
pub.use('/api', (req, res, next) => {
  const o = req.headers.origin; if (o && ORIGINS().includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS'); }
  if (req.method === 'OPTIONS') return res.status(204).end(); next();
});
const readPublic = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', f), 'utf8');
pub.get('/widget.js', (_q, res) => { res.type('application/javascript'); res.set('Cache-Control', 'public, max-age=300'); res.send(readPublic('refer-widget.js')); });
const jwrap = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { if (!e.status) console.error('[outreach-widget]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' }); } };
pub.post('/api/me', limiter(10, 60000), jwrap((req) => community.widgetMe(req.body || {})));
pub.post('/api/invite', limiter(20, 60000), jwrap((req) => community.widgetInvite(req.body || {})));

// ---- Product Lab working groups (public room; the member token is the credential)
pub.get('/lab/:code', async (req, res) => { try { await lab.publicInfo(req.params.code); res.type('text/html'); res.send(readPublic('lab.html')); } catch (_e) { res.status(404).send(page('Not found', '<h2>Group not found</h2>')); } });
pub.get('/api/lab/:code', jwrap((req) => lab.publicInfo(req.params.code)));
pub.post('/api/lab/:code/join', limiter(10, 60000), jwrap((req) => lab.join(req.params.code, req.body || {})));
pub.get('/api/lab/:code/view', jwrap((req) => lab.view(req.params.code, req.query.m)));
pub.post('/api/lab/:code/post', limiter(30, 60000), jwrap((req) => lab.post(req.params.code, (req.body || {}).m, (req.body || {}).text)));
pub.post('/api/lab/:code/idea', limiter(10, 60000), jwrap((req) => lab.addIdea(req.params.code, (req.body || {}).m, req.body || {})));
pub.post('/api/lab/:code/vote', limiter(60, 60000), jwrap((req) => lab.vote(req.params.code, (req.body || {}).m, (req.body || {}).ideaId)));
module.exports = { admin, pub };
