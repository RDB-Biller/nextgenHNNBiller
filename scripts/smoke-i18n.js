'use strict';
// Smoke test: languages, catalogs, LibreTranslate adapter (faked) with cache/cap/fallback, public API,
// developer chat rooms (per-reader translation, original on tap, bot commands) and the WhatsApp bridge.
//   node scripts/smoke-i18n.js

process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const express = require('express');
const store = require('../src/store');
const i18n = require('../src/services/i18n');
const chat = require('../src/services/devChat');
const messaging = require('../src/services/messaging');
const operatingMode = require('../src/services/operatingMode');
const messagingAccount = require('../src/services/messagingAccount');
const i18nApi = require('../src/routes/i18nApi');
const devChat = require('../src/routes/devChat');
const platformI18n = require('../src/routes/platformI18n');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };

// fake LibreTranslate: supports 9 languages, not Twi/Hausa/Yoruba/Ga
let ltUp = true; let ltCalls = 0;
const LT = ['en', 'fr', 'pt', 'es', 'ar', 'zh', 'hi', 'de', 'sw'];
i18n._setRequestImplForTests(async (method, url, body) => {
  if (!ltUp) throw new Error('ECONNREFUSED');
  if (url.endsWith('/languages')) return { status: 200, body: LT.map((code) => ({ code, name: code })) };
  if (url.endsWith('/translate')) { ltCalls++; return { status: 200, body: { translatedText: `[${body.target}] ${body.q}` } }; }
  return { status: 404, body: null };
});
const wa = [];
messaging._setRequestImplForTests(async (url, opts) => {
  const j = JSON.parse(opts.body); wa.push({ to: j.phoneNumber, body: JSON.stringify(j.body) });
  return { status: 200, body: JSON.stringify({ id: 'wa_' + wa.length }) };
});

(async () => {
  await store.init?.();
  await operatingMode.set({ settlement: { sandbox: true }, messaging: { sandbox: false } });
  await messagingAccount.set({ provider: 'africastalking', credentials: { apiKey: 'k', username: 'sandbox', waNumber: '+233500000000' }, active: true });

  // registry + catalogs
  ok(i18n.LANGUAGES.length === 13 && ['en', 'fr', 'pt', 'es', 'ar', 'zh', 'hi', 'de', 'sw', 'tw', 'ha', 'yo', 'gaa'].every((c) => i18n.isKnown(c)), '13 languages registered');
  ok(i18n.lang('ar').rtl === true && i18n.LANGUAGES.filter((l) => l.rtl).length === 1, 'Arabic is the only RTL language');
  ok(['tw', 'ha', 'yo', 'gaa'].every((c) => i18n.lang(c).reviewed === false) && i18n.lang('fr').reviewed, 'Twi/Hausa/Yoruba/Ga flagged as needing native-speaker review');
  ok(i18n.normalise('fr-CA') === 'fr' && i18n.normalise('zh-CN') === 'zh' && i18n.normalise('xx') === 'en' && i18n.normalise('pt_BR') === 'pt', 'locale codes normalise');
  const fr = i18n.catalog('fr');
  ok(fr.strings['act.save'] === 'Enregistrer' && fr.missing === 0 && fr.rtl === false, 'French catalog complete');
  const yo = i18n.catalog('yo');
  ok(yo.strings['nav.home'] === 'Ilé' && yo.reviewed === false, 'Yoruba catalog loads and is flagged unreviewed');
  const ga = i18n.catalog('gaa');
  ok(ga.strings['act.save'] === 'Save' && ga.missing === ga.total, 'Ga falls back to English key by key (no invented text)');
  const en = i18n.catalog('en').strings;
  const allCats = i18n.LANGUAGES.map((l) => i18n.catalog(l.code));
  let placeholdersOk = true;
  for (const c of allCats) for (const [k, v] of Object.entries(c.strings)) {
    const want = (en[k].match(/\{\w+\}/g) || []).sort().join(); const got = (v.match(/\{\w+\}/g) || []).sort().join();
    if (want !== got) { placeholdersOk = false; console.error('placeholder mismatch', c.lang, k); }
  }
  ok(placeholdersOk, 'every translation keeps the same {placeholders} as English');
  ok(i18n.t('sms.otp', 'fr', { code: '123456' }).includes('123456') && i18n.t('sms.otp', 'sw', { code: '1' }).startsWith('Msimbo'), 'server messages translate with variables');
  ok(i18n.t('sms.otp', 'yo', { code: '9' }).startsWith('Your verification code is 9'), 'server messages fall back to English');

  // language visibility for patients
  let langs = (await i18n.listLanguages({ audience: 'patient' })).map((l) => l.code);
  ok(!langs.includes('tw') && !langs.includes('ha') && langs.includes('fr'), 'unreviewed languages hidden from patients by default');
  ok((await i18n.listLanguages()).length === 13, 'all 13 languages offered to developers');
  await i18n.setConfig({ showUnreviewed: true }, 't');
  ok((await i18n.listLanguages({ audience: 'patient' })).length === 13, 'Master Control can expose unreviewed languages');
  await i18n.setConfig({ showUnreviewed: false }, 't');

  // translation: not configured -> graceful
  let r = await i18n.translate('Hello team', 'en', 'fr');
  ok(r.ok === false && r.reason === 'not-configured' && r.text === 'Hello team', 'without LibreTranslate the original text is returned');
  ok((await i18n.status()).configured === false, 'status: not configured');

  await i18n.setConfig({ url: 'http://libretranslate.test:5000/' }, 't');
  ok((await i18n.status()).reachable && (await i18n.status()).unsupportedLanguages.join() === 'tw,ha,yo,gaa', 'status: reachable, African languages reported unsupported');
  r = await i18n.translate('Hello team', 'en', 'fr');
  ok(r.ok && r.text === '[fr] Hello team' && !r.cached, 'translate via LibreTranslate');
  const before = ltCalls;
  r = await i18n.translate('Hello team', 'en', 'fr');
  ok(r.ok && r.cached && ltCalls === before, 'second identical translation is served from cache');
  r = await i18n.translate('Hello', 'en', 'ha');
  ok(!r.ok && r.reason === 'unsupported-pair' && r.text === 'Hello', 'unsupported language pair falls back to the original');
  r = await i18n.translate('Hello', 'fr', 'fr');
  ok(r.ok && r.reason === 'same-language', 'same language is a no-op');
  r = await i18n.translate('Please run `npm install` then open https://example.com/a/b and ping @kofi about src/services/x.js', 'en', 'de');
  ok(r.ok && r.text.includes('`npm install`') && r.text.includes('https://example.com/a/b') && r.text.includes('@kofi') && r.text.includes('src/services/x.js'), 'code, URLs, mentions and paths are preserved');
  r = await i18n.translate('```\nconst x = 1;\n```', 'en', 'de');
  ok(r.ok && r.text === '```\nconst x = 1;\n```', 'code blocks are never sent for translation');
  ltUp = false;
  r = await i18n.translate('A brand new sentence', 'en', 'es');
  ok(!r.ok && r.reason === 'unavailable' && r.text === 'A brand new sentence', 'LibreTranslate down -> original text, no error');
  r = await i18n.translate('Hello team', 'en', 'fr');
  ok(r.ok && r.cached, 'cached translations still work while LibreTranslate is down');
  ltUp = true;
  await i18n.setConfig({ dailyCharCap: 5 }, 't');
  r = await i18n.translate('This is longer than the cap', 'en', 'pt');
  ok(!r.ok && r.reason === 'cap-reached', 'daily character cap enforced');
  await i18n.setConfig({ dailyCharCap: 200000 }, 't');
  await i18n.setConfig({ enabled: false }, 't');
  r = await i18n.translate('Another sentence here', 'en', 'pt');
  ok(!r.ok && r.reason === 'disabled', 'Master Control switch disables machine translation');
  await i18n.setConfig({ enabled: true }, 't');
  let bad = null; try { await i18n.setConfig({ url: 'ftp://x' }, 't'); } catch (e) { bad = e; }
  ok(bad && bad.status === 422, 'bad LibreTranslate URL refused');
  ok(!JSON.stringify(await i18n.publicConfig()).includes('apiKey":"'), 'API key never returned');

  // HTTP surface
  const app = express();
  app.use('/i18n/api', i18nApi);
  app.use('/chat/api', devChat.api);
  app.use('/chat-hooks', devChat.hooks);
  app.use('/api/platform/i18n', platformI18n);
  const server = app.listen(0); await new Promise((r2) => setTimeout(r2, 50));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token, ctype) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': ctype || 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? (ctype ? body : JSON.stringify(body)) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  let h = await call('GET', '/i18n/api/languages?audience=patient');
  ok(h.status === 200 && h.body.languages.length === 9 && h.body.languages.find((l) => l.code === 'ar').rtl, 'GET /i18n/api/languages (patient audience)');
  h = await call('GET', '/i18n/api/catalog/sw');
  ok(h.status === 200 && h.body.strings['nav.login'] === 'Ingia', 'GET /i18n/api/catalog/:lang');
  h = await call('GET', '/i18n/api/catalog/zz');
  ok(h.status === 404, 'unknown catalog language is 404');
  h = await call('POST', '/i18n/api/translate', { texts: ['Good morning', 'Thanks'], to: 'es' });
  ok(h.status === 200 && h.body.results[0].text === '[es] Good morning' && h.body.results[0].translated, 'POST /i18n/api/translate (batch)');
  h = await call('POST', '/i18n/api/translate', { texts: [], to: 'es' });
  ok(h.status === 422, 'empty batch refused');

  // developer chat
  const room = await chat.createRoom({ name: 'Billing core', topic: 'Sprint 12' }, 'test');
  ok(room.code.length === 8 && /^room_/.test(room.id), 'room created with an invite code');
  let e = null; try { await chat.join({ code: 'NOPE0000', name: 'X', lang: 'en' }); } catch (x) { e = x; }
  ok(e && e.status === 404, 'wrong invite code refused');
  e = null; try { await chat.join({ code: room.code, name: 'X', lang: 'klingon' }); } catch (x) { e = x; }
  ok(e && e.status === 422, 'unknown language refused');
  h = await call('POST', '/chat/api/join', { code: room.code.toLowerCase(), name: 'Ana', lang: 'pt' });
  const ana = h.body;
  ok(h.status === 201 && ana.token && ana.participant.lang === 'pt', 'Ana joins in Portuguese (code is case-insensitive)');
  h = await call('POST', '/chat/api/join', { code: room.code, name: 'Kofi', lang: 'en' });
  const kofi = h.body;
  h = await call('POST', '/chat/api/join', { code: room.code, name: 'Li', lang: 'zh' });
  const li = h.body;
  h = await call('POST', '/chat/api/join', { code: room.code, name: 'Yaw', lang: 'tw' });
  const yaw = h.body;
  h = await call('POST', '/chat/api/messages', { text: 'The webhook retries are failing in staging' }, kofi.token);
  ok(h.status === 201, 'Kofi posts in English');
  h = await call('GET', '/chat/api/messages?since=0', null, ana.token);
  const m1 = h.body.messages.find((m) => m.kind === 'user');
  ok(m1 && m1.text === '[pt] The webhook retries are failing in staging' && m1.translated && m1.original === 'The webhook retries are failing in staging' && m1.name === 'Kofi', 'Ana reads it in Portuguese, original available');
  ok(h.body.messages.some((m) => m.kind === 'system' && /Ana entrou e fala Português/.test(m.text)), 'system notices are localised for the reader');
  h = await call('GET', '/chat/api/messages?since=0', null, kofi.token);
  const mk = h.body.messages.find((m) => m.kind === 'user');
  ok(mk.text === 'The webhook retries are failing in staging' && !mk.translated, 'sender sees their own language unchanged');
  h = await call('GET', '/chat/api/messages?since=0', null, yaw.token);
  const my = h.body.messages.find((m) => m.kind === 'user');
  ok(my.text === 'The webhook retries are failing in staging' && my.untranslated && my.reason === 'unsupported-pair', 'Twi reader gets the original, flagged untranslated');
  h = await call('GET', '/chat/api/messages?since=0', null, li.token);
  ok(h.body.messages.find((m) => m.kind === 'user').text.startsWith('[zh] '), 'Li reads Chinese');
  ltUp = false;
  await call('POST', '/chat/api/messages', { text: 'I will look at it tomorrow' }, ana.token);
  h = await call('GET', `/chat/api/messages?since=${m1.seq}`, null, kofi.token);
  const m2 = h.body.messages.find((m) => m.kind === 'user');
  ok(m2 && m2.text === 'I will look at it tomorrow' && m2.untranslated, 'LibreTranslate down: chat keeps working in the original language');
  ltUp = true;
  h = await call('GET', `/chat/api/messages?since=${m1.seq}`, null, kofi.token);
  ok(h.body.messages.find((m) => m.kind === 'user').text === '[en] I will look at it tomorrow', 'once it is back the same message translates');
  await call('POST', '/chat/api/messages', { text: 'run `npm test` in src/services/devChat.js' }, kofi.token);
  h = await call('GET', `/chat/api/messages?since=${m2.seq}`, null, ana.token);
  ok(h.body.messages.find((m) => m.kind === 'user').text.includes('`npm test`') && h.body.messages.find((m) => m.kind === 'user').text.includes('src/services/devChat.js'), 'code stays untouched in chat');

  // commands
  await call('POST', '/chat/api/messages', { text: '/lang fr' }, ana.token);
  h = await call('GET', '/chat/api/me', null, ana.token);
  ok(h.body.me.lang === 'fr' && h.body.members.length === 4, '/lang changes the reader language; roster lists everyone');
  h = await call('POST', '/chat/api/messages', { text: '/who' }, ana.token);
  const all = (await call('GET', '/chat/api/messages?since=0', null, ana.token)).body.messages;
  ok(all.some((m) => m.kind === 'bot' && /Kofi \(English\)/.test(m.text)), '/who answered by the bot');
  ok(!(await call('GET', '/chat/api/messages?since=0', null, kofi.token)).body.messages.some((m) => m.kind === 'bot'), 'bot replies are private to the asker');
  h = await call('PATCH', '/chat/api/me', { lang: 'ar' }, ana.token);
  ok(h.status === 200 && h.body.me.lang === 'ar', 'PATCH /chat/api/me changes language');

  // auth + limits
  h = await call('GET', '/chat/api/messages', null, 'cp.abc.def');
  ok(h.status === 401, 'forged token refused');
  h = await call('GET', '/chat/api/messages');
  ok(h.status === 401, 'no token refused');
  h = await call('POST', '/chat/api/messages', { text: 'x'.repeat(2001) }, kofi.token);
  ok(h.status === 422, 'over-long message refused');
  h = await call('POST', '/chat/api/messages', { text: '   ' }, kofi.token);
  ok(h.status === 422, 'empty message refused');

  // WhatsApp bridge
  const nWa = wa.length;
  h = await call('POST', '/chat/api/whatsapp', { phone: '+233 24 111 2222' }, li.token);
  ok(h.status === 200 && h.body.linked, 'Li links a WhatsApp number');
  await chat.flush();
  ok(wa.length > nWa && wa[wa.length - 1].to === '+233241112222', 'welcome sent to the linked number');
  const nWa2 = wa.length;
  await call('POST', '/chat/api/messages', { text: 'Deploy is green' }, kofi.token);
  await chat.flush();
  const toLi = wa.slice(nWa2).filter((w) => w.to === '+233241112222');
  ok(toLi.length === 1 && /Kofi: \[zh\] Deploy is green/.test(toLi[0].body), 'web message relayed to WhatsApp in the member\'s language');
  const nWa3 = wa.length;
  await call('POST', '/chat/api/messages', { text: 'from li on web' }, li.token);
  await chat.flush();
  ok(!wa.slice(nWa3).some((w) => w.to === '+233241112222'), 'sender is not echoed on WhatsApp');
  h = await call('POST', '/chat/api/whatsapp', { phone: '+233241112222' }, kofi.token);
  ok(h.status === 409, 'a number already linked by someone else is refused');

  // inbound WhatsApp (Africa's Talking-style JSON and Twilio-style form)
  const cfg = await chat.getConfig();
  const hook = `/chat-hooks/${cfg.hookSecret}/whatsapp`;
  h = await call('POST', '/chat-hooks/wrongsecret/whatsapp', { from: '+233', text: 'hi' });
  ok(h.status === 404, 'wrong hook secret is a bare 404');
  const nWa4 = wa.length;
  h = await call('POST', hook, { from: '+233 55 000 1111', text: 'hello?' });
  await chat.flush();
  ok(h.body.action === 'prompted' && wa.slice(nWa4).some((w) => /JOIN/.test(w.body)), 'unknown sender is told how to join');
  h = await call('POST', hook, { from: '+233550001111', text: `JOIN ${room.code} fr` });
  ok(h.body.ok && h.body.action === 'joined', 'JOIN <code> <lang> from WhatsApp');
  const nWa5 = wa.length;
  h = await call('POST', hook, 'From=whatsapp%3A%2B233550001111&Body=Bonjour+%C3%A0+tous', null, 'application/x-www-form-urlencoded');
  ok(h.body.action === 'posted', 'Twilio-style form message is posted to the room');
  await chat.flush();
  h = await call('GET', '/chat/api/messages?since=0', null, kofi.token);
  ok(h.body.messages.some((m) => m.kind === 'user' && m.via === 'whatsapp' && m.original === 'Bonjour à tous' && m.text === '[en] Bonjour à tous'), 'WhatsApp message shows to web readers translated, original kept');
  ok(wa.slice(nWa5).some((w) => w.to === '+233241112222' && /\[zh\] Bonjour/.test(w.body)), 'and is relayed to other WhatsApp members in their language');
  h = await call('POST', hook, { from: '+233550001111', text: 'LANG sw' });
  ok(h.body.action === 'lang', 'LANG sw from WhatsApp');
  h = await call('POST', hook, { from: '+233550001111', text: 'LEAVE' });
  ok(h.body.action === 'left', 'LEAVE from WhatsApp');
  h = await call('POST', hook, { from: '+233550001111', text: 'still there?' });
  ok(h.body.action === 'prompted', 'after leaving, messages are no longer posted');

  // Master Control
  const admin = express(); admin.use((req, _res, next) => { req.principal = { id: 'tester' }; next(); }); admin.use('/pi', platformI18n);
  const s2 = admin.listen(0); await new Promise((r2) => setTimeout(r2, 50));
  const pc = async (method, path, body) => { const res = await fetch(`http://127.0.0.1:${s2.address().port}/pi${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json().catch(() => ({})) }; };
  let p = await pc('GET', '/');
  ok(p.status === 200 && p.body.translation.configured && p.body.chat.whatsappHookUrl.includes('/chat-hooks/') && p.body.rooms.length === 1 && p.body.languages.length === 13, 'Master Control overview');
  p = await pc('POST', '/rooms', { name: 'Mobile' });
  ok(p.status === 201 && p.body.code, 'create a room from Master Control');
  const rc = await pc('POST', `/rooms/${p.body.id}/rotate-code`);
  ok(rc.body.code && rc.body.code !== p.body.code, 'rotate invite code');
  h = await call('POST', '/chat/api/join', { code: p.body.code, name: 'Late' });
  ok(h.status === 404, 'old invite code no longer works');
  await pc('PUT', '/chat', { enabled: false });
  h = await call('POST', '/chat/api/join', { code: rc.body.code, name: 'Late', lang: 'en' });
  ok(h.status === 503, 'chat switched off in Master Control');
  h = await call('GET', '/chat/api/messages', null, kofi.token);
  ok(h.status === 503, 'existing sessions also stop while chat is off');
  await pc('PUT', '/chat', { enabled: true });
  h = await call('GET', '/chat/api/messages?since=0', null, kofi.token);
  ok(h.status === 200, 'chat back on');
  await pc('POST', `/rooms/${rc.body.id}/archive`);
  h = await call('POST', '/chat/api/join', { code: rc.body.code, name: 'Late' });
  ok(h.status === 404, 'archived room cannot be joined');
  h = await call('POST', '/chat/api/leave', null, yaw.token);
  ok(h.status === 200, 'leave');

  server.close(); s2.close();
  console.log(`\n${a} assertions${process.exitCode ? ' — WITH FAILURES' : ' — all passed'}`);
})().catch((x) => { console.error(x); process.exit(1); });
