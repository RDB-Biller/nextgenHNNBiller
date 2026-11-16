'use strict';
/**
 * Product Lab. Pick a product type, enter a few parameters, and get a complete draft product with a first run.
 * Then iterate: change the parameters as a new version, make variations to run side by side, compare them, and keep an ideas board.
 * Everything it makes is a draft in the Library. It still passes the same gates (draft, dry run, shadow, approved) and the regulator check.
 */
const orgs = require('./orgs');
const plans = require('./plans');
const assets = require('./assets');
const engine = require('./engine');
const audit = require('./audit');
const regulatory = require('./regulatory');
const fin = require('./scenarios/financing');
const outcomes = require('./scenarios/outcomes');
const campaignSc = require('./scenarios/campaign');
const { err, iso, id, round } = require('./util');

const num = (key, label, def, min, max, help, unit) => ({ key, label, type: 'number', default: def, min, max, help, unit });
const txt = (key, label, def, help) => ({ key, label, type: 'text', default: def, help });
const sel = (key, label, def, options, help) => ({ key, label, type: 'select', default: def, options, help });

const HEALTH_BASE = (d) => [
  txt('name', 'Product name', d.name), num('monthlyPremium', 'Premium a month', d.premium, 5, 5000, 'What a member pays each month.', 'GHS'), num('annualCap', 'Most the plan pays in a year', d.cap, 100, 500000, 'The benefit cap per member per year.', 'GHS'),
  num('coPayPct', 'Co-payment', d.coPay, 0, 60, 'Share of each bill the member pays.', '%'), num('waitingDays', 'Waiting period', d.wait, 0, 400, 'Days before cover starts.', 'days'),
  sel('tierCount', 'Hospital tiers', String(d.tiers), [['2', '2 tiers'], ['3', '3 tiers']], 'Tier 1 is the cheapest to treat at.'), num('topTierCostMultiple', 'How much dearer the top tier is', d.top, 1.2, 6, 'For example 2.4 means the top tier costs 2.4 times Tier 1.', '×'),
  sel('memberChoice', 'Let members choose a tier option', 'yes', [['yes', 'Yes, with a different premium for each'], ['no', 'No, one standard option']], 'Lets members trade a lower premium for lower-tier hospitals, or pay more for a few higher-tier ones.'),
  txt('exclusions', 'Not covered (comma separated)', d.excl, 'Anything the plan will not pay for.'),
];
const TYPICAL = { outpatient_cover: [3, 140], inpatient_surgical: [0.25, 2600], maternity: [0.3, 2300], chronic_care: [4, 170], micro_health: [2, 70], family_plan: [5, 150] };
const HEALTH = {
  outpatient_cover: { label: 'Outpatient cover', summary: 'Consultations, medicines and tests without admission.', d: { name: 'Outpatient cover', premium: 70, cap: 1800, coPay: 0, wait: 30, tiers: 3, top: 2.4, excl: 'Cosmetic surgery, Dental whitening' } },
  inpatient_surgical: { label: 'Inpatient and surgical cover', summary: 'Admission, surgery and hospital stays.', d: { name: 'Inpatient and surgical cover', premium: 140, cap: 15000, coPay: 10, wait: 60, tiers: 3, top: 2.8, excl: 'Cosmetic surgery, Experimental treatment' } },
  maternity: { label: 'Maternity cover', summary: 'Antenatal care, delivery and newborn care.', d: { name: 'Maternity cover', premium: 95, cap: 6000, coPay: 0, wait: 270, tiers: 2, top: 2.2, excl: 'Fertility treatment' } },
  chronic_care: { label: 'Chronic condition care', summary: 'Regular care for conditions such as hypertension and diabetes.', d: { name: 'Chronic condition care', premium: 120, cap: 4500, coPay: 10, wait: 90, tiers: 2, top: 1.8, excl: 'Conditions not declared at sign-up' } },
  micro_health: { label: 'Micro health cover', summary: 'A low-premium basic plan for lower-income households.', d: { name: 'Micro health cover', premium: 25, cap: 600, coPay: 20, wait: 14, tiers: 2, top: 1.6, excl: 'Cosmetic surgery, Dental' } },
  family_plan: { label: 'Family plan', summary: 'One premium for a household.', d: { name: 'Family plan', premium: 180, cap: 9000, coPay: 5, wait: 30, tiers: 3, top: 2.4, excl: 'Cosmetic surgery' } },
};
function healthData(p, key) {
  const k = Number(p.tierCount) === 2 ? 2 : 3, top = Number(p.topTierCostMultiple); const mids = k === 3 ? [1, round(1 + (top - 1) * 0.4, 2), top] : [1, top];
  const hospitalTiers = mids.map((m, i) => ({ name: `T${i + 1}`, costMultiple: m })); const names = hospitalTiers.map((t) => t.name);
  const adj = k === 3 ? [-8, 0, 12] : [-8, 6]; const label = k === 3 ? ['Essential: Tier 1 hospitals', 'Choice: Tier 1 plus chosen Tier 2', 'Open: all hospitals'] : ['Essential: Tier 1 hospitals', 'Open: all hospitals'];
  const options = p.memberChoice === 'yes' ? names.slice(k === 3 ? 0 : 0).map((_, i) => ({ name: label[i], tiers: names.slice(0, k === 3 ? i + 1 : i + 1), premiumAdjPct: adj[i] })) : [];
  return { name: p.name, currency: 'GHS', premium: Number(p.monthlyPremium), benefitCap: Number(p.annualCap), coPayPct: Number(p.coPayPct), waitingDays: Number(p.waitingDays), typical: TYPICAL[key] ? { claimsPerMemberYear: TYPICAL[key][0], medianClaimCost: TYPICAL[key][1] } : undefined, exclusions: String(p.exclusions || '').split(',').map((x) => x.trim()).filter(Boolean), hospitalTiers, options };
}
const ARCH = {};
for (const [key, h] of Object.entries(HEALTH)) ARCH[key] = { key, label: h.label, summary: h.summary, packs: ['insurer'], kind: 'product', params: HEALTH_BASE(h.d), build: (p) => healthData(p, key), scenario: 'plan_options', input: 'product' };
ARCH.cashback_loyalty = { key: 'cashback_loyalty', label: 'Loyalty cashback or discount', summary: 'Reward members for a qualifying action, such as renewing early or using a partner clinic.', packs: ['insurer'], kind: 'campaign', scenario: 'campaign', input: 'campaign',
  params: [txt('name', 'Programme name', 'Loyalty cashback'), num('cashbackPct', 'Reward', 5, 0, 30, 'Cashback or discount as a share of the premium.', '%'), num('monthlyPremium', 'Premium a month', 70, 5, 5000, '', 'GHS'), num('marginPct', 'Your margin on the premium', 22, 0, 80, '', '%'), num('budget', 'Budget', 2000, 100, 1000000, 'Most you will spend contacting people.', 'GHS'), sel('segment', 'Who it is for', 'member', [['member', 'Current members'], ['prospect', 'New prospects'], ['lapsed', 'Lapsed members'], ['all', 'Everyone']], '')],
  build: (p) => ({ ...campaignSc.DEFAULT_CAMPAIGN(), name: p.name, audience: { segment: p.segment, minAge: 18, maxAge: 70, regions: [] }, offer: { discountPct: Number(p.cashbackPct) }, product: { monthlyPremium: Number(p.monthlyPremium), marginPct: Number(p.marginPct), firstYearRetentionPct: 75 }, budget: Number(p.budget) }) };
ARCH.outcomes_care = { key: 'outcomes_care', label: 'Outcomes-based care programme', summary: 'Pay providers by how their own patients do, for hypertension, diabetes or high cholesterol.', packs: ['insurer'], kind: 'outcomes_programme', scenario: 'outcomes_based_care', input: 'outcomes_programme',
  params: [txt('name', 'Programme name', 'Outcomes-based care'), sel('condition', 'Condition', 'hypertension', [['hypertension', 'Hypertension'], ['diabetes', 'Diabetes'], ['dyslipidemia', 'High cholesterol']], ''), num('controlWeight', 'Weight on getting the condition under control', 40, 0, 100, 'Out of 100 across all measures.', '%'), num('adherenceWeight', 'Weight on follow-up and medicine adherence', 25, 0, 100, '', '%'), num('screeningWeight', 'Weight on screening', 10, 0, 100, '', '%'), num('complicationWeight', 'Weight on fewer complications', 25, 0, 100, '', '%'), num('bonusMaxPct', 'Largest bonus', 10, 0, 30, 'As a share of the base fee.', '%'), num('penaltyMaxPct', 'Largest reduction', 6, 0, 20, 'As a share of the base fee.', '%'), num('cashback', 'Patient cashback a year for staying in control', 8, 0, 200, '0 to switch it off.', 'GHS')],
  build: (p) => { const b = Number(p.bonusMaxPct), pn = Number(p.penaltyMaxPct); return { name: p.name, condition: p.condition, weights: { control: Number(p.controlWeight), adherence: Number(p.adherenceWeight), screening: Number(p.screeningWeight), complications: Number(p.complicationWeight) }, bands: [{ minScore: 80, adjPct: b }, { minScore: 65, adjPct: round(b / 2, 1) }, { minScore: 50, adjPct: 0 }, { minScore: 35, adjPct: -round(pn / 2, 1) }, { minScore: 0, adjPct: -pn }], patientCashback: { enabled: Number(p.cashback) > 0, amount: Number(p.cashback) } }; } };
ARCH.instalment_overdraft = { key: 'instalment_overdraft', label: 'Instalment premium with overdraft', summary: 'Premium paid in instalments by auto-debit, with an overdraft when the wallet is short.', packs: ['fintech'], kind: 'finance_offer', scenario: 'premium_financing', input: 'finance_offer',
  params: [txt('name', 'Offer name', 'Instalment premium with overdraft'), sel('installments', 'Instalments a year', '4', [['2', 'Twice a year'], ['4', 'Quarterly'], ['12', 'Monthly']], ''), num('loadingPct', 'Loading for paying in instalments', 6, 0, 25, 'Extra the customer pays because the money comes later.', '%'), num('feePct', 'Overdraft fee', 3, 0, 15, 'Charged on each advance.', '%'), num('termDays', 'Days to repay', 30, 7, 120, '', 'days'), num('limitMultiple', 'Overdraft limit', 1, 0.25, 3, 'As a multiple of one instalment.', '×'), num('eligibleSharePct', 'Customers eligible', 65, 5, 100, 'Share with enough wallet history.', '%')],
  build: (p) => ({ ...fin.DEFAULT_OFFER(), name: p.name, coverCash: { ...fin.DEFAULT_OFFER().coverCash, enabled: false }, premiumOverdraft: { enabled: true, installments: Number(p.installments), loadingPct: Number(p.loadingPct), feePct: Number(p.feePct), termDays: Number(p.termDays), limitMultiple: Number(p.limitMultiple), eligibleSharePct: Number(p.eligibleSharePct) } }) };
ARCH.cover_cash = { key: 'cover_cash', label: 'Cash for co-payments and uncovered services', summary: 'Short advances for co-payments and services the plan does not cover.', packs: ['fintech'], kind: 'finance_offer', scenario: 'copay_cash', input: 'finance_offer',
  params: [txt('name', 'Offer name', 'Cover cash'), num('feePct', 'Fee', 6, 0, 20, 'Charged on each advance.', '%'), num('repayDays', 'Days to repay', 30, 7, 120, '', 'days'), num('maxAdvance', 'Largest advance', 800, 50, 10000, '', 'GHS')],
  build: (p) => ({ ...fin.DEFAULT_OFFER(), name: p.name, premiumOverdraft: { ...fin.DEFAULT_OFFER().premiumOverdraft, enabled: false }, coverCash: { enabled: true, feePct: Number(p.feePct), repayDays: Number(p.repayDays), maxAdvance: Number(p.maxAdvance) } }) };

const forPack = (pack) => Object.values(ARCH).filter((a) => a.packs.includes(pack));
const publicArch = (a) => ({ key: a.key, label: a.label, summary: a.summary, kind: a.kind, scenario: a.scenario, params: a.params });
function archetypes(orgId) { const o = orgs.raw(orgId); return forPack(o.pack).map(publicArch); }
function arch(orgId, key) { const o = orgs.raw(orgId); const a = ARCH[key]; if (!a || !a.packs.includes(o.pack)) throw err(404, 'That product type is not offered to your organisation.'); return a; }
function cleanParams(a, input = {}) {
  const out = {}; for (const f of a.params) {
    let v = input[f.key]; if (v === undefined || v === '' || v === null) v = f.default;
    if (f.type === 'number') { v = Number(v); if (!Number.isFinite(v)) throw err(422, `${f.label} must be a number.`); if (v < f.min || v > f.max) throw err(422, `${f.label} must be between ${f.min} and ${f.max}.`); }
    else if (f.type === 'select') { if (!f.options.some(([val]) => String(val) === String(v))) throw err(422, `Pick one of the choices for ${f.label}.`); v = String(v); }
    else { v = String(v).trim().slice(0, 140); if (f.key === 'name' && !v) throw err(422, 'Give it a name.'); }
    out[f.key] = v;
  } return out;
}
const SUGGEST = [
  { label: 'Lower the premium by 8%', changes: { premiumPct: -8 } }, { label: 'Raise the yearly cap by 25%', changes: { capPct: 25 } }, { label: 'Add a 10% co-payment', changes: { coPayPct: 10 } }, { label: 'Halve the waiting period', changes: { waitingFactor: 0.5 } },
];
function describeAny(kind, d) {
  if (kind === 'product') return describeProduct(d);
  if (kind === 'outcomes_programme') return { rows: [['Condition', d.condition], ['Score weights', Object.entries(d.weights).map(([k, v]) => `${k} ${v}`).join(', ')], ['Pay bands', d.bands.map((b) => `score ${b.minScore}+: ${b.adjPct > 0 ? '+' : ''}${b.adjPct}%`).join('; ')], ['Patient cashback', d.patientCashback && d.patientCashback.enabled ? `${d.patientCashback.amount} a year` : 'None']] };
  if (kind === 'campaign') return { rows: [['Audience', d.audience.segment], ['Reward', `${d.offer.discountPct}% of the premium`], ['Premium a month', d.product.monthlyPremium], ['Budget', d.budget]] };
  if (kind === 'finance_offer') { const rows = []; const po = d.premiumOverdraft, cc = d.coverCash; if (po && po.enabled !== false) rows.push(['Instalments', `${po.installments} a year, ${po.loadingPct}% loading`], ['Overdraft', `${po.feePct}% fee for ${po.termDays} days, limit ${po.limitMultiple}× an instalment`]); if (cc && cc.enabled !== false) rows.push(['Cash advances', `${cc.feePct}% fee for ${cc.repayDays} days, up to ${cc.maxAdvance}`]); return { rows }; }
  return null;
}
function describeProduct(d) { return { name: d.name, premium: d.premium, benefitCap: d.benefitCap, coPayPct: d.coPayPct, waitingDays: d.waitingDays, tiers: d.hospitalTiers.map((t) => `${t.name} (${t.costMultiple}×)`), options: (d.options || []).map((o) => `${o.name} (${o.premiumAdjPct > 0 ? '+' : ''}${o.premiumAdjPct}%)`), exclusions: d.exclusions }; }

/** Build the data from parameters without saving anything, so the form can show what it would make. */
function preview(orgId, key, params) { const a = arch(orgId, key); const p = cleanParams(a, params); const data = a.build(p); return { params: p, data, summary: describeAny(a.kind, data) }; }

async function generate(orgId, actor, role, { archetype, params, note } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot create products.');
  const a = arch(orgId, archetype); const p = cleanParams(a, params); const data = { ...a.build(p), archetype: a.key, generatedFrom: p };
  const asset = await assets.create(orgId, actor, { kind: a.kind, name: p.name, description: `Made in Product Lab from "${a.label}".`, tags: ['product-lab', a.key], data, note: note || 'Generated in Product Lab' });
  const rec = await adapter(orgId).get(orgId, 'assets', asset.id); rec.card.lab = { archetype: a.key, root: asset.id }; await adapter(orgId).put(orgId, 'assets', asset.id, rec);
  let run = null, runNote = null;
  if (orgs.can(role, 'run')) { try { run = await engine.run(orgId, actor, role, { scenario: a.scenario, name: `${p.name}: first run`, inputs: { [a.input]: { assetId: asset.id } }, params: {} }); } catch (e) { runNote = `The first run was skipped: ${e.message}`; } }
  await audit.log(orgId, actor, 'lab.generate', { assetId: asset.id, archetype: a.key });
  return { asset: await assets.detail(orgId, asset.id, {}), run, runNote, summary: describeAny(a.kind, data), suggestions: a.kind === 'product' ? SUGGEST : [], nextSteps: ['Read the first run. Check the loss ratio against your target.', 'Make a few variations and compare them side by side.', 'When one looks right, move it through the gates: dry run, shadow, then approved.'] };
}
const adapter = (orgId) => audit.adapter(orgId);

/** Change the parameters of a product as a NEW VERSION of the same asset. */
async function regenerate(orgId, actor, role, assetId, params, note) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot change products.');
  const { asset, version } = await assets.versionData(orgId, assetId); const key = version.data.archetype; const a = arch(orgId, key); const p = cleanParams(a, { ...(version.data.generatedFrom || {}), ...params, name: params && params.name ? params.name : asset.name });
  const data = { ...a.build(p), archetype: a.key, generatedFrom: p }; const r = await assets.addVersion(orgId, actor, assetId, { data, note: note || 'Parameters changed in Product Lab' });
  await audit.log(orgId, actor, 'lab.regenerate', { assetId }); return r;
}
/** Copy a product into a new one with a few changes, so several can be run side by side. */
async function variation(orgId, actor, role, assetId, { name, changes = {} } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot create variations.');
  const { asset, version } = await assets.versionData(orgId, assetId); if (asset.kind !== 'product') throw err(422, 'Variations are for products.');
  const d = JSON.parse(JSON.stringify(version.data)); const c = changes; const bits = [];
  const setN = (field, val, label) => { if (val !== undefined && val !== null && val !== '' && Number(val) !== d[field]) { d[field] = round(Number(val), 2); bits.push(`${label} ${d[field]}`); } };
  if (c.premiumPct !== undefined) { d.premium = round(d.premium * (1 + Number(c.premiumPct) / 100), 2); bits.push(`premium ${Number(c.premiumPct) > 0 ? '+' : ''}${c.premiumPct}%`); } else setN('premium', c.premium, 'premium');
  if (c.capPct !== undefined) { d.benefitCap = Math.round(d.benefitCap * (1 + Number(c.capPct) / 100)); bits.push(`cap ${Number(c.capPct) > 0 ? '+' : ''}${c.capPct}%`); } else setN('benefitCap', c.benefitCap, 'cap');
  setN('coPayPct', c.coPayPct, 'co-pay'); if (c.waitingFactor !== undefined) { d.waitingDays = Math.round(d.waitingDays * Number(c.waitingFactor)); bits.push(`waiting ${d.waitingDays} days`); } else setN('waitingDays', c.waitingDays, 'waiting');
  if (!bits.length) throw err(422, 'Change at least one thing.'); if (d.premium <= 0 || d.benefitCap <= 0 || d.coPayPct < 0 || d.coPayPct > 100 || d.waitingDays < 0) throw err(422, 'Those changes give values that do not make sense.');
  const root = (asset.card.lab && asset.card.lab.root) || asset.id; const vname = String(name || `${asset.name.replace(/ · .*$/, '')} · ${bits.join(', ')}`).slice(0, 140); d.name = vname; if (d.generatedFrom) d.generatedFrom = { ...d.generatedFrom, name: vname, monthlyPremium: d.premium, annualCap: d.benefitCap, coPayPct: d.coPayPct, waitingDays: d.waitingDays };
  const na = await assets.create(orgId, actor, { kind: 'product', name: vname, description: `Variation of "${asset.name}": ${bits.join(', ')}.`, tags: ['product-lab', 'variation'], data: d, note: `Variation of ${asset.name} v${version.v}` });
  const rec = await adapter(orgId).get(orgId, 'assets', na.id); rec.card.lab = { archetype: d.archetype || null, root, derivedFrom: asset.id, changes: bits }; await adapter(orgId).put(orgId, 'assets', na.id, rec);
  const cls = regulatory.classify(version.data, d, o.regulatoryRules); await audit.log(orgId, actor, 'lab.variation', { from: assetId, to: na.id });
  return { asset: await assets.detail(orgId, na.id, {}), changes: bits, regulatory: { overall: cls.overall, summary: cls.summary } };
}
async function family(orgId, assetId) {
  const all = await assets.list(orgId, 'product'); const me = all.find((x) => x.id === assetId); if (!me) throw err(404, 'Unknown product.'); const root = (me.card.lab && me.card.lab.root) || me.id;
  return all.filter((x) => x.id === root || (x.card.lab && x.card.lab.root === root)).map((x) => ({ id: x.id, name: x.name, latest: x.latest, latestGate: x.latestGate, changes: x.card.lab && x.card.lab.changes || [], isRoot: x.id === root, derivedFrom: x.card.lab && x.card.lab.derivedFrom || null }));
}
/** Run the same scenario on each product and compare. Also says what each needs from the regulator, against the first one. */
async function compareProducts(orgId, actor, role, assetIds, params = {}) {
  if (!Array.isArray(assetIds) || assetIds.length < 2) throw err(422, 'Pick at least two products to compare.'); if (assetIds.length > 6) throw err(422, 'Compare up to six at a time.');
  const o = orgs.raw(orgId); const runIds = [], cls = []; let first = null;
  for (const aid of assetIds) {
    const { asset, version } = await assets.versionData(orgId, aid); if (asset.kind !== 'product') throw err(422, `${asset.name} is not a product.`);
    const r = await engine.run(orgId, actor, role, { scenario: 'plan_options', name: asset.name, inputs: { product: { assetId: aid } }, params, seed: 1 }); runIds.push(r.id);
    if (!first) first = version.data; const c = regulatory.classify(first, version.data, o.regulatoryRules); cls.push({ assetId: aid, name: asset.name, overall: aid === assetIds[0] ? 'baseline' : c.overall, summary: aid === assetIds[0] ? 'The one the others are measured against.' : c.summary });
  }
  return { comparison: await engine.compare(orgId, runIds), regulatory: cls, runIds };
}
// ---- ideas board ----
async function ideas(orgId, memberId) { return (await adapter(orgId).list(orgId, 'ideas')).sort((a, b) => (b.votes.length - a.votes.length) || b.createdAt.localeCompare(a.createdAt)).map((i) => ({ ...i, votes: i.votes.length, voted: i.votes.includes(memberId) })); }
async function addIdea(orgId, actor, { title, problem, whoBenefits, proposal, archetype } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); const t = String(title || '').trim().slice(0, 140); if (!t) throw err(422, 'Give the idea a title.'); if (!String(proposal || '').trim()) throw err(422, 'Say what you would change.');
  const rec = { id: id('ida'), title: t, problem: String(problem || '').slice(0, 800), whoBenefits: String(whoBenefits || '').slice(0, 300), proposal: String(proposal).slice(0, 1500), archetype: archetype && ARCH[archetype] ? archetype : null, by: actor.name, byId: actor.id, createdAt: iso(), status: 'open', votes: [actor.id], assetId: null };
  await adapter(orgId).put(orgId, 'ideas', rec.id, rec); await audit.log(orgId, actor, 'idea.add', { ideaId: rec.id }); return rec;
}
async function getIdea(orgId, iid) { const i = await adapter(orgId).get(orgId, 'ideas', iid); if (!i) throw err(404, 'Unknown idea.'); return i; }
async function vote(orgId, actor, iid) { const i = await getIdea(orgId, iid); if (i.status !== 'open') throw err(409, 'This idea is closed.'); const at = i.votes.indexOf(actor.id); if (at >= 0) i.votes.splice(at, 1); else i.votes.push(actor.id); await adapter(orgId).put(orgId, 'ideas', iid, i); return { votes: i.votes.length, voted: at < 0 }; }
async function promote(orgId, actor, role, iid, { archetype, params } = {}) {
  const i = await getIdea(orgId, iid); if (i.status !== 'open') throw err(409, 'This idea is closed.'); if (!orgs.can(role, 'write')) throw err(403, 'Your role cannot do that.');
  const g = await generate(orgId, actor, role, { archetype: archetype || i.archetype, params: { name: i.title, ...(params || {}) }, note: `From idea: ${i.title}` });
  i.status = 'promoted'; i.assetId = g.asset.id; i.promotedBy = actor.name; await adapter(orgId).put(orgId, 'ideas', iid, i); return { idea: i, ...g };
}
async function closeIdea(orgId, actor, iid) { const i = await getIdea(orgId, iid); i.status = 'closed'; await adapter(orgId).put(orgId, 'ideas', iid, i); return i; }
module.exports = { archetypes, preview, generate, regenerate, variation, family, compareProducts, ideas, addIdea, vote, promote, closeIdea };
