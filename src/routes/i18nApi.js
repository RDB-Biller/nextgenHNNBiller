'use strict';

const express = require('express');
const i18n = require('../services/i18n');
const { limiter } = require('../middleware/rateLimit');

/**
 * Public language API (CORS *) used by every Biller page, the Afriyie app and any
 * connected application:
 *   GET  /i18n/api/languages[?audience=patient]  language list (RTL / reviewed flags)
 *   GET  /i18n/api/catalog/:lang                 UI strings, English filled in for gaps
 *   POST /i18n/api/translate {texts[], from?, to}  machine translation (LibreTranslate), cached
 *   GET  /i18n/api/status                        is machine translation available?
 */
const r = express.Router();
r.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
r.use(express.json({ limit: '200kb' }));
r.use(limiter(240, 60000));
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (!e.status) console.error('[i18n-api]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' });
  }
};

r.get('/languages', wrap(async (req, res) => res.json({ default: i18n.DEFAULT_LANG, languages: await i18n.listLanguages({ audience: req.query.audience }) })));
r.get('/catalog/:lang', wrap(async (req, res) => {
  if (!i18n.isKnown(req.params.lang)) return res.status(404).json({ error: 'unknown_language' });
  res.set('Cache-Control', 'public, max-age=300');
  res.json(i18n.catalog(req.params.lang));
}));
r.get('/status', wrap(async (_req, res) => {
  const s = await i18n.status();
  res.json({ machineTranslation: s.configured && s.enabled && s.reachable, machineLanguages: s.machineLanguages });
}));
r.post('/translate', limiter(20, 60000), wrap(async (req, res) => {
  const { texts, from, to } = req.body || {};
  if (!Array.isArray(texts) || !texts.length || texts.length > 40) return res.status(422).json({ error: 'texts must be an array of 1-40 strings' });
  if (!i18n.isKnown(to)) return res.status(422).json({ error: 'unknown_target_language' });
  const out = [];
  for (const x of texts) {
    const r2 = await i18n.translate(String(x || '').slice(0, 2000), from || 'en', to);
    out.push({ text: r2.text, translated: r2.ok && r2.from !== r2.to && r2.reason !== 'nothing-to-translate', reason: r2.ok ? undefined : r2.reason });
  }
  res.json({ to: i18n.normalise(to), results: out });
}));
module.exports = r;
