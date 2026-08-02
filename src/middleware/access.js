'use strict';

const store = require('../store');
const editions = require('../services/editions');

/**
 * Platform admin (master control board). Accepts the env superkey, or any user
 * with the platform_admin role.
 */
async function authPlatform(req, res, next) {
  try {
    const key = req.header('x-platform-key') || req.header('x-console-key');
    if (!key) return res.status(401).json({ error: 'missing_platform_key' });
    if (key === (process.env.PLATFORM_ADMIN_KEY || 'platform_demo_key_123')) {
      req.principal = { kind: 'platform', id: 'env_superkey', role: 'platform_admin' };
      return next();
    }
    const user = await store.users.byApiKey(key);
    if (!user || user.status !== 'active' || user.role !== 'platform_admin') {
      return res.status(401).json({ error: 'invalid_platform_key' });
    }
    req.principal = { kind: 'platform', id: user.id, role: user.role, user };
    next();
  } catch (e) { next(e); }
}

/**
 * Console auth for the IT-lead configuration API. Accepts:
 *   - a user console key (x-console-key) scoped to their org,
 *   - the platform superkey (full scope),
 *   - the legacy shared ADMIN_API_KEY (x-admin-key) for backwards compatibility.
 */
async function authConsole(req, res, next) {
  try {
    const consoleKey = req.header('x-console-key');
    const adminKey = req.header('x-admin-key');
    const platformKey = req.header('x-platform-key');

    if (platformKey && platformKey === (process.env.PLATFORM_ADMIN_KEY || 'platform_demo_key_123')) {
      req.principal = { kind: 'platform', role: 'platform_admin', scope: 'all' };
      return next();
    }
    if (adminKey && adminKey === (process.env.ADMIN_API_KEY || 'admin_demo_key_123')) {
      req.principal = { kind: 'legacy_admin', role: 'platform_admin', scope: 'all' };
      return next();
    }
    if (consoleKey) {
      const user = await store.users.byApiKey(consoleKey);
      if (!user || user.status !== 'active') return res.status(401).json({ error: 'invalid_console_key' });
      req.principal = {
        kind: 'user', id: user.id, role: user.role, user,
        scope: user.role === 'platform_admin' ? 'all' : 'org',
        orgType: user.orgType, orgId: user.orgId,
      };
      return next();
    }
    return res.status(401).json({ error: 'missing_console_key' });
  } catch (e) { next(e); }
}

/** An IT lead may only act on their own organisation. */
function assertScope(req, res, orgType, orgId) {
  const p = req.principal;
  if (!p) { res.status(401).json({ error: 'unauthenticated' }); return false; }
  if (p.scope === 'all') return true;
  if (p.orgType === orgType && p.orgId === orgId) return true;
  res.status(403).json({ error: 'out_of_scope', message: `Your console key is scoped to ${p.orgType}:${p.orgId}` });
  return false;
}

/** Gate a route behind an edition feature (tenant-scoped routes only). */
function requireFeature(feature) {
  return (req, res, next) => {
    const tenant = req.tenant;
    if (!tenant) return next();
    if (editions.has(tenant, feature)) return next();
    res.status(402).json({
      error: 'upgrade_required',
      feature,
      edition: editions.editionOf(tenant),
      message: `The ${feature.replace(/_/g, ' ')} feature requires the commercial edition. Redeem a licence key to upgrade.`,
    });
  };
}

module.exports = { authPlatform, authConsole, assertScope, requireFeature };
