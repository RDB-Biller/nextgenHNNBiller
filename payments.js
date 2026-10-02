'use strict';

const express = require('express');
const store = require('../store');
const { createPaymentIntent, charge, markPaid } = require('../services/payments');

const router = express.Router();
async function ownBill(req, res) {
  const b = await store.bills.get(req.body?.billId);
  if (!b || b.tenantId !== req.tenant.id) { res.status(404).json({ error: 'bill_not_found' }); return null; }
  return b;
}

router.post('/intents', async (req, res, next) => {
  try {
    const bill = await ownBill(req, res); if (!bill) return;
    const intent = await createPaymentIntent({ bill, method: req.body.method, payerPhone: req.body.payerPhone });
    if (intent.status !== 'paid') await charge(intent);
    res.status(201).json(intent);
  } catch (e) { next(e); }
});

router.get('/intents/:id', async (req, res, next) => {
  try {
    const intent = await store.payments.get(req.params.id);
    if (!intent) return res.status(404).json({ error: 'intent_not_found' });
    const bill = await store.bills.get(intent.billId);
    if (!bill || bill.tenantId !== req.tenant.id) return res.status(404).json({ error: 'intent_not_found' });
    res.json(intent);
  } catch (e) { next(e); }
});

module.exports = { router, markPaid };
