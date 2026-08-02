'use strict';

const express = require('express');
const store = require('../store');
const claimsService = require('../services/claims');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
async function load(req, res) {
  const c = await claimsService.getByToken(req.params.token);
  if (!c) { res.status(404).json({ error: 'claim_not_found' }); return null; }
  return c;
}
async function view(c) {
  const bill = await store.bills.get(c.billId);
  const payer = await store.payers.get(c.payerId);
  return {
    claimId: c.id, status: c.status, payer: payer?.name, payerKind: payer?.kind,
    provider: c.provider || bill?.provider, amount: c.amount, currency: c.currency,
    patientName: c.patient?.name || bill?.patient?.name || null, memberId: c.memberId,
    sponsor: c.patient?.sponsor || bill?.coverage?.sponsor?.name || null,
    lineItems: (c.lineItems && c.lineItems.length
      ? c.lineItems
      : (bill?.lineItems || []).map((i) => ({ name: i.name, code: i.code || null,
          qty: i.qty || 1, unitPrice: i.unitPrice ?? i.cost, lineTotal: i.cost }))),
    breakdown: c.breakdown || null,
    clinical: c.clinical || bill?.clinical || null,
    transferReference: c.transferReference || null, beneficiaryName: c.beneficiaryName || null,
  };
}

router.get('/:token', async (req, res, next) => {
  try { const c = await load(req, res); if (c) res.json(await view(c)); } catch (e) { next(e); }
});
router.post('/:token/authorize', idempotency((r) => `claimlink:${r.params.token}`), async (req, res, next) => {
  try {
    const c = await load(req, res); if (!c) return;
    await claimsService.authorize(c.id);
    res.json(await view(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});
router.post('/:token/reject', async (req, res, next) => {
  try {
    const c = await load(req, res); if (!c) return;
    await claimsService.reject(c.id, req.body?.reason);
    res.json(await view(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});

module.exports = router;
