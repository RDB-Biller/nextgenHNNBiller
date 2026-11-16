'use strict';
/**
 * Proposals link two organisations. A fintech designs and tests a facility, then puts it to an insurer (or an insurer asks a fintech for one).
 * The other side sees a snapshot of the design and the evidence, never the proposer's data. When the recipient accepts, the design lands in their
 * library as a draft they can run for themselves. The platform owner can introduce the two sides, names a launch partner, and records its fees.
 */
const reg = require('./registry');
const orgs = require('./orgs');
const plans = require('./plans');
const assets = require('./assets');
const engine = require('./engine');
const { err, iso, id } = require('./util');

const store = () => { const r = reg.load(); r.proposals = r.proposals || {}; return r.proposals; };
const orgByRef = (ref) => ref ? Object.values(reg.load().orgs).find((o) => o.id.slice(4, 12) === String(ref).trim()) || null : null;
const fees = () => { const c = reg.load().config; return { linkFeePct: c.linkFeePct ?? 5, launchCommissionPct: c.launchCommissionPct ?? 10 }; };
const KINDS = ['offer', 'request'];

function describeRun(rec) {
  const h = rec.headline || {}, r = rec.result || {};
  if (rec.scenario === 'premium_financing') return `Paying the premium in ${r.installments} instalments with an automatic overdraft: lapses fall from ${r.lapsePctWithoutOverdraft}% to ${r.lapsePct}%, ${r.extraMembersReached} more customers are reached than with an upfront premium, and the customer pays ${r.customerExtraCostPct}% of the premium extra.`;
  if (rec.scenario === 'copay_cash') return `Cash for co-payments and uncovered services: ${h.advances} advances, ${r.extraServicesEnabled} extra uncovered services made possible for providers, credit loss ${r.creditLossPctOfAdvances}% of advances.`;
  return `${rec.name}: ${Object.entries(h).map(([k, v]) => `${k} ${v}`).join(', ')}.`;
}
async function snapshot(orgId, assetId, version, runIds) {
  let terms = null, termsRef = null;
  if (assetId) { const { asset, version: v } = await assets.versionData(orgId, assetId, version); if (asset.kind !== 'finance_offer') throw err(422, 'Choose a finance offer to put forward.'); terms = JSON.parse(JSON.stringify(v.data)); termsRef = { name: asset.name, version: v.v, gate: v.gate }; }
  const evidence = []; for (const rid of runIds || []) { const rec = await engine.getRun(orgId, rid); evidence.push({ runId: rid, scenario: rec.scenario, name: rec.name, at: rec.at, headline: rec.headline, finding: describeRun(rec), assumptions: rec.result && rec.result.assumptions ? rec.result.assumptions : null, caution: rec.result && rec.result.caution || null, syntheticInputs: Object.values(rec.inputs || {}).some((x) => x && x.synthetic) }); }
  return { terms, termsRef, evidence };
}
/** A suggested proposal from a design and its runs. The person edits it before sending. */
async function suggest(orgId, { assetId, version, runIds } = {}) {
  if (!assetId) throw err(422, 'Choose the finance offer you want to propose.');
  const s = await snapshot(orgId, assetId, version, runIds || []); const o = orgs.raw(orgId);
  const bits = []; if (s.terms.premiumOverdraft && s.terms.premiumOverdraft.enabled !== false) bits.push(`pay the premium in ${s.terms.premiumOverdraft.installments} instalments, with an overdraft raised automatically when the wallet is short on the debit date`); if (s.terms.coverCash && s.terms.coverCash.enabled !== false) bits.push('short cash advances for co-payments and services the plan does not cover');
  return { kind: 'offer', title: `Instalment premium and cover cash from ${o.name}`, summary: `We propose that your customers can ${bits.join(', and ')}.\n\n${s.evidence.map((e) => e.finding).join('\n')}${s.evidence.length ? '' : 'Run the design first so the proposal carries evidence.'}\n\nThe results come from a simulation with stated assumptions. We suggest a small pilot to replace them with real figures.`, terms: s.terms, evidence: s.evidence, termsRef: s.termsRef };
}
async function create(orgId, actor, role, body = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); plans.assertNotDemo(o, 'Sending proposals'); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot send proposals.');
  const kind = KINDS.includes(body.kind) ? body.kind : 'offer'; const title = String(body.title || '').trim().slice(0, 140), summary = String(body.summary || '').trim().slice(0, 4000);
  if (!title) throw err(422, 'Give the proposal a title.'); if (!summary) throw err(422, 'Say what you are proposing.');
  let snap = { terms: null, termsRef: null, evidence: [] }; if (kind === 'offer') { if (!body.assetId) throw err(422, 'Choose the finance offer to put forward.'); snap = await snapshot(orgId, body.assetId, body.version, body.runIds || []); if (!snap.evidence.length) throw err(422, 'Attach at least one run so the other side can see the evidence.'); }
  const to = body.to ? orgByRef(body.to) : null; if (body.to && !to) throw err(422, 'That partner code was not recognised. Ask them for the code in their Settings, or leave it empty and we will introduce you.'); if (to && to.id === orgId) throw err(422, 'That is your own code.'); if (to) plans.assertWritable(to);
  const lp = body.launchPartner === 'platform' ? { kind: 'platform', name: 'The platform' } : { kind: 'none' };
  const p = { id: id('prp'), kind, fromOrgId: orgId, fromName: o.name, toOrgId: to ? to.id : null, toName: to ? to.name : null, status: to ? 'sent' : 'awaiting_introduction', title, summary, terms: snap.terms, termsRef: snap.termsRef, evidence: snap.evidence,
    launchPartner: lp, fees: fees(), thread: [{ at: iso(), by: actor.name, org: o.name, action: 'sent', text: summary.slice(0, 300) }], createdAt: iso(), createdBy: actor.name };
  store()[p.id] = p; reg.save(); return p;
}
const view = (p, orgId) => ({ ...p, side: p.fromOrgId === orgId ? 'sent' : 'received', fees: p.fees });
function listFor(orgId) { return Object.values(store()).filter((p) => p.fromOrgId === orgId || (p.toOrgId === orgId && p.status !== 'awaiting_introduction')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((p) => view(p, orgId)); }
const pendingFor = (orgId) => Object.values(store()).filter((p) => p.toOrgId === orgId && p.status === 'sent').length;
function get(orgId, pid) { const p = store()[pid]; if (!p || (p.fromOrgId !== orgId && p.toOrgId !== orgId) || (p.toOrgId === orgId && p.status === 'awaiting_introduction')) throw err(404, 'Unknown proposal.'); return p; }
async function respond(orgId, actor, role, pid, { action, note } = {}) {
  const p = get(orgId, pid); const o = orgs.raw(orgId); const mine = p.fromOrgId === orgId; const text = String(note || '').trim().slice(0, 1000);
  if (['accepted', 'declined', 'withdrawn'].includes(p.status)) throw err(409, 'This proposal is closed.');
  if (action === 'reply') { if (!text) throw err(422, 'Write a message.'); }
  else if (action === 'withdraw') { if (!mine) throw err(403, 'Only the sender can withdraw it.'); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot do that.'); p.status = 'withdrawn'; }
  else if (action === 'accept' || action === 'decline') {
    if (mine) throw err(403, 'The other side decides.'); if (!orgs.can(role, 'approve')) throw err(403, 'Only an approver or admin can accept or decline a proposal.'); plans.assertNotDemo(o, 'Answering proposals');
    if (action === 'decline') p.status = 'declined';
    else { p.status = 'accepted'; p.acceptedAt = iso(); if (p.terms) { const a = await assets.create(orgId, actor, { kind: 'finance_offer', name: `Proposal: ${p.title}`, description: `Received from ${p.fromName}`, data: p.terms, note: `Accepted proposal from ${p.fromName}. Run it on your own data before approving.` }); p.importedAssetId = a.id; } }
  } else throw err(422, 'action must be reply, accept, decline or withdraw.');
  p.thread.push({ at: iso(), by: actor.name, org: o.name, action, text }); reg.save(); return view(p, orgId);
}
// ---- platform owner ----
const listAll = () => Object.values(store()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
function platformUpdate(pid, { toOrgId, launchPartner, linkFeePct, launchCommissionPct, status, note } = {}) {
  const p = store()[pid]; if (!p) throw err(404, 'Unknown proposal.');
  if (toOrgId) { const t = orgs.raw(toOrgId); if (t.id === p.fromOrgId) throw err(422, 'Cannot introduce an organisation to itself.'); p.toOrgId = t.id; p.toName = t.name; if (p.status === 'awaiting_introduction') p.status = 'sent'; p.thread.push({ at: iso(), by: 'platform owner', org: 'platform', action: 'introduced', text: `Introduced to ${t.name}.` }); }
  if (launchPartner) { const k = launchPartner.kind; if (!['none', 'platform', 'partner'].includes(k)) throw err(422, 'launchPartner.kind must be none, platform or partner.'); let lp = { kind: k }; if (k === 'platform') lp.name = 'The platform'; if (k === 'partner') { const t = orgs.raw(launchPartner.orgId); lp = { kind: 'partner', orgId: t.id, name: t.name }; } p.launchPartner = lp; p.thread.push({ at: iso(), by: 'platform owner', org: 'platform', action: 'launch_partner', text: k === 'none' ? 'No launch partner.' : `Launch partner: ${lp.name}.` }); }
  if (linkFeePct !== undefined) p.fees.linkFeePct = Number(linkFeePct); if (launchCommissionPct !== undefined) p.fees.launchCommissionPct = Number(launchCommissionPct);
  if (status) { if (!['launched', 'sent'].includes(status)) throw err(422, 'status can be set to launched.'); if (status === 'launched' && p.status !== 'accepted') throw err(409, 'Only an accepted proposal can be marked launched.'); p.status = status; if (status === 'launched') p.launchedAt = iso(); }
  if (note) p.thread.push({ at: iso(), by: 'platform owner', org: 'platform', action: 'note', text: String(note).slice(0, 500) });
  reg.save(); return p;
}
module.exports = { suggest, create, listFor, pendingFor, get, respond, listAll, platformUpdate, orgByRef };
