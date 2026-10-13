'use strict';

const express = require('express');
const store = require('../store');
const savings = require('../services/savingsPlans');

/**
 * Hospital-facing BirthPrep API (mounted at /api/v1/savings behind authTenant): enrol, look up,
 * re-plan when facts change, record a contribution, bridge with InsureCredit, and "should the
 * terminal suggest a plan for this bill?". The tenant is always the caller.
 */
const router = express.Router();

async function ownPlan(req, res) {
  const pl = await store.savingsPlans.get(req.params.id);
  if (!pl || pl.tenantId !== req.tenant.id) { res.status(404).json({ error: 'plan_not_found' }); return null; }
  return pl;
}
async function programme(req, res) {
  const p = await savings.productFor(req.tenant.id, req.body?.productId || req.query?.productId);
  if (!p) { res.status(404).json({ error: 'no_live_savings_programme' }); return null; }
  return p;
}

router.get('/questions', (req, res) => res.json({ questions: savings.QUESTIONS, goals: savings.GOALS, horizons: savings.HORIZONS }));

router.get('/', async (req, res, next) => {
  try { res.json(await savings.list({ tenantId: req.tenant.id, status: req.query.status, limit: Number(req.query.limit) || 200 })); } catch (e) { next(e); }
});
router.get('/lookup', async (req, res, next) => {
  try { res.json({ data: await savings.findByPhone(req.tenant.id, req.query.phone) }); } catch (e) { next(e); }
});
// What the biller already knows about this patient (previous caesareans, hypertension, diabetes...).
router.get('/history', async (req, res, next) => {
  try { res.json(await savings.inferHistory(req.tenant.id, { phone: req.query.phone, memberId: req.query.memberId })); } catch (e) { next(e); }
});
// Should the terminal suggest a plan for this bill?
router.get('/suggest/:billId', async (req, res, next) => {
  try {
    const bill = await store.bills.get(req.params.billId);
    if (!bill || bill.tenantId !== req.tenant.id) return res.status(404).json({ error: 'bill_not_found' });
    const p = await savings.productFor(req.tenant.id);
    if (!p) return res.json({ suggest: false, reason: 'no_live_savings_programme' });
    const sug = savings.suggestionFor(bill, savings.paramsOf(p));
    const history = sug.suggest ? await savings.inferHistory(req.tenant.id, { phone: bill.patient?.phone, memberId: bill.coverage?.memberId }) : null;
    res.json({ ...sug, programme: { id: p.id, name: savings.paramsOf(p).brandName }, history: history ? history.facts : null });
  } catch (e) { next(e); }
});
// Dry-run the plan maths without enrolling.
router.post('/preview', async (req, res, next) => {
  try {
    const p = await programme(req, res); if (!p) return;
    const r = await savings.run({ surface: 'hospital', tenant: req.tenant, product: p }, savings.paramsOf(p), { ...(req.body || {}), action: 'simulate' });
    res.json(r);
  } catch (e) { next(e); }
});
// Enrol: { patient:{name,phone,memberId}, goal, horizon, other, facts, answers, billId, productId }
router.post('/plans', async (req, res, next) => {
  try {
    const p = await programme(req, res); if (!p) return;
    if (p.status !== 'live') return res.status(409).json({ error: 'programme_not_live' });
    res.status(201).json(savings.view(await savings.enrol({ tenant: req.tenant, product: p, input: req.body || {}, by: req.principal?.id || 'hospital' })));
  } catch (e) { next(e); }
});
router.get('/plans/:id', async (req, res, next) => {
  try { const pl = await ownPlan(req, res); if (pl) res.json(savings.view(pl)); } catch (e) { next(e); }
});
// Clinical change -> re-plan: { facts, answers, goal, horizon, other, note }
router.post('/plans/:id/replan', async (req, res, next) => {
  try { const pl = await ownPlan(req, res); if (!pl) return; res.json(savings.view(await savings.update(pl, { ...(req.body || {}), by: req.principal?.id || 'hospital' }))); } catch (e) { next(e); }
});
router.post('/plans/:id/contributions', async (req, res, next) => {
  try { const pl = await ownPlan(req, res); if (!pl) return; res.json(savings.view(await savings.contribute(pl, { amount: req.body?.amount, via: req.body?.via || 'cashier', reference: req.body?.reference || null, by: req.principal?.id || 'hospital' }))); } catch (e) { next(e); }
});
router.post('/plans/:id/status', async (req, res, next) => {
  try { const pl = await ownPlan(req, res); if (!pl) return; res.json(savings.view(await savings.setStatus(pl, req.body?.status, req.principal?.id || 'hospital'))); } catch (e) { next(e); }
});
// Bridge the shortfall with an InsureCredit offer against a real bill (delivery / procedure day).
router.post('/plans/:id/insurecredit', async (req, res, next) => {
  try { const pl = await ownPlan(req, res); if (!pl) return; res.status(201).json(await savings.bridgeWithInsureCredit(pl, { billId: req.body?.billId, tenant: req.tenant })); } catch (e) { next(e); }
});

module.exports = router;
