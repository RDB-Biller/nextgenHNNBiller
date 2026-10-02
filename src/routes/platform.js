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
const targets = require('../services/targets');
const priceList = require('../services/priceList');
const messaging = require('../services/messaging');
const messagingAccount = require('../services/messagingAccount');
const credentials = require('../services/credentials');
const operatingMode = require('../services/operatingMode');
const payerEditions = require('../services/payerEditions');
const fees = require('../services/fees');
const metricsLibrary = require('../services/metricsLibrary');
const products = require('../services/products');
const incentives = require('../services/incentives');
const campaigns = require('../services/campaigns');
const trialRegistrations = require('../services/trialRegistrations');

const router = express.Router();
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24);
const rand = () => crypto.randomBytes(5).toString('hex');

router.get('/me', (req, res) => res.json({ principal: req.principal, editions: editions.EDITIONS, roles: users.ROLES }));

// ---- Operating Mode: runtime sandbox/live switch for Settlement (Stanbic/SBG) --
// ---- and Messaging (SMS/WhatsApp), independently switchable (hybrid combos) ----
// See services/operatingMode.js. This is now the LIVE, authoritative switch —
// SBG_SANDBOX/MESSAGING_SANDBOX only seed the starting default (get().seededFromEnv
// says whether anything's actually been saved here yet). Switching Settlement to
// live moves real money through Stanbic, so it requires confirm:"LIVE" in the
// same call; Messaging has no such gate (see operatingMode.js's header comment
// for why). Switching either rail back to sandbox never needs confirmation.
router.get('/operating-mode', async (req, res, next) => {
  try { res.json(await operatingMode.get()); } catch (e) { next(e); }
});

// Body: { settlement?: { sandbox }, messaging?: { sandbox }, confirm? }. Only the
// rail(s) actually included are changed. 422 with { error:'confirmation_required',
// detail } if settlement.sandbox:false is sent without confirm:"LIVE" (exact).
router.put('/operating-mode', async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};
    if (body.settlement && 'sandbox' in body.settlement) patch.settlement = { sandbox: body.settlement.sandbox };
    if (body.messaging && 'sandbox' in body.messaging) patch.messaging = { sandbox: body.messaging.sandbox };
    if (body.confirm !== undefined) patch.confirm = body.confirm;
    res.json(await operatingMode.set(patch, req.principal?.id || 'HNN'));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, detail: e.detail });
    next(e);
  }
});

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
// Never includes the encrypted blob or a decrypted secret — same shape as
// messagingAccount.mask(), just read off a tenant record instead of the
// platform settings singleton.
function maskTenantCredentials(tc) {
  const rec = tc || {};
  return {
    useOwnCredentials: rec.useOwnCredentials === true,
    provider: rec.provider || null,
    configured: !!rec.encrypted,
    hint: rec.hint || null,
    updatedAt: rec.updatedAt || null,
  };
}

router.get('/clients', async (req, res, next) => {
  try {
    const rows = await store.tenants.all();
    res.json({ data: rows.map((t) => ({
      id: t.id, name: t.name, apiKey: t.apiKey,
      edition: editions.editionOf(t), editionUpdatedAt: t.editionUpdatedAt || null,
      features: editions.featureList(t),
      receivingAccount: t.receivingAccount || null, contact: t.contact || null,
      verificationChannels: t.verificationChannels || { sms: false, whatsapp: false, includeTreatmentDetail: false },
      messagingCredentials: maskTenantCredentials(t.messagingCredentials),
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

// Opt a clinic into real SMS/WhatsApp delivery of the patient verification link
// (default off — see services/messaging.js and README "Patient verification by
// SMS/WhatsApp"). includeTreatmentDetail is a second, separate opt-in: when off
// (the default) the message only carries the amount, a reference and the link,
// never line-item names, per this codebase's existing "no PHI over SMS/WhatsApp"
// stance; a clinic can turn it on deliberately if that fits their own context.
router.put('/clients/:id/verification-channels', async (req, res, next) => {
  try {
    const tenant = await store.tenants.get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'client_not_found' });
    const body = req.body || {};
    tenant.verificationChannels = {
      sms: body.sms === true,
      whatsapp: body.whatsapp === true,
      includeTreatmentDetail: body.includeTreatmentDetail === true,
    };
    await store.tenants.save(tenant);
    res.json({ id: tenant.id, verificationChannels: tenant.verificationChannels });
  } catch (e) { next(e); }
});

// ---- real SMS/WhatsApp sending: provider metadata, platform test account, ---
// ---- and per-client "bring your own credentials" ----------------------------
//
// Three layers, resolved in this order by services/messaging.js#resolveSender
// whenever MESSAGING_SANDBOX=false on this deployment (otherwise every send
// just logs, full stop, regardless of anything below):
//   1. A client's own provider account, if it has turned "useOwnCredentials"
//      on and saved working credentials (PUT /clients/:id/messaging-credentials).
//   2. The platform's own shared test account, if HNN has configured one AND
//      switched it active (PUT /messaging/test-account) — meant to be flipped
//      on for a live test and off again afterwards, no redeploy required.
//   3. Sandbox (log only).
// Every credential is encrypted at rest (CREDENTIAL_ENCRYPTION_KEY; see
// services/credentials.js) and every GET below returns a masked projection —
// provider, whether something is configured, a last-4 hint — never the secret.

// Which providers are wired in, their required fields, and an honest
// per-provider WhatsApp availability label (see messaging.js PROVIDER_META).
router.get('/messaging/providers', (req, res) => {
  res.json({ data: messaging.PROVIDER_META, encryptionConfigured: credentials.isConfigured() });
});

function validateProviderFields(provider, rawCreds) {
  const meta = messaging.PROVIDER_META[provider];
  if (!meta) return 'unknown_provider';
  const missing = meta.fields.filter((f) => !f.optional && !String(rawCreds?.[f.name] || '').trim());
  return missing.length ? `missing_fields: ${missing.map((f) => f.name).join(', ')}` : null;
}

router.get('/messaging/test-account', async (req, res, next) => {
  try { res.json(messagingAccount.mask(await messagingAccount.get())); }
  catch (e) { next(e); }
});

// Body: { provider?, credentials?: {...per PROVIDER_META[provider].fields}, active? }.
// Omit `credentials` to flip `active` without resupplying the secret (the
// "deactivate when testing is over" switch); include it to set or replace
// what's stored. Rejects activating with nothing usable configured.
router.put('/messaging/test-account', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.credentials) {
      const effectiveProvider = 'provider' in body ? body.provider : (await messagingAccount.get()).provider;
      const err = validateProviderFields(effectiveProvider, body.credentials);
      if (err) return res.status(422).json({ error: err });
    }
    // Build the patch from only the keys actually sent — messagingAccount.set()
    // uses `'key' in patch` to tell "leave this alone" apart from "set this to
    // undefined/false", so e.g. a credentials-only save must not include an
    // `active` key at all, or it would read as "turn active off".
    const patch = {};
    if ('provider' in body) patch.provider = body.provider;
    if (body.credentials) patch.credentials = body.credentials;
    if ('active' in body) patch.active = body.active;
    const rec = await messagingAccount.set(patch, req.principal?.id || 'HNN');
    res.json(messagingAccount.mask(rec));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Body: { useOwnCredentials?, provider?, credentials?: {...} }. A client
// turns this on to send through its own Twilio/Africa's Talking/Hubtel
// account instead of (or as well as configured — it always wins when on)
// the platform's shared test account. Master Control is where this is
// entered on the client's behalf today; nothing stops a future facility-
// scoped console (admin.html) from exposing the same endpoint to a client's
// own IT lead instead, since the storage and sending logic don't care who
// called it.
router.put('/clients/:id/messaging-credentials', async (req, res, next) => {
  try {
    const tenant = await store.tenants.get(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'client_not_found' });
    const body = req.body || {};
    const current = tenant.messagingCredentials || {};
    const provider = 'provider' in body ? (body.provider || null) : current.provider;
    if (body.credentials) {
      const err = validateProviderFields(provider, body.credentials);
      if (err) return res.status(422).json({ error: err });
    }
    const next_ = { ...current, updatedAt: new Date().toISOString(), updatedBy: req.principal?.id || 'HNN' };
    if ('provider' in body) next_.provider = provider;
    // Switching provider without new credentials in the same call would
    // otherwise leave the OLD provider's encrypted blob stored under the NEW
    // provider's name — safe (the adapter sees the wrong shape and fails
    // cleanly) but misleading in the UI. Require re-entry instead.
    if ('provider' in body && provider !== current.provider && !body.credentials) {
      next_.encrypted = null;
      next_.hint = null;
    }
    if (body.credentials && Object.keys(body.credentials).length) {
      next_.encrypted = credentials.encrypt(body.credentials);
      const secretFieldDef = (messaging.PROVIDER_META[provider]?.fields || []).find((f) => f.secret);
      next_.hint = credentials.hint(secretFieldDef ? body.credentials[secretFieldDef.name] : '');
    }
    if ('useOwnCredentials' in body) next_.useOwnCredentials = body.useOwnCredentials === true;
    if (next_.useOwnCredentials && (!next_.encrypted || !next_.provider)) {
      return res.status(422).json({ error: 'no_credentials_configured' });
    }
    tenant.messagingCredentials = next_;
    await store.tenants.save(tenant);
    res.json({ id: tenant.id, messagingCredentials: maskTenantCredentials(tenant.messagingCredentials) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// ---- payers (insurers + corporate) ------------------------------------------
// Never includes the encrypted blob or a decrypted secret — same shape as
// maskTenantCredentials() above, just for a payer's Stanbic/SBG credentials.
function maskSettlementCredentials(sc) {
  const rec = sc || {};
  return { configured: !!rec.encrypted, hint: rec.hint || null, updatedAt: rec.updatedAt || null, updatedBy: rec.updatedBy || null };
}

router.get('/payers', async (req, res, next) => {
  try {
    const rows = (await store.payers.all()).filter((p) => !p.tenantId);
    res.json({ data: rows.map((p) => ({ id: p.id, name: p.name, kind: p.kind, apiKey: p.apiKey,
      sourceAccount: p.sbg?.sourceAccount || null, contact: p.contact || null, tracker: p.tracker || null,
      repriceClaims: p.repriceClaims === true, requirePatientVerification: p.requirePatientVerification === true,
      // Commercial edition + per-claim commission (Master Control) -- see
      // services/payerEditions.js / fees.js#onPayerCommission. Doesn't gate any
      // of the fields above; only the commission itself.
      edition: payerEditions.editionOf(p), editionUpdatedAt: p.editionUpdatedAt || null,
      licence: payerEditions.licenceState(p),
      commission: { enabled: p.commission?.enabled === true, rate: p.commission?.rate || 0,
        cap: fees.MAX_PAYER_COMMISSION_RATE, updatedAt: p.commission?.updatedAt || null },
      // Encrypted Stanbic/SBG credentials entered via Master Control, and
      // whether the legacy plaintext fallback (payer.sbg.{username,password},
      // pre-dating this encrypted path) is what's actually in effect instead --
      // see services/settlement.js#clientForPayer().
      settlementCredentials: maskSettlementCredentials(p.settlementCredentials),
      legacySettlementCredentialsConfigured: !!(p.sbg?.username && p.sbg?.password),
    })) });
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

// Flip a payer between editions — instant, reversible, no data loss. Unlike a
// hospital, this doesn't gate the payer's own feature access (NNEST, price
// lists, targets, prior approvals keep working regardless) -- only whether the
// per-claim commission below can be enabled.
router.put('/payers/:id/edition', async (req, res, next) => {
  try { res.json(await payerEditions.setEdition(req.params.id, req.body?.edition, req.principal?.id || 'platform_admin')); }
  catch (e) { next(e); }
});

// Renew a payer's licence for another term (default 6 months), mirroring
// POST /clients/:id/renew. feeAmount = what was charged for this term.
router.post('/payers/:id/renew', async (req, res, next) => {
  try {
    res.json(await payerEditions.renew(req.params.id, {
      termMonths: req.body?.termMonths, feeAmount: req.body?.feeAmount, by: req.principal?.id || 'HNN',
    }));
  } catch (e) { next(e); }
});

// Set/enable a commercial payer's per-claim platform commission (separate from,
// and additive to, whatever expedited-settlement fee the hospital's own pricing
// rules may already charge this same payer -- see fees.js#onPayerCommission).
// Body: { enabled?, rate? } -- either alone leaves the other untouched. rate
// accepts 0..1 or 0..100 and is clamped to fees.MAX_PAYER_COMMISSION_RATE.
router.put('/payers/:id/commission', async (req, res, next) => {
  try {
    const payer = await store.payers.get(req.params.id);
    if (!payer) return res.status(404).json({ error: 'payer_not_found' });
    if (payerEditions.editionOf(payer) !== 'commercial') {
      return res.status(402).json({ error: 'upgrade_required', feature: 'payer_commission',
        edition: payerEditions.editionOf(payer), message: 'A per-claim commission requires the commercial edition.' });
    }
    const body = req.body || {};
    payer.commission = {
      enabled: body.enabled !== undefined ? body.enabled === true : (payer.commission?.enabled || false),
      rate: body.rate != null ? fees.normalisePayerCommissionRate(body.rate) : (payer.commission?.rate || 0),
      updatedAt: new Date().toISOString(), updatedBy: req.principal?.id || 'HNN',
    };
    await store.payers.save(payer);
    res.json({ payerId: payer.id, commission: payer.commission, cap: fees.MAX_PAYER_COMMISSION_RATE });
  } catch (e) { next(e); }
});

// A payer's own Stanbic/SBG marketplace username/password (the A2A authoriser
// credentials used by settlement.js#clientForPayer()), entered via Master
// Control and encrypted at rest -- same treatment as SMS/WhatsApp provider
// credentials (services/credentials.js), and for the same reason: these can't
// be known at deploy time and are at least as sensitive as any other secret
// this app handles. Falls back to legacy plaintext payer.sbg.{username,password}
// (pre-existing seed/demo data) whenever this hasn't been set -- see
// settlement.js. Body: { username, password }, both required.
router.put('/payers/:id/settlement-credentials', async (req, res, next) => {
  try {
    const payer = await store.payers.get(req.params.id);
    if (!payer) return res.status(404).json({ error: 'payer_not_found' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(422).json({ error: 'username_and_password_required' });
    payer.settlementCredentials = {
      encrypted: credentials.encrypt({ username, password }),
      hint: credentials.hint(password),
      updatedAt: new Date().toISOString(), updatedBy: req.principal?.id || 'HNN',
    };
    await store.payers.save(payer);
    res.json({ payerId: payer.id, settlementCredentials: maskSettlementCredentials(payer.settlementCredentials) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Clear the encrypted settlement credentials, reverting to whatever legacy
// plaintext payer.sbg fields exist (or none, if there are none).
router.delete('/payers/:id/settlement-credentials', async (req, res, next) => {
  try {
    const payer = await store.payers.get(req.params.id);
    if (!payer) return res.status(404).json({ error: 'payer_not_found' });
    payer.settlementCredentials = null;
    await store.payers.save(payer);
    res.json({ payerId: payer.id, settlementCredentials: maskSettlementCredentials(null) });
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

// Toggle whether this payer's approved price list GOVERNS settlement (default off).
// When on, a claim routed to this payer is repriced to its approved prices; the
// patient covers any gap between billed and approved. When off (default), the billed
// price governs and the list is reference-only.
router.put('/payers/:id/reprice', async (req, res, next) => {
  try {
    const payer = await store.payers.get(req.params.id);
    if (!payer) return res.status(404).json({ error: 'payer_not_found' });
    payer.repriceClaims = req.body?.enabled === true;
    await store.payers.save(payer);
    res.json({ payerId: payer.id, repriceClaims: payer.repriceClaims });
  } catch (e) { next(e); }
});

// Toggle whether this payer requires the PATIENT to verify their bill before this
// payer can authorise the A2A transfer (default off). When on, authorize() is
// blocked with 409 patient_verification_pending until the patient confirms via the
// link sent automatically when the bill was created (see services/verification.js).
router.put('/payers/:id/require-verification', async (req, res, next) => {
  try {
    const payer = await store.payers.get(req.params.id);
    if (!payer) return res.status(404).json({ error: 'payer_not_found' });
    payer.requirePatientVerification = req.body?.enabled === true;
    await store.payers.save(payer);
    res.json({ payerId: payer.id, requirePatientVerification: payer.requirePatientVerification });
  } catch (e) { next(e); }
});

// ---- Payer volume targets ---------------------------------------------------
// Set a processing target for an insurer/employer (monthly / 6-month / yearly / custom).
router.put('/payers/:id/target', async (req, res, next) => {
  try { res.json(await targets.setTarget(req.params.id, req.body || {})); }
  catch (e) { next(e); }
});

router.delete('/payers/:id/target', async (req, res, next) => {
  try { res.json(await targets.clearTarget(req.params.id)); }
  catch (e) { next(e); }
});

// Progress for one payer, or all payers with a target.
router.get('/payers/:id/target', async (req, res, next) => {
  try {
    const p = await targets.progress(req.params.id);
    if (!p) return res.status(404).json({ error: 'no_target' });
    res.json(p);
  } catch (e) { next(e); }
});

router.get('/targets', async (req, res, next) => {
  try { res.json({ data: await targets.allProgress() }); } catch (e) { next(e); }
});

// ---- Payer price lists (pre-approved prices, CSV upload) ---------------------
// Body: { csv: "<raw csv text>", replace?: true }. The console reads an Excel/CSV
// file to text and posts it here. Rows may target a provider for facility pricing.
router.post('/payers/:id/pricelist', async (req, res, next) => {
  try {
    const csv = req.body?.csv;
    if (!csv || typeof csv !== 'string') return res.status(422).json({ error: 'csv_required' });
    res.json(await priceList.upload(req.params.id, csv, { replace: req.body.replace !== false }));
  } catch (e) {
    if (e.status === 422) return res.status(422).json({ error: e.message, detail: e.detail });
    next(e);
  }
});

router.get('/payers/:id/pricelist', async (req, res, next) => {
  try {
    if (req.query.q != null) {
      return res.json({ data: await priceList.search(req.params.id, req.query.q, Math.min(parseInt(req.query.limit || '50', 10), 200)) });
    }
    const list = await priceList.get(req.params.id);
    res.json({ payerId: req.params.id, count: list.count, uploadedAt: list.uploadedAt,
      sample: (list.rows || []).slice(0, 20) });
  } catch (e) { next(e); }
});

router.delete('/payers/:id/pricelist', async (req, res, next) => {
  try { res.json(await priceList.clear(req.params.id)); } catch (e) { next(e); }
});

// ---- Product Development Environment ---------------------------------------
// A non-technical product manager builds a VBC program, promotional campaign,
// or loyalty/discount program here (services/products.js), against clinical
// observations an EMR partner has fed in (services/observations.js, routes/
// emr.js), then previews and accrues the incentives/penalties/cashback it
// produces (services/incentives.js). Nothing here disburses money -- see
// incentives.js's own header for why that's deliberate right now.

// The metric library a VBC program is built from -- condition optional, e.g.
// ?domain=vbc&condition=diabetes to populate a condition-specific picker.
router.get('/metrics-library', (req, res) => {
  res.json({
    conditions: metricsLibrary.CONDITIONS,
    metrics: metricsLibrary.listMetrics({ domain: req.query.domain, condition: req.query.condition }),
  });
});

router.get('/products', async (req, res, next) => {
  try {
    let data = req.query.payerId ? await products.listByPayer(req.query.payerId) : await products.all();
    if (!Array.isArray(data)) data = [];
    if (req.query.type) data = data.filter((p) => p.type === req.query.type);
    res.json({ data });
  } catch (e) { next(e); }
});

router.get('/products/:id', async (req, res, next) => {
  try { res.json(await products.get(req.params.id)); } catch (e) { next(e); }
});

// Body: { payerId, type: 'vbc'|'campaign'|'loyalty', name, description?, config }
// -- config's required shape depends on type; see products.js#validateConfig.
router.post('/products', async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await products.create(b.payerId, b, req.principal?.id || 'HNN'));
  } catch (e) { next(e); }
});

router.put('/products/:id', async (req, res, next) => {
  try { res.json(await products.update(req.params.id, req.body || {}, req.principal?.id || 'HNN')); }
  catch (e) { next(e); }
});

// Body: { status: 'draft'|'sandbox'|'live' }. Only draft<->sandbox<->live
// (in that order) are allowed in one step -- see products.js#VALID_TRANSITIONS.
router.post('/products/:id/status', async (req, res, next) => {
  try { res.json(await products.setStatus(req.params.id, req.body?.status, req.principal?.id || 'HNN')); }
  catch (e) { next(e); }
});

// Read-only: runs the scoring/reward engine for a period WITHOUT writing
// anything -- lets a product manager see what a program would pay out before
// committing to it. Body: { from?, to? } (ISO dates; both optional/open-ended).
router.post('/products/:id/preview', async (req, res, next) => {
  try {
    const product = await products.get(req.params.id);
    res.json(await incentives.compute(product, { from: req.body?.from, to: req.body?.to }));
  } catch (e) { next(e); }
});

// Runs the same engine as /preview but WRITES one accrual row per rewarded/
// penalised provider and patient. Safe to call repeatedly for different,
// non-overlapping periods; calling it twice for the same period double-counts,
// same caveat as re-running any other accrual job -- callers are expected to
// track which periods they've already run (the UI shows accrual history per
// product so this is visible, not hidden).
router.post('/products/:id/accrue', async (req, res, next) => {
  try {
    const product = await products.get(req.params.id);
    res.json(await incentives.accrue(product, { from: req.body?.from, to: req.body?.to }, req.principal?.id || 'HNN'));
  } catch (e) { next(e); }
});

router.get('/products/:id/accruals', async (req, res, next) => {
  try { res.json({ data: await incentives.listAccrualsByProduct(req.params.id) }); }
  catch (e) { next(e); }
});

// ---- Prospecting campaigns ("Campaigns" tab) --------------------------------
// Bulk SMS/WhatsApp to prospective clients -- see services/campaigns.js header
// for how this differs from the Product Lab above (that's for existing
// patients of an existing tenant; this is for people HNN hasn't signed up yet).

router.get('/campaigns/groups', async (req, res, next) => {
  try { res.json({ data: await campaigns.listGroups() }); } catch (e) { next(e); }
});

// Body: { name, numbers: "one per line or comma-separated" }. Each number is
// normalized to +233E.164; anything that doesn't resolve is reported back in
// `rejected` rather than silently dropped.
router.post('/campaigns/groups', async (req, res, next) => {
  try {
    const { group, added, rejected } = await campaigns.createGroup(req.body || {});
    res.status(201).json({ group, added, rejected });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.get('/campaigns/groups/:id/contacts', async (req, res, next) => {
  try {
    const group = await campaigns.getGroup(req.params.id);
    if (!group) return res.status(404).json({ error: 'group_not_found' });
    res.json({ group, data: await campaigns.listContacts(req.params.id, Math.min(parseInt(req.query.limit || '200', 10), 1000)) });
  } catch (e) { next(e); }
});

router.get('/campaigns', async (req, res, next) => {
  try { res.json({ data: await campaigns.listCampaigns(), smsAdvisoryLimit: campaigns.SMS_ADVISORY_LIMIT }); }
  catch (e) { next(e); }
});

// Body: { groupId, body, channel: 'sms'|'whatsapp' }. Returns immediately with
// status 'sending' -- the actual send runs in the background (see
// services/campaigns.js#runSend); poll GET /campaigns/:id for progress. This
// is the one action in this whole tab that actually dispatches real messages
// to real third parties, so it is never triggered by anything other than this
// direct call from a deliberate click in Master Control.
router.post('/campaigns', async (req, res, next) => {
  try {
    const b = req.body || {};
    const campaign = await campaigns.createCampaign({
      groupId: b.groupId, body: b.body, channel: b.channel, createdBy: req.principal?.id || 'HNN',
    });
    res.status(201).json(campaign);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.get('/campaigns/:id', async (req, res, next) => {
  try {
    const c = await campaigns.getCampaign(req.params.id);
    if (!c) return res.status(404).json({ error: 'campaign_not_found' });
    res.json(c);
  } catch (e) { next(e); }
});

router.get('/campaigns/:id/sends', async (req, res, next) => {
  try { res.json({ data: await campaigns.listSends(req.params.id) }); } catch (e) { next(e); }
});

// ---- Trial registrations (public /register/ sign-ups) -----------------------
// Pure lead queue -- approving/declining here never provisions a tenant; see
// services/trialRegistrations.js header for why that stays a separate,
// deliberate step via the existing "Add a client" form in the Clients tab.

router.get('/trial-registrations', async (req, res, next) => {
  try { res.json({ data: await trialRegistrations.list(), orgTypes: trialRegistrations.ORG_TYPES }); }
  catch (e) { next(e); }
});

router.put('/trial-registrations/:id/status', async (req, res, next) => {
  try { res.json(await trialRegistrations.setStatus(req.params.id, req.body?.status, req.principal?.id || 'HNN')); }
  catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

module.exports = router;
