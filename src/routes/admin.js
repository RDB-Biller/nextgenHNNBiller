'use strict';

/**
 * Admin API — for IT leads configuring the SaaS revenue model.
 * Auth: header `x-admin-key` (env ADMIN_API_KEY).
 *
 * Rules are per tenant (clinic/hospital/pharmacy), so different partners can be
 * on different commercial terms. Rate caps are enforced server-side.
 */
const express = require('express');
const store = require('../store');
const pricing = require('../services/pricing');
const payerSlots = require('../services/payerSlots');
const editions = require('../services/editions');
const { authConsole, assertScope } = require('../middleware/access');

const router = express.Router();

// IT-lead console auth: personal console key, platform superkey, or legacy admin key.
router.use(authConsole);

// An IT lead may only configure their own facility.
async function scoped(req, res) {
  const tenantId = req.params.tenantId;
  if (!assertScope(req, res, 'tenant', tenantId)) return null;
  const tenant = await store.tenants.get(tenantId);
  if (!tenant) { res.status(404).json({ error: 'client_not_found' }); return null; }
  return tenant;
}

// Identity + scope, so a console UI can adapt to who is signed in.
router.get('/me', (req, res) => {
  const p = req.principal || {};
  res.json({ role: p.role || null, scope: p.scope || 'all', orgType: p.orgType || null,
    orgId: p.orgId || null, name: p.user?.name || null });
});

// Metadata the console uses to build its form (types, caps, allowed targets).
router.get('/pricing/schema', (req, res) => {
  res.json({
    ruleTypes: pricing.RULE_TYPES,
    ruleModes: pricing.RULE_MODE,
    caps: pricing.CAPS,
    chargeTargets: pricing.CHARGE_TARGETS,
    defaults: pricing.DEFAULTS,
    notes: {
      billing: 'insurer = reverse-bill; provider/beneficiary = invoice; member = netted from cashback',
      custody: 'Fees are accrued to the ledger as receivables. The platform never custodies funds.',
    },
  });
});

// Tenants list, so the console can pick which partner to configure.
router.get('/tenants', async (req, res, next) => {
  try {
    let rows = await store.tenants.all();
    const p = req.principal || {};
    if (p.scope === 'org' && p.orgType === 'tenant') rows = rows.filter((t) => t.id === p.orgId);
    res.json({ data: rows.map((t) => ({ id: t.id, name: t.name, edition: editions.editionOf(t) })) });
  } catch (e) { next(e); }
});

// Effective rules for a tenant (saved values, or defaults where unset).
router.get('/pricing/:tenantId', async (req, res, next) => {
  try {
    const tenant = await scoped(req, res); if (!tenant) return;
    res.json({ tenantId: tenant.id, edition: editions.editionOf(tenant),
      features: editions.featureList(tenant),
      commercial: editions.has(tenant, 'revenue_rules'),
      rules: await pricing.listRules(tenant.id) });
  } catch (e) { next(e); }
});

// Program a rule. Rate accepts 0..1 or 0..100 and is clamped to the cap.
router.put('/pricing/:tenantId/:type', async (req, res, next) => {
  try {
    const tenant = await scoped(req, res); if (!tenant) return;
    if (!editions.has(tenant, 'revenue_rules')) {
      return res.status(402).json({ error: 'upgrade_required', feature: 'revenue_rules',
        edition: editions.editionOf(tenant), message: 'Revenue rules require the commercial edition.' });
    }
    res.json(await pricing.setRule(tenant.id, req.params.type, req.body || {}));
  } catch (e) { next(e); }
});

// Preview what a rule would charge on a given basis — no data written.
router.post('/pricing/:tenantId/:type/preview', async (req, res, next) => {
  try {
    const rule = await pricing.getRule(req.params.tenantId, req.params.type);
    const draft = req.body?.rule ? pricing.validate(req.params.type, req.body.rule) : rule;
    res.json({ rule: draft, fee: pricing.compute({ ...draft, enabled: true }, req.body?.basis || 0) });
  } catch (e) { next(e); }
});

// Revenue report from the append-only ledger (fee entries only).
router.get('/revenue/:tenantId', async (req, res, next) => {
  try {
    if (!(await scoped(req, res))) return;
    const rows = await store.ledger.summary(req.params.tenantId);
    const feeRows = rows.filter((r) => String(r.type).startsWith('platform_fee_'))
      .map((r) => ({ type: r.type, count: Number(r.n), total: Number(r.total) }));
    res.json({
      tenantId: req.params.tenantId,
      byType: feeRows,
      totalRevenue: Math.round(feeRows.reduce((s, r) => s + r.total, 0) * 100) / 100,
      entries: (await store.ledger.listByTenant(req.params.tenantId, 200))
        .filter((e) => String(e.type).startsWith('platform_fee_')).slice(0, 50),
    });
  } catch (e) { next(e); }
});

// ---- Agnostic payer slots (facility self-service) ----------------------------
router.get('/payer-slots/:tenantId', async (req, res, next) => {
  try {
    if (!(await scoped(req, res))) return;
    res.json({ tenantId: req.params.tenantId, counts: payerSlots.SLOT_COUNTS,
      slots: await payerSlots.list(req.params.tenantId) });
  } catch (e) { next(e); }
});

// Program a slot: { name, sourceAccount, contactEmail, expiresAt, enabled }
router.put('/payer-slots/:tenantId/:kind/:index', async (req, res, next) => {
  try {
    const tenant = await scoped(req, res); if (!tenant) return;
    if (!editions.has(tenant, 'payer_slots')) {
      return res.status(402).json({ error: 'upgrade_required', feature: 'payer_slots',
        edition: editions.editionOf(tenant), message: 'Agnostic payer tabs require the commercial edition.' });
    }
    const p = await payerSlots.program(req.params.tenantId, req.params.kind, req.params.index, req.body || {});
    res.json({ id: p.id, name: p.name, kind: p.kind, slot: p.slot, apiKey: p.apiKey,
      sourceAccount: p.sbg.sourceAccount, contactEmail: p.contact.email,
      enabled: p.enabled, expiresAt: p.expiresAt, provisional: true });
  } catch (e) { next(e); }
});

router.delete('/payer-slots/:tenantId/:kind/:index', async (req, res, next) => {
  try {
    if (!(await scoped(req, res))) return; res.json(await payerSlots.release(req.params.tenantId, req.params.kind, req.params.index)); }
  catch (e) { next(e); }
});

// ---- Edition / licence (IT lead can redeem an upgrade key themselves) --------
router.get('/edition/:tenantId', async (req, res, next) => {
  try {
    const tenant = await scoped(req, res); if (!tenant) return;
    res.json({ tenantId: tenant.id, name: tenant.name, edition: editions.editionOf(tenant),
      features: editions.featureList(tenant), editionUpdatedAt: tenant.editionUpdatedAt || null });
  } catch (e) { next(e); }
});

router.post('/edition/:tenantId/redeem', async (req, res, next) => {
  try {
    const tenant = await scoped(req, res); if (!tenant) return;
    res.json(await editions.redeem(req.body?.key, tenant.id));
  } catch (e) { next(e); }
});

module.exports = router;
