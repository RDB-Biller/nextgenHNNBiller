'use strict';

const store = require('../store');

/** Authenticate an EMR/EHR tenant by API key (async DB lookup). */
async function authTenant(req, res, next) {
  try {
    const key = req.header('x-api-key');
    if (!key) return res.status(401).json({ error: 'missing_api_key' });
    const tenant = await store.tenants.byApiKey(key);
    if (!tenant) return res.status(401).json({ error: 'invalid_api_key' });
    req.tenant = tenant;
    next();
  } catch (e) { next(e); }
}

/**
 * Enforce the licensing policy. A no-op while the platform is non-commercial and
 * fee-free (the current default): it only blocks when HNN has switched the policy
 * to 'licensed' AND the client's licence has lapsed. Then the client must renew.
 */
async function requireLicense(req, res, next) {
  try {
    const licensing = require('../services/licensing');
    const { allowed, licence, grace } = await licensing.clientAllowed(req.tenant);
    if (allowed) return next();
    return res.status(402).json({
      error: 'license_required',
      message: grace && grace.endsAt
        ? 'Your grace period to obtain a licence has ended. Please pay to receive a licence key.'
        : 'A current licence is required to use the platform. Please renew.',
      expiredAt: licence?.expiresAt || null,
      graceEndedAt: grace?.endsAt || null,
    });
  } catch (e) { next(e); }
}

function errorHandler(err, req, res, _next) {
  const status = err.status || 502;
  const payload = { error: err.code || 'error', message: err.message };
  if (err.body) payload.upstream = err.body;
  if (status >= 500) console.error(err);
  res.status(status).json(payload);
}

module.exports = { authTenant, requireLicense, errorHandler };
