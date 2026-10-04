'use strict';

const express = require('express');
const sms = require('../services/smsDashboard');

/**
 * Africa's Talking callbacks (SMS -> Callback URLs in the AT dashboard).
 * They are form-urlencoded POSTs with no custom headers, so authentication
 * is the unguessable secret in the path (rotatable from Master Control).
 * A wrong secret gets a bare 404 -- nothing to confirm the route exists.
 * Always answers 200 for a recognised, authenticated callback so AT does not
 * keep retrying on an application-level miss (e.g. an unmatched delivery id).
 */
const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '100kb' }));

router.use('/:secret', async (req, res, next) => {
  try {
    if (!(await sms.checkSecret(req.params.secret))) return res.status(404).end();
    next();
  } catch (e) { next(e); }
});

router.post('/:secret/delivery', async (req, res, next) => {
  try { res.json({ ok: true, ...(await sms.recordDeliveryReport(req.body || {})) }); }
  catch (e) { if (e.status === 422) return res.json({ ok: false, error: e.message }); next(e); }
});

router.post('/:secret/inbox', async (req, res, next) => {
  try { const r = await sms.recordInbound(req.body || {}); res.json({ ok: true, id: r.id }); }
  catch (e) { if (e.status === 422) return res.json({ ok: false, error: e.message }); next(e); }
});
// AT's inbox callback is sometimes probed with GET when saving the URL.
router.get('/:secret/inbox', (_req, res) => res.json({ ok: true }));

router.post('/:secret/optout', async (req, res, next) => {
  try { res.json({ ok: true, ...(await sms.recordOptOut(req.body || {})) }); }
  catch (e) { if (e.status === 422) return res.json({ ok: false, error: e.message }); next(e); }
});

module.exports = router;
