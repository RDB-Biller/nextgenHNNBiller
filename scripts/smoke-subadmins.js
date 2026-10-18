'use strict';
// Smoke test for sub-admins: invite, own password, per-area access, read-only, chief-only parts, deactivation.
//   node scripts/smoke-subadmins.js
process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const express = require('express');
const store = require('../src/store');
const admins = require('../src/services/subAdmins');
const ctl = require('../src/services/accountControl');
const { authPlatform } = require('../src/middleware/access');
const adminRoutes = require('../src/routes/subAdmins');
const accountRoutes = require('../src/routes/accountControlAdmin');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const rej = (p) => p.then(() => null, (e) => e);

(async () => {
  await store.init?.();
  let e = await rej(admins.invite({ name: 'X', preset: 'support' })); ok(e && e.status === 422, 'an invite needs an email or phone');
  e = await rej(admins.invite({ name: 'X', email: 'x@y.com', preset: 'custom' })); ok(e && e.status === 422, 'and at least one area');
  const inv = await admins.invite({ name: 'Efua Partner-Mgr', email: 'Efua@HNN.org', preset: 'partner_manager' });
  ok(/\/app\/platform\.html#invite=/.test(inv.inviteLink) && inv.account.status === 'invited' && inv.account.areas.join() === 'partners,accounts', 'the chief gets an invite link, with the role\'s areas');
  const tok = inv.inviteLink.split('invite=')[1];
  e = await rej(admins.login({ handle: 'efua@hnn.org', password: 'whatever12345' })); ok(e && e.status === 401, 'nobody can sign in before accepting the invite');
  e = await rej(admins.acceptInvite({ token: tok, password: 'short' })); ok(e && e.status === 422, 'the person must choose a real password (10+ characters)');
  const acc = await admins.acceptInvite({ token: tok, password: 'my-own-password-1' }); ok(!!acc.token && acc.account.status === 'active', 'the person chooses their own password and is signed in');
  e = await rej(admins.acceptInvite({ token: tok, password: 'another-password-1' })); ok(e && e.status === 410, 'an invite works once');
  e = await rej(admins.login({ handle: 'efua@hnn.org', password: 'platform_demo_key_123' })); ok(e && e.status === 401, 'the demo key is not a password');
  const s = await admins.login({ handle: 'efua@hnn.org', password: 'my-own-password-1' }); ok(!!s.token, 'sign-in with email and password');

  // ---- what the server lets them reach
  const app = express();
  const plat = express.Router(); plat.use((req, res) => res.json({ ok: true })); app.use('/api/platform/partners', authPlatform, plat);
  app.use('/api/platform/erheat', authPlatform, plat); app.use('/api/platform/settlement-batches', authPlatform, plat); app.use('/api/platform/users', authPlatform, plat);
  app.use('/api/platform/overview', authPlatform, plat); app.use('/api/platform/operating-mode', authPlatform, plat);
  app.use('/api/platform/admins', authPlatform, adminRoutes.admin); app.use('/api/platform/accounts', authPlatform, accountRoutes);
  const srv = app.listen(0); await new Promise((r) => setTimeout(r, 50)); const base = `http://127.0.0.1:${srv.address().port}`;
  const B = { Authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }; const K = { 'x-platform-key': 'platform_demo_key_123', 'content-type': 'application/json' };
  const get = (p, h) => fetch(`${base}/api/platform/${p}`, { headers: h }).then((r) => r.status);
  ok(await get('partners', B) === 200 && await get('erheat/config', B) === 200, 'a partner manager can open partners and ER HEAT');
  ok(await get('settlement-batches', B) === 403, 'but not settlement');
  ok(await get('operating-mode', B) === 403, 'nor the sandbox and live switch');
  ok(await get('users', B) === 403, 'nor user creation (that would be a way up)');
  ok(await get('admins', B) === 403, 'nor admin management');
  ok(await get('overview', B) === 200, 'everyone signed in sees the overview');
  ok(await get('partners', { Authorization: 'Bearer junk' }) === 401, 'a bad token is refused');
  ok(await get('admins', K) === 200, 'the chief key still reaches everything');

  // ---- read-only and accounts limits
  const acctId = (await admins.list())[0].id;
  await admins.update(acctId, { readOnly: true });
  let r = await fetch(`${base}/api/platform/partners`, { method: 'POST', headers: B, body: '{}' }); ok(r.status === 403, 'a read-only admin cannot change anything');
  ok(await get('partners', B) === 200, 'but can look');
  await admins.update(acctId, { readOnly: false });
  r = await fetch(`${base}/api/platform/accounts/staff/usr_x`, { method: 'PATCH', headers: B, body: JSON.stringify({ disabled: true }) }); ok(r.status === 403, 'a sub-admin cannot deactivate staff accounts');
  r = await fetch(`${base}/api/platform/accounts/partner/pt_x`, { method: 'PATCH', headers: B, body: JSON.stringify({ grants: { goLive: true } }) }); ok(r.status === 403, 'nor change clearances');
  r = await fetch(`${base}/api/platform/accounts/partner/pt_x`, { method: 'PATCH', headers: B, body: JSON.stringify({ disabled: true }) }); ok(r.status === 404, 'but can manage ordinary accounts (unknown id is a 404, not a 403)');

  // ---- end of access
  await admins.update(acctId, { status: 'suspended' }); ok(await get('partners', B) === 401, 'suspending an admin ends their session at once');
  await admins.update(acctId, { status: 'active' }); const s2 = await admins.login({ handle: 'efua@hnn.org', password: 'my-own-password-1' });
  await ctl.update('subadmin', acctId, { disabled: true }); e = await rej(admins.authenticate(`Bearer ${s2.token}`)); ok(e && e.status === 401, 'deactivating from the account directory also ends it');
  ok((await ctl.directory({ kind: 'subadmin' })).rows.length === 1, 'sub-admins appear in the account directory');
  await ctl.update('subadmin', acctId, { disabled: false });
  const re = await admins.reinvite(acctId, false); e = await rej(admins.login({ handle: 'efua@hnn.org', password: 'my-own-password-1' })); ok(e && e.status === 401 && re.inviteLink, 'a new invite voids the old password');
  await admins.remove(acctId); e = await rej(admins.acceptInvite({ token: re.inviteLink.split('invite=')[1], password: 'brand-new-password-1' })); ok(e && e.status === 410, 'a removed admin cannot come back through an old invite');
  srv.close();
  console.log(`\n${a} assertions${process.exitCode ? ' — WITH FAILURES' : ' — all passed'}`);
})().catch((x) => { console.error(x); process.exit(1); });
