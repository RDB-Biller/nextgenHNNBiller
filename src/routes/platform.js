'use strict';

/**
 * MASTER CONTROL BOARD — SaaS owner API.
 * Auth: `x-platform-key` (env PLATFORM_ADMIN_KEY) or a platform_admin user key.
 *
 * Manages every organisation on the deployment (hospitals/pharmacies, insurers and
 * corporate payers, EMR/EHR vendors), the IT leads assigned to them, and the
 * commercial vs non-commercial edition of each client.
 */
const crypto = require('crypto');
const express = require('express');
const store = require('../store');
const users = require('../services/users');
const editions = require('../services/editions');
const submissions = require('../services/submissions');
const revenue = require('../services/revenue');
const licensing = require('../services/licensing');

const router = express.Router();
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24);
const rand = () => crypto.randomBytes(5).toString('hex');

router.get('/me', (req, res) => res.json({ principal: req.principal, editions: editions.EDITIONS, roles: users.ROLES }));

// ---- overview ---------------------------------------------------------------
router.get('/overview', async (req, res, next) => {
  try {
    const [tenants, payers, emr, us, lics] = await Promise.all([
      store.tenants.all(), store.payers.all(), store.emrPartners.all(), store.users.all(), store.licenses.all(),
    ]);
    const globalPayers = payers.filter((p) => !p.tenantId);
    res.json({
      clients: tenants.length,
      commercial: tenants.filter((t) => editions.editionOf(t) === 'commercial').length,
      nonCommercial: tenants.filter((t) => editions.editionOf(t) === 'non_commercial').length,
      payers: globalPayers.length,
      insurers: globalPayers.filter((p) => p.kind === 'insurer').length,
      corporatePayers: globalPayers.filter((p) => p.kind === 'employer').length,
      emrPartners: emr.length,
      itLeads: us.filter((u) => u.role !== 'platform_admin').length,
      licenses: { issued: lics.filter((l) => l.status === 'issued').length,
        redeemed: lics.filter((l) => l.status === 'redeemed').length,
        revoked: lics.filter((l) => l.status === 'revoked').length },
    });
  } catch (e) { next(e); }
});

// ---- clients (hospitals / clinics / pharmacies) ------------------------------
router.get('/clients', async (req, res, next) => {
  try {
    const rows = await store.tenants.all();
    res.json({ data: rows.map((t) => ({
      id: t.id, name: t.name, apiKey: t.apiKey,
      edition: editions.editionOf(t), editionUpdatedAt: t.editionUpdatedAt || null,
      features: editions.featureList(t),
      receivingAccount: t.receivingAccount || null, contact: t.contact || null,
    })) });
  } catch (e) { next(e); }
});

router.post('/clients', async (req, res, next) => {
  try {
    const { name, edition = 'non_commercial', serviceRoutingCode, beneficiaryAccount, email, phone } = req.body || {};
    if (!name) return res.status(422).json({ error: 'name_required' });
    const tenant = {
      id: `tenant_${slug(name)}`, apiKey: `emr_${slug(name)}_${rand()}`, name,
      edition: editions.EDITIONS.includes(edition) ? edition : 'non_commercial',
      receivingAccount: { serviceRoutingCode: serviceRoutingCode || null, beneficiaryAccount: beneficiaryAccount || null },
      contact: { email: email || null, phone: phone || null },
      createdAt: new Date().toISOString(),
    };
    await store.tenants.save(tenant);
    res.status(201).json(tenant);
  } catch (e) { next(e); }
});

// Flip a client between editions — instant, reversible, no data loss.
router.put('/clients/:id/edition', async (req, res, next) => {
  try { res.json(await editions.setEdition(req.params.id, req.body?.edition, req.principal?.id || 'platform_admin')); }
  catch (e) { next(e); }
});

// ---- payers (insurers + corporate) ------------------------------------------
router.get('/payers', async (req, res, next) => {
  try {
    const rows = (await store.payers.all()).filter((p) => !p.tenantId);
    res.json({ data: rows.map((p) => ({ id: p.id, name: p.name, kind: p.kind, apiKey: p.apiKey,
      sourceAccount: p.sbg?.sourceAccount || null, contact: p.contact || null, tracker: p.tracker || null })) });
  } catch (e) { next(e); }
});

router.post('/payers', async (req, res, next) => {
  try {
    const { name, kind = 'insurer', sourceAccount, email } = req.body || {};
    if (!name) return res.status(422).json({ error: 'name_required' });
    const payer = { id: slug(name), name, kind: kind === 'employer' ? 'employer' : 'insurer',
      apiKey: `payer_${slug(name)}_${rand()}`, contact: { email: email || null },
      sbg: { sourceAccount: sourceAccount || null }, createdAt: new Date().toISOString() };
    await store.payers.save(payer);
    res.status(201).json(payer);
  } catch (e) { next(e); }
});

// ---- EMR / EHR vendor partners ----------------------------------------------
router.get('/emr-partners', async (req, res, next) => {
  try { res.json({ data: await store.emrPartners.all() }); } catch (e) { next(e); }
});

router.post('/emr-partners', async (req, res, next) => {
  try {
    const { name, email, contactName } = req.body || {};
    if (!name) return res.status(422).json({ error: 'name_required' });
    const p = { id: `emr_${slug(name)}`, name, apiKey: `emrp_${slug(name)}_${rand()}`,
      contact: { name: contactName || null, email: email || null },
      clients: [], createdAt: new Date().toISOString() };
    await store.emrPartners.save(p);
    res.status(201).json(p);
  } catch (e) { next(e); }
});

// ---- IT leads / users --------------------------------------------------------
router.get('/users', async (req, res, next) => {
  try { res.json({ data: await users.list() }); } catch (e) { next(e); }
});

router.post('/users', async (req, res, next) => {
  try {
    const u = await users.create({ ...req.body, createdBy: req.principal?.id || 'platform_admin' });
    res.status(201).json(users.publicView(u));
  } catch (e) { next(e); }
});

router.put('/users/:id/status', async (req, res, next) => {
  try { res.json(users.publicView(await users.setStatus(req.params.id, req.body?.status))); }
  catch (e) { next(e); }
});

router.post('/users/:id/rotate-key', async (req, res, next) => {
  try { res.json(users.publicView(await users.rotateKey(req.params.id))); } catch (e) { next(e); }
});

// ---- licences ----------------------------------------------------------------
router.get('/licenses', async (req, res, next) => {
  try { res.json({ data: await store.licenses.all() }); } catch (e) { next(e); }
});

router.post('/licenses', async (req, res, next) => {
  try {
    res.status(201).json(await editions.issueLicense({ ...req.body, issuedBy: req.principal?.id || 'platform_admin' }));
  } catch (e) { next(e); }
});

router.post('/licenses/:key/revoke', async (req, res, next) => {
  try { res.json(await editions.revoke(req.params.key)); } catch (e) { next(e); }
});

// ---- Submissions oversight & approval (SaaS administrator) -------------------
// Every claim across all developers/tenants; approve to trigger the Stanbic A2A
// transfer, or decline. The provider is paid directly — funds never touch the platform.
router.get('/submissions', async (req, res, next) => {
  try {
    res.json({ data: await submissions.list({ status: req.query.status, tenantId: req.query.tenantId,
      limit: Math.min(parseInt(req.query.limit || '200', 10), 500) }) });
  } catch (e) { next(e); }
});

router.get('/submissions/summary', async (req, res, next) => {
  try { res.json(await submissions.summary()); } catch (e) { next(e); }
});

router.get('/submissions/:id', async (req, res, next) => {
  try {
    const c = await require('../store').claims.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'claim_not_found' });
    res.json(await submissions.enrich(c));
  } catch (e) { next(e); }
});

// Approve -> runs the A2A transfer to the provider and settles.
router.post('/submissions/:id/approve', async (req, res, next) => {
  try { res.json(await submissions.approve(req.params.id, req.principal?.id || 'administrator')); }
  catch (e) { next(e); }
});

// Decline with a reason.
router.post('/submissions/:id/decline', async (req, res, next) => {
  try { res.json(await submissions.decline(req.params.id, req.body?.reason, req.principal?.id || 'administrator')); }
  catch (e) { next(e); }
});

// ---- SaaS-wide revenue (platform owner) --------------------------------------
router.get('/revenue', async (req, res, next) => {
  try { res.json(await revenue.summary()); } catch (e) { next(e); }
});

router.get('/revenue/recent', async (req, res, next) => {
  try { res.json({ data: await revenue.recent(Math.min(parseInt(req.query.limit || '100', 10), 500)) }); }
  catch (e) { next(e); }
});

// ---- Licensing policy (SaaS owner) ------------------------------------------
// The platform ships non-commercial and fee-free. HNN can switch to 'licensed'
// (require a paid licence) and set the fee per 6-month term.
router.get('/licensing', async (req, res, next) => {
  try { res.json(await licensing.get()); } catch (e) { next(e); }
});

router.put('/licensing', async (req, res, next) => {
  try { res.json(await licensing.set(req.body || {}, req.principal?.id || 'HNN')); }
  catch (e) { next(e); }
});

// Licence state for every client (edition, expiry, days left, due-soon flags).
router.get('/licenses/state', async (req, res, next) => {
  try {
    const [tenants, policy] = await Promise.all([store.tenants.all(), licensing.get()]);
    const graceEndsAt = licensing.graceEndsAt(policy);
    res.json({ policy: { mode: policy.mode, graceEndsAt },
      data: tenants.map((t) => {
        const st = editions.licenceState(t);
        const unlicensedInGrace = policy.requireLicense && !st.expiresAt && graceEndsAt && Date.now() < new Date(graceEndsAt).getTime();
        return { id: t.id, name: t.name, ...st,
          graceEndsAt: (!st.expiresAt && policy.requireLicense) ? graceEndsAt : null,
          effectiveStatus: !policy.requireLicense ? 'free'
            : st.expiresAt ? (st.active ? 'licensed' : 'lapsed')
            : (unlicensedInGrace ? 'grace' : 'unlicensed') };
      }) });
  } catch (e) { next(e); }
});

// Renew a client's licence for another term (default 6 months). feeAmount = what
// was charged (0 while non-commercial/free).
router.post('/clients/:id/renew', async (req, res, next) => {
  try {
    res.json(await editions.renew(req.params.id, {
      termMonths: req.body?.termMonths,
      feeAmount: req.body?.feeAmount,
      by: req.principal?.id || 'HNN',
    }));
  } catch (e) { next(e); }
});

module.exports = router;
