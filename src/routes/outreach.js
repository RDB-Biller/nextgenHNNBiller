'use strict';

const express = require('express');
const outreach = require('../services/outreach');
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
module.exports = { admin, pub };
