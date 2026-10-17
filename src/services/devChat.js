'use strict';

/**
 * Developer chat rooms across languages.
 *
 * - A room has an invite code. Anyone with the code joins with a display name and
 *   their own preferred language (web), or from their own WhatsApp number.
 * - Messages are stored once, in the sender's language. Each reader gets them in
 *   their own language (LibreTranslate via services/i18n, cached per message and
 *   language) and can tap to see the original. If translation is unavailable the
 *   reader sees the original text, flagged -- chat never stops working.
 * - Code blocks, inline code, URLs, paths and @mentions are never translated.
 * - WhatsApp bridge: members who link a WhatsApp number receive the room's messages
 *   there (in their language) and what they send back is posted to the room. This
 *   is per-person, not a WhatsApp *group*: provider APIs (Africa's Talking, Twilio)
 *   cannot join or post into WhatsApp groups.
 * - Bot commands: /lang <code>, /who, /help (answered privately to the sender).
 */

const crypto = require('crypto');
const store = require('../store');
const i18n = require('./i18n');
const messaging = require('./messaging');

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const MAX_LEN = 2000;
const PAGE = 100;
const ONLINE_MS = 45000;

// ----------------------------------------------------------------- settings
const CFG_KEY = 'chat_config';
async function getConfig() {
  let s = await store.settings.get(CFG_KEY);
  if (!s) { s = { enabled: true, hookSecret: crypto.randomBytes(18).toString('hex'), signKey: crypto.randomBytes(24).toString('hex'), createdAt: now() }; await store.settings.set(CFG_KEY, s); }
  return s;
}
async function setEnabled(enabled, by) {
  const s = await getConfig(); s.enabled = !!enabled; s.updatedAt = now(); s.updatedBy = by || null;
  await store.settings.set(CFG_KEY, s); return publicConfig();
}
async function rotateHookSecret() { const s = await getConfig(); s.hookSecret = crypto.randomBytes(18).toString('hex'); await store.settings.set(CFG_KEY, s); return s.hookSecret; }
async function checkHookSecret(given) { const s = await getConfig(); const a = Buffer.from(String(given || '')); const b = Buffer.from(s.hookSecret); return a.length === b.length && crypto.timingSafeEqual(a, b); }
async function publicConfig(baseUrl) {
  const s = await getConfig();
  const root = String(baseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return { enabled: s.enabled, whatsappHookUrl: `${root}/chat-hooks/${s.hookSecret}/whatsapp`, updatedAt: s.updatedAt || null, updatedBy: s.updatedBy || null };
}
async function requireEnabled() { if (!(await getConfig()).enabled) throw err(503, 'chat_disabled'); }

// ------------------------------------------------------------------ tokens
async function sign(pid) {
  const s = await getConfig();
  return 'cp.' + pid + '.' + crypto.createHmac('sha256', s.signKey).update('chat|' + pid).digest('base64url').slice(0, 32);
}
async function authenticate(header) {
  const m = /^Bearer\s+(cp\.[\w-]+\.[\w-]+)$/.exec(String(header || ''));
  if (!m) throw err(401, 'missing_or_invalid_token');
  const [, pid, mac] = m[1].split('.');
  const want = (await sign(pid)).split('.')[2];
  const a = Buffer.from(mac); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw err(401, 'missing_or_invalid_token');
  const p = await store.settings.get('chat:p:' + pid);
  if (!p || p.left) throw err(401, 'missing_or_invalid_token');
  await requireEnabled();
  return p;
}

// -------------------------------------------------------------------- rooms
const newCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 8; i++) c += A[crypto.randomInt(A.length)]; return c; };
const roomKey = (id) => 'chat:room:' + id;
const msgKey = (room, seq) => `chat:msg:${room}:${String(seq).padStart(9, '0')}`;
const pub = (r) => ({ id: r.id, name: r.name, topic: r.topic || '', createdAt: r.createdAt, archived: !!r.archived });

async function createRoom({ name, topic } = {}, by) {
  name = String(name || '').trim().slice(0, 80);
  if (!name) throw err(422, 'room_name_required');
  const id = 'room_' + crypto.randomBytes(5).toString('hex');
  let code = newCode();
  for (let i = 0; i < 5 && (await store.settings.get('chat:code:' + code)); i++) code = newCode();
  const room = { id, name, topic: String(topic || '').slice(0, 200), code, seq: 0, createdAt: now(), createdBy: by || null, archived: false };
  await store.settings.set(roomKey(id), room);
  await store.settings.set('chat:code:' + code, { roomId: id });
  return { ...pub(room), code };
}
async function listRooms() {
  const out = [];
  for (const k of await store.settings.keys('chat:room:')) { const r = await store.settings.get(k); if (r) out.push({ ...pub(r), code: r.code, members: (await members(r.id)).length }); }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
async function archiveRoom(id, archived = true) {
  const r = await store.settings.get(roomKey(id)); if (!r) throw err(404, 'room_not_found');
  r.archived = !!archived; await store.settings.set(roomKey(id), r); return pub(r);
}
async function rotateCode(id) {
  const r = await store.settings.get(roomKey(id)); if (!r) throw err(404, 'room_not_found');
  await store.settings.set('chat:code:' + r.code, { roomId: id, revoked: true });
  r.code = newCode(); await store.settings.set(roomKey(id), r); await store.settings.set('chat:code:' + r.code, { roomId: id });
  return { ...pub(r), code: r.code };
}

const locks = new Map();
async function withRoom(id, fn) { // serialise writes to a room so seq numbers never collide
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(id, run.catch(() => {}));
  return run;
}
async function appendMessage(roomId, msg) {
  return withRoom(roomId, async () => {
    const r = await store.settings.get(roomKey(roomId)); if (!r) throw err(404, 'room_not_found');
    r.seq += 1; await store.settings.set(roomKey(roomId), r);
    const rec = { seq: r.seq, at: now(), ...msg };
    await store.settings.set(msgKey(roomId, r.seq), rec);
    return rec;
  });
}

// ------------------------------------------------------------- participants
async function members(roomId) {
  const out = [];
  for (const k of await store.settings.keys('chat:p:')) { const p = await store.settings.get(k); if (p && p.roomId === roomId && !p.left) out.push(p); }
  return out;
}
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);

async function join({ code, name, lang } = {}, { channel = 'web', phone = null } = {}) {
  await requireEnabled();
  const c = await store.settings.get('chat:code:' + String(code || '').trim().toUpperCase());
  if (!c || c.revoked) throw err(404, 'invalid_invite_code');
  const room = await store.settings.get(roomKey(c.roomId));
  if (!room || room.archived) throw err(404, 'invalid_invite_code');
  name = cleanName(name);
  if (!name) throw err(422, 'name_required');
  if (lang && !i18n.isKnown(lang)) throw err(422, 'unknown_language');
  const L = i18n.normalise(lang);
  const id = crypto.randomBytes(8).toString('hex');
  const p = { id, roomId: room.id, name, lang: L, channel, phone, joinedAt: now(), lastSeen: Date.now() };
  await store.settings.set('chat:p:' + id, p);
  await appendMessage(room.id, { kind: 'system', key: 'chat.joined', vars: { name, lang: L } });
  return { token: await sign(id), participant: publicParticipant(p), room: pub(room) };
}
const publicParticipant = (p) => ({ id: p.id, name: p.name, lang: p.lang, channel: p.channel, whatsapp: !!(p.phone && p.relay), online: Date.now() - (p.lastSeen || 0) < ONLINE_MS });

async function setLanguage(p, lang) {
  if (!i18n.isKnown(lang)) throw err(422, 'unknown_language');
  p.lang = i18n.normalise(lang); await store.settings.set('chat:p:' + p.id, p); return publicParticipant(p);
}
async function leave(p) {
  p.left = true; await store.settings.set('chat:p:' + p.id, p);
  if (p.phone) { const w = await store.settings.get('chat:wa:' + p.phone); if (w && w.pid === p.id) await store.settings.set('chat:wa:' + p.phone, { pid: null }); }
  await appendMessage(p.roomId, { kind: 'system', key: 'chat.left', vars: { name: p.name, lang: p.lang } });
  return { ok: true };
}
async function roster(p) {
  const room = await store.settings.get(roomKey(p.roomId));
  return { room: pub(room), me: publicParticipant(p), members: (await members(p.roomId)).map(publicParticipant) };
}

// ---------------------------------------------------------------- messages
const rate = new Map();
function rateOk(pid) {
  const t = Date.now(); const h = (rate.get(pid) || []).filter((x) => t - x < 60000);
  if (h.length >= 30) return false;
  h.push(t); rate.set(pid, h); return true;
}
const pending = new Set(); // in-flight WhatsApp relays (tests await flush())
async function flush() { while (pending.size) await Promise.allSettled([...pending]); }

async function post(p, text, { via = 'web' } = {}) {
  await requireEnabled();
  text = String(text == null ? '' : text).replace(/\u0000/g, '').trim();
  if (!text) throw err(422, 'message_required');
  if (text.length > MAX_LEN) throw err(422, 'message_too_long');
  if (!rateOk(p.id)) throw err(429, 'slow_down');
  p.lastSeen = Date.now(); await store.settings.set('chat:p:' + p.id, p);
  if (text.startsWith('/')) return command(p, text);
  const rec = await appendMessage(p.roomId, { kind: 'user', pid: p.id, name: p.name, lang: p.lang, text, via });
  const job = relay(p, rec).catch((e) => console.error('[devchat relay]', e && e.message)).finally(() => pending.delete(job));
  pending.add(job);
  return { seq: rec.seq };
}

async function command(p, text) {
  const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
  let reply;
  switch ((cmd || '').toLowerCase()) {
    case 'lang': {
      if (!rest[0] || !i18n.isKnown(rest[0].toLowerCase())) {
        reply = 'Languages: ' + i18n.LANGUAGES.map((l) => `${l.code} (${l.native})`).join(', ');
      } else { await setLanguage(p, rest[0].toLowerCase()); reply = `OK: ${i18n.lang(p.lang).native}`; }
      break;
    }
    case 'who': reply = (await members(p.roomId)).map((m) => `${m.name} (${i18n.lang(m.lang).native}${m.phone && m.relay ? ', WhatsApp' : ''})`).join('; '); break;
    case 'help': reply = i18n.t('chat.help', p.lang); break;
    default: reply = i18n.t('chat.help', p.lang);
  }
  const rec = await appendMessage(p.roomId, { kind: 'bot', to: p.id, text: reply, lang: p.lang });
  return { seq: rec.seq, command: true };
}

/** Render one stored message for a reader in `lang`. */
async function render(m, lang) {
  if (m.kind === 'system') {
    const L = lang;
    return { seq: m.seq, at: m.at, kind: 'system', text: i18n.t(m.key, L, { name: m.vars.name, lang: i18n.lang(m.vars.lang).native }) };
  }
  if (m.kind === 'bot') return { seq: m.seq, at: m.at, kind: 'bot', text: m.text };
  const base = { seq: m.seq, at: m.at, kind: 'user', pid: m.pid, name: m.name, lang: m.lang, via: m.via, original: m.text };
  if (i18n.normalise(m.lang) === i18n.normalise(lang)) return { ...base, text: m.text, translated: false };
  const r = await i18n.translate(m.text, m.lang, lang);
  if (r.ok) return { ...base, text: r.text, translated: r.reason !== 'nothing-to-translate' && r.text !== m.text };
  return { ...base, text: m.text, translated: false, untranslated: true, reason: r.reason };
}

async function list(p, { since = 0 } = {}) {
  await requireEnabled();
  p.lastSeen = Date.now(); await store.settings.set('chat:p:' + p.id, p);
  const room = await store.settings.get(roomKey(p.roomId));
  since = Math.max(0, parseInt(since, 10) || 0);
  const out = [];
  for (let s = since + 1; s <= room.seq && out.length < PAGE; s++) {
    const m = await store.settings.get(msgKey(p.roomId, s));
    if (!m) continue;
    if (m.kind === 'bot' && m.to !== p.id) continue;
    out.push(await render(m, p.lang));
  }
  return { messages: out, last: room.seq, lang: p.lang };
}

// ------------------------------------------------------------- WhatsApp bridge
async function sendWa(phone, body) {
  const r = await messaging.send({ channel: 'whatsapp', to: phone, body, tenant: null });
  return !!r.ok;
}
async function relay(sender, rec) {
  const all = (await members(sender.roomId)).filter((m) => m.id !== sender.id && m.phone && m.relay);
  for (const m of all) {
    const r = await render(rec, m.lang);
    const body = `${rec.name}: ${r.text}` + (r.untranslated ? ` (${i18n.t('chat.untranslated', m.lang)})` : '');
    await sendWa(m.phone, body).catch(() => false);
  }
}
/** A web member links their own WhatsApp number to the room. */
async function linkWhatsApp(p, phoneRaw) {
  const phone = canon(phoneRaw);
  if (!/^\+\d{8,15}$/.test(phone)) throw err(422, 'phone_invalid');
  const w = await store.settings.get('chat:wa:' + phone);
  if (w && w.pid && w.pid !== p.id) throw err(409, 'phone_already_linked');
  p.phone = phone; p.relay = true; await store.settings.set('chat:p:' + p.id, p);
  await store.settings.set('chat:wa:' + phone, { pid: p.id });
  const room = await store.settings.get(roomKey(p.roomId));
  const sent = await sendWa(phone, `${room.name}: ${i18n.t('chat.help', p.lang)}`).catch(() => false);
  return { linked: true, delivered: sent, whatsapp: maskPhone(phone) };
}
async function unlinkWhatsApp(p) {
  if (p.phone) { const w = await store.settings.get('chat:wa:' + p.phone); if (w && w.pid === p.id) await store.settings.set('chat:wa:' + p.phone, { pid: null }); }
  p.phone = null; p.relay = false; await store.settings.set('chat:p:' + p.id, p); return { linked: false };
}
const canon = (raw) => messaging.toDialable(String(raw || '').replace(/^whatsapp:/i, '').replace(/[\s().-]/g, ''));
const maskPhone = (ph) => ph.replace(/^(\+\d{3})\d+(\d{2})$/, '$1•••••$2');

function pickFrom(b) {
  const from = b.From || b.from || b.sender || b.phoneNumber || b.msisdn || b.waId || (b.contact && b.contact.phone) || '';
  let text = b.Body || b.text || b.body || b.message || b.messageBody || '';
  if (text && typeof text === 'object') text = text.text || text.body || '';
  return { from: String(from).replace(/^whatsapp:/i, ''), text: String(text || '').trim() };
}

/** Inbound WhatsApp message (Africa's Talking or Twilio shapes). JOIN <code> [lang] | LANG xx | WHO | LEAVE | <text>. */
async function inboundWhatsApp(body) {
  await requireEnabled();
  const { from, text } = pickFrom(body || {});
  const phone = canon(from);
  if (!/^\+\d{8,15}$/.test(phone) || !text) return { ok: false, error: 'unrecognised_message' };
  const reply = (s) => sendWa(phone, s).catch(() => false);
  const link = await store.settings.get('chat:wa:' + phone);
  const cur = link && link.pid ? await store.settings.get('chat:p:' + link.pid) : null;
  const active = cur && !cur.left ? cur : null;
  const [w1, w2, ...restW] = text.split(/\s+/);
  const kw = (w1 || '').toUpperCase();

  if (kw === 'JOIN' && w2) {
    const lg = restW[0] && i18n.isKnown(restW[0].toLowerCase()) ? restW[0].toLowerCase() : (active ? active.lang : 'en');
    const nm = (active && active.name) || ('WhatsApp ' + phone.slice(-4));
    try {
      if (active) await leave(active);
      const j = await join({ code: w2, name: nm, lang: lg }, { channel: 'whatsapp', phone });
      const p = await store.settings.get('chat:p:' + j.participant.id); p.relay = true; await store.settings.set('chat:p:' + p.id, p);
      await store.settings.set('chat:wa:' + phone, { pid: p.id });
      await reply(`${j.room.name}: ${i18n.t('chat.help', lg)}`);
      return { ok: true, action: 'joined', room: j.room.id };
    } catch (e) { await reply(e.message === 'invalid_invite_code' ? 'Invalid invite code.' : 'Could not join.'); return { ok: false, error: e.message }; }
  }
  if (!active) { await reply('Send: JOIN <invite code> [language code, e.g. fr] to enter a developer chat room.'); return { ok: true, action: 'prompted' }; }
  if (kw === 'LEAVE') { await leave(active); await reply('You left the room.'); return { ok: true, action: 'left' }; }
  if (kw === 'LANG') {
    if (w2 && i18n.isKnown(w2.toLowerCase())) { await setLanguage(active, w2.toLowerCase()); await reply('OK: ' + i18n.lang(active.lang).native); return { ok: true, action: 'lang' }; }
    await reply('Languages: ' + i18n.LANGUAGES.map((l) => l.code).join(', ')); return { ok: true, action: 'lang-help' };
  }
  if (kw === 'WHO') { const r = await command(active, '/who'); const m = await store.settings.get(msgKey(active.roomId, r.seq)); await reply(m.text); return { ok: true, action: 'who' }; }
  await post(active, text, { via: 'whatsapp' });
  return { ok: true, action: 'posted' };
}

module.exports = {
  getConfig, setEnabled, rotateHookSecret, checkHookSecret, publicConfig,
  createRoom, listRooms, archiveRoom, rotateCode,
  join, authenticate, setLanguage, leave, roster, post, list,
  linkWhatsApp, unlinkWhatsApp, inboundWhatsApp, flush,
};
