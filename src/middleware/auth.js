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

/** Authenticate an EMR/EHR partner by API key — the one source clinical
 *  observations (Product Development Environment / VBC) are ever accepted
 *  from. Separate from authTenant: an EMR partner isn't a clinic/hospital
 *  tenant and has no bill/claims access, only this one feed. */
async function authEmrPartner(req, res, next) {
  try {
    const key = req.header('x-api-key');
    if (!key) return res.status(401).json({ error: 'missing_api_key' });
    const partner = await store.emrPartners.byApiKey(key);
    if (!partner) return res.status(401).json({ error: 'invalid_api_key' });
    req.emrPartner = partner;
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
  if (err.detail && status < 500) payload.detail = err.detail;
  if (err.body) payload.upstream = err.body;
  if (status >= 500) console.error(err);
  res.status(status).json(payload);
}

module.exports = { authTenant, authEmrPartner, requireLicense, errorHandler };
