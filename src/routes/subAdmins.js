'use strict';

const express = require('express');
const admins = require('../services/subAdmins');

const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (!e.status) console.error('[admins]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong. Please try again.' }); } };
const hits = new Map();
const limiter = (limit, windowMs) => (req, res, next) => { const n = Date.now(); const k = (req.ip || 'x') + req.path; const h = (hits.get(k) || []).filter((t) => n - t < windowMs); if (h.length >= limit) return res.status(429).json({ error: 'Too many tries. Please wait a moment.' }); h.push(n); hits.set(k, h); next(); };

// ---- chief only: invite and manage sub-admins (mounted behind the platform key and refused for sub-admin sessions)
const admin = express.Router();
admin.use(express.json({ limit: '20kb' }));
admin.get('/', wrap(async (_q, res) => res.json({ areas: Object.entries(admins.AREAS).map(([key, a]) => ({ key, label: a.label })), presets: Object.entries(admins.PRESETS).map(([key, p]) => ({ key, label: p.label, areas: p.areas })), admins: await admins.list() })));
admin.get('/demo', wrap(async (_q, res) => res.json({ ...(await admins.demoConfig()), handle: admins.DEMO.handle, password: admins.DEMO.password })));
admin.put('/demo', wrap(async (req, res) => res.json(await admins.setDemoEnabled(!!(req.body || {}).enabled))));
admin.post('/', wrap(async (req, res) => res.status(201).json(await admins.invite(req.body || {}, (req.principal && req.principal.id) || 'chief'))));
admin.patch('/:id', wrap(async (req, res) => res.json({ account: await admins.update(req.params.id, req.body || {}) })));
admin.post('/:id/invite', wrap(async (req, res) => res.json(await admins.reinvite(req.params.id, !!(req.body || {}).sendSms))));
admin.delete('/:id', wrap(async (req, res) => res.json(await admins.remove(req.params.id))));

// ---- the sub-admin themselves (public sign-in)
const api = express.Router();
api.use(express.json({ limit: '10kb' }));
api.get('/demo', wrap(async (_q, res) => { const c = await admins.demoConfig(); res.json(c.enabled ? { enabled: true, handle: admins.DEMO.handle, password: admins.DEMO.password, note: 'Dummy credentials for a guided look. You get your own private practice copy: change anything, and only you see it. Nothing touches real data, and keys and contact details are hidden.' } : { enabled: false }); }));
api.post('/login', limiter(15, 60000), wrap(async (req, res) => res.json(await admins.login(req.body || {}))));
api.post('/accept-invite', limiter(10, 60000), wrap(async (req, res) => res.json(await admins.acceptInvite(req.body || {}))));
api.get('/me', wrap(async (req, res) => { const a = await admins.authenticate(req.get('authorization')); res.json({ account: admins.view(a) }); }));
api.post('/password', limiter(10, 60000), wrap(async (req, res) => { const a = await admins.authenticate(req.get('authorization')); res.json(await admins.changePassword(a, req.body || {})); }));
module.exports = { admin, api };
