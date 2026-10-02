'use strict';

const express = require('express');
const report = require('../services/medicalReport');

const router = express.Router();
router.get('/:token', async (req, res, next) => {
  try {
    const r = await report.getByToken(req.params.token);
    if (!r) return res.status(404).json({ error: 'report_not_found' });
    const { tenantId, billId, shareToken, ...safe } = r;
    res.json(safe);
  } catch (e) { next(e); }
});

module.exports = router;
