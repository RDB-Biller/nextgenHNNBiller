'use strict';

/**
 * Product Lab working groups: invite-only co-creation rooms for people from different organisations, countries and
 * languages. Everyone writes in their own language; the translator (LibreTranslate via the i18n service) shows each
 * member the thread in theirs. Ideas are structured (problem, proposal, success measure) and voted on, a challenge
 * keeps the room moving, and a shortlisted idea can be promoted to a Product Lab brief.
 *
 * Linked to the referral programme: a member joins from an invite link that carries the inviter's referral code; the
 * inviter is credited when the invitee joins, and the room shows who invited whom, so a team spread over several
 * countries can be seen working together because one referred the other.
 *
 * No emails or phone numbers are ever shown to other members: first name, organisation, country and language only.
 */
const crypto = require('crypto');
const store = require('../store');
const outreach = require('./outreach');
const i18n = require('./i18n');
const countries = require('../data/countries');

const G = 'lab:g:'; const IDX = 'lab:idx';
const { err, rid, now } = outreach._x;
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const code = () => crypto.randomBytes(5).toString('hex');
const ROLES = ['product', 'engineering', 'claims', 'compliance', 'clinical', 'sales', 'leadership', 'other'];
const IDEA_STATUS = ['open', 'shortlisted', 'promoted', 'parked'];

async function load(id) { const g = await store.settings.get(G + id); if (!g) throw err(404, 'group_not_found'); return g; }
async function byCode(c) {
  const idx = (await store.settings.get(IDX)) || {}; const id = idx[String(c || '')]; if (!id) throw err(404, 'group_not_found'); return load(id);
}
async function save(g) { await store.settings.set(G + g.id, g); }

async function createGroup(b = {}, by) {
  const name = clean(b.name, 80); if (!name) throw err(422, 'name_required');
  let productId = '';
  if (b.productId) { try { const products = require('./products'); const p = await products.get(String(b.productId)); if (!p) throw new Error('x'); productId = p.id; } catch (_e) { throw err(422, 'productId is not a Product Lab product'); } }
  const g = { id: rid('lg'), code: code(), name, topic: clean(b.topic, 300), productId, challenge: clean(b.challenge, 300), status: 'open', members: [], messages: [], ideas: [], createdAt: now(), createdBy: by || null };
  await save(g); const idx = (await store.settings.get(IDX)) || {}; idx[g.code] = g.id; await store.settings.set(IDX, idx); return summary(g);
}
const summary = (g) => ({ id: g.id, code: g.code, name: g.name, topic: g.topic, productId: g.productId, challenge: g.challenge, status: g.status, members: g.members.length, languages: [...new Set(g.members.map((m) => m.lang))], countries: [...new Set(g.members.map((m) => m.cc).filter(Boolean))], ideas: g.ideas.length, messages: g.messages.length, createdAt: g.createdAt });
async function listGroups() { const out = []; for (const k of await store.settings.keys(G)) { const g = await store.settings.get(k); if (g) out.push(summary(g)); } return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
async function updateGroup(id, b = {}) {
  const g = await load(id);
  if (b.name !== undefined) g.name = clean(b.name, 80) || g.name; if (b.topic !== undefined) g.topic = clean(b.topic, 300); if (b.challenge !== undefined) g.challenge = clean(b.challenge, 300);
  if (b.status !== undefined) { if (!['open', 'closed'].includes(b.status)) throw err(422, 'bad_status'); g.status = b.status; }
  if (b.productId !== undefined) { if (!b.productId) g.productId = ''; else { const p = await require('./products').get(String(b.productId)).catch(() => null); if (!p) throw err(422, 'productId is not a Product Lab product'); g.productId = p.id; } }
  await save(g); return summary(g);
}
/** Operator's view: members with their referral chain, ideas and a brief for promoted ideas. */
async function adminView(id) {
  const g = await load(id); const byRef = new Map(g.members.map((m) => [m.refCode, m]));
  return { ...summary(g), members: g.members.map((m) => ({ id: m.id, name: m.name, org: m.org, cc: m.cc, lang: m.lang, role: m.role, email: m.email, invitedBy: (byRef.get(m.invitedByCode) || {}).name || (m.invitedByCode ? 'a referrer outside the group' : ''), joinedAt: m.joinedAt })),
    ideas: g.ideas.map((i) => ({ ...i, votes: i.votes.length, by: (g.members.find((m) => m.id === i.memberId) || {}).name })), sameCompanyAcrossCountries: crossBorderTeams(g) };
}
function crossBorderTeams(g) {
  const by = {}; for (const m of g.members) { const k = String(m.org || '').toLowerCase(); if (!k) continue; (by[k] = by[k] || []).push(m); }
  return Object.values(by).filter((a) => new Set(a.map((m) => m.cc)).size > 1 || new Set(a.map((m) => m.lang)).size > 1).map((a) => ({ org: a[0].org, members: a.map((m) => ({ name: m.name, cc: m.cc, lang: m.lang })) }));
}
async function moderateIdea(id, ideaId, b = {}) {
  const g = await load(id); const i = g.ideas.find((x) => x.id === ideaId); if (!i) throw err(404, 'idea_not_found');
  if (b.remove) g.ideas = g.ideas.filter((x) => x.id !== ideaId);
  else { if (!IDEA_STATUS.includes(b.status)) throw err(422, 'bad_status'); i.status = b.status; }
  await save(g); return { ok: true, brief: b.status === 'promoted' ? brief(g, i) : undefined };
}
const brief = (g, i) => ({ title: i.title, problem: i.problem, proposal: i.proposal, successMeasure: i.metric, votes: i.votes.length, group: g.name, productLabProductId: g.productId || null, note: 'Create or edit the Product Lab product from this brief.' });
async function removeMessage(id, msgId) { const g = await load(id); g.messages = g.messages.filter((m) => m.id !== msgId); await save(g); return { ok: true }; }

// ------------------------------------------------------------------ members
async function publicInfo(c) { const g = await byCode(c); return { code: g.code, name: g.name, topic: g.topic, challenge: g.challenge, members: g.members.length, languages: [...new Set(g.members.map((m) => m.lang))], status: g.status }; }
async function join(c, b = {}) {
  const g = await byCode(c); if (g.status !== 'open') throw err(409, 'This group is closed.');
  const name = clean(b.name, 100); if (!name) throw err(422, 'Your name, please.');
  const em = clean(b.email, 160).toLowerCase(); if (!outreach._x.EMAIL_RE.test(em)) throw err(422, 'A valid email, please. It is never shown to other members.');
  if (!b.consent || b.consent === 'false') throw err(422, 'Please agree to take part and to share your first name, organisation and country with the group.');
  if (g.members.length >= 300) throw err(409, 'This group is full.');
  const ex = g.members.find((m) => m.email === em); if (ex) return { token: ex.token, memberId: ex.id, rejoined: true };
  const geo = b.country ? countries.find(b.country) : null; const lang = b.lang && i18n.isKnown(b.lang) ? i18n.normalise(b.lang) : (geo ? geo.langs[0] : 'en');
  const partner = await outreach.ensurePartner({ name, email: em, org: b.org });
  const m = { id: rid('m'), token: crypto.randomBytes(12).toString('base64url'), name, email: em, org: clean(b.org, 120), cc: geo ? geo.code : '', lang, role: ROLES.includes(b.role) ? b.role : 'other', refCode: partner.code, invitedByCode: '', joinedAt: now() };
  const ref = clean(b.ref, 40);
  if (ref && ref !== partner.code && await outreach.getReferrer(ref)) { m.invitedByCode = ref; await outreach.creditReferrer(ref, { kind: 'lab', name, orgName: m.org, ref: g.id }); }
  g.members.push(m); await save(g); return { token: m.token, memberId: m.id, referralCode: partner.code };
}
const member = (g, token) => { const m = g.members.find((x) => x.token === String(token || '')); if (!m) throw err(401, 'Please join the group first.'); return m; };
async function inTheirLanguage(item, field, from, to) {
  if (!to || to === from) return { text: item[field], translated: false };
  item.tr = item.tr || {}; if (item.tr[field + ':' + to]) return { text: item.tr[field + ':' + to], translated: true };
  const r = await i18n.translate(item[field], from || 'en', to);
  if (r && r.ok && r.text) { item.tr[field + ':' + to] = r.text; return { text: r.text, translated: true }; }
  return { text: item[field], translated: false };
}
/** What a member sees: the thread and ideas translated into their language; others shown by first name, organisation, country. */
async function view(c, token) {
  const g = await byCode(c); const me = member(g, token); let dirty = false; const byId = new Map(g.members.map((m) => [m.id, m]));
  const who = (id) => { const m = byId.get(id); return m ? { name: m.name.split(/\s+/)[0], org: m.org, cc: m.cc, lang: m.lang } : { name: 'Former member', org: '', cc: '', lang: 'en' }; };
  let budget = 40; const msgs = [];
  for (const m of g.messages.slice(-80)) {
    let t = { text: m.text, translated: false };
    if (m.lang !== me.lang && budget > 0) { const had = !!(m.tr && m.tr['text:' + me.lang]); t = await inTheirLanguage(m, 'text', m.lang, me.lang); if (!had && t.translated) { dirty = true; budget--; } }
    msgs.push({ id: m.id, at: m.at, from: who(m.memberId), mine: m.memberId === me.id, text: t.text, translated: t.translated, original: t.translated ? m.text : '', lang: m.lang });
  }
  const ideas = [];
  for (const i of g.ideas) {
    const out = { id: i.id, at: i.at, from: who(i.memberId), status: i.status, votes: i.votes.length, voted: i.votes.includes(me.id) };
    for (const f of ['title', 'problem', 'proposal', 'metric']) { const had = !!(i.tr && i.tr[f + ':' + me.lang]); const t = await inTheirLanguage(i, f, i.lang, me.lang); out[f] = t.text; if (!had && t.translated) dirty = true; }
    ideas.push(out);
  }
  if (dirty) await save(g);
  ideas.sort((a, b) => b.votes - a.votes);
  const base = String((await outreach.getConfig()).publicBaseUrl || '').replace(/\/$/, '');
  const roster = g.members.map((m) => ({ name: m.name.split(/\s+/)[0], org: m.org, cc: m.cc, lang: m.lang, role: m.role, invitedBy: (g.members.find((x) => x.refCode === m.invitedByCode) || {}).name ? g.members.find((x) => x.refCode === m.invitedByCode).name.split(/\s+/)[0] : '' }));
  return { group: { code: g.code, name: g.name, topic: g.topic, challenge: g.challenge }, me: { name: me.name, lang: me.lang, org: me.org, cc: me.cc, referralCode: me.refCode, inviteLink: `${base}/o/lab/${g.code}?ref=${me.refCode}` }, roster, messages: msgs, ideas, translatorOn: await translatorOn() };
}
async function translatorOn() { try { const c = await i18n.getConfig(); return !!(c && c.url && c.enabled); } catch (_e) { return false; } }
async function post(c, token, text) {
  const g = await byCode(c); const me = member(g, token); const t = clean(text, 1500); if (!t) throw err(422, 'Write something first.');
  const recent = g.messages.filter((m) => m.memberId === me.id && Date.now() - Date.parse(m.at) < 60000).length; if (recent >= 8) throw err(429, 'Slow down a little, please.');
  g.messages.push({ id: rid('msg'), memberId: me.id, at: now(), lang: me.lang, text: t, tr: {} }); g.messages = g.messages.slice(-500); await save(g); return { ok: true };
}
async function addIdea(c, token, b = {}) {
  const g = await byCode(c); const me = member(g, token); const title = clean(b.title, 100); if (!title) throw err(422, 'Give your idea a short title.');
  if (g.ideas.length >= 200) throw err(409, 'The idea board is full; ask the host to clear it.');
  g.ideas.push({ id: rid('idea'), memberId: me.id, at: now(), lang: me.lang, title, problem: clean(b.problem, 600), proposal: clean(b.proposal, 800), metric: clean(b.metric, 300), votes: [me.id], status: 'open', tr: {} });
  await save(g); return { ok: true };
}
async function vote(c, token, ideaId) {
  const g = await byCode(c); const me = member(g, token); const i = g.ideas.find((x) => x.id === ideaId); if (!i) throw err(404, 'idea_not_found');
  i.votes = i.votes.includes(me.id) ? i.votes.filter((v) => v !== me.id) : [...i.votes, me.id]; await save(g); return { votes: i.votes.length, voted: i.votes.includes(me.id) };
}
module.exports = { createGroup, listGroups, updateGroup, adminView, moderateIdea, removeMessage, publicInfo, join, view, post, addIdea, vote, ROLES };
