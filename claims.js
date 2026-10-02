'use strict';

const express = require('express');
const store = require('../store');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try { res.json({ data: await store.claims.listByTenant(req.tenant.id) }); }
  catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const c = await store.claims.get(req.params.id);
    if (!c || c.tenantId !== req.tenant.id) return res.status(404).json({ error: 'claim_not_found' });
    res.json({ claim: c, bill: await store.bills.get(c.billId) });
  } catch (e) { next(e); }
});

module.exports = router;
