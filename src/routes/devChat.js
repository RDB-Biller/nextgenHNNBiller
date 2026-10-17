'use strict';

const express = require('express');
const chat = require('../services/devChat');
const { limiter } = require('../middleware/rateLimit');

/**
 * /chat/api   - developer chat for web clients (CORS *, bearer participant token)
 * /chat-hooks - WhatsApp inbound callback (secret in the path, rotatable in Master Control)
 */
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (!e.status) console.error('[devchat]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' });
  }
};
const authed = (fn) => wrap(async (req, res) => fn(req, res, await chat.authenticate(req.get('authorization'))));

const api = express.Router();
api.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
api.use(express.json({ limit: '50kb' }));
api.use(limiter(600, 60000));

api.get('/status', wrap(async (_req, res) => res.json({ enabled: (await chat.getConfig()).enabled })));
api.post('/join', limiter(10, 60000), wrap(async (req, res) => res.status(201).json(await chat.join(req.body || {}))));
api.get('/me', authed(async (_req, res, p) => res.json(await chat.roster(p))));
api.patch('/me', authed(async (req, res, p) => res.json({ me: await chat.setLanguage(p, (req.body || {}).lang) })));
api.get('/messages', authed(async (req, res, p) => res.json(await chat.list(p, { since: req.query.since }))));
api.post('/messages', authed(async (req, res, p) => res.status(201).json(await chat.post(p, (req.body || {}).text))));
api.post('/whatsapp', limiter(5, 60000), authed(async (req, res, p) => res.json(await chat.linkWhatsApp(p, (req.body || {}).phone))));
api.delete('/whatsapp', authed(async (_req, res, p) => res.json(await chat.unlinkWhatsApp(p))));
api.post('/leave', authed(async (_req, res, p) => res.json(await chat.leave(p))));

const hooks = express.Router();
hooks.use(express.urlencoded({ extended: false, limit: '100kb' }));
hooks.use(express.json({ limit: '100kb' }));
hooks.use('/:secret', async (req, res, next) => {
  try { if (!(await chat.checkHookSecret(req.params.secret))) return res.status(404).end(); next(); } catch (e) { next(e); }
});
hooks.get('/:secret/whatsapp', (_req, res) => res.json({ ok: true }));
hooks.post('/:secret/whatsapp', async (req, res, next) => {
  try { res.json(await chat.inboundWhatsApp(req.body || {})); }
  catch (e) { if (e.status) return res.json({ ok: false, error: e.message }); next(e); }
});

module.exports = { api, hooks };
