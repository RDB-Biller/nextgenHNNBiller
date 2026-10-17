'use strict';

const express = require('express');
const erheat = require('../services/erheat');
const accounts = require('../services/patientAccounts');
const i18n = require('../services/i18n');
const { limiter } = require('../middleware/rateLimit');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (!e.status) console.error('[erheat]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong. Please try again.' });
  }
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const authed = (fn) => wrap(async (req, res) => fn(req, res, await accounts.authenticate(req.get('authorization'))));

// ---- borrower API for the TrimesterSave app (patient account token). The app holds no rules.
const api = express.Router();
api.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS'); res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end(); next();
});
api.use(express.json({ limit: '200kb' }));
api.use(limiter(120, 60000));
api.get('/lines', wrap(async (req, res) => {
  let phone = null; if (req.get('authorization')) { try { phone = (await accounts.authenticate(req.get('authorization'))).phone; } catch (_e) { /* anonymous catalogue */ } }
  res.json({ result: await erheat.lines(phone) });
}));
api.get('/health/facilities', wrap(async (_q, res) => res.json({ result: await erheat.healthFacilities() })));
api.get('/health/pending', authed(async (_q, res, a) => res.json({ result: await erheat.healthPending(a) })));
api.get('/profile', authed(async (_q, res, a) => res.json({ result: await erheat.getProfile(a) })));
api.put('/profile', authed(async (req, res, a) => res.json({ result: await erheat.saveProfile(a, req.body || {}) })));
api.get('/history', authed(async (_q, res, a) => res.json({ result: await erheat.awardedHistory(a) })));
api.get('/passport', authed(async (_q, res, a) => res.json({ result: await erheat.passport(a.phone) })));
api.get('/apps', authed(async (_q, res, a) => res.json({ result: await erheat.myApps(a) })));
api.post('/apply', limiter(10, 60000), authed(async (req, res, a) => res.status(201).json({ result: await erheat.apply(a, req.body || {}) })));
api.get('/apps/:id', authed(async (req, res, a) => res.json({ result: await erheat.getMine(a, req.params.id) })));
api.post('/apps/:id/consent', limiter(10, 60000), authed(async (req, res, a) => res.json({ result: await erheat.consent(a, req.params.id, { agree: (req.body || {}).agree, ip: req.ip }) })));
api.post('/apps/:id/cancel', authed(async (req, res, a) => res.json({ result: await erheat.cancel(a, req.params.id) })));
api.post('/apps/:id/resend/:vid', limiter(5, 60000), authed(async (req, res, a) => res.json({ result: await erheat.resendVerifier(a, req.params.id, req.params.vid) })));

// ---- verifier pages (no app, no account): the one-time link in the SMS is the credential
const pages = express.Router();
pages.use(express.urlencoded({ extended: false, limit: '20kb' }));
pages.use(express.json({ limit: '20kb' }));
pages.use(limiter(120, 60000));
const CSS = 'body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:6vh auto;padding:0 16px;color:#17202b}input,select{width:100%;padding:9px;border:1px solid #cfd6df;border-radius:8px;font:inherit;margin:4px 0 12px}button{padding:11px 16px;border:0;border-radius:8px;background:#0b6e4f;color:#fff;font:inherit;cursor:pointer;margin-right:8px}button.no{background:#8a2c2c}.card{border:1px solid #cfd6df;border-radius:12px;padding:14px;margin:12px 0}.m{color:#5b6675;font-size:13px}';
const shell = (title, body, lang) => `<!doctype html><html lang="${esc(lang || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}<script src="/o/widget.js" defer></script></body></html>`;
async function tr(text, lang) { if (!lang || lang === 'en') return text; try { const r = await i18n.translate(text, 'en', lang); return r && r.ok ? r.text : text; } catch (_e) { return text; } }
async function verifierPage(tok, flash) {
  const v = await erheat.verifierView(tok); const L = v.lang;
  const T = async (s) => esc(await tr(s, L));
  const rows = [['Request', v.appNo], ['Amount', `GHS ${v.amount.toFixed(2)}`], ['Payee', v.payeeName], ...v.fields.map((f) => [f.label, f.value])].map(([k, x]) => `<tr><td class="m">${esc(k)}</td><td><b>${esc(x)}</b></td></tr>`).join('');
  const head = `<h2>${await T('ERHEAT Shield: please confirm')}</h2>${flash ? `<p class="card">${esc(flash)}</p>` : ''}`;
  if (!v.open) return shell('ERHEAT Shield', `${head}<p>${await T(v.status === 'confirmed' ? 'Thank you, you have confirmed this request.' : 'This request is closed or was already answered.')}</p>`, L);
  return shell('ERHEAT Shield', `${head}<div class="card"><p>${esc(await tr(v.question, L))}</p><table>${rows}</table></div>
<form method="post"><label>${await T('If a different amount is due, enter it (optional)')}<input name="confirmedAmount" type="number" step="0.01" min="1"></label>
${v.askAccountName ? `<label>${await T('Name on the mobile money or bank account that should receive the money')}<input name="accountName"></label>` : ''}
<label>${await T('Note (optional)')}<input name="note" maxlength="200"></label>
<button name="decision" value="confirm">${await T('Yes, confirm')}</button><button class="no" name="decision" value="decline">${await T('No, I do not know this person')}</button></form>
<p class="m">${await T('We only use your answer to verify this request. If you did not expect it, choose No.')}</p>`, L);
}
pages.get('/v/:token', async (req, res) => { try { res.send(await verifierPage(req.params.token)); } catch (e) { res.status(e.status || 500).send(shell('Not found', `<h2>${esc(e.message)}</h2>`)); } });
pages.post('/v/:token', limiter(20, 60000), async (req, res) => {
  try { const b = req.body || {}; const r = await erheat.verifierRespond(req.params.token, { ...b, ip: req.ip }); res.send(await verifierPage(req.params.token, r.status === 'declined' ? 'Thank you. We have recorded that you do not know this request.' : 'Thank you. Your confirmation is recorded.')); }
  catch (e) { res.status(e.status || 500).send(shell('Could not save', `<h2>${esc(e.message)}</h2>`)); }
});
pages.get('/redeem', (_q, res) => res.send(shell('Redeem a voucher', `<h2>Redeem an ERHEAT voucher</h2><form method="post" action="/erheat/redeem"><label>Voucher code<input name="code" required></label><label>Customer one-time code<input name="otp" required inputmode="numeric"></label><label>Your registered phone number<input name="phone" required></label><button>Redeem</button></form><p class="m">Release the goods or service only after this page confirms the voucher.</p>`)));
pages.post('/redeem', limiter(15, 60000), async (req, res) => {
  const wantsJson = /json/.test(req.get('content-type') || '');
  try { const r = await erheat.redeem(req.body || {}); if (wantsJson) return res.json(r); res.send(shell('Redeemed', `<h2>Voucher accepted</h2><p>GHS ${esc(r.amount.toFixed(2))} for ${esc(r.payee)}. ${esc(r.note)}</p>`)); }
  catch (e) { if (wantsJson) return res.status(e.status || 500).json({ error: e.message }); res.status(e.status || 500).send(shell('Could not redeem', `<h2>${esc(e.message)}</h2><p><a href="/erheat/redeem">Try again</a></p>`)); }
});

// ---- lender hooks: the secret in the path is the credential
const hooks = express.Router();
hooks.use(express.json({ limit: '100kb' }));
hooks.use(limiter(120, 60000));
hooks.use('/:secret', async (req, res, next) => { try { if (!(await erheat.checkSecret(req.params.secret))) return res.status(404).json({ error: 'not_found' }); return next(); } catch (e) { return next(e); } });
hooks.post('/:secret/decision', wrap(async (req, res) => res.json(await erheat.recordDecision(req.body || {}))));
hooks.post('/:secret/paid', wrap(async (req, res) => res.json(await erheat.recordPaid(req.body || {}))));
hooks.post('/:secret/repayment', wrap(async (req, res) => res.json(await erheat.recordRepayment(req.body || {}))));
hooks.get('/:secret/applications/:no', wrap(async (req, res) => res.json(await erheat.packetByAppNo(req.params.no))));

// ---- Master Control
const admin = express.Router();
admin.use(express.json({ limit: '100kb' }));
admin.get('/config', wrap(async (req, res) => res.json({ config: await erheat.getConfig(), lines: Object.fromEntries(Object.entries(erheat.LINES).map(([k, l]) => [k, { label: l.label, verifier: l.verifierLabel, voucher: l.voucher }])), hookUrls: await erheat.hookUrls(`${req.protocol}://${req.get('host')}`), hardCap: erheat.HARD_CAP })));
admin.put('/config', wrap(async (req, res) => res.json({ config: await erheat.setConfig(req.body || {}) })));
admin.post('/secret/rotate', wrap(async (req, res) => { await erheat.rotateSecret(); res.json({ hookUrls: await erheat.hookUrls(`${req.protocol}://${req.get('host')}`) }); }));
admin.get('/apps', wrap(async (req, res) => res.json(await erheat.listAll(req.query))));
admin.get('/apps/:id', wrap(async (req, res) => res.json(await erheat.adminGet(req.params.id))));
admin.post('/apps/:id/simulate', wrap(async (req, res) => res.json(await erheat.simulate(req.params.id, req.body || {}))));
module.exports = { api, pages, hooks, admin };
