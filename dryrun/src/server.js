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
const { err, wrap } = require('./util');

const app = express();
app.use(express.json({ limit: '25mb' })); app.use(express.text({ type: 'text/csv', limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'dry-run', hnnConnected: hnn.configured() }));
app.get('/api/packs', (req, res) => res.json(packs.list()));
app.get('/api/packs/:key', (req, res) => res.json(packs.detail(req.params.key)));


const siteUrl = (req) => (process.env.DRYRUN_PUBLIC_URL || `${req.get('x-forwarded-proto') || 'http'}://${req.get('host')}`).replace(/\/$/, '');
/** Send sign-in details on the chosen channels. Never throws; the key is still returned to the caller so nothing is lost if a send fails. */
async function sendCreds(req, { org, orgId, phone, key, role, by, deliver, adminAppointment }) {
  const channels = { sms: !!(deliver && deliver.sms), whatsapp: !!(deliver && deliver.whatsapp) };
  if (!channels.sms && !channels.whatsapp) return [];
  const text = adminAppointment ? messaging.adminText(org, siteUrl(req), key) : messaging.memberText(org, by, role, siteUrl(req), key);
  return messaging.deliver({ phone, channels, text, orgId, orgName: org, who: role, purpose: adminAppointment ? 'admin appointment' : 'team invite' });
}

// ---- public: survey pages (no sign-in) ------------------------------------------------------------------------------------------
app.get('/api/public/survey/:token', wrap(async (req, res) => res.json(await surveys.publicView(req.params.token))));
app.post('/api/public/survey/:token', wrap(async (req, res) => res.status(201).json(await surveys.submit(req.params.token, (req.body || {}).answers, req.get('x-forwarded-for') || req.headers.host || 'x'))));

// ---- platform owner ------------------------------------------------------------------------------------------------------------
const platformOnly = (req, res, next) => { const a = orgs.authenticate(req); if (!a.platform) throw err(403, 'Platform owner only.'); next(); };
const P = express.Router(); P.use(platformOnly);
P.get('/orgs', (req, res) => res.json(orgs.list()));
P.post('/orgs', wrap(async (req, res) => {
  const r = orgs.create(req.body, packs);
  const delivery = await sendCreds(req, { org: r.org.name, orgId: r.org.id, phone: req.body.adminPhone, key: r.admin.apiKey, role: 'admin', deliver: req.body.deliver, adminAppointment: true });
  res.status(201).json({ ...r, delivery, signInUrl: siteUrl(req) });
}));
P.get('/directory', (req, res) => res.json(orgs.directory()));
P.get('/messaging', (req, res) => res.json({ configured: messaging.status(), recent: messaging.history(null, 50) }));
P.post('/orgs/:id/members/:mid/resend', wrap(async (req, res) => {
  const o = orgs.raw(req.params.id); const m = orgs.memberRaw(req.params.id, req.params.mid); if (!m.phone) throw err(422, 'This person has no phone number on file.');
  const k = orgs.rotateKey(req.params.id, m.id);
  const delivery = await sendCreds(req, { org: o.name, orgId: o.id, phone: m.phone, key: k.apiKey, role: m.role, by: 'the platform owner', deliver: req.body.deliver || { sms: true }, adminAppointment: m.role === 'admin' });
  res.json({ ...k, delivery });
}));
P.get('/orgs/:id', (req, res) => res.json(orgs.get(req.params.id)));
P.patch('/orgs/:id/plan', (req, res) => res.json(orgs.setPlan(req.params.id, req.body)));
P.get('/config', (req, res) => res.json(orgs.platformConfig()));
P.patch('/config', (req, res) => res.json(orgs.setPlatformConfig(req.body)));
P.get('/live', wrap(async (req, res) => res.json(await live.all())));
P.patch('/live/:orgId/:id', wrap(async (req, res) => res.json(await live.setTerms(req.params.orgId, req.params.id, req.body))));
app.use('/api/platform', P);

// ---- an organisation's own workspace -------------------------------------------------------------------------------------------
const O = express.Router();
O.use((req, res, next) => {
  const a = orgs.authenticate(req); if (a.platform) throw err(403, 'Use a member key for workspace routes. The platform owner manages organisations under /api/platform.');
  req.org = a.org; req.actor = { id: a.member.id, name: a.member.name, role: a.member.role }; req.role = a.member.role; next();
});
const need = (action) => (req, res, next) => { if (!orgs.can(req.role, action)) throw err(403, `Your role (${req.role}) cannot do this.`); next(); };
const oid = (req) => req.org.id;

O.get('/', (req, res) => res.json({ me: req.actor, org: orgs.get(oid(req)), pack: packs.detail(req.org.pack) }));
O.get('/team', need('read'), (req, res) => res.json(orgs.members(oid(req))));
O.post('/team', need('team'), wrap(async (req, res) => {
  const m = orgs.addMember(oid(req), req.body, req.actor.name);
  const deliver = req.body.deliver || (req.body.phone ? { sms: true, whatsapp: true } : {});
  const delivery = req.body.phone ? await sendCreds(req, { org: req.org.name, orgId: oid(req), phone: req.body.phone, key: m.apiKey, role: m.role, by: req.actor.name, deliver }) : [];
  res.status(201).json({ ...m, delivery });
}));
O.get('/messaging', need('read'), (req, res) => res.json({ configured: messaging.status(), recent: messaging.history(oid(req), 30) }));
O.patch('/team/:mid', need('team'), (req, res) => res.json(orgs.setRole(oid(req), req.params.mid, req.body.role)));
O.delete('/team/:mid', need('team'), (req, res) => res.json(orgs.removeMember(oid(req), req.params.mid)));
O.post('/team/:mid/rotate-key', need('team'), wrap(async (req, res) => {
  const m = orgs.memberRaw(oid(req), req.params.mid); const k = orgs.rotateKey(oid(req), m.id);
  const delivery = m.phone && req.body && req.body.deliver ? await sendCreds(req, { org: req.org.name, orgId: oid(req), phone: m.phone, key: k.apiKey, role: m.role, by: req.actor.name, deliver: req.body.deliver }) : [];
  res.json({ ...k, delivery });
}));
O.patch('/settings', need('settings'), (req, res) => res.json(orgs.settings(oid(req), req.body)));
O.get('/storage', need('read'), (req, res) => res.json(store.describe(req.org.storage)));
O.put('/storage', need('settings'), wrap(async (req, res) => res.json(await orgs.setStorage(oid(req), req.body))));

O.get('/assets', need('read'), wrap(async (req, res) => res.json(await assets.list(oid(req), req.query.kind))));
O.post('/assets', need('write'), wrap(async (req, res) => res.status(201).json(await assets.create(oid(req), req.actor, req.body))));
O.get('/assets/:id', need('read'), wrap(async (req, res) => res.json(await assets.detail(oid(req), req.params.id, { withData: req.query.data === '1' }))));
O.post('/assets/:id/versions', need('write'), wrap(async (req, res) => res.status(201).json(await assets.addVersion(oid(req), req.actor, req.params.id, req.body))));
O.post('/assets/:id/promote', need('promote'), wrap(async (req, res) => res.json(await assets.promote(oid(req), req.actor, req.role, req.params.id, req.body.version, req.body.to, req.body.note))));
O.get('/assets/:id/export', need('read'), wrap(async (req, res) => res.json(await assets.exportApproved(oid(req), req.actor, req.params.id))));
O.post('/upload', need('write'), wrap(async (req, res) => res.status(201).json(await assets.upload(oid(req), req.actor, req.body))));

O.post('/runs', need('run'), wrap(async (req, res) => res.status(201).json(await engine.run(oid(req), req.actor, req.role, req.body))));
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
O.post('/surveys/:id/invite', need('write'), wrap(async (req, res) => { const s = (await surveys.list(oid(req))).find((x) => x.id === req.params.id); if (!s) throw err(404, 'Unknown survey.'); res.json(await surveys.invite(oid(req), req.actor, req.params.id, `${siteUrl(req)}/s.html?t=${encodeURIComponent(s.token)}`, req.body)); }));

O.get('/live', need('read'), wrap(async (req, res) => res.json(await live.list(oid(req)))));
O.post('/live', need('approve'), wrap(async (req, res) => res.status(201).json(await live.create(oid(req), req.actor, req.role, req.body))));
O.get('/live/:id', need('read'), wrap(async (req, res) => res.json(await live.get(oid(req), req.params.id))));
O.post('/live/:id/status', need('approve'), wrap(async (req, res) => res.json(await live.setStatus(oid(req), req.actor, req.role, req.params.id, req.body.status, req.body.note))));
O.post('/live/:id/actuals', need('write'), wrap(async (req, res) => res.json(await live.addActuals(oid(req), req.actor, req.role, req.params.id, req.body.periods || req.body))));
O.post('/live/:id/notes', need('write'), wrap(async (req, res) => res.json(await live.addNote(oid(req), req.actor, req.role, req.params.id, req.body.note))));

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
app.use((e, req, res, next) => { const s = e.status || 500; if (s === 500) console.error(e); res.status(s).json({ error: s === 500 ? 'Something went wrong on our side.' : e.message }); });

module.exports = app;
if (require.main === module) { const port = process.env.PORT || 4100; app.listen(port, () => console.log(`Dry Run listening on ${port}`)); }
