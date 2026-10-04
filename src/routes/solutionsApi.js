'use strict';

const express = require('express');
const solutions = require('../services/solutions');

/** Hospital-facing surface (mounted at /api/v1/solutions behind authTenant). The tenant is always the caller -- never taken from input. */
const router = express.Router();

router.get('/', async (req, res, next) => {
  try { res.json({ data: await solutions.listFor('hospital', { tenant: req.tenant }) }); } catch (e) { next(e); }
});

router.post('/:id/run', async (req, res, next) => {
  try {
    const input = { ...(req.body?.input || {}) };
    delete input.tenantId;
    res.json(await solutions.run(req.params.id, 'hospital', { tenant: req.tenant, input }));
  } catch (e) { next(e); }
});

module.exports = router;
