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

function errorHandler(err, req, res, _next) {
  const status = err.status || 502;
  const payload = { error: err.code || 'error', message: err.message };
  if (err.body) payload.upstream = err.body;
  if (status >= 500) console.error(err);
  res.status(status).json(payload);
}

module.exports = { authTenant, errorHandler };
