'use strict';
// Smoke test: the NABIP special group, its value proposition, the verified contact and the "send now" email.   node scripts/smoke-nabip.js
process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const store = require('../src/store');
const outreach = require('../src/services/outreach');
const email = require('../src/services/email');
const operatingMode = require('../src/services/operatingMode');
let a = 0;
const ok = (c, l) => { a++; if (!c) { console.error(`FAIL #${a}: ${l}`); process.exitCode = 1; } else console.log(`ok  : ${l}`); };
const rej = async (p) => { try { await p; return null; } catch (e) { return e; } };
const sent = [];
process.env.EMAIL_PROVIDER = 'resend'; process.env.EMAIL_API_KEY = 'k'; process.env.EMAIL_FROM = 'HNN <ekforson@hnnworld.com>';
email._setRequestImplForTests(async (url, o) => { sent.push(JSON.parse(o.body)); return { status: 200, body: JSON.stringify({ id: 'e' + sent.length }) }; });

(async () => {
  await store.init?.();
  await operatingMode.set({ settlement: { sandbox: true }, messaging: { sandbox: false } });

  // value proposition: summary and details
  const v = outreach.valueProposition('association');
  ok(v.summary && v.summary.points.length >= 3 && v.details.length >= 5, 'the association value proposition has a summary and details');
  ok(/never hold/i.test(JSON.stringify(v)) && !/endorse(s|d) by/i.test(v.summary.headline), 'it says we never hold money and does not claim an endorsement');
  ok(outreach.valueProposition('bank').details.length >= 3, 'banks have a summary and details too');
  ok((await rej(Promise.resolve().then(() => outreach.valueProposition('nope')))).status === 404, 'an unknown segment is a 404');

  // the group
  const r = await outreach.setupNabip({ fromEmail: 'ekforson@hnnworld.com', senderName: 'E. Forson', by: 'tester' });
  ok(r.org.lists.includes('nabip') && r.contact.email === 'mandel@nabip.org', 'NABIP group exists with mandel@nabip.org');
  ok(r.contact.verified && r.contact.verified.at, 'the contact is marked verified');
  const again = await outreach.setupNabip({}); ok(again.contact.id === r.contact.id && again.org.id === r.org.id, 'running it again changes nothing');
  const orgs = await outreach.listOrgs({ list: 'nabip' }); ok(orgs.total === 1 && orgs.rows[0].type === 'association', 'the nabip list holds one association');
  const cons = await outreach.listContacts({ list: 'nabip' }); ok(cons.rows.length === 1 && cons.rows[0].status === 'new', 'the group has the one contact');
  const cid = r.contact.id;

  // preview uses the association email
  const pv = await outreach.preview(cid, 'email-only', 0);
  ok(/Dear Michael,/.test(pv.body) && /never hold the money/.test(pv.body) && /Unsubscribe in one click/.test(pv.body) && /public page \(NABIP LinkedIn post/.test(pv.body), 'the email greets Michael, states the offer and carries the source note and opt-out');
  ok(!/embedded savings, micro-credit/.test(pv.body), 'it is not the bank pitch');

  // sender settings missing -> refused with a clear reason
  let e = await rej(outreach.sendNow(cid, {}));
  ok(e && e.status === 422 && /postal address/.test(e.message), 'sending is refused until the postal address and public URL are set');
  await outreach.setConfig({ senderRole: 'Founder', senderOrg: 'HNN Biller / TrimesterSave', postalAddress: '1 Example Street, Accra, Ghana', publicBaseUrl: 'https://biller.example.com' }, 'tester');
  const pc = await outreach.publicConfig(); ok(pc.readyToSend && pc.fromEmail === 'ekforson@hnnworld.com' && pc.replyTo === 'ekforson@hnnworld.com' && pc.senderCheck.ok, 'settings ready; sender is ekforson@hnnworld.com');

  // send now, from the operator's address, outside hours and with the global switch off
  const cfg0 = await outreach.getConfig(); ok(cfg0.enabled === false, 'the global campaign switch is still off');
  const s = await outreach.sendNow(cid, { by: 'tester' });
  ok(s.ok && !s.sandbox && s.to === 'mandel@nabip.org' && s.from === 'ekforson@hnnworld.com', 'send now goes to mandel@nabip.org from ekforson@hnnworld.com');
  ok(sent.length === 1 && sent[0].from === 'ekforson@hnnworld.com' && sent[0].reply_to === 'ekforson@hnnworld.com' && sent[0].to[0] === 'mandel@nabip.org', 'the provider call carries from and reply_to');
  ok(/Unsubscribe in one click: https:\/\/biller\.example\.com\/o\/u\//.test(sent[0].text) && /1 Example Street/.test(sent[0].text), 'the sent email has the opt-out link and postal address');
  const c2 = (await outreach.listContacts({ list: 'nabip' })).rows[0]; ok(c2.status === 'contacted' && c2.history.some((h) => h.type === 'step' && h.manual), 'the contact is marked contacted and the send is in its history');

  // an edited body keeps the footer
  const s2 = await outreach.sendNow(cid, { subject: 'Hello', body: 'Dear Michael,\n\nShort edited note.\n\nThanks' });
  ok(sent.length === 2 && sent[1].subject === 'Hello' && /Short edited note/.test(sent[1].text) && /Unsubscribe in one click/.test(sent[1].text), 'an edited email still carries the footer and opt-out');

  // a sender on another domain is refused
  await outreach.setConfig({ fromEmail: 'someone@other.org' }, 'tester');
  e = await rej(outreach.sendNow(cid, {})); ok(e && e.status === 422 && /EMAIL_FROM/.test(e.message), 'a sender on a different domain from EMAIL_FROM is refused');
  await outreach.setConfig({ fromEmail: 'ekforson@hnnworld.com' }, 'tester');

  // opt-out is honoured
  await outreach.suppress('mandel@nabip.org', 'test'); e = await rej(outreach.sendNow(cid, {}));
  ok(e && e.status === 409 && /opted out/.test(e.message), 'an opted-out address cannot be sent to');
  ok(sent.length === 2, 'and nothing more was sent');

  // free-mail is still not allowed for cold contacts
  const org = (await outreach.listOrgs({ list: 'nabip' })).rows[0]; e = await rej(outreach.addContact({ orgId: org.id, name: 'X', email: 'x@gmail.com', source: 'test' }));
  ok(e && /free-mail/.test(e.message), 'free-mail addresses are still refused');
  console.log(`\n${a} assertions${process.exitCode ? ' — WITH FAILURES' : ' — all passed'}`);
})().catch((e) => { console.error(e); process.exit(1); });
