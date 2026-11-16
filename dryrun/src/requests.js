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
const list = () => Object.values(store()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const pending = () => list().filter((r) => r.status === 'new').length;
function get(rid) { const r = store()[rid]; if (!r) throw err(404, 'Unknown request.'); return r; }
function decline(rid, reason) { const r = get(rid); if (r.status !== 'new') throw err(409, 'This request has already been dealt with.'); r.status = 'declined'; r.reason = String(reason || '').slice(0, 300); r.decidedAt = iso(); reg.save(); return r; }
/** Create the organisation for a request. The caller sends the sign-in details. */
function approve(rid, { plan } = {}) {
  const r = get(rid); if (r.status !== 'new') throw err(409, 'This request has already been dealt with.');
  const created = orgs.create({ name: r.organisation, sector: r.sector, adminName: r.contactName, adminEmail: r.email, adminPhone: r.phone || undefined, plan: plan || r.plan }, packs);
  r.status = 'approved'; r.decidedAt = iso(); r.orgId = created.org.id; reg.save(); return { request: r, created };
}
module.exports = { submit, list, pending, get, decline, approve, orgFromRef };
