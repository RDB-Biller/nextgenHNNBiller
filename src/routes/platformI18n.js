'use strict';

const express = require('express');
const i18n = require('../services/i18n');
const chat = require('../services/devChat');

/** Master Control: languages / LibreTranslate settings and developer chat rooms. Mounted behind authPlatform. */
const r = express.Router();
r.use(express.json({ limit: '50kb' }));
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (!e.status) console.error('[platform-i18n]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' });
  }
};
const who = (req) => (req.principal && req.principal.id) || 'platform';
const base = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`);

r.get('/', wrap(async (req, res) => res.json({
  translation: await i18n.publicConfig(), machine: await i18n.status(),
  chat: await chat.publicConfig(base(req)), rooms: await chat.listRooms(),
  languages: i18n.LANGUAGES.map(({ code, name, native, rtl, reviewed }) => ({ code, name, native, rtl, reviewed })),
})));
r.put('/translation', wrap(async (req, res) => res.json(await i18n.setConfig(req.body || {}, who(req)))));
r.post('/translation/test', wrap(async (_req, res) => res.json(await i18n.testConnection())));
r.put('/chat', wrap(async (req, res) => res.json(await chat.setEnabled((req.body || {}).enabled, who(req)))));
r.post('/chat/rotate-hook', wrap(async (req, res) => { await chat.rotateHookSecret(); res.json(await chat.publicConfig(base(req))); }));
r.post('/rooms', wrap(async (req, res) => res.status(201).json(await chat.createRoom(req.body || {}, who(req)))));
r.post('/rooms/:id/rotate-code', wrap(async (req, res) => res.json(await chat.rotateCode(req.params.id))));
r.post('/rooms/:id/archive', wrap(async (req, res) => res.json(await chat.archiveRoom(req.params.id, (req.body || {}).archived !== false))));
module.exports = r;
