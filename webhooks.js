'use strict';

const express = require('express');
const { markPaid } = require('./payments');
const config = require('../config');
const verification = require('../services/verification');
const clinicalLinks = require('../services/clinicalLinks');
const messaging = require('../services/messaging');

const router = express.Router();
router.post('/collection', async (req, res, next) => {
  try {
    const secret = req.header('x-webhook-secret');
    if (!secret || secret !== (process.env.COLLECTION_WEBHOOK_SECRET || 'dev-secret')) {
      return res.status(401).json({ error: 'bad_signature' });
    }
    const { intentId, status, reference } = req.body || {};
    if (status === 'success') {
      const intent = await markPaid(intentId, reference);
      if (!intent) return res.status(404).json({ error: 'intent_not_found' });
      return res.json({ ok: true, intent });
    }
    res.json({ ok: true, ignored: true });
  } catch (e) { next(e); }
});

/**
 * Inbound SMS/WhatsApp reply — either to a patient-verification message
 * (services/verification.js handleInboundReply) or a clinical check-in
 * (services/clinicalLinks.js handleInboundReply, Product Development
 * Environment / VBC self-report). No real provider is wired in (see
 * services/messaging.js), so this accepts a small, provider-agnostic JSON
 * shape — { from, text, channel } — plus a couple of common field-name
 * aliases, rather than one specific provider's webhook payload. Wiring in a
 * real provider later may mean adding a thin translation in front of this
 * (e.g. Twilio's form-encoded From/Body) — this handler and the matching
 * logic underneath it do not change.
 *
 * Clinical is tried first and only ever claims a message that is either
 * clearly clinical-shaped (a "BP 130/85"-style reading or STOP/HELP) or an
 * exact/unambiguous OTP-code match for a pending clinical link — anything
 * else returns null from it and falls straight through to bill verification
 * exactly as before this feature existed, so a phone that has never touched
 * clinical check-ins sees no change in behaviour at all.
 *
 * Secured the same way as /collection: a shared secret header, not a
 * provider-specific request signature, for the same "generic adapter" reason.
 */
router.post('/messaging-inbound', async (req, res, next) => {
  try {
    const secret = req.header('x-webhook-secret');
    if (!secret || secret !== config.messaging.webhookSecret) {
      return res.status(401).json({ error: 'bad_signature' });
    }
    const b = req.body || {};
    const from = b.from || b.From || b.sender || b.msisdn || '';
    const text = b.text || b.Body || b.body || b.message || '';
    const channelRaw = String(b.channel || (String(b.From || '').startsWith('whatsapp:') ? 'whatsapp' : 'sms') || 'sms');
    const channel = channelRaw.toLowerCase() === 'whatsapp' ? 'whatsapp' : 'sms';
    if (!from || !text) return res.status(422).json({ error: 'missing_from_or_text' });

    const result = (await clinicalLinks.handleInboundReply({ from, text, channel }))
      || (await verification.handleInboundReply({ from, text, channel }));
    if (result.reply) await messaging.send({ channel, to: from, body: result.reply });
    res.json({
      ok: true, outcome: result.outcome,
      verificationId: result.verification?.id || null,
      clinicalLinkId: result.link?.id || null,
    });
  } catch (e) { next(e); }
});

module.exports = router;
