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
module.exports = { admin, pub };
