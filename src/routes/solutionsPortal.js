'use strict';

const express = require('express');
const store = require('../store');
const solutions = require('../services/solutions');

/**
 * Patient-facing surface for Product Lab solutions. Unauthenticated by design
 * (a patient shouldn't need a key to compare pharmacy prices), so it is
 * deliberately narrow: only solutions that are LIVE and have 'patient' enabled
 * are reachable, only modules that list the patient surface can run, input is
 * length-capped by the module, tenant/payer-identifying detail is stripped
 * (see solutions.run for the patient branch), and each IP is rate-limited.
 */
const router = express.Router();

const hits = new Map();
const LIMIT = 30; const WINDOW_MS = 60000;
router.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip || 'unknown';
  const h = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (h.length >= LIMIT) return res.status(429).json({ error: 'rate_limited' });
  h.push(now); hits.set(key, h);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  next();
});

router.get('/', async (req, res, next) => {
  try { res.json({ data: await solutions.listFor('patient') }); } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const p = await store.products.get(req.params.id);
    if (!p || p.type !== 'solution' || p.status !== 'live' || !p.config.surfaces.includes('patient')) {
      return res.status(404).json({ error: 'solution_not_found' });
    }
    res.json(solutions.publicView(p));
  } catch (e) { next(e); }
});

router.post('/:id/run', async (req, res, next) => {
  try { res.json(await solutions.run(req.params.id, 'patient', { input: req.body?.input || req.body })); }
  catch (e) { next(e); }
});

module.exports = router;
