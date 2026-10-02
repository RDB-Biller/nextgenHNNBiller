'use strict';

const express = require('express');
const store = require('../store');
const { charge, markPaid } = require('../services/payments');

const router = express.Router();

// Public, sanitized view of a payment intent for the patient page.
router.get('/session/:intentId', async (req, res, next) => {
  try {
    const intent = await store.payments.get(req.params.intentId);
    if (!intent) return res.status(404).json({ error: 'session_not_found' });
    const bill = await store.bills.get(intent.billId);
    res.json({
      intentId: intent.id, amount: intent.amount, currency: intent.currency,
      status: intent.status, method: intent.method, provider: bill?.provider || null,
      payerPhoneMasked: maskPhone(intent.payerPhone),
      lineItems: (bill?.lineItems || []).map((i) => ({ name: i.name, cost: i.cost })),
    });
  } catch (e) { next(e); }
});

router.post('/session/:intentId/confirm', async (req, res, next) => {
  try {
    const intent = await store.payments.get(req.params.intentId);
    if (!intent) return res.status(404).json({ error: 'session_not_found' });
    if (intent.status === 'paid') return res.json({ status: 'paid' });
    await charge(intent);
    await markPaid(intent.id, `MOMO-${Date.now()}`);
    res.json({ status: 'paid' });
  } catch (e) { next(e); }
});

function maskPhone(p) {
  if (!p) return null;
  const s = String(p);
  return s.length <= 4 ? s : `${'•'.repeat(s.length - 4)}${s.slice(-4)}`;
}

module.exports = router;
