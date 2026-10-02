'use strict';

const express = require('express');
const store = require('../store');
const config = require('../config');
const messaging = require('../services/messaging');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try { res.json({ data: await store.claims.listByTenant(req.tenant.id) }); }
  catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const c = await store.claims.get(req.params.id);
    if (!c || c.tenantId !== req.tenant.id) return res.status(404).json({ error: 'claim_not_found' });
    res.json({ claim: c, bill: await store.bills.get(c.billId) });
  } catch (e) { next(e); }
});

// Text/WhatsApp this claim's secure payer-portal link to a number staff type in —
// e.g. an insurer's claims desk that works faster off WhatsApp than email, or a
// live demo of instant delivery. There's no payer phone on file anywhere in this
// codebase today (payers only carry a contact email — see src/seed.js), so this
// takes the destination per call instead of silently having nothing to send to.
router.post('/:id/share-link', async (req, res, next) => {
  try {
    const c = await store.claims.get(req.params.id);
    if (!c || c.tenantId !== req.tenant.id) return res.status(404).json({ error: 'claim_not_found' });
    const { channel, to } = req.body || {};
    if (!['sms', 'whatsapp'].includes(channel)) return res.status(422).json({ error: 'invalid_channel' });
    if (!to) return res.status(422).json({ error: 'to_required' });
    const tenant = await store.tenants.get(c.tenantId);
    const link = `${config.messaging.publicBaseUrl}${c.link}`;
    const body = `${c.provider || tenant?.name || 'HNN Biller'}: a claim of ${c.currency} ${Number(c.amount).toFixed(2)}`
      + `${c.patient?.name ? ` for ${c.patient.name}` : ''} awaits your authorisation. Secure link: ${link}`;
    const r = await messaging.send({ channel, to, body, tenant });
    if (!r.ok) return res.status(422).json({ error: r.error || 'send_failed' });
    res.json({ ok: true, channel, providerMessageId: r.providerMessageId || null, sentAt: r.sentAt || null, sandbox: !!r.sandbox });
  } catch (e) { next(e); }
});

module.exports = router;
