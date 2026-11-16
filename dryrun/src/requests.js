'use strict';
/** People ask for an account on the public page. The platform owner reviews each request; approving it creates the organisation and sends the admin's sign-in details. */
const reg = require('./registry');
const orgs = require('./orgs');
const packs = require('./packs');
const messaging = require('./messaging');
const { err, iso, id } = require('./util');
const store = () => { const r = reg.load(); r.requests = r.requests || {}; return r.requests; };
const hits = new Map();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECTORS = () => packs.list().map((p) => p.key);

function submit(body, ip) {
  if (body.website) return { received: true }; // honeypot: bots fill hidden fields
  const now = Date.now(); const h = (hits.get(ip) || []).filter((t) => now - t < 3600000); if (h.length >= 5) throw err(429, 'Too many requests from this device. Try again later.'); h.push(now); hits.set(ip, h);
  const need = (k, label) => { if (!String(body[k] || '').trim()) throw err(422, `${label} is required.`); return String(body[k]).trim().slice(0, 200); };
  const organisation = need('organisation', 'Organisation'), contactName = need('contactName', 'Your name'), email = need('email', 'Email').toLowerCase();
  if (!EMAIL.test(email)) throw err(422, 'That email address does not look right.');
  if (body.phone && !messaging.validPhone(body.phone)) throw err(422, 'That phone number does not look right. Use 024… or +233….');
  const sector = body.sector || 'insurer'; if (!SECTORS().includes(sector)) throw err(422, 'Pick a sector from the list.');
  if (Object.values(store()).some((r) => r.status === 'new' && r.email === email)) throw err(409, 'We already have a request from this email. We will be in touch.');
  const r = { id: id('req'), createdAt: iso(), status: 'new', organisation, contactName, email, phone: body.phone ? String(body.phone).trim() : '', jobTitle: String(body.jobTitle || '').slice(0, 100), sector, interest: String(body.interest || '').slice(0, 800), plan: body.plan === 'paid' ? 'paid' : 'free_trial', referredBy: orgFromRef(body.ref) };
  store()[r.id] = r; reg.save(); return { received: true, request: r };
}
function orgFromRef(ref) { if (!ref) return null; const o = Object.values(reg.load().orgs).find((x) => x.id.slice(4, 12) === String(ref)); return o ? { orgId: o.id, name: o.name } : null; }
const list = () => Object.values(store()).filter((r) => r.type !== 'team').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const pending = () => list().filter((r) => r.status === 'new').length;
function get(rid) { const r = store()[rid]; if (!r) throw err(404, 'Unknown request.'); return r; }
function decline(rid, reason) { const r = get(rid); if (r.status !== 'new') throw err(409, 'This request has already been dealt with.'); r.status = 'declined'; r.reason = String(reason || '').slice(0, 300); r.decidedAt = iso(); reg.save(); return r; }
/** Create the organisation for a request. The caller sends the sign-in details. */
function approve(rid, { plan } = {}) {
  const r = get(rid); if (r.status !== 'new') throw err(409, 'This request has already been dealt with.');
  const created = orgs.create({ name: r.organisation, sector: r.sector, adminName: r.contactName, adminEmail: r.email, adminPhone: r.phone || undefined, plan: plan || r.plan }, packs);
  r.status = 'approved'; r.decidedAt = iso(); r.orgId = created.org.id; reg.save(); return { request: r, created };
}
/** ---- Team requests: someone asks to join an existing organisation's team. The organisation's admin decides, not the platform owner. ---- */
const crypto = require('crypto');
function orgFromTeamToken(t) { if (!t) return null; return Object.values(reg.load().orgs).find((o) => o.teamInvite && o.teamInvite.on && o.plan !== 'demo' && o.teamInvite.token === String(t)) || null; }
function teamToken(orgId, rotate) { const o = orgs.raw(orgId); if (!o.teamInvite || rotate) { o.teamInvite = { token: 'tm_' + crypto.randomBytes(9).toString('hex'), on: true, createdAt: iso() }; reg.save(); } return o.teamInvite; }
function teamInviteOff(orgId) { const o = orgs.raw(orgId); teamToken(orgId); o.teamInvite.on = false; reg.save(); return o.teamInvite; }
function teamInviteOn(orgId) { const o = orgs.raw(orgId); teamToken(orgId); o.teamInvite.on = true; reg.save(); return o.teamInvite; }
function submitTeam(body, ip) {
  if (body.website) return { received: true };
  const o = orgFromTeamToken(body.token); if (!o) throw err(404, 'This invite link is no longer active. Ask your colleague for a new one.');
  const key = 'team:' + ip; const now = Date.now(); const h = (hits.get(key) || []).filter((t) => now - t < 3600000); if (h.length >= 5) throw err(429, 'Too many requests from this device. Try again later.'); h.push(now); hits.set(key, h);
  const name = String(body.contactName || '').trim().slice(0, 200), email = String(body.email || '').trim().toLowerCase();
  if (!name) throw err(422, 'Your name is required.'); if (!EMAIL.test(email)) throw err(422, 'That email address does not look right.');
  if (body.phone && !messaging.validPhone(body.phone)) throw err(422, 'That phone number does not look right. Use 024… or +233….');
  if (Object.values(o.members).some((m) => m.email.toLowerCase() === email)) throw err(409, 'That email is already on this team. Sign in instead.');
  if (Object.values(store()).some((r) => r.type === 'team' && r.orgId === o.id && r.status === 'new' && r.email === email)) throw err(409, 'You have already asked to join. Your admin will be in touch.');
  const r = { id: id('req'), type: 'team', createdAt: iso(), status: 'new', orgId: o.id, organisation: o.name, contactName: name, email, phone: body.phone ? String(body.phone).trim() : '', jobTitle: String(body.jobTitle || '').slice(0, 100), note: String(body.interest || '').slice(0, 400) };
  store()[r.id] = r; reg.save(); return { received: true, request: r, org: o.name };
}
const teamList = (orgId) => Object.values(store()).filter((r) => r.type === 'team' && r.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const teamPending = (orgId) => teamList(orgId).filter((r) => r.status === 'new').length;
function teamGet(orgId, rid) { const r = store()[rid]; if (!r || r.type !== 'team' || r.orgId !== orgId) throw err(404, 'Unknown request.'); return r; }
function teamDecline(orgId, rid, reason, by) { const r = teamGet(orgId, rid); if (r.status !== 'new') throw err(409, 'This request has already been dealt with.'); r.status = 'declined'; r.reason = String(reason || '').slice(0, 300); r.decidedAt = iso(); r.decidedBy = by; reg.save(); return r; }
/** Add the person to the team. The caller sends their sign-in details. */
function teamApprove(orgId, rid, role, by) {
  const r = teamGet(orgId, rid); if (r.status !== 'new') throw err(409, 'This request has already been dealt with.');
  const m = orgs.addMember(orgId, { name: r.contactName, email: r.email, phone: r.phone, role: role || 'viewer' }, by);
  r.status = 'approved'; r.decidedAt = iso(); r.decidedBy = by; reg.save(); return { request: r, member: m };
}
module.exports = { orgFromTeamToken, teamToken, teamInviteOff, teamInviteOn, submitTeam, teamList, teamPending, teamDecline, teamApprove, submit, list, pending, get, decline, approve, orgFromRef };
