'use strict';
/**
 * The engine runs a scenario against versions of an organisation's assets (or synthetic data), stores the run, compares runs,
 * and lets the Coach propose a better version. The Coach only ever drafts: a person must move the draft through the gates.
 */
const orgs = require('./orgs');
const plans = require('./plans');
const assets = require('./assets');
const audit = require('./audit');
const packs = require('./packs');
const synthetic = require('./scenarios/synthetic');
const planOpts = require('./scenarios/planOptions');
const campaignSc = require('./scenarios/campaign');
const regulatory = require('./regulatory');
const { err, iso, id, round } = require('./util');

const adapter = (orgId) => audit.adapter(orgId);
const DEFAULT_PLAN = { baselineDays: 30, tiers: [{ days: 14, discountPct: 10 }, { days: 1, discountPct: 15 }] };

function packScenario(o, key) {
  const pack = packs.get(o.pack); if (!pack || !pack.scenarios.includes(key)) throw err(422, `The ${pack ? pack.label : o.pack} pack does not offer the scenario "${key}".`);
  return packs.scenario(key);
}
async function resolve(orgId, ref, kind) {
  if (!ref || !ref.assetId) return null;
  const { asset, version } = await assets.versionData(orgId, ref.assetId, ref.version);
  if (asset.kind !== kind) throw err(422, `Asset ${asset.name} is a ${asset.kind}, not a ${kind}.`);
  return { assetId: asset.id, name: asset.name, version: version.v, gate: version.gate, data: version.data };
}
/** Gather the inputs for a scenario. Anything not supplied is filled with synthetic data and labelled as such. */
async function gather(orgId, scenario, inputs = {}, syntheticSpec = {}, seed) {
  const used = {}; const ref = (x) => ({ assetId: x.assetId, name: x.name, version: x.version });
  if (scenario === 'plan_options') {
    const pr = await resolve(orgId, inputs.product, 'product'); used.product = pr ? ref(pr) : { synthetic: true };
    return { product: pr ? pr.data : planOpts.DEFAULT_PRODUCT(), used };
  }
  if (scenario === 'campaign') {
    const cu = await resolve(orgId, inputs.customer_dataset, 'customer_dataset'); const cp = await resolve(orgId, inputs.campaign, 'campaign');
    used.customer_dataset = cu ? ref(cu) : { synthetic: true }; used.campaign = cp ? ref(cp) : { synthetic: true };
    return { customers: cu ? cu.data.customers : synthetic.customers(Number(syntheticSpec.customers || 3000), seed), campaign: cp ? cp.data : campaignSc.DEFAULT_CAMPAIGN(), used };
  }
  let syn = null; const ensure = () => (syn = syn || synthetic.build(Number(syntheticSpec.claims || 1500), seed));
  const claimsIn = await resolve(orgId, inputs.claims_dataset, 'claims_dataset');
  const claims = claimsIn ? claimsIn.data.claims : ensure().claims; used.claims_dataset = claimsIn ? ref(claimsIn) : { synthetic: true, claims: claims.length };
  const out = { claims, used };
  if (scenario === 'adjudication_ladder') {
    const rs = await resolve(orgId, inputs.rule_set, 'rule_set'); out.ruleSet = rs ? rs.data : synthetic.defaultRules(); used.rule_set = rs ? ref(rs) : { synthetic: true };
    const pb = await resolve(orgId, inputs.price_book, 'price_book'); out.priceBook = pb ? pb.data.items : (claimsIn && !pb ? [] : ensure().priceBook); used.price_book = pb ? ref(pb) : (claimsIn ? { none: true } : { synthetic: true });
  } else {
    const pp = await resolve(orgId, inputs.payment_plan, 'payment_plan'); out.plan = pp ? pp.data : DEFAULT_PLAN; used.payment_plan = pp ? ref(pp) : { synthetic: true };
  }
  return out;
}
function execute(scenario, g, params, seed) {
  const s = packs.scenario(scenario);
  if (scenario === 'plan_options') return s.engine.run({ product: g.product, params, seed });
  if (scenario === 'campaign') return s.engine.run({ customers: g.customers, campaign: g.campaign, params, seed });
  return scenario === 'adjudication_ladder' ? s.engine.run({ claims: g.claims, ruleSet: g.ruleSet, priceBook: g.priceBook, params, seed }) : s.engine.run({ claims: g.claims, plan: g.plan, params, seed });
}
async function monthRuns(orgId) { const m = iso().slice(0, 7); return (await adapter(orgId).list(orgId, 'runs')).filter((r) => r.at.startsWith(m)).length; }

async function run(orgId, actor, role, { scenario, name, inputs = {}, params = {}, seed = 1, synthetic: syn = {} } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o);
  if (!orgs.can(role, 'run')) throw err(403, 'Your role cannot run scenarios.');
  packScenario(o, scenario); plans.assertRoom(o, 'runsPerMonth', await monthRuns(orgId));
  const g = await gather(orgId, scenario, inputs, syn, seed); const result = execute(scenario, g, params, seed);
  const s = packs.scenario(scenario);
  const rec = { id: id('run'), scenario, name: name || `${s.label} run`, at: iso(), by: actor ? actor.name : 'platform owner', inputs: g.used, inputRefs: inputs, params, seed, syntheticSpec: syn, headline: s.engine.headline(result), result };
  await adapter(orgId).put(orgId, 'runs', rec.id, rec);
  await audit.log(orgId, actor, 'run.create', { runId: rec.id, scenario, inputs: g.used }); return rec;
}
const brief = (r) => ({ id: r.id, scenario: r.scenario, name: r.name, at: r.at, by: r.by, inputs: r.inputs, headline: r.headline, hasCoach: !!r.coach });
async function listRuns(orgId, scenario) { return (await adapter(orgId).list(orgId, 'runs')).filter((r) => !scenario || r.scenario === scenario).sort((a, b) => b.at.localeCompare(a.at)).map(brief); }
async function getRun(orgId, runId) { const r = await adapter(orgId).get(orgId, 'runs', runId); if (!r) throw err(404, 'Unknown run.'); return r; }

/** Compare runs of one scenario: each metric, its change from the first run, and whether that is better or worse. */
async function compare(orgId, runIds) {
  if (!Array.isArray(runIds) || runIds.length < 2) throw err(422, 'Pick at least two runs to compare.');
  const rs = []; for (const i of runIds) rs.push(await getRun(orgId, i));
  if (new Set(rs.map((r) => r.scenario)).size > 1) throw err(422, 'Runs from different scenarios cannot be compared.');
  const dir = packs.scenario(rs[0].scenario).engine.DIRECTION; const base = rs[0].headline;
  const metrics = Object.keys(base).map((k) => ({ metric: k, direction: dir[k] || 'info', values: rs.map((r) => { const v = r.headline[k]; const d = typeof v === 'number' && typeof base[k] === 'number' ? round(v - base[k], 2) : null; const verdict = d === null || d === 0 || (dir[k] || 'info') === 'info' ? 'same' : ((dir[k] === 'higher') === (d > 0) ? 'better' : 'worse'); return { runId: r.id, value: v, change: d, verdict }; }) }));
  return { scenario: rs[0].scenario, runs: rs.map((r) => ({ id: r.id, name: r.name, at: r.at, inputs: r.inputs, params: r.params })), metrics };
}

// ---- Coach ---------------------------------------------------------------------------------------------------------------------
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
function coachLadder(g, params, seed, base) {
  const ruleSet = g.ruleSet; const st = ruleSet.settings || {}; const maxMiss = st.maxMissRatePct ?? 0.5; const labelled = g.claims.some((c) => c.known_issue);
  const covered = new Set((ruleSet.rules || []).flatMap((r) => r.icdPrefixes || []));
  const clean = g.claims.filter((c) => c.eligible !== false && (!c.known_issue || c.known_issue === 'none'));
  const byDx = {}; for (const c of clean) (byDx[c.diagnosis] = byDx[c.diagnosis] || []).push(c.amount);
  const newRules = Object.entries(byDx).filter(([dx, a]) => a.length >= 20 && ![...covered].some((p) => dx.startsWith(p))).sort((a, b) => b[1].length - a[1].length).slice(0, 4)
    .map(([dx, a]) => ({ name: `${dx}: suggested routine rule`, icdPrefixes: [dx], maxAmount: round(q(a, 0.9) * 1.05, 0), suggested: true }));
  const cands = []; for (const withNew of [false, true]) for (const m of [0.75, 1, 1.25, 1.5, 2, 2.5, 3]) {
    if (withNew && !newRules.length) continue;
    const rules = [...(ruleSet.rules || []).map((r) => ({ ...r, maxAmount: round(r.maxAmount * m, 2) })), ...(withNew ? newRules : [])];
    const rs = { ...ruleSet, rules }; const res = require('./scenarios/adjudicationLadder').run({ claims: g.claims, ruleSet: rs, priceBook: g.priceBook, params, seed });
    cands.push({ ruleSet: rs, multiple: m, addedRules: withNew ? newRules.length : 0, autoPct: res.lanePct.auto, miss: res.calibration ? res.calibration.missRatePctOfAuto : null, leakage: res.estimatedLeakage });
  }
  const safe = cands.filter((c) => c.miss === null ? true : c.miss <= maxMiss).sort((a, b) => b.autoPct - a.autoPct || (a.miss ?? 0) - (b.miss ?? 0));
  const best = safe[0]; const baseAuto = base.lanePct.auto;
  if (!best || best.autoPct <= baseAuto) return { suggestions: [], message: `No safe improvement found within your guardrail (misses at most ${maxMiss}% of auto-approved claims). The current rules are already the best this search found.` };
  const changes = []; if (best.multiple !== 1) changes.push(`Scale every rule's maximum amount by ${best.multiple}x`); if (best.addedRules) changes.push(`Add auto-approve rules for: ${newRules.map((r) => `${r.icdPrefixes[0]} up to ${r.maxAmount}`).join(', ')}`);
  return { suggestions: [{ title: 'Raise auto-approval within your guardrail', changes, expected: { autoPct: { from: baseAuto, to: best.autoPct }, missRatePctOfAuto: { from: base.calibration ? base.calibration.missRatePctOfAuto : null, to: best.miss } },
    confidence: labelled ? 'Checked against your labelled issues' : 'Unverified: this data has no labelled issues, so misses cannot be measured. Treat as a starting point and check in shadow mode.',
    draft: { kind: 'rule_set', data: best.ruleSet } }], message: `Searched ${cands.length} combinations of rule limits and new rules.` };
}
function coachSettlement(g, params, seed, base) {
  const settle = require('./scenarios/expeditedSettlement'); const maxD = Number(params.maxDiscountPct ?? 15); const bd = g.plan.baselineDays || 30; const out = [];
  for (const days of [14, 7, 3, 1]) for (let d = 2; d <= maxD; d++) { const r = settle.run({ claims: g.claims, plan: { baselineDays: bd, tiers: [{ days, discountPct: d }] }, params, seed }); out.push({ days, discountPct: d, net: r.netBenefit, uptake: r.uptakePct }); }
  const best = [...out].sort((a, b) => b.net - a.net)[0]; const two = []; 
  for (const a of out.filter((x) => x.days >= 7)) for (const b of out.filter((x) => x.days <= 3)) { if (a.days <= b.days || a.discountPct >= b.discountPct) continue; const r = settle.run({ claims: g.claims, plan: { baselineDays: bd, tiers: [{ days: a.days, discountPct: a.discountPct }, { days: b.days, discountPct: b.discountPct }] }, params, seed }); two.push({ tiers: [{ days: a.days, discountPct: a.discountPct }, { days: b.days, discountPct: b.discountPct }], net: r.netBenefit, uptake: r.uptakePct }); }
  const best2 = two.sort((a, b) => b.net - a.net)[0]; const pick = best2 && best2.net > best.net ? { tiers: best2.tiers, net: best2.net, uptake: best2.uptake } : { tiers: [{ days: best.days, discountPct: best.discountPct }], net: best.net, uptake: best.uptake };
  if (pick.net <= base.netBenefit) return { suggestions: [], message: 'No better tier found than the current plan, within the maximum discount you set.' };
  return { suggestions: [{ title: 'Better early-pay tiers', changes: pick.tiers.map((t) => `Pay in ${t.days} days for ${t.discountPct}% off`), expected: { netBenefit: { from: base.netBenefit, to: pick.net }, uptakePct: { from: base.uptakePct, to: pick.uptake } },
    confidence: 'Based on assumed provider costs of funds. Confirm with real providers before offering.', draft: { kind: 'payment_plan', data: { baselineDays: bd, tiers: pick.tiers } } }], message: `Searched ${out.length + two.length} tier combinations up to ${maxD}% discount.` };
}
const LEVEL = { none: 0, notify: 1, regulator: 2 };
function coachPlanOptions(g, params, seed, base, rules) {
  const target = Number(params.targetLossRatioPct ?? 70); const fast = { ...params, members: Math.min(Number(params.members || 2000), 1500) }; const tiers = g.product.hospitalTiers.map((t) => t.name);
  const score = (r) => (r.lossRatioPct <= target ? r.margin : -1e9 - r.lossRatioPct); const baseScore = score(base);
  const search = (allowReg) => {
    let cur = JSON.parse(JSON.stringify(g.product)); let curRes = planOpts.run({ product: cur, params: fast, seed }); let curScore = score(curRes);
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < cur.options.length; i++) {
      const o0 = g.product.options[i]; let best = null;
      for (let k = 1; k <= tiers.length; k++) for (const d of [-9, -6, -3, 0, 3, 6, 9]) {
        const cand = JSON.parse(JSON.stringify(cur)); cand.options[i] = { ...o0, tiers: tiers.slice(0, k), premiumAdjPct: round((Number(o0.premiumAdjPct) || 0) + d, 1) };
        if (new Set(cand.options.map((x) => x.tiers.join())).size < cand.options.length) continue;
        const cls = regulatory.classify(g.product, cand, rules); if (!allowReg && LEVEL[cls.overall] > LEVEL.notify) continue;
        const res = planOpts.run({ product: cand, params: fast, seed }); const sc = score(res); if (!best || sc > best.sc) best = { cand, res, sc, cls };
      }
      if (best && best.sc > curScore) { cur = best.cand; curRes = best.res; curScore = best.sc; }
    }
    return { cur, curRes, curScore, cls: regulatory.classify(g.product, cur, rules) };
  };
  const out = []; const describe = (cur) => cur.options.map((o, i) => { const b = g.product.options[i]; const ch = []; if (o.premiumAdjPct !== b.premiumAdjPct) ch.push(`premium ${b.premiumAdjPct}% → ${o.premiumAdjPct}%`); if (o.tiers.join() !== b.tiers.join()) ch.push(`hospitals ${b.tiers.join('+')} → ${o.tiers.join('+')}`); return ch.length ? `${o.name}: ${ch.join(', ')}` : null; }).filter(Boolean);
  for (const allowReg of [false, true]) {
    const r = search(allowReg); if (r.curScore <= baseScore) continue; const changes = describe(r.cur); if (!changes.length) continue;
    if (out.length && JSON.stringify(out[0].draft.data) === JSON.stringify(r.cur)) continue;
    out.push({ title: allowReg ? 'A better result, but it needs regulator approval' : 'Improve the result without needing regulator approval', changes, expected: { lossRatioPct: { from: base.lossRatioPct, to: r.curRes.lossRatioPct }, margin: { from: base.margin, to: r.curRes.margin } },
      regulatory: { overall: r.cls.overall, summary: r.cls.summary }, confidence: 'Based on assumed choice and cost behaviour. Check with your survey and real claims by tier.', draft: { kind: 'product', data: r.cur } });
  }
  const msg = out.length ? 'Searched premium and hospital-tier combinations for every option. Each suggestion shows whether it needs the regulator.' : `No combination meets the ${target}% loss-ratio target better than the current setup, even with regulator-approval changes allowed.`;
  return { suggestions: out, message: msg };
}
function coachCampaign(g, params, seed, base, rules) {
  const c = g.campaign; const maxD = Math.min(Number(params.maxDiscountPct ?? regulatory.merge(rules).maxDiscountPct), 30); const chans = c.channels; let best = null; const evalIt = (camp) => campaignSc.run({ customers: g.customers, campaign: camp, params, seed });
  const subsets = []; for (let m = 1; m < (1 << chans.length); m++) subsets.push(chans.filter((_, i) => m & (1 << i)));
  for (const sub of subsets) for (let d = 0; d <= maxD; d++) { const camp = { ...c, channels: sub, offer: { ...(c.offer || {}), discountPct: d } }; const r = evalIt(camp); if (!best || r.margin > best.r.margin) best = { camp, r }; }
  if (!best || best.r.margin <= base.margin) return { suggestions: [], message: 'No better channel mix or discount found within the limit you set.' };
  const changes = []; if ((c.offer || {}).discountPct !== best.camp.offer.discountPct) changes.push(`Discount ${(c.offer || {}).discountPct || 0}% → ${best.camp.offer.discountPct}%`);
  if (best.camp.channels.length !== chans.length) changes.push(`Use only ${best.camp.channels.map((x) => x.channel).join(' and ')} (it returns more per cedi than the one dropped)`);
  return { suggestions: [{ title: 'Better offer and channel mix', changes: changes.length ? changes : ['Same offer and channels; spend is already well placed'], expected: { margin: { from: base.margin, to: best.r.margin }, roiPct: { from: base.roiPct, to: best.r.roiPct }, signups: { from: base.signups, to: best.r.signups } },
    confidence: 'Based on assumed response rates. Run a small live test and put the real rates in.', draft: { kind: 'campaign', data: best.camp } }], message: `Searched ${subsets.length * (maxD + 1)} offer and channel combinations up to ${maxD}% discount.` };
}
async function coach(orgId, actor, role, runId, { maxDiscountPct } = {}) {
  const o = orgs.raw(orgId); if (!orgs.can(role, 'run')) throw err(403, 'Your role cannot ask the Coach.'); plans.assertWritable(o);
  const rec = await getRun(orgId, runId); const params = { ...rec.params, ...(maxDiscountPct ? { maxDiscountPct } : {}) };
  const g = await gather(orgId, rec.scenario, rec.inputRefs, rec.syntheticSpec, rec.seed);
  const rules = o.regulatoryRules;
  const out = rec.scenario === 'adjudication_ladder' ? coachLadder(g, params, rec.seed, rec.result) : rec.scenario === 'plan_options' ? coachPlanOptions(g, params, rec.seed, rec.result, rules) : rec.scenario === 'campaign' ? coachCampaign(g, params, rec.seed, rec.result, rules) : coachSettlement(g, params, rec.seed, rec.result);
  rec.coach = { at: iso(), by: actor ? actor.name : 'platform owner', ...out }; await adapter(orgId).put(orgId, 'runs', rec.id, rec);
  await audit.log(orgId, actor, 'coach.suggest', { runId, found: out.suggestions.length }); return rec.coach;
}
/** Turn a suggestion into a new DRAFT version. It still has to pass the gates. */
async function applyCoach(orgId, actor, role, runId, index = 0) {
  if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot create versions.');
  const rec = await getRun(orgId, runId); const sug = rec.coach && rec.coach.suggestions[index]; if (!sug) throw err(404, 'No such suggestion. Ask the Coach first.');
  const kind = sug.draft.kind; const ref = rec.inputs[kind]; const note = `Coach suggestion from run "${rec.name}": ${sug.changes.join('; ')}`;
  const asset = ref && ref.assetId ? await assets.addVersion(orgId, actor, ref.assetId, { data: sug.draft.data, note }) : await assets.create(orgId, actor, { kind, name: `Coach: ${sug.title}`, description: note, data: sug.draft.data, note });
  await audit.log(orgId, actor, 'coach.apply', { runId, assetId: asset.id }); return { asset, message: 'Saved as a draft. Run it, then move it through the gates.' };
}

// ---- pace ----------------------------------------------------------------------------------------------------------------------
function pace(orgId) {
  const o = orgs.raw(orgId); const pack = packs.get(o.pack); if (!pack) throw err(404, 'Unknown pack.');
  return pack.scenarios.map((k) => { const s = packs.scenario(k); const steps = s.pace[o.pace]; return { scenario: k, label: s.label, pace: o.pace, steps: steps.map((t, i) => ({ step: i, text: t, done: !!(o.checklist[k] && o.checklist[k][i]) })) }; });
}
module.exports = { run, listRuns, getRun, compare, coach, applyCoach, pace, DEFAULT_PLAN };
