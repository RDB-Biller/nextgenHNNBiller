'use strict';

const express = require('express');
const store = require('../store');
const claimsService = require('../services/claims');
const networks = require('../services/networks');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    const payer = await store.payers.byApiKey(req.header('x-payer-key'));
    if (!payer) return res.status(401).json({ error: 'invalid_payer_key' });
    req.payer = payer;
    next();
  } catch (e) { next(e); }
});

async function claimView(c) {
  const bill = await store.bills.get(c.billId);
  return {
    claimId: c.id, status: c.status, amount: c.amount, currency: c.currency,
    provider: bill?.provider, patientName: bill?.patient?.name || null,
    memberId: c.memberId, sponsor: bill?.coverage?.sponsor?.name || null,
    lineItems: (bill?.lineItems || []).map((i) => ({ name: i.name, cost: i.cost })),
    transferReference: c.transferReference || null, beneficiaryName: c.beneficiaryName || null,
    link: c.link, createdAt: c.createdAt,
  };
}

router.get('/me', (req, res) => res.json({ id: req.payer.id, name: req.payer.name, kind: req.payer.kind }));

router.get('/summary', async (req, res, next) => {
  try {
    const cs = await store.claims.listByPayer(req.payer.id);
    const val = (s) => cs.filter((c) => c.status === s).reduce((a, c) => a + c.amount, 0);
    res.json({
      payer: req.payer.name, kind: req.payer.kind,
      pending: cs.filter((c) => c.status === 'pending').length, pendingValue: val('pending'),
      settled: cs.filter((c) => c.status === 'settled').length, settledValue: val('settled'),
      rejected: cs.filter((c) => c.status === 'rejected').length,
    });
  } catch (e) { next(e); }
});

router.get('/claims', async (req, res, next) => {
  try {
    let cs = await store.claims.listByPayer(req.payer.id);
    if (req.query.status) cs = cs.filter((c) => c.status === req.query.status);
    res.json({ payer: req.payer.name, data: await Promise.all(cs.map(claimView)) });
  } catch (e) { next(e); }
});

async function own(req, res) {
  const c = await store.claims.get(req.params.id);
  if (!c || c.payerId !== req.payer.id) { res.status(404).json({ error: 'claim_not_found' }); return null; }
  return c;
}

router.get('/claims/:id', async (req, res, next) => {
  try { const c = await own(req, res); if (c) res.json(await claimView(c)); }
  catch (e) { next(e); }
});

router.post('/claims/:id/authorize', idempotency((r) => `payer:${r.payer.id}:authorize`), async (req, res, next) => {
  try {
    const c = await own(req, res); if (!c) return;
    await claimsService.authorize(c.id);
    res.json(await claimView(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});

router.post('/claims/:id/reject', async (req, res, next) => {
  try {
    const c = await own(req, res); if (!c) return;
    await claimsService.reject(c.id, req.body?.reason);
    res.json(await claimView(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});

// ---- NNEST: Narrow Network Expedited Settlement Terms (payer-operated) -------

// Network posture for this payer.
router.get('/network', async (req, res, next) => {
  try {
    const terms = await networks.listByPayer(req.payer.id);
    res.json({
      payer: req.payer.name,
      networkMode: req.payer.networkMode || 'open',
      outOfNetworkPolicy: req.payer.outOfNetworkPolicy || 'standard',
      caps: { feeRate: networks.MAX_FEE_RATE, promptPaymentDiscount: networks.MAX_PROMPT_DISCOUNT },
      providers: terms.map((t) => ({
        tenantId: t.tenantId, providerName: t.providerName, status: t.status,
        settlement: t.settlement, feeRate: t.feeRate, chargeTo: t.chargeTo,
        promptPaymentDiscountPercent: t.promptPaymentDiscountPercent,
        maxClaimAmount: t.maxClaimAmount, effectiveFrom: t.effectiveFrom, effectiveTo: t.effectiveTo,
        active: networks.isActive(t), updatedAt: t.updatedAt,
      })),
    });
  } catch (e) { next(e); }
});

// Open vs narrow network, and what happens out of network.
router.put('/network/posture', async (req, res, next) => {
  try { res.json(await networks.setPosture(req.payer.id, req.body || {})); }
  catch (e) { next(e); }
});

// Add or update a provider's expedited settlement terms.
router.put('/network/providers/:tenantId', async (req, res, next) => {
  try { res.json(await networks.setTerms(req.payer.id, req.params.tenantId, req.body || {})); }
  catch (e) { next(e); }
});

// Suspend terms (provider stays on record; instant settlement stops).
router.delete('/network/providers/:tenantId', async (req, res, next) => {
  try { res.json(await networks.suspend(req.payer.id, req.params.tenantId)); }
  catch (e) { next(e); }
});

// Dry-run: how would a claim of this size settle for this provider today?
router.post('/network/preview', async (req, res, next) => {
  try {
    res.json(await networks.resolve(req.payer, req.body?.tenantId, Number(req.body?.amount) || 0));
  } catch (e) { next(e); }
});

module.exports = router;
