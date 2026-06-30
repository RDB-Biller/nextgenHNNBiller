'use strict';

const express = require('express');
const { markPaid } = require('./payments');

const router = express.Router();
router.post('/collection', async (req, res, next) => {
  try {
    const secret = req.header('x-webhook-secret');
    if (!secret || secret !== (process.env.COLLECTION_WEBHOOK_SECRET || 'dev-secret')) {
      return res.status(401).json({ error: 'bad_signature' });
    }
    const { intentId, status, reference } = req.body || {};
    if (status === 'success') {
      const intent = await markPaid(intentId, reference);
      if (!intent) return res.status(404).json({ error: 'intent_not_found' });
      return res.json({ ok: true, intent });
    }
    res.json({ ok: true, ignored: true });
  } catch (e) { next(e); }
});

module.exports = router;
