'use strict';

const express = require('express');
const partners = require('../services/partners');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (!e.status) console.error('[partners]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong. Please try again.' });
  }
};
const hits = new Map();
const limiter = (limit, windowMs) => (req, res, next) => { const n = Date.now(); const k = (req.ip || 'x') + req.path; const h = (hits.get(k) || []).filter((t) => n - t < windowMs); if (h.length >= limit) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' }); h.push(n); hits.set(k, h); next(); };
const authed = (fn) => wrap(async (req, res) => fn(req, res, await partners.authenticate(req.get('authorization'))));

// ---- Master Control: issue and manage partner logins
const admin = express.Router();
admin.use(express.json({ limit: '50kb' }));
admin.get('/', wrap(async (_q, res) => res.json({ sectors: Object.entries(partners.SECTORS).map(([key, s]) => ({ key, label: s.label, who: s.who, lines: s.lines })), partners: await partners.list() })));
admin.post('/', wrap(async (req, res) => res.status(201).json(await partners.create(req.body || {}, (req.principal && req.principal.id) || 'master'))));
admin.patch('/:id', wrap(async (req, res) => res.json({ account: await partners.update(req.params.id, req.body || {}) })));
admin.post('/:id/reset-password', wrap(async (req, res) => res.json(await partners.resetPassword(req.params.id, req.body || {}))));
admin.post('/:id/universal', wrap(async (req, res) => res.json({ account: await partners.setUniversal(req.params.id, !(req.body && req.body.approve === false)) })));

// ---- Partner console API (served to /app/partner.html)
const api = express.Router();
api.use(express.json({ limit: '20kb' }));
api.post('/login', limiter(15, 60000), wrap(async (req, res) => res.json(await partners.login(req.body || {}))));
api.get('/me', authed(async (_q, res, a) => res.json({ account: partners.view(a) })));
api.post('/password', limiter(10, 60000), authed(async (req, res, a) => res.json(await partners.changePassword(a, req.body || {}))));
api.post('/request-universal', authed(async (_q, res, a) => res.json({ account: await partners.requestUniversal(a) })));
api.get('/requests', authed(async (req, res, a) => res.json(await partners.requests(a, { status: req.query.status }))));
api.post('/redeem', limiter(15, 60000), authed(async (req, res, a) => res.json(await partners.redeem(a, req.body || {}))));
module.exports = { admin, api };
