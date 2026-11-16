'use strict';

const express = require('express');
const pb = require('../services/priceBooks');
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (!e.status) console.error('[price-books]', e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong.' }); } };

// Master Control: which price books clinics can use, the platform default, and platform-wide uploads (also open in the demo, in its private scratch copy).
const r = express.Router();
r.use(express.json({ limit: '4mb' }));
r.get('/', wrap(async (_q, res) => res.json(await pb.adminView())));
r.put('/', wrap(async (req, res) => res.json(await pb.adminSet(req.body || {}))));
r.post('/', wrap(async (req, res) => res.status(201).json(await pb.upload('platform', req.body || {}))));
r.delete('/:id', wrap(async (req, res) => res.json(await pb.remove('platform', req.params.id))));
r.get('/template.csv', (_q, res) => res.type('text/csv').set('Content-Disposition', 'attachment; filename="price-book-template.csv"').send(pb.sampleCsv()));
// Read one book with its items. Used by the Dry Run service's HNN connector (read-only).
r.get('/:id', wrap(async (req, res) => { const b = await pb.get(null, req.params.id); if (!b) return res.status(404).json({ error: 'Unknown price book.' }); res.json({ id: b.id, name: b.name, currency: b.currency, items: b.items || [] }); }));
module.exports = r;
