'use strict';
// Smoke test for currencies: GHS and USD as the two main ones, the Other list (naira and East Africa first), rates, conversion, preference.
//   node scripts/smoke-currencies.js
process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const express = require('express');
const store = require('../src/store');
const cur = require('../src/services/currencies');
const accounts = require('../src/services/patientAccounts');
const routes = require('../src/routes/currency');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const rej = (p) => p.then(() => null, (e) => e);

(async () => {
  await store.init?.();
  const v = await cur.publicView();
  ok(v.main.map((m) => m.code).join() === 'GHS,USD' && v.defaultCurrency === 'GHS', 'GHS and USD are the two main currencies, GHS the platform default');
  ok(v.other.length >= 80 && !v.other.some((c) => ['GHS', 'USD'].includes(c.code)), 'every other currency is in the Other list (80+)');
  ok(v.other.slice(0, 7).map((c) => c.code).join() === 'NGN,KES,UGX,TZS,RWF,ETB,BIF', 'the naira and then East Africa come first');
  ok(['NGN', 'KES', 'UGX', 'TZS', 'ETB', 'ZAR', 'EUR', 'GBP', 'XOF', 'EGP', 'INR', 'CNY'].every((c) => v.other.find((x) => x.code === c)), 'the main African and world currencies are there');
  ok(v.rates.indicative === true && /ndicative/.test(v.rates.note), 'rates are labelled indicative until Master Control saves its own');
  const c1 = await cur.convert(110, 'GHS', 'USD'); ok(c1.amount === 10 && c1.indicative, 'GHS 110 -> USD at the starting rate');
  const c2 = await cur.convert(1, 'USD', 'KES'); ok(c2.amount === 129, 'USD to Kenyan shillings');
  const c3 = await cur.convert(1000, 'GHS', 'UGX'); ok(Number.isInteger(c3.amount), 'currencies without decimals round to whole units (UGX)');
  let e = await rej(cur.convert(1, 'GHS', 'XXX')); ok(e && e.status === 422, 'unknown currencies are refused');
  e = await rej(cur.setConfig({ rates: { GHS: 0 } })); ok(e && e.status === 422, 'a rate must be above zero');
  e = await rej(cur.setConfig({ platformDefault: 'NGN' })); ok(e && e.status === 422, 'the platform default is GHS or USD');
  await cur.setConfig({ rates: { GHS: 15, NGN: 1600 }, platformDefault: 'USD', disabled: ['SSP', 'GHS'] }, 'tester');
  const v2 = await cur.publicView(); ok(v2.rates.indicative === false && v2.rates.asOf && v2.defaultCurrency === 'USD', 'saving rates clears the indicative flag and can change the default');
  ok(!v2.other.find((c) => c.code === 'SSP') && v2.main.length === 2, 'a currency can be switched off, but never GHS or USD');
  ok((await cur.convert(150, 'GHS', 'USD')).amount === 10 && (await cur.convert(1, 'USD', 'NGN')).amount === 1600, 'converting uses the saved rates');

  await accounts.register({ first_name: 'Ama', last_name: 'T', phone: '+233241112222', password: 'secret1' }); const ama = await accounts.byPhone('+233241112222');
  ok(!ama.currency, 'a new account has not chosen a currency yet (so the app asks)');
  const u = await accounts.updateProfile(ama, { currency: 'usd' }); ok(u.currency === 'USD', 'the person\'s default currency is saved');
  e = await rej(accounts.updateProfile(ama, { currency: 'nope' })); ok(e && e.status === 422, 'an unknown currency is refused');
  const app = express(); app.use('/currency/api', routes.api); const srv = app.listen(0); await new Promise((r) => setTimeout(r, 50)); const base = `http://127.0.0.1:${srv.address().port}`;
  let r = await fetch(`${base}/currency/api/list`); let j = await r.json(); ok(r.status === 200 && j.result.main.length === 2 && r.headers.get('access-control-allow-origin') === '*', 'HTTP: public list with CORS');
  r = await fetch(`${base}/currency/api/convert?amount=30&from=GHS&to=USD`); j = await r.json(); ok(r.status === 200 && j.result.amount === 2, 'HTTP: convert');
  srv.close();
  console.log(`\n${a} assertions${process.exitCode ? ' — WITH FAILURES' : ' — all passed'}`);
})().catch((x) => { console.error(x); process.exit(1); });
