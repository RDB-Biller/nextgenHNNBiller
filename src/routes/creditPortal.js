'use strict';

const express = require('express');
const credit = require('../services/insurecredit');

/**
 * Applicant- and funder-facing InsureCredit surface (mounted at /credit/api).
 * No key: the unguessable token in the SMS link IS the credential, exactly like
 * /claim and /verify. Narrow on purpose -- every route works on one application
 * found by its token, the applicant sees first name only, and each IP is rate
 * limited (a stricter limit on the one route that can send a message to a third
 * party, so the platform can't be used as an SMS/email relay).
 */
const router = express.Router();

function limiter(limit, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(); const key = req.ip || 'unknown';
    const h = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (h.length >= limit) return res.status(429).json({ error: 'rate_limited' });
    h.push(now); hits.set(key, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    next();
  };
}
router.use(limiter(90, 60000));
const strict = limiter(6, 60000);

// Funder opens the justification note.
router.get('/share/:shareToken', async (req, res, next) => {
  try { res.json(await credit.shareView(req.params.shareToken)); } catch (e) { next(e); }
});

router.get('/:token', async (req, res, next) => {
  try { res.json(await credit.view(req.params.token)); } catch (e) { next(e); }
});

router.post('/:token/consent', async (req, res, next) => {
  try { res.json(await credit.consent(req.params.token, { scoring: req.body?.scoring === true, ip: req.ip })); } catch (e) { next(e); }
});

router.post('/:token/apply', strict, async (req, res, next) => {
  try { res.json(await credit.apply(req.params.token, { ip: req.ip })); } catch (e) { next(e); }
});

router.post('/:token/share', strict, async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await credit.share(req.params.token, { name: b.name, email: b.email, phone: b.phone, relationship: b.relationship, consent: b.consent === true, ip: req.ip }));
  } catch (e) { next(e); }
});

router.post('/:token/shares/:shareId/revoke', async (req, res, next) => {
  try { res.json(await credit.revokeShare(req.params.token, req.params.shareId)); } catch (e) { next(e); }
});

module.exports = router;
