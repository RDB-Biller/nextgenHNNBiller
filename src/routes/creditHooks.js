'use strict';

const express = require('express');
const credit = require('../services/insurecredit');

/**
 * Machine callbacks for InsureCredit. Authenticated by an unguessable secret in
 * the path (rotatable from Master Control) -- Africa's Talking USSD cannot send
 * custom headers, and ConfirmU is given the same style of URL. A wrong secret is
 * a bare 404 so nothing confirms the route exists.
 *
 *   POST /ussd/:secret                                  Africa's Talking USSD (form-urlencoded)
 *   POST /insurecredit-hooks/:secret/decision           ConfirmU -> { applicationNo, decision, approvedAmount?, reference?, reason? }
 *   GET  /insurecredit-hooks/:secret/applications/:no   ConfirmU -> need-verification packet (micro medical report etc.)
 */
const ussd = express.Router();
ussd.use(express.urlencoded({ extended: false, limit: '20kb' }));
ussd.post('/:secret', async (req, res, next) => {
  try {
    if (!(await credit.checkSecret(req.params.secret))) return res.status(404).end();
    const text = await credit.ussd({ phoneNumber: req.body?.phoneNumber, text: req.body?.text });
    res.type('text/plain').send(text);
  } catch (e) { next(e); }
});

const hooks = express.Router();
hooks.use('/:secret', async (req, res, next) => {
  try { if (!(await credit.checkSecret(req.params.secret))) return res.status(404).end(); next(); } catch (e) { next(e); }
});
hooks.post('/:secret/decision', async (req, res, next) => {
  try { res.json({ ok: true, ...(await credit.recordDecision(req.body?.applicationNo, req.body || {})) }); } catch (e) { next(e); }
});
hooks.get('/:secret/applications/:no', async (req, res, next) => {
  try { res.json(await credit.verifyByAppNo(req.params.no)); } catch (e) { next(e); }
});

module.exports = { ussd, hooks };
