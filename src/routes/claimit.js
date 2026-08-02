'use strict';

/** NHIS ClaimIt tracker (tenant-scoped). */
const express = require('express');
const store = require('../store');
const claimit = require('../services/claimit');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try { res.json({ data: await claimit.listByTenant(req.tenant.id) }); } catch (e) { next(e); }
});

router.get('/summary', async (req, res, next) => {
  try { res.json(await claimit.summary(req.tenant.id)); } catch (e) { next(e); }
});

/**
 * Track an NHIS claim. Two intake styles:
 *  A) ROUTED   — pass `billId` for a bill raised here.
 *  B) EXTERNAL — the claim was submitted/settled in your EMR or the ClaimIt portal;
 *     just send the data: { provider, nhisAmount, nhisClaimNumber, patientName,
 *     memberId, refundPercent, refundedBy, externalRef, claimedAt }.
 * Idempotent on nhisClaimNumber.
 */
router.post('/', async (req, res, next) => {
  try {
    let bill = null;
    if (req.body.billId) {
      bill = await store.bills.get(req.body.billId);
      if (!bill || bill.tenantId !== req.tenant.id) return res.status(404).json({ error: 'bill_not_found' });
    }
    const rec = await claimit.track({ ...req.body, bill, tenantId: req.tenant.id });
    res.status(201).json(rec);
  } catch (e) { next(e); }
});

/**
 * Bulk intake from an EMR / ClaimIt export.
 * Body: { claims: [ { nhisClaimNumber, nhisAmount, provider?, patientName?, memberId?,
 *                     refundPercent?, refundedBy?, externalRef?, claimedAt? }, ... ] }
 */
router.post('/ingest', async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : (req.body?.claims || []);
    if (!Array.isArray(rows) || !rows.length) return res.status(422).json({ error: 'claims_array_required' });
    const provider = req.tenant.name;
    res.status(201).json(await claimit.ingest(req.tenant.id, rows.map((r) => ({ provider, ...r }))));
  } catch (e) { next(e); }
});

async function own(req, res) {
  const rec = await store.claimit.get(req.params.id);
  if (!rec || rec.tenantId !== req.tenant.id) { res.status(404).json({ error: 'claimit_not_found' }); return null; }
  return rec;
}

router.get('/:id', async (req, res, next) => {
  try { const r = await own(req, res); if (r) res.json(r); } catch (e) { next(e); }
});

router.post('/:id/status', async (req, res, next) => {
  try {
    const r = await own(req, res); if (!r) return;
    res.json(await claimit.setStatus(r.id, req.body.status, req.body.note));
  } catch (e) { next(e); }
});

// Record the refund received -> computes cashback + accrues the SaaS margin.
router.post('/:id/refund', async (req, res, next) => {
  try {
    const r = await own(req, res); if (!r) return;
    res.json(await claimit.recordRefund(r.id, { amount: req.body.amount, reference: req.body.reference }));
  } catch (e) { next(e); }
});

module.exports = router;
