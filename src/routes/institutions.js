'use strict';

const express = require('express');
const { sbg } = require('../sbgClient');

const router = express.Router();

// List receiving institutions (banks / wallets) from Stanbic.
router.get('/institutions', async (req, res, next) => {
  try {
    res.json(await sbg.listInstitutions());
  } catch (e) {
    next(e);
  }
});

// Validate a beneficiary (provider) account resolves to a name.
router.get('/account-validation', async (req, res, next) => {
  try {
    const { serviceRoutingCode, beneficiaryAccount } = req.query;
    if (!serviceRoutingCode || !beneficiaryAccount) {
      return res.status(400).json({ error: 'missing_params' });
    }
    res.json(await sbg.validateAccount({ serviceRoutingCode, beneficiaryAccount }));
  } catch (e) {
    next(e);
  }
});

module.exports = router;
