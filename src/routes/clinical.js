'use strict';

const express = require('express');
const observations = require('../services/observations');
const clinicalLinks = require('../services/clinicalLinks');
const store = require('../store');

/**
 * Hospital-side manual entry of the clinical indicators Value-Based-Care
 * metrics are computed from (services/metricsLibrary.js) — the tenant-
 * authenticated counterpart to the EMR/EHR partner feed at
 * /api/v1/emr/observations (routes/emr.js). For a clinic with no EMR
 * integration, or simply keying in today's readings by hand, this is the
 * other deliberate way clinical_observations rows get created — see
 * services/observations.js for the full list of sources.
 *
 * The patient's own side of manual entry (self-service web form + SMS/
 * WhatsApp) is routes/clinicalPortal.js + services/clinicalLinks.js instead,
 * since a patient has no tenant api-key to authenticate with here. A clinic
 * CAN kick off that enrollment on a patient's behalf (POST /link below) —
 * the patient still has to confirm the code themselves before anything can
 * be submitted from their side.
 */
const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const input = { ...(req.body || {}), tenantId: req.tenant.id };
    const note = req.body?.recordedByNote ? String(req.body.recordedByNote).slice(0, 200) : null;
    const o = await observations.recordManual(input, {
      source: 'manual_hospital',
      recordedBy: { tenantId: req.tenant.id, note },
    });
    res.status(201).json(o);
  } catch (e) { next(e); }
});

router.get('/', async (req, res, next) => {
  try {
    const { payerId, memberId } = req.query;
    if (!payerId || !memberId) { const e = new Error('payerId_and_memberId_required'); e.status = 422; throw e; }
    const all = await store.observations.listByMember(String(payerId), String(memberId));
    // Scoped to what THIS clinic recorded by hand — the EMR feed and other
    // clinics' entries for the same member aren't this endpoint's to show.
    const mine = all.filter((o) => o.source === 'manual_hospital' && o.tenantId === req.tenant.id);
    res.json({ ok: true, count: mine.length, data: mine });
  } catch (e) { next(e); }
});

/** A clinic can start a patient's phone-link during a visit; the patient still confirms it themselves. */
router.post('/link', async (req, res, next) => {
  try {
    const { payerId, memberId, phone, condition, channel } = req.body || {};
    const link = await clinicalLinks.request({
      payerId, memberId, phone, condition, channel, createdBy: 'hospital', tenantId: req.tenant.id,
    });
    res.status(201).json({ id: link.id, status: link.status, payerId: link.payerId, memberId: link.memberId, condition: link.condition });
  } catch (e) { next(e); }
});

module.exports = router;
