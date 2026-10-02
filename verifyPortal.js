'use strict';

const express = require('express');
const store = require('../store');
const verification = require('../services/verification');

const router = express.Router();
async function load(req, res) {
  const v = await verification.getByToken(req.params.token);
  if (!v) { res.status(404).json({ error: 'verification_not_found' }); return null; }
  return v;
}
async function view(v) {
  const bill = await store.bills.get(v.billId);
  return {
    verificationId: v.id, status: v.status,
    provider: v.provider || bill?.provider,
    patientName: v.patientName || bill?.patient?.name || null,
    amount: v.amount ?? bill?.totals?.net ?? null, currency: v.currency || bill?.currency,
    lineItems: (bill?.lineItems || []).map((i) => ({
      name: i.name, code: i.code || null, qty: i.qty || 1,
      unitPrice: i.unitPrice ?? i.cost, lineTotal: i.cost })),
    breakdown: bill ? { subtotal: bill.totals.subtotal, discount: bill.totals.discount,
      net: bill.totals.net, patientPayable: bill.totals.patientPayable } : null,
    clinical: bill?.clinical || null,
    disputeReason: v.disputeReason || null,
    createdAt: v.createdAt, verifiedAt: v.verifiedAt || null, disputedAt: v.disputedAt || null,
    // Which channels this went out on — lets the page mention the text/WhatsApp reply
    // option when relevant. Never includes the OTP code, phone number, or attempt state;
    // those stay server-side (see services/verification.js).
    channelsSent: v.channelsSent || [],
  };
}

router.get('/:token', async (req, res, next) => {
  try { const v = await load(req, res); if (v) res.json(await view(v)); } catch (e) { next(e); }
});
router.post('/:token/confirm', async (req, res, next) => {
  try {
    const v = await load(req, res); if (!v) return;
    await verification.confirm(v.id);
    res.json(await view(await store.verifications.get(v.id)));
  } catch (e) { next(e); }
});
router.post('/:token/dispute', async (req, res, next) => {
  try {
    const v = await load(req, res); if (!v) return;
    await verification.dispute(v.id, req.body?.reason);
    res.json(await view(await store.verifications.get(v.id)));
  } catch (e) { next(e); }
});

module.exports = router;
