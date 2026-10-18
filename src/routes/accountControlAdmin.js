'use strict';

const express = require('express');
const ctl = require('../services/accountControl');

const r = express.Router();
r.use(express.json({ limit: '20kb' }));
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (!e.status) console.error('[accounts]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' }); } };
// Every account of every kind, with its state and clearances.   GET ?kind=&q=&status=&limit=
r.get('/', wrap(async (req, res) => res.json(await ctl.directory(req.query || {}))));
// Switch an account off or on, or change its clearances.  PATCH { disabled?, reason?, grants?: { productLab?, goLive? }, note? }
r.patch('/:kind/:id', wrap(async (req, res) => {
  const p = req.principal || {};
  if (p.kind === 'subadmin' && ((req.body || {}).grants || ['staff', 'subadmin'].includes(req.params.kind))) return res.status(403).json({ error: 'Only the chief administrator can change clearances or manage staff and admin accounts.' });
  res.json({ control: await ctl.update(req.params.kind, req.params.id, req.body || {}, (req.principal && req.principal.id) || 'master') });
}));
module.exports = r;
