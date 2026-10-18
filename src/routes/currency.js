'use strict';

const express = require('express');
const cur = require('../services/currencies');
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (!e.status) console.error('[currency]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' }); } };

// Public: the apps ask for the list and the rates.
const api = express.Router();
api.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Methods', 'GET,OPTIONS'); res.set('Access-Control-Allow-Headers', 'Content-Type'); if (req.method === 'OPTIONS') return res.status(204).end(); next(); });
api.get('/list', wrap(async (_q, res) => res.json({ result: await cur.publicView() })));
api.get('/convert', wrap(async (req, res) => res.json({ result: await cur.convert(req.query.amount, req.query.from || 'GHS', req.query.to || 'USD') })));

// Master Control: rates, platform default, which currencies are offered.
const admin = express.Router();
admin.use(express.json({ limit: '50kb' }));
admin.get('/', wrap(async (_q, res) => res.json({ config: await cur.config(), currencies: cur.CURRENCIES, main: cur.MAIN, seed: cur.SEED })));
admin.put('/', wrap(async (req, res) => res.json({ config: await cur.setConfig(req.body || {}, (req.principal && req.principal.id) || 'master') })));
module.exports = { api, admin };
