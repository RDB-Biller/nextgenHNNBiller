'use strict';
/**
 * Dry Run Live. Takes a version that has passed the gates and runs it for real, first as a capped beta cohort, then live for the first
 * year, while comparing what actually happens with what the Dry Run forecast. Dry Run does not move money or issue policies itself:
 * the organisation (or Dry Run as the managed operator, if agreed) records the actual figures each period, and the guardrails say when to pause.
 */
const orgs = require('./orgs');
const plans = require('./plans');
const assets = require('./assets');
const audit = require('./audit');
const engine = require('./engine');
const { err, iso, id, round } = require('./util');
const adapter = (orgId) => audit.adapter(orgId);
const STATUSES = ['planned', 'beta', 'live', 'paused', 'closed'];
const NEXT = { planned: ['beta'], beta: ['live', 'paused', 'closed'], live: ['paused', 'closed'], paused: ['beta', 'live', 'closed'], closed: [] };
const need = (role, a) => { if (!orgs.can(role, a)) throw err(403, 'Only an approver or admin can do this.'); };

async function create(orgId, actor, role, { name, productAssetId, version, forecastRunId, cohortCap, managed = false, startDate, guardrails = {} } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); need(role, 'approve'); if (!name || !productAssetId) throw err(422, 'Give the programme a name and pick a product.');
  const { asset, version: v } = await assets.versionData(orgId, productAssetId, version); if (asset.kind !== 'product') throw err(422, 'A live programme runs a product.');
  if (v.gate !== 'approved') throw err(409, 'Only an approved version can go live. Move it through the gates first.');
  if (v.classification && v.classification.overall === 'regulator' && !v.regulator) throw err(409, 'This version needs regulator approval first. Record the regulator reference on the version.');
  if (!(Number(cohortCap) > 0)) throw err(422, 'Set a cohort cap: the most members allowed in at the start.');
  let forecast = null; if (forecastRunId) { const run = await engine.getRun(orgId, forecastRunId); if (run.scenario !== 'plan_options') throw err(422, 'Pick a plan options run as the forecast.'); const r = run.result; forecast = { runId: run.id, runName: run.name, lossRatioPct: r.lossRatioPct, capReachedPct: r.capReachedPct, premiumPerMemberMonth: round(r.revenue / r.members / 12, 2), claimsPerMemberMonth: round(r.claimsPaid / r.members / 12, 2) }; }
  const g = { maxLossRatioPct: Number(guardrails.maxLossRatioPct ?? (forecast ? Math.ceil(forecast.lossRatioPct + 10) : 80)), maxCapReachedPct: Number(guardrails.maxCapReachedPct ?? 20), watchGapPts: Number(guardrails.watchGapPts ?? 8) };
  const p = { id: id('live'), name: String(name).slice(0, 120), status: 'planned', product: { assetId: asset.id, name: asset.name, version: v.v }, regulator: v.regulator || null, forecast, cohortCap: Number(cohortCap), managed: !!managed, serviceTerms: '', startDate: startDate || null, guardrails: g, actuals: [], decisions: [{ at: iso(), by: actor.name, action: 'created', note: `From ${asset.name} v${v.v}` }], createdAt: iso(), createdBy: actor.name };
  await adapter(orgId).put(orgId, 'live', p.id, p); await audit.log(orgId, actor, 'live.create', { liveId: p.id, product: asset.name, version: v.v }); return summarise(p);
}
function summarise(p) {
  const a = [...p.actuals].sort((x, y) => x.period.localeCompare(y.period)); const sum = (k) => a.reduce((s, x) => s + (Number(x[k]) || 0), 0); const last = a[a.length - 1];
  const prem = sum('premiumCollected'), claims = sum('claimsPaid'); const lr = prem ? 100 * claims / prem : null; const g = p.guardrails; const alerts = [];
  const capPct = last && last.members ? 100 * (Number(last.capReachedMembers) || 0) / last.members : null;
  if (last && last.members > p.cohortCap) alerts.push({ level: 'breach', text: `Members (${last.members}) are above the cohort cap of ${p.cohortCap}.` });
  if (lr !== null && lr > g.maxLossRatioPct) alerts.push({ level: 'breach', text: `Loss ratio ${round(lr, 1)}% is above your ${g.maxLossRatioPct}% guardrail. Consider pausing new sign-ups.` });
  if (capPct !== null && capPct > g.maxCapReachedPct) alerts.push({ level: 'breach', text: `${round(capPct, 1)}% of members have reached their cap, above your ${g.maxCapReachedPct}% guardrail.` });
  if (lr !== null && p.forecast && lr - p.forecast.lossRatioPct > g.watchGapPts && lr <= g.maxLossRatioPct) alerts.push({ level: 'watch', text: `Loss ratio is ${round(lr - p.forecast.lossRatioPct, 1)} points above the Dry Run forecast of ${p.forecast.lossRatioPct}%.` });
  if (last && (Date.now() - Date.parse(last.period + '-28')) > 45 * 86400000 && ['beta', 'live'].includes(p.status)) alerts.push({ level: 'watch', text: `The latest figures are for ${last.period}. A monthly review is due.` });
  if (['beta', 'live'].includes(p.status) && !a.length) alerts.push({ level: 'watch', text: 'No actual figures recorded yet.' });
  const health = alerts.some((x) => x.level === 'breach') ? 'breach' : alerts.length ? 'watch' : a.length ? 'on track' : 'no data';
  return { ...p, actuals: a, totals: { periods: a.length, premiumCollected: round(prem), claimsPaid: round(claims), lossRatioPct: lr === null ? null : round(lr, 1), margin: round(prem - claims), latestMembers: last ? last.members : 0, capReachedPct: capPct === null ? null : round(capPct, 1),
    forecastGapPts: lr !== null && p.forecast ? round(lr - p.forecast.lossRatioPct, 1) : null, projectedYearMargin: a.length ? round((prem - claims) / a.length * 12) : null }, alerts, health };
}
async function load(orgId, liveId) { const p = await adapter(orgId).get(orgId, 'live', liveId); if (!p) throw err(404, 'Unknown programme.'); return p; }
const list = async (orgId) => (await adapter(orgId).list(orgId, 'live')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summarise);
const get = async (orgId, liveId) => summarise(await load(orgId, liveId));
async function setStatus(orgId, actor, role, liveId, status, note = '') {
  const o = orgs.raw(orgId); plans.assertWritable(o); need(role, 'approve'); const p = await load(orgId, liveId);
  if (!STATUSES.includes(status)) throw err(422, `status must be one of ${STATUSES.join(', ')}.`); if (!NEXT[p.status].includes(status)) throw err(422, `A programme cannot go from ${p.status} to ${status}.`);
  if (status === 'live') { const s = summarise(p); if (!p.actuals.length) throw err(409, 'Run the beta first: record at least one period of actual figures before going live.'); if (s.health === 'breach') throw err(409, 'A guardrail is breached. Resolve it, or pause, before going live.'); }
  if (!note && ['paused', 'closed'].includes(status)) throw err(422, 'Say why in the note, so the record is clear.');
  p.decisions.push({ at: iso(), by: actor.name, action: `${p.status} → ${status}`, note }); p.status = status; if (status === 'beta' && !p.startDate) p.startDate = iso().slice(0, 10);
  await adapter(orgId).put(orgId, 'live', p.id, p); await audit.log(orgId, actor, 'live.status', { liveId, status, note }); return summarise(p);
}
async function addActuals(orgId, actor, role, liveId, rows) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot record figures.'); const p = await load(orgId, liveId); const list = Array.isArray(rows) ? rows : [rows];
  if (['planned', 'closed'].includes(p.status)) throw err(409, 'Start the beta before recording figures.');
  for (const r of list) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(r.period || ''))) throw err(422, 'Period must look like 2027-01.'); for (const k of ['members', 'premiumCollected', 'claimsPaid']) if (!(Number(r[k]) >= 0)) throw err(422, `${k} must be a number, zero or more.`);
    const row = { period: r.period, members: Number(r.members), premiumCollected: Number(r.premiumCollected), claimsPaid: Number(r.claimsPaid), capReachedMembers: Number(r.capReachedMembers) || 0, notes: String(r.notes || '').slice(0, 300), by: actor.name, at: iso() };
    const i = p.actuals.findIndex((x) => x.period === row.period); if (i >= 0) p.actuals[i] = row; else p.actuals.push(row); }
  await adapter(orgId).put(orgId, 'live', p.id, p); await audit.log(orgId, actor, 'live.actuals', { liveId, periods: list.map((x) => x.period) }); return summarise(p);
}
async function addNote(orgId, actor, role, liveId, note) { if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot add notes.'); if (!note) throw err(422, 'Write the note.'); const p = await load(orgId, liveId); p.decisions.push({ at: iso(), by: actor.name, action: 'note', note: String(note).slice(0, 500) }); await adapter(orgId).put(orgId, 'live', p.id, p); return summarise(p); }
/** Platform owner view across organisations, and the terms of the managed service. */
async function all() { const out = []; for (const o of orgs.list()) for (const p of await list(o.id)) out.push({ orgId: o.id, orgName: o.name, id: p.id, name: p.name, status: p.status, managed: p.managed, serviceTerms: p.serviceTerms, health: p.health, lossRatioPct: p.totals.lossRatioPct, members: p.totals.latestMembers, periods: p.totals.periods, alerts: p.alerts.length }); return out; }
async function setTerms(orgId, liveId, { managed, serviceTerms }) { const p = await load(orgId, liveId); if (managed !== undefined) p.managed = !!managed; if (serviceTerms !== undefined) p.serviceTerms = String(serviceTerms).slice(0, 1000); await adapter(orgId).put(orgId, 'live', p.id, p); return summarise(p); }
module.exports = { create, list, get, setStatus, addActuals, addNote, all, setTerms };
