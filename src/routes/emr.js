'use strict';

const express = require('express');
const { authEmrPartner } = require('../middleware/auth');
const observations = require('../services/observations');

/**
 * The one endpoint an EMR/EHR partner calls directly (as itself, via its own
 * api_key — not a tenant, not a shared webhook secret): pushing the clinical
 * observations that feed Value-Based-Care metrics (services/metricsLibrary.js,
 * services/incentives.js). Nothing else in this app accepts clinical data —
 * see services/observations.js for why that's deliberate.
 */
const router = express.Router();
router.use(authEmrPartner);

router.post('/observations', async (req, res, next) => {
  try {
    const saved = await observations.recordBatch(req.emrPartner, req.body || {});
    res.json({ ok: true, count: saved.length, data: saved });
  } catch (e) { next(e); }
});

module.exports = router;
