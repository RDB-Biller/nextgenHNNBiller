'use strict';

const express = require('express');
const store = require('../store');
const { createBill } = require('../services/billing');
const { routeToPayer, routeToPayers } = require('../services/claims');
const payerSlots = require('../services/payerSlots');
const editions = require('../services/editions');
const networks = require('../services/networks');
const catalog = require('../services/catalog');

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

// What this client is licensed for — lets an API-only partner adapt its own UI.
router.get('/edition', (req, res) => {
  res.json({ client: req.tenant.id, name: req.tenant.name,
    edition: editions.editionOf(req.tenant), features: editions.featureList(req.tenant),
    licence: editions.licenceState(req.tenant) });
});

// Chargeable catalog (demo items + full NHIS Medicines List). Search by code or name.
router.get('/catalog', (req, res) => {
  const q = req.query.q || req.query.search;
  const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
  const category = req.query.category || null;
  if (q) return res.json({ count: catalog.count(), data: catalog.search(q, { limit, category }) });
  // No query: return the count + a small sample (the full list is large).
  res.json({ count: catalog.count(), data: catalog.DEFAULT_CATALOG.slice(0, limit) });
});

// This facility's expedited settlement terms, as set by each payer (read-only).
router.get('/network-terms', async (req, res, next) => {
  try {
    const rows = await networks.listByTenant(req.tenant.id);
    res.json({ provider: req.tenant.name, data: rows.map((t) => ({
      payerId: t.payerId, payerName: t.payerName, status: t.status, active: networks.isActive(t),
      settlement: t.settlement, feeRate: t.feeRate, chargeTo: t.chargeTo,
      promptPaymentDiscountPercent: t.promptPaymentDiscountPercent,
      maxClaimAmount: t.maxClaimAmount, effectiveFrom: t.effectiveFrom, effectiveTo: t.effectiveTo })) });
  } catch (e) { next(e); }
});

// Payers this facility can route to: global + its own programmed slots.
router.get('/payers', async (req, res, next) => {
  try { res.json({ data: await payerSlots.routableFor(req.tenant.id) }); }
  catch (e) { next(e); }
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

    // Multi-payer split: body has split:{payers:[...]}, or the bill was created with one.
    const splitSpec = req.body.split || bill.coverage.split;
    const splitPayers = splitSpec && Array.isArray(splitSpec.payers)
      ? splitSpec.payers.filter((p) => p && p.payerId && p.paying !== false) : [];

    if (splitPayers.length > 1) {
      const { claims, split } = await routeToPayers(bill, splitSpec);
      return res.status(201).json({
        claims: claims.map((c) => ({ claimId: c.id, payerId: c.payerId, payerName: c.payerName,
          amount: c.amount, payerLink: c.link })),
        split: split.payers, mode: 'split',
      });
    }

    const payerId = req.body.payerId || req.body.insurerId
      || (splitPayers[0] && splitPayers[0].payerId) || bill.coverage.payerId;
    const { claim } = await routeToPayer(bill, payerId);
    res.status(201).json({ claim, payerLink: claim.link, mode: 'single' });
  } catch (e) { next(e); }
});

module.exports = router;
