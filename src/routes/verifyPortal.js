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

// How long a patient must wait between self-service resends. This endpoint has
// no login — just the bare token in the URL — so without a cooldown it would be
// an easy way to run up the clinic's Twilio bill or spam the patient's own phone
// (accidentally, via a stuck double-tap, or on purpose). It only ever sends to
// the phone already on this verification record — never a caller-supplied
// number — so at worst a patient re-messages themselves too often, never anyone
// else.
const RESEND_COOLDOWN_MS = 30 * 1000;

router.get('/:token', async (req, res, next) => {
  try { const v = await load(req, res); if (v) res.json(await view(v)); } catch (e) { next(e); }
});
// Patient self-service: "I didn't get the text, try WhatsApp instead" (or
// vice versa). Body: { channel: 'sms'|'whatsapp' }. Always resends to the
// phone number already on file for this bill — there is no way to pass a
// different destination in from here.
router.post('/:token/resend', async (req, res, next) => {
  try {
    const v = await load(req, res); if (!v) return;
    const { channel } = req.body || {};
    if (!['sms', 'whatsapp'].includes(channel)) return res.status(422).json({ error: 'invalid_channel' });
    if (!v.phone) return res.status(422).json({ error: 'no_phone_on_file' });
    const sinceLast = v.lastRemindedAt ? Date.now() - new Date(v.lastRemindedAt).getTime() : Infinity;
    if (sinceLast < RESEND_COOLDOWN_MS) {
      return res.status(429).json({ error: 'too_soon', retryAfterMs: RESEND_COOLDOWN_MS - sinceLast });
    }
    const updated = await verification.reissue(v.id, { channels: { [channel]: true } });
    const channelError = channel === 'whatsapp' ? updated.whatsappError : updated.smsError;
    res.json({ ok: !channelError, channelsSent: updated.channelsSent || [], ...(channelError ? { error: channelError } : {}) });
  } catch (e) { next(e); }
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
