'use strict';
// Smoke coverage for Master Control's Operating Mode: the runtime-authoritative,
// independently-switchable sandbox/live control for the Settlement (Stanbic/SBG)
// and Messaging (SMS/WhatsApp) rails (src/services/operatingMode.js). Covers:
//   - env vars only seed a starting default, and only until anything is saved
//   - Settlement going live requires confirm:'LIVE' (exact, case-sensitive);
//     Messaging needs no such gate (it only costs SMS fees, not bank risk)
//   - the two rails switch independently -- the hybrid-mode requirement itself
//   - the wiring into messaging.js#isSandbox() and settlement.js#clientForPayer()
//     (both the sandbox flag AND credentials resolution: encrypted
//     payer.settlementCredentials preferred over legacy plaintext
//     payer.sbg.{username,password})
//
// Sets SBG_SANDBOX/MESSAGING_SANDBOX explicitly before any require (src/config.js
// reads env vars once, at require time) so this file's starting point is fixed
// regardless of the ambient environment -- same reason smoke-messaging-live.js
// sets its own env vars up front. No real Stanbic network is reached: sbgClient's
// fetch is intercepted via _setFetchImplForTests, mirroring how
// smoke-messaging-live.js intercepts messaging's own transport.

process.env.SBG_SANDBOX = 'true';
process.env.MESSAGING_SANDBOX = 'true';
if (!process.env.CREDENTIAL_ENCRYPTION_KEY) process.env.CREDENTIAL_ENCRYPTION_KEY = 'smoke-test-only-key-do-not-use-in-production';

const operatingMode = require('../src/services/operatingMode');
const messaging = require('../src/services/messaging');
const credentials = require('../src/services/credentials');
const { executePayerTransfer, transferStatus } = require('../src/services/settlement');
const { _setFetchImplForTests } = require('../src/sbgClient');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exit(1); } console.log(`ok  : ${label}`); };

async function envSeededDefaults() {
  const mode = await operatingMode.get();
  ok(mode.seededFromEnv === true, 'nothing saved yet: get() reports seededFromEnv');
  ok(mode.settlement.sandbox === true && mode.messaging.sandbox === true,
    'nothing saved yet: both rails default from their env vars (both true here)');
  ok(mode.updatedAt === null && mode.updatedBy === null, 'nothing saved yet: no updatedAt/updatedBy');
}

async function confirmationGate() {
  let threw = false, status = null, detail = null;
  try { await operatingMode.set({ settlement: { sandbox: false } }, 'tester'); }
  catch (e) { threw = true; status = e.status; detail = e.detail; }
  ok(threw && status === 422, 'settlement -> live with no confirm is rejected (422)');
  ok(!!detail, 'the rejection explains why (real money through Stanbic)');
  let mode = await operatingMode.get();
  ok(mode.settlement.sandbox === true, 'the rejected attempt leaves settlement sandboxed, not half-saved');

  threw = false; status = null;
  try { await operatingMode.set({ settlement: { sandbox: false }, confirm: 'live' }, 'tester'); }
  catch (e) { threw = true; status = e.status; }
  ok(threw && status === 422, 'a lowercase "live" does not satisfy the gate -- exact, case-sensitive match required');

  mode = await operatingMode.set({ settlement: { sandbox: false }, confirm: 'LIVE' }, 'ops@hnn');
  ok(mode.settlement.sandbox === false, 'confirm:"LIVE" switches settlement to live');
  ok(mode.updatedBy === 'ops@hnn' && !!mode.updatedAt, 'records who made the change and when');
  ok(mode.seededFromEnv === false, 'once anything is saved, seededFromEnv is false going forward');

  // Going back to sandbox never needs confirmation, for either rail.
  mode = await operatingMode.set({ settlement: { sandbox: true } }, 'ops@hnn');
  ok(mode.settlement.sandbox === true, 'settlement -> sandbox needs no confirm');

  // Messaging has no confirmation gate at all, in either direction.
  mode = await operatingMode.set({ messaging: { sandbox: false } }, 'ops@hnn');
  ok(mode.messaging.sandbox === false, 'messaging -> live is a plain toggle, no confirm needed');
}

async function hybridIndependence() {
  // From confirmationGate(): settlement is sandbox:true, messaging is sandbox:false.
  // Flipping settlement to live (with confirm) must not disturb messaging, and
  // vice versa -- this independence IS the hybrid-mode requirement.
  let mode = await operatingMode.set({ settlement: { sandbox: false }, confirm: 'LIVE' });
  ok(mode.settlement.sandbox === false && mode.messaging.sandbox === false,
    'flipping settlement live leaves messaging (already live) untouched');

  mode = await operatingMode.set({ messaging: { sandbox: true } });
  ok(mode.messaging.sandbox === true && mode.settlement.sandbox === false,
    'flipping messaging back to sandbox leaves settlement (live) untouched -- hybrid: messaging sandboxed, settlement live');

  mode = await operatingMode.set({ messaging: { sandbox: false } });
  ok(mode.messaging.sandbox === false && mode.settlement.sandbox === false, 'both rails live together');
}

async function messagingWiring() {
  // messaging.js no longer owns a SANDBOX constant -- it asks operatingMode
  // fresh, every call, via isSandbox().
  await operatingMode.set({ messaging: { sandbox: true } });
  ok((await messaging.isSandbox()) === true, 'messaging.isSandbox() reflects operatingMode after a toggle to sandbox');
  await operatingMode.set({ messaging: { sandbox: false } });
  ok((await messaging.isSandbox()) === false, 'messaging.isSandbox() reflects operatingMode after a toggle to live');
  await operatingMode.set({ messaging: { sandbox: true } }); // leave sandboxed for anything after this script
}

async function settlementSandboxWiring() {
  await operatingMode.set({ settlement: { sandbox: true } });
  // If sandboxed code ever reached the transport, this throws and crashes the
  // script loudly -- stronger than a silent "calls.length === 0" check could be,
  // since SbgClient's sandbox branches are supposed to never call it at all.
  _setFetchImplForTests(async () => { throw new Error('must not reach the network while sandboxed'); });

  const payer = { id: 'acacia', kind: 'insurer', name: 'Acacia Health',
    sbg: { username: 'legacy-user', password: 'legacy-pass' } };
  const tenant = { receivingAccount: { category: 'BANKS', serviceRoutingCode: '300591', beneficiaryAccount: '0123456789' } };
  const bill = { id: 'bill_sandbox1' };

  const result = await executePayerTransfer({ bill, payer, tenant, amount: 500, narration: 'test' });
  ok(result.status === 'SUCCESS' && String(result.reference).startsWith('SBX-'),
    'sandboxed: executePayerTransfer returns the canned sandbox-shaped result (the fake transport would throw if it were ever called)');

  const status = await transferStatus(payer, result.serviceRequestId);
  ok(status === 'SUCCESS', 'sandboxed: transferStatus also never reaches the transport');

  _setFetchImplForTests(null);
}

// A minimal fake Stanbic backend good enough to drive executePayerTransfer end to
// end: /auth/login, /account-validation, /service-charge, /disbursements. Captures
// every call so tests can assert on exactly what credentials/body were sent.
function fakeSbg(calls, { refPrefix = 'LIVE-REF' } = {}) {
  return async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, opts, body });
    const envelope = (data) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ responseHeader: { statusCode: '000', responseCode: 'SUCCESS' }, responseBody: { data } }),
    });
    if (url.includes('/auth/login')) return envelope({ accessToken: `TOK-${body.username}` });
    if (url.includes('/account-validation')) return envelope({ serviceRequestId: 'SRQ-1', beneficiaryName: 'EURACARE HOSPITAL LTD' });
    if (url.includes('/service-charge')) return envelope({ currency: 'GHS', charge: 5 });
    // GET status-by-id (/disbursements/<id>) must be checked before the plain
    // POST-create case, since both contain the substring "/disbursements".
    if (/\/disbursements\/[^/?]+/.test(url)) return envelope({ serviceRequestId: 'SRQ-1', status: 'SUCCESS' });
    if (url.includes('/disbursements')) return envelope({ serviceRequestId: 'SRQ-1', status: 'SUCCESS', reference: `${refPrefix}-1` });
    return { ok: false, status: 404, text: async () => '{}' };
  };
}

async function settlementLiveCredentialsWiring() {
  await operatingMode.set({ settlement: { sandbox: false }, confirm: 'LIVE' });
  const tenant = { receivingAccount: { category: 'BANKS', serviceRoutingCode: '300591', beneficiaryAccount: '0123456789' } };
  const bill = { id: 'bill_live1' };

  // Payer A: only the legacy plaintext fields -- pre-dates the encrypted path.
  let calls = [];
  _setFetchImplForTests(fakeSbg(calls));
  const payerLegacy = { id: 'acacia', kind: 'insurer', name: 'Acacia Health',
    sbg: { username: 'legacy-user', password: 'legacy-pass' } };
  const result = await executePayerTransfer({ bill, payer: payerLegacy, tenant, amount: 500, narration: 'legacy creds' });
  ok(calls.length > 0, 'live: executePayerTransfer actually reaches the (mocked) transport this time');
  ok(result.reference === 'LIVE-REF-1', 'live: the result comes from the mocked live backend, not the sandbox canned path');
  const login = calls.find((c) => c.url.includes('/auth/login'));
  ok(login.body.username === 'legacy-user' && login.body.password === 'legacy-pass',
    'legacy payer (no settlementCredentials): clientForPayer() falls back to plaintext payer.sbg.{username,password}');

  // Payer B: has BOTH legacy plaintext AND encrypted settlementCredentials, with
  // DIFFERENT values in each -- proves the encrypted field wins, not just "works".
  calls = [];
  _setFetchImplForTests(fakeSbg(calls));
  const payerBoth = { id: 'metro', kind: 'insurer', name: 'Metro Mutual',
    sbg: { username: 'legacy-user-2', password: 'legacy-pass-2' },
    settlementCredentials: { encrypted: credentials.encrypt({ username: 'encrypted-user', password: 'encrypted-pass' }),
      hint: credentials.hint('encrypted-pass'), updatedAt: new Date().toISOString(), updatedBy: 'ops@hnn' } };
  await executePayerTransfer({ bill, payer: payerBoth, tenant, amount: 500, narration: 'encrypted creds' });
  const login2 = calls.find((c) => c.url.includes('/auth/login'));
  ok(login2.body.username === 'encrypted-user' && login2.body.password === 'encrypted-pass',
    'a payer with BOTH: clientForPayer() prefers the decrypted settlementCredentials over the legacy plaintext fields');

  // transferStatus() goes through the same clientForPayer() and the same live path.
  calls = [];
  _setFetchImplForTests(fakeSbg(calls));
  await transferStatus(payerBoth, 'SRQ-1');
  ok(calls.some((c) => /\/disbursements\/[^/?]+/.test(c.url)), 'transferStatus() also resolves credentials/sandbox live and hits the transport');

  _setFetchImplForTests(null);
  await operatingMode.set({ settlement: { sandbox: true } }); // leave sandboxed for anything after this script
}

async function main() {
  await envSeededDefaults();
  await confirmationGate();
  await hybridIndependence();
  await messagingWiring();
  await settlementSandboxWiring();
  await settlementLiveCredentialsWiring();
  console.log('\nOPERATING MODE CHECK: ALL PASSED');
}

main().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(1); });
