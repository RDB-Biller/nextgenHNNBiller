'use strict';

const express = require('express');
const store = require('../store');
const { createBill } = require('../services/billing');
const { routeToPayer, routeToPayers } = require('../services/claims');
const verification = require('../services/verification');
const messaging = require('../services/messaging');
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
    // The patient is sent a verification link immediately, for every bill — this is
    // a courtesy confirmation step and never blocks bill creation itself. Not
    // persisted onto the bill (single source of truth stays the verifications
    // table); this is just a one-time convenience snapshot in the response.
    const v = await verification.createForBill(bill);
    // Sandbox-only convenience: while the Messaging rail is sandboxed (Master
    // Control's Operating Mode, or MESSAGING_SANDBOX before anything's been
    // saved there — see services/operatingMode.js), nothing is ever sent for
    // real, so this is the only way to see the code at all while testing/demoing.
    const messagingSandbox = await messaging.isSandbox();
    res.status(201).json({ ...bill, patientVerification: {
      status: v.status, link: v.link, channelsSent: v.channelsSent || [],
      // Per-channel send failures (e.g. provider_credentials_incomplete,
      // provider_whatsapp_not_supported) so a wanted-but-missing channel is
      // visibly explained rather than just absent from channelsSent.
      ...((v.smsError || v.whatsappError) ? { channelErrors: {
        ...(v.smsError ? { sms: v.smsError } : {}), ...(v.whatsappError ? { whatsapp: v.whatsappError } : {}),
      } } : {}),
      ...(messagingSandbox && v.otpCode ? { otpCodeSandbox: v.otpCode } : {}),
    } });
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

// Resend the patient verification link (same token) — for hospital staff to nudge a
// patient who hasn't responded yet. A disputed record is reset to pending first.
// Body is optional: {} (or no body) resends over whatever channels the clinic has
// configured as default. { channel: 'sms'|'whatsapp', to? } forces exactly that one
// channel regardless of the clinic's default — e.g. the "SMS" / "WhatsApp" tabs next
// to the link on the billing screen, each a one-click, explicit send.
router.post('/:id/verification/reissue', async (req, res, next) => {
  try {
    const bill = await ownBill(req);
    if (!bill) return res.status(404).json({ error: 'bill_not_found' });
    const v = await verification.forBill(bill.id);
    if (!v) return res.status(404).json({ error: 'verification_not_found' });
    const { channel, to } = req.body || {};
    let opts = {};
    if (channel) {
      if (!['sms', 'whatsapp'].includes(channel)) return res.status(422).json({ error: 'invalid_channel' });
      if (!(to || v.phone)) return res.status(422).json({ error: 'no_recipient_phone' });
      opts = { channels: { [channel]: true }, ...(to ? { to } : {}) };
    }
    const updated = await verification.reissue(v.id, opts);
    const messagingSandbox = await messaging.isSandbox();
    res.json({ status: updated.status, link: updated.link, remindersSent: updated.remindersSent,
      channelsSent: updated.channelsSent || [],
      ...((updated.smsError || updated.whatsappError) ? { channelErrors: {
        ...(updated.smsError ? { sms: updated.smsError } : {}), ...(updated.whatsappError ? { whatsapp: updated.whatsappError } : {}),
      } } : {}),
      ...(messagingSandbox && updated.otpCode ? { otpCodeSandbox: updated.otpCode } : {}) });
  } catch (e) { next(e); }
});

module.exports = router;
