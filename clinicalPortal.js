'use strict';

const express = require('express');
const store = require('../store');
const clinicalLinks = require('../services/clinicalLinks');
const metricsLibrary = require('../services/metricsLibrary');

/**
 * The patient's own side of manual clinical-indicator entry — a lightweight,
 * OTP-verified "login" binding a phone number to a payerId+memberId (see
 * services/clinicalLinks.js), then a small API to submit and review their
 * own readings. Unauthenticated by design (a patient has no tenant/payer
 * api key) — phone ownership plus knowing their own payer+member id is the
 * bar, the same trust level routes/verifyPortal.js already extends to
 * patients over a mailed/texted link.
 *
 * Once active, every write requires the link's own bearer token (returned
 * only once, in the confirm response) — never the link id alone, since an
 * id can appear in browser history/referrers. See services/clinicalLinks.js
 * for why requesting a link always (re-)issues a fresh OTP challenge rather
 * than maintaining a persistent session.
 */
const router = express.Router();

function bearerToken(req) {
  const h = req.header('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : (req.header('x-clinical-token') || null);
}

// Masked projection returned by every endpoint below that ISN'T gated on the
// bearer token (POST /link, GET /link/:id, POST /link/:id/resend) — never the
// otp code or the bearer token itself. The id alone (8 random bytes, same
// strength as obs_/acc_/vfy_ ids elsewhere in this app) is treated as a
// routing reference, not a secret, which is why those three stay open on id
// alone: nothing this returns is more sensitive than what a GET on any of
// this app's other id-keyed records already exposes. Submitting or reading
// actual readings (the two routes below that DO call loadActive) is the one
// thing that needs the separate, higher-entropy bearer token instead.
function view(link) {
  return {
    id: link.id, status: link.status, payerId: link.payerId, memberId: link.memberId,
    condition: link.condition,
    phoneMasked: link.phoneNormalized ? `•••${link.phoneNormalized.slice(-4)}` : null,
    createdAt: link.createdAt, consentedAt: link.consentedAt,
  };
}

async function loadActive(req, res) {
  const link = await store.clinicalLinks.get(req.params.id);
  if (!link || link.status !== 'active') { res.status(404).json({ error: 'link_not_found' }); return null; }
  const token = bearerToken(req);
  if (!token || token !== link.activeToken) { res.status(401).json({ error: 'invalid_token' }); return null; }
  return link;
}

router.get('/conditions', (req, res) => res.json({ conditions: metricsLibrary.CONDITIONS }));

router.post('/link', async (req, res, next) => {
  try {
    const { payerId, memberId, phone, condition, channel } = req.body || {};
    const link = await clinicalLinks.request({ payerId, memberId, phone, condition, channel, createdBy: 'patient_web' });
    res.status(201).json(view(link));
  } catch (e) { next(e); }
});

router.get('/link/:id', async (req, res, next) => {
  try {
    const link = await store.clinicalLinks.get(req.params.id);
    if (!link) return res.status(404).json({ error: 'link_not_found' });
    res.json(view(link));
  } catch (e) { next(e); }
});

router.post('/link/:id/resend', async (req, res, next) => {
  try { res.json(view(await clinicalLinks.resend(req.params.id))); } catch (e) { next(e); }
});

router.post('/link/:id/confirm', async (req, res, next) => {
  try {
    const link = await clinicalLinks.confirmById(req.params.id, req.body?.code);
    res.json({ ...view(link), token: link.activeToken });
  } catch (e) { next(e); }
});

router.post('/link/:id/observations', async (req, res, next) => {
  try {
    const link = await loadActive(req, res); if (!link) return;
    const o = await clinicalLinks.recordForLink(link, req.body || {}, 'manual_patient');
    res.status(201).json(o);
  } catch (e) { next(e); }
});

router.get('/link/:id/observations', async (req, res, next) => {
  try {
    const link = await loadActive(req, res); if (!link) return;
    const all = await store.observations.listByMember(link.payerId, link.memberId);
    res.json({ ok: true, count: all.length, data: all });
  } catch (e) { next(e); }
});

module.exports = router;
