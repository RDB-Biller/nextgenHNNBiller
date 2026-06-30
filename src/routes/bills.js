'use strict';

const express = require('express');
const store = require('../store');
const { createBill } = require('../services/billing');
const { routeToPayer } = require('../services/claims');

const router = express.Router();
async function ownBill(req) {
  const b = await store.bills.get(req.params.id);
  return b && b.tenantId === req.tenant.id ? b : null;
}

router.post('/', async (req, res, next) => {
  try {
    const bill = createBill(req.body || {});
    bill.tenantId = req.tenant.id;
    await store.bills.insert(bill);
    res.status(201).json(bill);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const b = await ownBill(req);
    return b ? res.json(b) : res.status(404).json({ error: 'bill_not_found' });
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try { res.json({ data: await store.bills.listByTenant(req.tenant.id) }); }
  catch (e) { next(e); }
});

router.post('/:id/route', async (req, res, next) => {
  try {
    const bill = await ownBill(req);
    if (!bill) return res.status(404).json({ error: 'bill_not_found' });
    const payerId = req.body.payerId || req.body.insurerId || bill.coverage.payerId;
    const { claim } = await routeToPayer(bill, payerId);
    res.status(201).json({ claim, payerLink: claim.link });
  } catch (e) { next(e); }
});

module.exports = router;
