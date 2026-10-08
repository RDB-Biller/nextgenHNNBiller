'use strict';
// Smoke coverage for the real-provider / credentials feature (platform test
// account + per-client "bring your own credentials"). Separate file from
// smoke-verification.js on purpose: this needs MESSAGING_SANDBOX=false and
// CREDENTIAL_ENCRYPTION_KEY set at process start (src/config.js reads env vars
// once, at require time), which would change the meaning of
// smoke-verification.js's own sandbox-mode assertions if set in the same
// process. Sets both itself below, so a plain `node scripts/smoke-messaging-live.js`
// (or `npm run smoke:messaging-live`) just works — no special invocation needed.
//
// No real network reaches Twilio/Africa's Talking/Hubtel here: every HTTP call
// is intercepted via messaging._setRequestImplForTests and answered with a
// canned response, so this runs anywhere, offline, in any environment.

process.env.MESSAGING_SANDBOX = 'false';
if (!process.env.CREDENTIAL_ENCRYPTION_KEY) process.env.CREDENTIAL_ENCRYPTION_KEY = 'smoke-test-only-key-do-not-use-in-production';

const credentials = require('../src/services/credentials');
const messagingAccount = require('../src/services/messagingAccount');
const messaging = require('../src/services/messaging');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exit(1); } console.log(`ok  : ${label}`); };

async function credentialsChecks() {
  const blob = credentials.encrypt({ accountSid: 'ACxxx', authToken: 'topsecret9999' });
  ok(typeof blob === 'string' && blob.length > 0, 'encrypt() returns an opaque string blob');
  const back = credentials.decrypt(blob);
  ok(back.accountSid === 'ACxxx' && back.authToken === 'topsecret9999', 'decrypt() round-trips the original object');
  ok(credentials.hint('topsecret9999') === '…9999', 'hint() exposes only the last 4 chars');
  ok(credentials.decrypt(null) === null, 'decrypt(null) returns null instead of throwing');

  let threw = false;
  try { credentials.decrypt(blob.slice(0, -4) + 'abcd'); } catch (e) { threw = true; }
  ok(threw, 'a tampered blob fails to decrypt (GCM auth tag catches it) rather than returning garbage');
}

async function messagingAccountChecks() {
  let threw = false, code = null;
  try { await messagingAccount.set({ active: true }); } catch (e) { threw = true; code = e.status; }
  ok(threw && code === 422, 'activating the test account with nothing configured is rejected (422)');
  ok((await messagingAccount.mask(await messagingAccount.get())).configured === false,
    'rejected activate leaves the account unconfigured, not half-saved');

  const saved = await messagingAccount.set({ provider: 'twilio',
    credentials: { accountSid: 'AC1', authToken: 'tok-aaaa', from: '+15550001111' }, active: true });
  ok(saved.active === true && !!saved.encrypted, 'provider+credentials+active=true saves and activates in one call');
  const masked = messagingAccount.mask(saved);
  ok(masked.encrypted === undefined && JSON.stringify(masked).indexOf('tok-aaaa') === -1,
    'mask() never includes the encrypted blob or the raw secret anywhere in its output');
  ok(masked.hint === '…aaaa', 'mask() exposes the hint for display');

  // The bug this test is really here to pin down: a credentials-only update
  // (no `active` key sent at all) must NOT silently deactivate.
  const afterCredsOnlyUpdate = await messagingAccount.set({
    credentials: { accountSid: 'AC1', authToken: 'tok-bbbb', from: '+15550001111' },
  });
  ok(afterCredsOnlyUpdate.active === true, 'a credentials-only save leaves `active` untouched (regression check)');

  const deactivated = await messagingAccount.set({ active: false });
  ok(deactivated.active === false, 'explicit active:false still deactivates');

  // Switching provider without supplying new credentials for it clears the
  // stale blob (never show "configured" with a hint for a different
  // provider's secret) — but doing that while still `active`, with no
  // explicit `active` value sent either, would leave the account claiming to
  // be active with nothing usable configured. That combination is rejected
  // rather than silently flipping `active` off behind the caller's back.
  await messagingAccount.set({ provider: 'twilio',
    credentials: { accountSid: 'AC1', authToken: 'tok-cccc', from: '+1555' }, active: true });
  threw = false; code = null;
  try { await messagingAccount.set({ provider: 'hubtel' }); } catch (e) { threw = true; code = e.status; }
  ok(threw && code === 422,
    'switching provider while active, with no new credentials and no explicit `active`, is rejected (422) instead of silently going active-with-nothing-configured');
  const afterRejectedSwitch = await messagingAccount.get();
  ok(afterRejectedSwitch.provider === 'twilio' && !!afterRejectedSwitch.encrypted,
    'the rejected switch leaves the previous twilio config untouched, not half-saved');

  // The same switch succeeds once the caller is explicit about `active`.
  const afterProviderSwitch = await messagingAccount.set({ provider: 'hubtel', active: false });
  ok(afterProviderSwitch.encrypted === null && afterProviderSwitch.provider === 'hubtel',
    'switching provider + explicit active:false clears the old encrypted blob');
  ok(afterProviderSwitch.active === false, '...and applies the explicit active value sent with it');

  // The realistic "switch and activate a different provider" admin action:
  // provider + credentials + active:true together in one call.
  const afterSwitchWithNewCreds = await messagingAccount.set({ provider: 'hubtel',
    credentials: { clientId: 'cid1', clientSecret: 'sec-dddd', from: 'EURACARE' }, active: true });
  ok(afterSwitchWithNewCreds.active === true && !!afterSwitchWithNewCreds.encrypted
    && afterSwitchWithNewCreds.provider === 'hubtel',
    'switching provider + new credentials + active:true succeeds in one call');
}

async function resolveSenderAndSendChecks() {
  // Clean slate for this section.
  await messagingAccount.set({ active: false });

  let r = await messaging.send({ channel: 'sms', to: '0244000111', body: 'hi' });
  ok(r.ok === false && r.error === 'messaging_provider_not_configured',
    'send() with nothing configured anywhere returns a clear error, not a crash');

  const calls = [];
  messaging._setRequestImplForTests(async (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith('https://api.twilio.com/')) return { status: 201, body: JSON.stringify({ sid: 'SM123' }) };
    if (url.startsWith('https://api.africastalking.com/') || url.startsWith('https://api.sandbox.africastalking.com/')) {
      return { status: 201, body: JSON.stringify({ SMSMessageData: { Recipients: [{ status: 'Success', messageId: 'ATXid_1' }] } }) };
    }
    if (url.startsWith('https://sms.hubtel.com/')) return { status: 200, body: JSON.stringify({ MessageId: 'HTid_1' }) };
    if (url.startsWith('https://chat.africastalking.com/')) return { status: 200, body: JSON.stringify({ id: 'WAid_1', status: 'Sent' }) };
    return { status: 500, body: '{}' };
  });

  await messagingAccount.set({ provider: 'twilio',
    credentials: { accountSid: 'ACtest', authToken: 'secret', from: '+15550009999' }, active: true });
  r = await messaging.send({ channel: 'sms', to: '0244000111', body: 'your bill is ready' });
  ok(r.ok === true && r.providerMessageId === 'SM123' && r.sandbox === false,
    'platform test account (twilio, active) sends for real through the mocked transport');
  ok(calls[calls.length - 1].opts.headers.Authorization.startsWith('Basic '),
    'twilio adapter sends Basic auth built from accountSid:authToken');
  ok(calls[calls.length - 1].url.includes('ACtest'), 'twilio adapter targets this account\'s own Messages endpoint');

  await messagingAccount.set({ active: false });
  r = await messaging.send({ channel: 'sms', to: '0244000111', body: 'hi' });
  ok(r.error === 'messaging_provider_not_configured',
    'deactivating the platform test account reverts everyone without their own creds to "unconfigured" — no redeploy needed');

  await messagingAccount.set({ active: true }); // re-activate (credentials from the twilio save above are still there)
  const atTenant = { messagingCredentials: { useOwnCredentials: true, provider: 'africastalking',
    encrypted: credentials.encrypt({ apiKey: 'at-key', username: 'myhospital', from: 'EURACARE' }) } };
  r = await messaging.send({ channel: 'sms', to: '0244000111', body: 'hi', tenant: atTenant });
  ok(r.ok === true && r.providerMessageId === 'ATXid_1',
    'a tenant with useOwnCredentials=true and its own provider wins over the active platform test account');
  ok(calls[calls.length - 1].url.startsWith('https://api.africastalking.com/'),
    'a non-"sandbox" Africa\'s Talking username resolves to the production base URL');

  const atSandboxTenant = { messagingCredentials: { useOwnCredentials: true, provider: 'africastalking',
    encrypted: credentials.encrypt({ apiKey: 'at-key', username: 'sandbox', from: 'EURACARE' }) } };
  await messaging.send({ channel: 'sms', to: '0244000111', body: 'hi', tenant: atSandboxTenant });
  ok(calls[calls.length - 1].url.startsWith('https://api.sandbox.africastalking.com/'),
    'username "sandbox" resolves to Africa\'s Talking\'s own sandbox base URL');

  // Without a configured WhatsApp sender number, africastalking + whatsapp
  // fails cleanly rather than guessing one.
  r = await messaging.send({ channel: 'whatsapp', to: '0244000111', body: 'hi', tenant: atTenant });
  ok(r.ok === false && r.error === 'provider_sender_not_configured',
    'africastalking + whatsapp without a configured waNumber fails cleanly instead of guessing a sender');

  // With waNumber configured, a plain string body sends as an ordinary
  // WhatsApp text message through the confirmed chat.africastalking.com API.
  const atWaTenant = { messagingCredentials: { useOwnCredentials: true, provider: 'africastalking',
    encrypted: credentials.encrypt({ apiKey: 'at-key', username: 'myhospital', from: 'EURACARE', waNumber: '+254711000111' }) } };
  r = await messaging.send({ channel: 'whatsapp', to: '0244000222', body: 'your bill is ready', tenant: atWaTenant });
  ok(r.ok === true && r.providerMessageId === 'WAid_1',
    'africastalking + whatsapp with waNumber configured sends a plain-text body for real');
  ok(calls[calls.length - 1].url === 'https://chat.africastalking.com/whatsapp/message/send',
    'whatsapp text send targets the confirmed chat.africastalking.com endpoint');
  ok(calls[calls.length - 1].opts.headers.apikey === 'at-key', 'whatsapp send authenticates with the apikey header, not Authorization');
  let sentBody = JSON.parse(calls[calls.length - 1].opts.body);
  ok(sentBody.waNumber === '+254711000111' && sentBody.phoneNumber === '+233244000222' // local 024... is rewritten to international form at the send seam
    && sentBody.body.message === 'your bill is ready',
    'whatsapp text send JSON body matches the documented {username, waNumber, phoneNumber, body:{message}} shape');

  // Rich message types -- image, template, interactive buttons, interactive
  // list -- all map onto the documented request shapes.
  r = await messaging.send({ channel: 'whatsapp', to: '0244000222',
    body: { mediaType: 'Image', url: 'https://example.com/pic.jpg', caption: 'Receipt' }, tenant: atWaTenant });
  ok(r.ok === true, 'an image message sends through the same adapter');
  sentBody = JSON.parse(calls[calls.length - 1].opts.body);
  ok(sentBody.body.mediaType === 'Image' && sentBody.body.url === 'https://example.com/pic.jpg' && sentBody.body.caption === 'Receipt',
    'image message body matches the documented {url, caption, mediaType} shape');

  r = await messaging.send({ channel: 'whatsapp', to: '0244000222',
    body: { templateId: 'my_template_id', headerValue: 'June', bodyValues: ['Jumba', '238156'] }, tenant: atWaTenant });
  ok(r.ok === true, 'a template message sends through the same adapter');
  sentBody = JSON.parse(calls[calls.length - 1].opts.body);
  ok(sentBody.body.templateId === 'my_template_id' && sentBody.body.headerValue === 'June'
    && sentBody.body.bodyValues.length === 2,
    'template message body matches the documented {templateId, headerValue, bodyValues} shape');

  r = await messaging.send({ channel: 'whatsapp', to: '0244000222',
    body: { buttons: [{ id: 'Id1', title: 'Id1 Title' }, { id: 'Id2', title: 'Id2 Title' }], text: 'This is a body', header: 'This is a header' },
    tenant: atWaTenant });
  ok(r.ok === true, 'an interactive-buttons message sends through the same adapter');
  sentBody = JSON.parse(calls[calls.length - 1].opts.body);
  ok(sentBody.body.action.buttons.length === 2 && sentBody.body.body.text === 'This is a body'
    && sentBody.body.header.text === 'This is a header',
    'interactive-buttons body matches the documented {action:{buttons}, body:{text}, header:{text}} shape');

  r = await messaging.send({ channel: 'whatsapp', to: '0244000222',
    body: { list: { button: 'List Button', sections: [{ title: 'Section 1', rows: [{ id: 'Id1', title: 'Id1 Title', description: 'description_1' }] }] },
      text: 'This is a body', footer: 'This is a footer' },
    tenant: atWaTenant });
  ok(r.ok === true, 'an interactive-list message sends through the same adapter');
  sentBody = JSON.parse(calls[calls.length - 1].opts.body);
  ok(sentBody.body.action.button === 'List Button' && sentBody.body.action.sections[0].rows[0].id === 'Id1'
    && sentBody.body.footer.text === 'This is a footer',
    'interactive-list body matches the documented {action:{button,sections}, body:{text}, footer:{text}} shape');

  // A rich body makes no sense outside WhatsApp, and an unrecognized rich
  // shape makes no sense even for WhatsApp -- both fail cleanly, before ever
  // reaching a provider.
  r = await messaging.send({ channel: 'sms', to: '0244000222', body: { mediaType: 'Image', url: 'x' }, tenant: atWaTenant });
  ok(r.ok === false && r.error === 'rich_body_requires_whatsapp',
    'a rich body on an sms send is rejected before it ever reaches a provider');
  r = await messaging.send({ channel: 'whatsapp', to: '0244000222', body: { nonsense: true }, tenant: atWaTenant });
  ok(r.ok === false && r.error === 'invalid_whatsapp_body',
    'a whatsapp body matching none of the documented shapes fails cleanly instead of sending garbage');

  const hubtelTenant = { messagingCredentials: { useOwnCredentials: true, provider: 'hubtel',
    encrypted: credentials.encrypt({ clientId: 'cid', clientSecret: 'csecret', from: 'EURACARE' }) } };
  r = await messaging.send({ channel: 'sms', to: '0244000111', body: 'hi', tenant: hubtelTenant });
  ok(r.ok === true && r.providerMessageId === 'HTid_1', 'hubtel SMS sends through the mocked transport');
  r = await messaging.send({ channel: 'whatsapp', to: '0244000111', body: 'hi', tenant: hubtelTenant });
  ok(r.ok === false && r.error === 'provider_whatsapp_not_supported',
    'hubtel + whatsapp returns "not supported", since Hubtel has no WhatsApp product');
  r = await messaging.send({ channel: 'whatsapp', to: '0244000111', body: { mediaType: 'Image', url: 'x' }, tenant: hubtelTenant });
  ok(r.ok === false && r.error === 'rich_whatsapp_body_not_supported_by_provider',
    'a rich whatsapp body against a non-africastalking provider is rejected before reaching that provider\'s own adapter');

  // A tenant that has NOT turned useOwnCredentials on must still fall back to
  // the (active) platform test account rather than being left unconfigured.
  const notOptedInTenant = { messagingCredentials: { useOwnCredentials: false, provider: 'hubtel',
    encrypted: credentials.encrypt({ clientId: 'cid', clientSecret: 'csecret', from: 'X' }) } };
  r = await messaging.send({ channel: 'sms', to: '0244000111', body: 'hi', tenant: notOptedInTenant });
  ok(r.ok === true && r.providerMessageId === 'SM123',
    'useOwnCredentials:false ignores the tenant\'s saved credentials and uses the platform test account instead');

  // A provider adapter given incomplete credentials fails cleanly, not a crash.
  const incompleteTenant = { messagingCredentials: { useOwnCredentials: true, provider: 'twilio',
    encrypted: credentials.encrypt({ accountSid: 'ACtest' }) } }; // no authToken, no from
  r = await messaging.send({ channel: 'sms', to: '0244000111', body: 'hi', tenant: incompleteTenant });
  ok(r.ok === false && r.error === 'provider_credentials_incomplete',
    'an incomplete credential set fails with a clear, specific error rather than throwing');

  messaging._setRequestImplForTests(null); // restore default (unused in tests beyond this point)
}

async function main() {
  // messaging.js no longer reads MESSAGING_SANDBOX itself at require time — it
  // asks operatingMode (store.settings), which falls back to this env var only
  // because nothing's been saved there yet in this fresh in-memory store.
  ok((await messaging.isSandbox()) === false, 'precondition: this file must run with MESSAGING_SANDBOX=false');
  ok(credentials.isConfigured() === true, 'precondition: this file must run with CREDENTIAL_ENCRYPTION_KEY set');
  await credentialsChecks();
  await messagingAccountChecks();
  await resolveSenderAndSendChecks();
  console.log('\nLIVE-PROVIDER / CREDENTIALS CHECK: ALL PASSED');
}

main().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(1); });
