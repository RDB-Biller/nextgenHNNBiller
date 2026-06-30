'use strict';

const express = require('express');
const store = require('../store');

const router = express.Router();

// Append-only money ledger for this clinic (audit / reconciliation).
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    res.json({ data: await store.ledger.listByTenant(req.tenant.id, limit) });
  } catch (e) { next(e); }
});

// Reconciliation summary: totals per movement type, with cash vs non-cash (credit).
router.get('/summary', async (req, res, next) => {
  try {
    const rows = await store.ledger.summary(req.tenant.id);
    const norm = rows.map((r) => ({ type: r.type, count: Number(r.n), cash: Number(r.cash), total: Number(r.total) }));
    res.json({
      tenant: req.tenant.name,
      byType: norm,
      cashSettled: norm.reduce((s, r) => s + r.cash, 0),
      creditOutstanding: norm.filter((r) => r.type === 'hospital_credit').reduce((s, r) => s + (r.total - r.cash), 0),
    });
  } catch (e) { next(e); }
});

// Entries for a single bill.
router.get('/bill/:billId', async (req, res, next) => {
  try {
    const bill = await store.bills.get(req.params.billId);
    if (!bill || bill.tenantId !== req.tenant.id) return res.status(404).json({ error: 'bill_not_found' });
    res.json({ data: await store.ledger.listByBill(req.params.billId) });
  } catch (e) { next(e); }
});

module.exports = router;
