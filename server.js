'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const store = require('./store');
const operatingMode = require('./services/operatingMode');
const { authTenant, requireLicense, errorHandler } = require('./middleware/auth');

const billsRoutes = require('./routes/bills');
const { router: paymentsRoutes } = require('./routes/payments');
const claimsRoutes = require('./routes/claims');
const dashboardRoutes = require('./routes/dashboard');
const institutionsRoutes = require('./routes/institutions');
const webhookRoutes = require('./routes/webhooks');
const checkoutRoutes = require('./routes/checkout');
const claimPortalRoutes = require('./routes/claimPortal');
const verifyPortalRoutes = require('./routes/verifyPortal');
const payerApiRoutes = require('./routes/payerApi');
const financingRoutes = require('./routes/financing');
const ledgerRoutes = require('./routes/ledger');
const adminRoutes = require('./routes/admin');
const platformRoutes = require('./routes/platform');
const { authPlatform, requireFeature } = require('./middleware/access');
const claimitRoutes = require('./routes/claimit');
const reportPortalRoutes = require('./routes/reportPortal');

const app = express();
app.use(express.json({ limit: '1mb' }));
const PUBLIC = path.join(__dirname, '..', 'public');

app.get('/', (req, res) => res.redirect('/app/dashboard.html'));

// `sandbox` (settlement's) is kept for any existing caller that only checks that
// one flag; `operatingMode` carries the live, independent state of both rails —
// see services/operatingMode.js. Reflects Master Control's saved setting once
// anything's been saved there, not just the env-var deploy default.
app.get('/health', async (req, res, next) => {
  try {
    const mode = await operatingMode.get();
    res.json({ ok: true, sandbox: mode.settlement.sandbox, operatingMode: mode });
  } catch (e) { next(e); }
});

// Public front ends + their public APIs
app.use('/pay/api', checkoutRoutes);
app.use('/pay', express.static(PUBLIC, { index: 'pay.html' }));
app.use('/claim/api', claimPortalRoutes);
app.use('/claim', express.static(PUBLIC, { index: 'claim.html' }));
app.use('/verify/api', verifyPortalRoutes);
app.use('/verify', express.static(PUBLIC, { index: 'verify.html' }));
app.use('/report/api', reportPortalRoutes);
app.use('/report', express.static(PUBLIC, { index: 'report.html' }));
app.use('/app', express.static(PUBLIC));

// Payer API (insurer RX / employer HR systems) — payer key
app.use('/api/payer', payerApiRoutes);
// Admin console API (IT leads) — x-admin-key
app.use('/api/admin', adminRoutes);
// Master control board (SaaS owners) — x-platform-key
app.use('/api/platform', authPlatform, platformRoutes);
// Collection gateway webhook
app.use('/api/v1/webhooks', webhookRoutes);

// Clinic / EHR / EMR API — tenant key
app.use('/api/v1', authTenant);
app.use('/api/v1', requireLicense);  // no-op unless HNN requires a licence
app.use('/api/v1/bills', billsRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/claims', claimsRoutes);
app.use('/api/v1/financing', requireFeature('financing'), financingRoutes);
app.use('/api/v1/ledger', requireFeature('ledger'), ledgerRoutes);
app.use('/api/v1/claimit', requireFeature('claimit'), claimitRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1', institutionsRoutes);

app.use(errorHandler);

if (require.main === module) {
  store.init().then(() => operatingMode.get()).then((mode) => app.listen(config.port, () => {
    const rail = (sandbox) => (sandbox ? 'sandbox' : 'LIVE');
    console.log(`Composite Billing Platform on :${config.port} `
      + `(settlement=${rail(mode.settlement.sandbox)}, messaging=${rail(mode.messaging.sandbox)}`
      + `${mode.seededFromEnv ? ', from env defaults — nothing saved in Master Control yet' : ''})`);
    console.log(`  Clinic terminal : http://localhost:${config.port}/app/biller.html`);
    console.log(`  Clinic dashboard: http://localhost:${config.port}/app/dashboard.html`);
    console.log(`  Payer inbox     : http://localhost:${config.port}/app/payers.html`);
    console.log(`  IT-lead console : http://localhost:${config.port}/app/admin.html`);
    console.log(`  Master control  : http://localhost:${config.port}/app/platform.html`);
  })).catch((e) => { console.error('Startup failed:', e); process.exit(1); });
}
module.exports = app;
