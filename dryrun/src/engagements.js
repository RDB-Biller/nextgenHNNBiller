'use strict';
/**
 * The partner network. A client organisation (for example an insurer) can engage a listed partner: a research firm to run fieldwork and
 * surveys, or a white-label operator to launch and monitor a programme. The client chooses exactly what the partner can see and do
 * (named surveys or programmes, never customer or claims data). Fees are agreed on the engagement, and Dry Run takes a share of the
 * partner's fee, set by the platform owner. Statements are calculated from recorded figures; Dry Run does not collect or pay money.
 */
const reg = require('./registry');
const orgs = require('./orgs');
const live = require('./live');
const { err, iso, id, round } = require('./util');

const PARTNER_PACKS = { research_firm: 'researcher', operator: 'operator', security_firm: 'tester' };
const store = () => { const r = reg.load(); r.engagements = r.engagements || {}; return r.engagements; };
const isPartner = (o) => !!PARTNER_PACKS[o.pack];
const money = (x, lo, hi, name) => { const n = Number(x || 0); if (!(n >= lo && n <= hi)) throw err(422, `${name} must be between ${lo} and ${hi}.`); return n; };

function setPartnerProfile(orgId, { listed, description, services } = {}) {
  const o = orgs.raw(orgId); if (!isPartner(o)) throw err(422, 'Only research firm and operator organisations can be listed as partners.');
  o.partner = { ...(o.partner || {}), ...(listed !== undefined ? { listed: !!listed } : {}), ...(description !== undefined ? { description: String(description).slice(0, 500) } : {}), ...(services !== undefined ? { services: String(services).slice(0, 300) } : {}) }; reg.save(); return o.partner;
}
const partners = () => orgs.list().filter((o) => isPartner(o) && o.pack !== 'security_firm' && !o.suspended).map((o) => { const r = orgs.raw(o.id); return r.partner && r.partner.listed ? { id: o.id, name: o.name, kind: o.pack, role: PARTNER_PACKS[o.pack], description: r.partner.description || '', services: r.partner.services || '' } : null; }).filter(Boolean);

function create(clientId, actor, { partnerOrgId, scope = {}, fee = {}, note = '' } = {}) {
  const c = orgs.raw(clientId); if (isPartner(c)) throw err(422, 'Partner organisations cannot engage other partners.');
  const p = (() => { try { return orgs.raw(partnerOrgId); } catch { throw err(404, 'Unknown partner.'); } })();
  if (!isPartner(p) || !(p.partner && p.partner.listed) || p.suspended) throw err(422, 'That partner is not available.');
  if (p.pack === 'security_firm') throw err(422, 'Security firms are engaged from Security tests, not from the partner network.');
  const role = PARTNER_PACKS[p.pack]; const key = role === 'researcher' ? 'surveyIds' : 'liveIds';
  const ids = scope[key] === 'all' ? 'all' : Array.isArray(scope[key]) ? scope[key].map(String) : []; if (ids !== 'all' && !ids.length) throw err(422, role === 'researcher' ? 'Choose which surveys the researcher can work on, or all.' : 'Choose which live programmes the operator can run, or all.');
  const e = { id: id('eng'), clientOrgId: clientId, partnerOrgId, role, scope: { [key]: ids }, fee: { oneOff: money(fee.oneOff, 0, 1e9, 'One-off fee'), fixedPerMonth: money(fee.fixedPerMonth, 0, 1e9, 'Monthly fee'), commissionPct: money(fee.commissionPct, 0, 50, 'Commission %') }, note: String(note).slice(0, 500),
    platformSharePct: reg.load().config.partnerPlatformSharePct ?? 10, status: 'offered', offeredBy: actor.name, offeredAt: iso(), history: [{ at: iso(), by: actor.name, action: 'offered' }] };
  store()[e.id] = e; reg.save(); return view(e, 'client');
}
function view(e, side) {
  const c = orgs.raw(e.clientOrgId), p = orgs.raw(e.partnerOrgId); const { platformSharePct, ...rest } = e;
  return { ...(side === 'client' ? rest : e), side, clientName: c.name, partnerName: p.name, role: e.role };
}
const raw = (eid) => { const e = store()[eid]; if (!e) throw err(404, 'Unknown engagement.'); return e; };
function listFor(orgId) { return Object.values(store()).filter((e) => e.clientOrgId === orgId || e.partnerOrgId === orgId).sort((a, b) => b.offeredAt.localeCompare(a.offeredAt)).map((e) => view(e, e.clientOrgId === orgId ? 'client' : 'partner')); }
const listAll = () => Object.values(store()).sort((a, b) => b.offeredAt.localeCompare(a.offeredAt)).map((e) => view(e, 'platform'));
function respond(orgId, actor, eid, action) {
  const e = raw(eid); const log = (a) => { e.history.push({ at: iso(), by: actor.name, action: a }); reg.save(); return view(e, e.clientOrgId === orgId ? 'client' : 'partner'); };
  if (action === 'accept' || action === 'decline') { if (e.partnerOrgId !== orgId) throw err(403, 'Only the partner can answer an offer.'); if (e.status !== 'offered') throw err(409, 'This offer has already been answered.'); e.status = action === 'accept' ? 'active' : 'declined'; if (action === 'accept') e.acceptedAt = iso(); return log(action === 'accept' ? 'accepted' : 'declined'); }
  if (action === 'end') { if (e.clientOrgId !== orgId && e.partnerOrgId !== orgId) throw err(403, 'Not your engagement.'); if (!['offered', 'active'].includes(e.status)) throw err(409, 'This engagement is already closed.'); e.status = 'ended'; e.endedAt = iso(); return log('ended'); }
  throw err(422, 'action must be accept, decline or end.');
}
function setShare(eid, pct) { const e = raw(eid); e.platformSharePct = money(pct, 0, 100, 'Share %'); reg.save(); return view(e, 'platform'); }
/** Resolve a partner member's access to a client's resources for one engagement. */
function access(partnerOrgId, member, eid, needRole) {
  const e = raw(eid); if (e.partnerOrgId !== partnerOrgId) throw err(403, 'This engagement belongs to another organisation.'); if (e.status !== 'active') throw err(409, 'This engagement is not active.'); if (needRole && e.role !== needRole) throw err(403, `This engagement is for ${e.role} work.`);
  const client = orgs.raw(e.clientOrgId), p = orgs.raw(partnerOrgId);
  return { e, clientId: e.clientOrgId, clientName: client.name, actor: { id: member.id, name: `${member.name} (${p.name})`, role: 'partner' } };
}
const inScope = (e, key, itemId) => e.scope[key] === 'all' || e.scope[key].includes(itemId);
function addScope(e, key, itemId) { if (e.scope[key] !== 'all' && !e.scope[key].includes(itemId)) { e.scope[key].push(itemId); reg.save(); } }

async function statement(orgId, eid, side) {
  const e = raw(eid); if (side !== 'platform' && e.clientOrgId !== orgId && e.partnerOrgId !== orgId) throw err(403, 'Not your engagement.');
  const lines = []; const f = e.fee; const start = (e.acceptedAt || e.offeredAt).slice(0, 7);
  if (e.status === 'offered' || e.status === 'declined') return { engagementId: e.id, lines, totals: { total: 0, platformShare: 0, partnerNet: 0 }, note: 'Nothing is due until the engagement is accepted.' };
  if (f.oneOff) lines.push({ period: start, item: 'One-off fee', base: null, amount: round(f.oneOff) });
  if (e.role === 'operator') {
    const progs = (await live.list(e.clientOrgId)).filter((p) => inScope(e, 'liveIds', p.id)); const months = new Set();
    for (const p of progs) for (const a of p.actuals) { months.add(a.period); if (f.commissionPct) lines.push({ period: a.period, item: `Commission on ${p.name}`, base: a.premiumCollected, amount: round(a.premiumCollected * f.commissionPct / 100) }); }
    if (f.fixedPerMonth) for (const m of [...months].sort()) lines.push({ period: m, item: 'Monthly operating fee', base: null, amount: round(f.fixedPerMonth) });
  } else if (f.fixedPerMonth) {
    const end = (e.endedAt || iso()).slice(0, 7); let [y, m] = start.split('-').map(Number); const [ey, em] = end.split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) { lines.push({ period: `${y}-${String(m).padStart(2, '0')}`, item: 'Monthly fee', base: null, amount: round(f.fixedPerMonth) }); m++; if (m > 12) { m = 1; y++; } }
  }
  lines.sort((a, b) => a.period.localeCompare(b.period)); const total = round(lines.reduce((s, l) => s + l.amount, 0)); const share = round(total * (e.platformSharePct || 0) / 100);
  const t = side === 'client' || (e.clientOrgId === orgId && side !== 'platform') ? { total } : { total, platformShare: share, partnerNet: round(total - share) };
  return { engagementId: e.id, lines, totals: t, note: 'Calculated from the figures recorded in Dry Run. This is a statement, not an invoice. Dry Run does not collect or pay money.' };
}
module.exports = { PARTNER_PACKS, isPartner, setPartnerProfile, partners, create, listFor, listAll, respond, setShare, access, inScope, addScope, statement };
