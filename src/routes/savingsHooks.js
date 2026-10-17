'use strict';

const express = require('express');
const store = require('../store');
const savings = require('../services/savingsPlans');

/**
 * Public surfaces for BirthPrep:
 *   /savings/api/:token            the patient's plan page (first name only); POST .../answers re-plans from the Q&A
 *   /savings-hooks/:secret/contribution   the savings partner posts a deposit { planNo, amount, reference, via? }.
 *     Secret in the path (partners can't send custom headers); wrong secret = bare 404; idempotent on reference.
 *   /savings-hooks/:secret/plans/:planNo  read-only plan feed for the partner app (e.g. Afriyie).
 */
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

const api = express.Router();
// The Afriyie app runs on another origin: these endpoints are public (no cookies), so a permissive CORS is safe.
api.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
api.use(limiter(90, 60000));
// ---- self-signup from the Afriyie app / general public (phone verified by one-time code) ----
api.get('/facilities', async (req, res, next) => { try { res.json({ data: await savings.facilities(), questions: savings.QUESTIONS, goals: savings.GOALS, horizons: savings.HORIZONS }); } catch (e) { next(e); } });
api.post('/verify/start', limiter(5, 60000), async (req, res, next) => { try { res.json(await savings.startVerification(req.body?.phone, { lang: req.body?.lang })); } catch (e) { next(e); } });
// Verify a code on its own (the Afriyie app's registration): returns a signed receipt for the TMS backend.
api.post('/verify/check', limiter(10, 60000), async (req, res, next) => { try { res.json(await savings.verifyAndReceipt(req.body?.phone, req.body?.code)); } catch (e) { next(e); } });
api.post('/signup', limiter(5, 60000), async (req, res, next) => { try { res.status(201).json(await savings.selfEnrol(req.body || {})); } catch (e) { next(e); } });
api.post('/my-plans', limiter(10, 60000), async (req, res, next) => { try { res.json(await savings.myPlans(req.body?.phone, req.body?.code)); } catch (e) { next(e); } });
api.get('/:token', async (req, res, next) => { try { res.json(await savings.publicView(await savings.byTokenOrThrow(req.params.token))); } catch (e) { next(e); } });
// The patient (or a chatbot on their behalf) answers the intake questions -> the plan is re-planned.
api.post('/:token/answers', limiter(10, 60000), async (req, res, next) => {
  try { const pl = await savings.byTokenOrThrow(req.params.token); res.json(await savings.publicView(await savings.update(pl, { answers: req.body?.answers || {}, by: 'patient' }))); } catch (e) { next(e); }
});
// Patient lookup when the link was lost: plan number + phone.
api.post('/lookup', limiter(6, 60000), async (req, res, next) => {
  try {
    const n = String(req.body?.planNo || '').replace(/\D/g, '');
    const pl = n ? await store.savingsPlans.byPlanNo(n) : null;
    const messaging = require('../services/messaging');
    if (!pl || !req.body?.phone || messaging.normalizePhone(pl.patient.phone) !== messaging.normalizePhone(req.body.phone)) return res.status(404).json({ error: 'plan_not_found' });
    res.json({ token: pl.token });
  } catch (e) { next(e); }
});

const hooks = express.Router();
hooks.use('/:secret', async (req, res, next) => { try { if (!(await savings.checkSecret(req.params.secret))) return res.status(404).end(); next(); } catch (e) { next(e); } });
hooks.post('/:secret/contribution', async (req, res, next) => {
  try {
    const b = req.body || {};
    const n = String(b.planNo || '').replace(/\D/g, '');
    const pl = n ? await store.savingsPlans.byPlanNo(n) : null;
    if (!pl) return res.status(404).json({ error: 'plan_not_found' });
    const v = await savings.contribute(pl, { amount: b.amount, via: b.via || 'partner', reference: b.reference || null, by: 'partner' });
    res.json({ ok: true, planNo: v.planNo, saved: v.saved, target: v.target.target, status: v.status });
  } catch (e) { next(e); }
});
// The partner backend can double-check a receipt here if it does not hold the signing key.
hooks.post('/:secret/verify-receipt', async (req, res, next) => { try { res.json({ valid: await savings.checkReceipt(req.body || {}) }); } catch (e) { next(e); } });
hooks.get('/:secret/plans/:planNo', async (req, res, next) => {
  try {
    const pl = await store.savingsPlans.byPlanNo(String(req.params.planNo).replace(/\D/g, ''));
    if (!pl) return res.status(404).json({ error: 'plan_not_found' });
    res.json(savings.view(pl));
  } catch (e) { next(e); }
});

module.exports = { api, hooks };
