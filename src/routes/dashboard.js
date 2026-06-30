'use strict';

const express = require('express');
const store = require('../store');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const tid = req.tenant.id;
    const [myBills, myClaims, notes, ledgerEntries, ledgerSummary] = await Promise.all([
      store.bills.listByTenant(tid),
      store.claims.listByTenant(tid),
      store.notifications.listByTenant(tid),
      store.ledger.listByTenant(tid, 10),
      store.ledger.summary(tid),
    ]);
    const sum = (arr) => arr.reduce((s, b) => s + (b.totals?.net || 0), 0);
    res.json({
      tenant: req.tenant.name,
      totals: {
        bills: myBills.length,
        open: myBills.filter((b) => b.status === 'open').length,
        awaitingPayer: myBills.filter((b) => b.status === 'awaiting_payer').length,
        settled: myBills.filter((b) => b.status === 'settled').length,
        rejected: myBills.filter((b) => b.status === 'rejected').length,
        settledValue: sum(myBills.filter((b) => b.status === 'settled')),
      },
      recentBills: myBills.slice(-10).reverse(),
      claims: myClaims.slice(-10).reverse(),
      notifications: notes.slice(-15).reverse(),
      ledger: ledgerEntries,
      reconciliation: ledgerSummary.map((r) => ({ type: r.type, count: Number(r.n), cash: Number(r.cash), total: Number(r.total) })),
    });
  } catch (e) { next(e); }
});

module.exports = router;
