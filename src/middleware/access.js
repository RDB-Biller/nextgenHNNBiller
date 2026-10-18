'use strict';

const store = require('../store');
const editions = require('../services/editions');

/**
 * Platform admin (master control board). Accepts the env superkey, or any user
 * with the platform_admin role.
 */
async function authPlatform(req, res, next) {
  try {
    // A sub-admin signs in with their own password (see services/subAdmins.js) and may open only the areas they were given.
    const bearer = req.header('authorization');
    if (bearer && /^Bearer\s+/i.test(bearer) && !req.header('x-platform-key') && !req.header('x-console-key')) {
      const subAdmins = require('../services/subAdmins');
      let a; try { a = await subAdmins.authenticate(bearer); } catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
      const full = String(req.originalUrl || (req.baseUrl || '') + req.path).split('?')[0];
      const seg = (/^\/api\/platform\/?([^/]*)/.exec(full) || [])[1] || '';
      const verdict = subAdmins.allows(a, seg, req.method);
      if (!verdict.ok) return res.status(403).json({ error: 'not_allowed', message: verdict.why });
      req.principal = { kind: 'subadmin', id: a._id, role: 'sub_admin', areas: a.areas, readOnly: !!a.readOnly, sandboxed: !!a.sandboxed, name: a.name };
      if (a.sandboxed) {
        // Demo and evaluator logins: every visitor works on a private scratch copy, so changes show for them alone and never reach real data. No secrets or contact details are shown.
        const guard = require('../services/demoGuard');
        const send = res.json.bind(res); res.json = (body) => send(guard.clean(body));
        if (seg === 'me') return next();
        const sc = await store.scratchFor(`v:${a.vid || a._id}`);
        return store.runInScratch(sc, () => next());
      }
      return next();
    }
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
    const ctl = require('../services/accountControl');
    const c = await ctl.get('staff', user.id);
    if (c.disabled) return res.status(403).json({ error: 'account_disabled', message: 'This account has been deactivated.' });
    // Clearances: staff keep both by default. Master Control can take either away from a person.
    const full = String(req.originalUrl || (req.baseUrl || '') + req.path).split('?')[0];
    const labPath = /^(\/api\/platform)?\/(products|solutions)(\/|$)/.test(full);
    if (labPath && !c.grants.productLab) return res.status(403).json({ error: 'clearance_required', message: 'Your account has not been cleared to use Product Lab.' });
    if (/^(\/api\/platform)?\/operating-mode\/?$/.test(full) && req.method !== 'GET' && !c.grants.goLive) return res.status(403).json({ error: 'clearance_required', message: 'Your account has not been cleared to switch between sandbox and live.' });
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
      if (await require('../services/accountControl').isDisabled('staff', user.id)) return res.status(403).json({ error: 'account_disabled', message: 'This account has been deactivated.' });
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
