'use strict';

const crypto = require('crypto');
const store = require('../store');
const config = require('../config');
const messaging = require('./messaging');
const { notify } = require('./notifications');

/**
 * BirthPrep savings plans -- the "TrimesterSave" idea inside the biller.
 *
 * A hospital (the biller) enrols a patient on a savings plan towards a goal: the
 * delivery of a baby, an elective procedure, or anything else. The plan has a
 * horizon (9, 6 or 3 months, or "other": any number of months/years, or
 * open-ended) and milestones in time. What makes it intelligent:
 *
 *   - The TARGET is not a guess. For a delivery it comes from obstetric pathway
 *     rules: two previous caesarean sections mean a planned caesarean (a strict
 *     recommendation), hypertension in pregnancy opens the door to an expedited
 *     delivery at 32 weeks (steroids for lung maturity, NICU), 34 weeks, 36-37
 *     weeks or term, diabetes in pregnancy raises the chance of an earlier and/or
 *     caesarean delivery, and so on. Each scenario has a probability, a cost and
 *     an expected date; the target is the expected cost (or the most likely, or
 *     the worst case -- the product decides) plus a buffer.
 *   - The HISTORY informs it: the patient's previous bills on this platform
 *     (diagnoses such as "caesarean section", "pre-eclampsia", "GDM") and a short
 *     question-and-answer intake (biller, patient page or chatbot) feed the same
 *     clinical facts.
 *   - The plan is RE-PLANNED when facts change: a planned vaginal delivery that
 *     becomes a planned surgery raises the target and reshapes the remaining
 *     milestones, with an advisory to the patient; contributions already made are
 *     kept.
 *   - The SCHEDULE respects the earliest plausible need: with hypertension the last
 *     milestone falls before 34 weeks, not before the due date.
 *   - The GAP is bridged: whatever will not be saved by the deadline is shown as a
 *     possible InsureCredit micro-loan (up to the platform cap), and an offer can be
 *     created the moment a delivery or procedure bill exists.
 *
 * HNN Biller never holds the money: contributions are recorded here by the hospital
 * (paid at the cashier) or posted by the savings partner (webhook), and the plan is
 * the ledger of record that the hospital, the patient and the partner all see.
 *
 * Clinical content is deliberately conservative and configurable (pathwayJson): it
 * is financial preparedness, not clinical advice, and says so to the patient.
 */

const KEY = 'savings_plans';
const DEFAULT_NAME = 'BirthPrep Savings (default)';
const MODULE = 'birthprep';
const GOALS = ['delivery', 'procedure', 'other'];
const HORIZONS = ['9', '6', '3', 'other'];
const CADENCES = ['monthly', 'biweekly', 'weekly'];
const BASES = ['expected', 'most_likely', 'worst_case'];
const PLAN_STATUSES = ['active', 'paused', 'completed', 'closed'];

const err = (status, message, detail) => { const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e; };
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const now = () => new Date().toISOString();
const rid = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const base = () => String(config.messaging.publicBaseUrl || '').replace(/\/$/, '');
const maskPhone = (p) => { const s = String(p || ''); return s.length <= 4 ? s : `${'•'.repeat(s.length - 4)}${s.slice(-4)}`; };
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const norm = (s) => String(s || '').trim().toLowerCase();
const n2 = (n) => Number(n || 0).toFixed(2);
const DAY = 86400000; const WEEK = 7 * DAY;
const TOKEN_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function shortToken(n = 12) { let t = ''; for (let i = 0; i < n; i++) t += TOKEN_CHARS[crypto.randomInt(TOKEN_CHARS.length)]; return t; }
const planLink = (token) => `${base()}/s/${token}`;

// ---- Product Lab parameters ------------------------------------------------------------

const PARAMS = [
  { key: 'brandName', label: 'Programme name shown to patients', type: 'text', default: 'BirthPrep Savings' },
  { key: 'partnerName', label: 'Savings partner (holds the money)', type: 'text', default: 'TrimesterSave' },
  { key: 'costSvd', label: 'Normal (vaginal) delivery package (GHS)', type: 'number', min: 0, default: 1800 },
  { key: 'costCs', label: 'Caesarean section package (GHS)', type: 'number', min: 0, default: 6500 },
  { key: 'costNicuPerDay', label: 'Newborn special care per day (GHS)', type: 'number', min: 0, default: 450 },
  { key: 'costSteroids', label: 'Antenatal steroids course (GHS)', type: 'number', min: 0, default: 120 },
  { key: 'costAntenatal', label: 'Remaining antenatal care to include (GHS)', type: 'number', min: 0, default: 0,
    help: 'Set when the plan should also cover antenatal visits and scans still to come.' },
  { key: 'bufferPercent', label: 'Safety buffer on the target (%)', type: 'number', min: 0, max: 100, default: 15 },
  { key: 'planningBasis', label: 'Target is based on', type: 'select', options: BASES, default: 'expected',
    help: 'expected = probability-weighted cost of the scenarios; most_likely = the single most likely scenario; worst_case = the costliest plausible scenario.' },
  { key: 'procedureContingencyPercent', label: 'Contingency on a quoted procedure (%)', type: 'number', min: 0, max: 100, default: 20 },
  { key: 'cadence', label: 'Milestone cadence', type: 'select', options: CADENCES, default: 'monthly' },
  { key: 'leadWeeks', label: 'Weeks before the earliest plausible need by which the target must be reached', type: 'number', min: 0, max: 12, default: 2 },
  { key: 'minContribution', label: 'Smallest contribution (GHS)', type: 'number', min: 1, default: 20 },
  { key: 'suggestOnPregnancy', label: 'Suggest a plan when a bill carries a pregnancy diagnosis', type: 'boolean', default: true },
  { key: 'suggestOnElective', label: 'Suggest a plan when a bill mentions a planned / elective procedure', type: 'boolean', default: true },
  { key: 'includeInsureCredit', label: 'Show the InsureCredit bridge for any shortfall', type: 'boolean', default: true },
  { key: 'insureCreditCap', label: 'InsureCredit bridge cap (GHS)', type: 'number', min: 0, max: 2000, default: 2000 },
  { key: 'reminderDaysBefore', label: 'Milestone reminder (days before)', type: 'number', min: 0, max: 30, default: 3 },
  { key: 'smsOnChange', label: 'Text the patient when the plan is re-planned', type: 'boolean', default: true },
  { key: 'channel', label: 'Message channel', type: 'select', options: ['sms', 'whatsapp', 'both'], default: 'sms' },
  { key: 'pathwayJson', label: 'Pathway overrides (JSON, advanced)', type: 'textarea', default: '',
    help: 'Optional JSON to override the built-in obstetric pathway table, e.g. {"pih":{"scenarios":[...]}}. Leave empty for the built-in rules.' },
  { key: 'disclaimer', label: 'Disclaimer shown to patients', type: 'textarea',
    default: 'This is financial preparedness, not medical advice. Your clinician decides how and when you deliver; the plan adapts to what they decide.' },
];

function check(p) {
  if (p.pathwayJson) { try { const j = JSON.parse(p.pathwayJson); if (!j || typeof j !== 'object') throw new Error('x'); } catch (_e) { throw err(422, 'param_invalid', 'pathwayJson must be a JSON object'); } }
  if (p.costCs < p.costSvd) throw err(422, 'param_invalid', 'costCs should not be below costSvd');
}
function defaults() { const o = {}; for (const d of PARAMS) o[d.key] = d.default; return o; }
const paramsOf = (product) => ({ ...defaults(), ...(product?.config?.params || {}) });

// ---- clinical facts and the obstetric pathway table ------------------------------------------

/** Questions a biller, the patient page or a chatbot can ask; answers map straight onto facts. */
const QUESTIONS = [
  { id: 'goal', q: 'What are you saving for?', type: 'select', options: GOALS, fact: 'goal' },
  { id: 'lmp', q: 'First day of your last menstrual period (if pregnant)?', type: 'date', fact: 'lmp' },
  { id: 'edd', q: 'Expected date of delivery, if your clinician gave one?', type: 'date', fact: 'edd' },
  { id: 'previousBirths', q: 'How many babies have you delivered before?', type: 'number', fact: 'parity' },
  { id: 'previousCs', q: 'How many of those were by caesarean section?', type: 'number', fact: 'previousCs' },
  { id: 'hypertension', q: 'Have you been told you have high blood pressure in this or a previous pregnancy?', type: 'yesno', fact: 'hypertension' },
  { id: 'diabetes', q: 'Do you have diabetes, or were you told you have diabetes in pregnancy?', type: 'yesno', fact: 'diabetes' },
  { id: 'multiple', q: 'Are you expecting twins or more?', type: 'yesno', fact: 'multiple' },
  { id: 'previousPreterm', q: 'Was any previous baby born before 37 weeks?', type: 'yesno', fact: 'previousPreterm' },
  { id: 'breech', q: 'Has your clinician said the baby is breech (bottom first) at 36 weeks or later?', type: 'yesno', fact: 'breech' },
  { id: 'praevia', q: 'Has your clinician said the placenta is low-lying (placenta praevia)?', type: 'yesno', fact: 'praevia' },
  { id: 'plannedCs', q: 'Has your clinician already planned a caesarean section?', type: 'yesno', fact: 'plannedCs' },
  { id: 'age', q: 'Your age', type: 'number', fact: 'age' },
  { id: 'procedureName', q: 'If saving for a procedure: which one?', type: 'text', fact: 'procedureName' },
  { id: 'procedureQuote', q: 'Quoted cost of the procedure (GHS)?', type: 'number', fact: 'procedureQuote' },
  { id: 'procedureDate', q: 'Planned date of the procedure?', type: 'date', fact: 'procedureDate' },
  { id: 'otherAmount', q: 'If saving for something else: how much (GHS)?', type: 'number', fact: 'otherAmount' },
  { id: 'otherLabel', q: 'What is it for?', type: 'text', fact: 'otherLabel' },
];
const yes = (v) => v === true || ['yes', 'y', 'true', '1'].includes(norm(v));

function factsFromAnswers(answers = {}) {
  const f = {};
  for (const q of QUESTIONS) {
    const v = answers[q.id]; if (v === undefined || v === null || v === '') continue;
    if (q.type === 'yesno') f[q.fact] = yes(v);
    else if (q.type === 'number') f[q.fact] = Number(v);
    else f[q.fact] = String(v);
  }
  return f;
}

// Built-in pathway table. Every entry: scenarios the condition makes plausible, each with the
// mode of delivery, the gestation in weeks, a probability and extras. Probabilities within a
// condition are normalised when combined.
const PATHWAYS = {
  // route of delivery
  baseline: { cs: 0.2, note: 'Baseline: most deliveries are vaginal; a caesarean is always possible.' },
  previousCs2: { cs: 0.98, plannedWeeks: 38.5, strict: true, note: 'Two or more previous caesarean sections: a planned repeat caesarean is the standard recommendation.' },
  previousCs1: { cs: 0.6, note: 'One previous caesarean: a trial of vaginal birth may be offered; a repeat caesarean is more likely than not.' },
  plannedCs: { cs: 0.97, plannedWeeks: 39, strict: true, note: 'A caesarean section has been planned by your clinician.' },
  breech: { cs: 0.9, plannedWeeks: 39, note: 'Breech presentation at term: a caesarean is usually advised.' },
  praevia: { cs: 1.0, plannedWeeks: 36.5, nicuDays: 2, note: 'Placenta praevia: delivery by caesarean, usually at 36-37 weeks.' },
  multiple: { cs: 0.6, scenarios: [{ weeks: 34, p: 0.25, nicuDays: 7, steroids: true }, { weeks: 36.5, p: 0.45, nicuDays: 2 }, { weeks: 38, p: 0.3 }], note: 'Twins or more: delivery is usually earlier (34-37 weeks) and more often by caesarean.' },
  // timing conditions
  pih: { cs: 0.5, scenarios: [{ weeks: 32, p: 0.15, nicuDays: 14, steroids: true, emergency: true }, { weeks: 34, p: 0.2, nicuDays: 7, steroids: true }, { weeks: 36.5, p: 0.35, nicuDays: 2 }, { weeks: 38, p: 0.3 }],
    note: 'Hypertension in pregnancy: an expedited delivery can become necessary at 32 weeks (steroids for the baby\'s lungs, special care), 34 weeks, 36-37 weeks, or at term.' },
  diabetes: { cs: 0.45, scenarios: [{ weeks: 36.5, p: 0.3, nicuDays: 3 }, { weeks: 37.5, p: 0.5, nicuDays: 1 }, { weeks: 39, p: 0.2 }],
    note: 'Diabetes in pregnancy: babies tend to be bigger, so delivery is often planned at 37-38 weeks and a caesarean is more likely; the baby may need a short stay for blood-sugar checks.' },
  previousPreterm: { scenarios: [{ weeks: 34, p: 0.3, nicuDays: 7, steroids: true }, { weeks: 39, p: 0.7 }], note: 'A previous preterm birth raises the chance of another.' },
  ageHigh: { cs: 0.3, note: 'Age 35 or over: slightly higher chance of a caesarean or an earlier delivery.' },
  ageLow: { cs: 0.25, note: 'Under 18: closer monitoring is usual.' },
};

function pathwayTable(p) {
  if (!p.pathwayJson) return PATHWAYS;
  try { return { ...PATHWAYS, ...JSON.parse(p.pathwayJson) }; } catch (_e) { return PATHWAYS; }
}

/** Gestation today from LMP or EDD; null if neither. */
function gestation(facts, at = Date.now()) {
  let edd = facts.edd ? new Date(facts.edd) : null;
  if (!edd && facts.lmp) edd = new Date(new Date(facts.lmp).getTime() + 280 * DAY);
  if (!edd || Number.isNaN(edd.getTime())) return null;
  const weeks = 40 - (edd.getTime() - at) / WEEK;
  return { edd: edd.toISOString().slice(0, 10), weeks: Math.round(weeks * 10) / 10, dateAtWeeks: (w) => new Date(edd.getTime() - (40 - w) * WEEK) };
}

/**
 * Turn clinical facts into delivery scenarios: [{ code, label, weeks, date, mode, probability,
 * cost, extras }] plus the applicable advisories. Pure function of facts + params.
 */
function deliveryScenarios(facts, p, at = Date.now()) {
  const T = pathwayTable(p);
  const g = gestation(facts, at);
  const notes = []; const applied = [];
  // 1. chance of caesarean: the strongest applicable rule wins; strict rules are absolute
  let cs = T.baseline.cs; let plannedWeeks = null; let strict = false;
  const consider = (key) => { const r = T[key]; if (!r) return; applied.push(key); notes.push(r.note); if (r.cs != null && (r.strict || r.cs > cs)) { cs = r.cs; if (r.plannedWeeks) plannedWeeks = r.plannedWeeks; strict = strict || !!r.strict; } };
  if (Number(facts.previousCs) >= 2) consider('previousCs2'); else if (Number(facts.previousCs) === 1) consider('previousCs1');
  if (facts.plannedCs) consider('plannedCs');
  if (facts.breech) consider('breech');
  if (facts.praevia) consider('praevia');
  if (facts.multiple) consider('multiple');
  if (facts.hypertension) consider('pih');
  if (facts.diabetes) consider('diabetes');
  if (facts.previousPreterm) consider('previousPreterm');
  if (Number(facts.age) >= 35) consider('ageHigh'); else if (facts.age && Number(facts.age) < 18) consider('ageLow');
  // 2. timing scenarios: combine the timing-bearing conditions (earliest plausible timing dominates the tail)
  const timing = ['pih', 'diabetes', 'multiple', 'previousPreterm', 'praevia'].filter((k) => applied.includes(k) && T[k].scenarios);
  let scen;
  if (!timing.length) scen = [{ weeks: plannedWeeks || 39.5, p: 1 }];
  else {
    // union by week bucket; probability of a bucket = 1 - prod(1 - p_i) for "early" buckets (any condition can trigger it), remainder to the latest bucket
    const buckets = new Map();
    for (const k of timing) for (const s of T[k].scenarios) {
      const b = buckets.get(s.weeks) || { weeks: s.weeks, pNot: 1, nicuDays: 0, steroids: false, emergency: false };
      b.pNot *= (1 - s.p); b.nicuDays = Math.max(b.nicuDays, s.nicuDays || 0); b.steroids = b.steroids || !!s.steroids; b.emergency = b.emergency || !!s.emergency;
      buckets.set(s.weeks, b);
    }
    const sorted = [...buckets.values()].sort((a, b) => a.weeks - b.weeks);
    let remaining = 1; scen = [];
    for (let i = 0; i < sorted.length; i++) {
      const b = sorted[i]; const isLast = i === sorted.length - 1;
      const pr = isLast ? remaining : Math.min(remaining, (1 - b.pNot) * remaining);
      scen.push({ weeks: b.weeks, p: pr, nicuDays: b.nicuDays, steroids: b.steroids, emergency: b.emergency }); remaining -= pr;
    }
    if (plannedWeeks) scen = scen.map((s) => (s.weeks > plannedWeeks ? { ...s, weeks: plannedWeeks } : s));
  }
  // 3. expand each timing bucket into vaginal / caesarean with costs
  const out = [];
  for (const s of scen) {
    const csHere = s.emergency ? Math.max(cs, 0.7) : (s.weeks < 34 ? Math.max(cs, 0.6) : cs);
    for (const mode of ['vaginal', 'caesarean']) {
      const pr = s.p * (mode === 'caesarean' ? csHere : 1 - csHere);
      if (pr < 0.005) continue;
      const extras = [];
      let cost = mode === 'caesarean' ? Number(p.costCs) : Number(p.costSvd);
      if (s.nicuDays) { cost += s.nicuDays * Number(p.costNicuPerDay); extras.push(`${s.nicuDays} days newborn special care`); }
      if (s.steroids) { cost += Number(p.costSteroids); extras.push('antenatal steroids'); }
      cost += Number(p.costAntenatal) || 0;
      const gw = g ? g.dateAtWeeks(s.weeks) : null;
      out.push({ code: `${mode}_${String(s.weeks).replace('.', '_')}w`, label: `${mode === 'caesarean' ? 'Caesarean' : 'Vaginal'} delivery at ${s.weeks} weeks${s.emergency ? ' (expedited)' : ''}`,
        weeks: s.weeks, date: gw ? gw.toISOString().slice(0, 10) : null, mode, probability: Math.round(pr * 1000) / 1000, cost: round2(cost), extras });
    }
  }
  out.sort((a, b) => b.probability - a.probability);
  return { scenarios: out, csProbability: Math.round(cs * 100) / 100, strict, plannedWeeks, notes, applied, gestation: g ? { edd: g.edd, weeksToday: g.weeks } : null };
}

/** Target amount from scenarios per the product's planning basis + buffer. */
function targetFrom(scenarios, p) {
  if (!scenarios.length) return { target: 0, basisAmount: 0, expected: 0, mostLikely: 0, worstCase: 0 };
  const expected = scenarios.reduce((s, x) => s + x.probability * x.cost, 0);
  const mostLikely = scenarios[0].cost;
  const worstCase = Math.max(...scenarios.filter((x) => x.probability >= 0.03).map((x) => x.cost));
  const basisAmount = p.planningBasis === 'most_likely' ? mostLikely : p.planningBasis === 'worst_case' ? worstCase : expected;
  return { target: round2(basisAmount * (1 + Number(p.bufferPercent) / 100)), basisAmount: round2(basisAmount), expected: round2(expected), mostLikely: round2(mostLikely), worstCase: round2(worstCase) };
}

/** The date by which the money must be there: earliest plausible need minus the lead time. */
function deadlineFrom(goal, scenarios, facts, p, at = Date.now()) {
  if (goal === 'delivery') {
    // plausible = the delivery DATE (both modes together) carries at least 10% probability
    const byDate = {}; for (const s of scenarios) if (s.date) byDate[s.date] = (byDate[s.date] || 0) + s.probability;
    const dated = Object.entries(byDate).filter(([, pr]) => pr >= 0.1).map(([d]) => new Date(d).getTime());
    const earliest = dated.length ? dated.reduce((a, b) => Math.min(a, b)) : null;
    if (earliest) return new Date(Math.max(at + 7 * DAY, earliest - Number(p.leadWeeks) * WEEK));
    return null;
  }
  if (goal === 'procedure' && facts.procedureDate) return new Date(Math.max(at + 7 * DAY, new Date(facts.procedureDate).getTime() - Number(p.leadWeeks) * WEEK));
  return null;
}

/** Horizon: '9' | '6' | '3' months, or 'other' with { months | years | open: true }. Returns the end date or null (open). */
function horizonEnd(horizon, other, at = Date.now()) {
  const months = HORIZONS.includes(String(horizon)) && String(horizon) !== 'other' ? Number(horizon)
    : other?.open ? null : other?.years != null ? Number(other.years) * 12 : other?.months != null ? Number(other.months) : null;
  if (months == null) return null;
  if (!(months > 0) || months > 600) throw err(422, 'horizon_invalid', 'months must be between 1 and 600');
  const d = new Date(at); d.setUTCMonth(d.getUTCMonth() + months); return d;
}

/** Milestones from start to end at the cadence, amounts equal to the remaining target. */
function buildSchedule({ target, saved = 0, start = Date.now(), end, cadence, existing = [] }) {
  const stepDays = cadence === 'weekly' ? 7 : cadence === 'biweekly' ? 14 : 30.4375;
  const kept = existing.filter((m) => m.status === 'paid' || new Date(m.dueDate).getTime() < start);
  const remaining = Math.max(0, round2(target - saved));
  if (!end) { // open-ended: one rolling milestone per period, amount = a suggested contribution
    const next = new Date(start + stepDays * DAY);
    return [...kept, { id: rid('ms'), dueDate: next.toISOString().slice(0, 10), amount: round2(Math.min(remaining, Math.max(remaining / 12, 1))), label: 'Next contribution', status: 'due', openEnded: true }];
  }
  const span = Math.max(1, Math.round((end.getTime() - start) / (stepDays * DAY)));
  const per = round2(remaining / span);
  const out = [...kept]; let acc = 0;
  for (let i = 1; i <= span; i++) {
    const due = new Date(Math.min(end.getTime(), start + i * stepDays * DAY));
    const amt = i === span ? round2(remaining - acc) : per; acc += amt;
    out.push({ id: rid('ms'), dueDate: due.toISOString().slice(0, 10), amount: amt, label: i === span ? 'Target reached' : `Milestone ${i}`, status: 'due' });
  }
  return out;
}

/** Everything the plan needs from the facts: scenarios, target, deadline, schedule, advisories. */
function plan(facts, { goal, horizon, other, p, saved = 0, start = Date.now(), existing = [] }) {
  let scenarios = []; let analysis = null; let label = '';
  if (goal === 'delivery') { analysis = deliveryScenarios(facts, p, start); scenarios = analysis.scenarios; label = 'Delivery of your baby'; }
  else if (goal === 'procedure') {
    const quote = Number(facts.procedureQuote) || 0;
    if (!(quote > 0)) throw err(422, 'procedure_quote_required');
    scenarios = [{ code: 'procedure', label: facts.procedureName || 'Planned procedure', date: facts.procedureDate || null, probability: 1, cost: round2(quote * (1 + Number(p.procedureContingencyPercent) / 100)), extras: [`${p.procedureContingencyPercent}% contingency`] }];
    label = facts.procedureName || 'Planned procedure';
  } else {
    const amt = Number(facts.otherAmount) || 0;
    if (!(amt > 0)) throw err(422, 'other_amount_required');
    scenarios = [{ code: 'goal', label: facts.otherLabel || 'Savings goal', date: null, probability: 1, cost: round2(amt), extras: [] }];
    label = facts.otherLabel || 'Savings goal';
  }
  const t = goal === 'delivery' ? targetFrom(scenarios, p) : { target: scenarios[0].cost, basisAmount: scenarios[0].cost, expected: scenarios[0].cost, mostLikely: scenarios[0].cost, worstCase: scenarios[0].cost };
  const deadline = deadlineFrom(goal, scenarios, facts, p, start);
  const hEnd = horizonEnd(horizon, other, start);
  // the plan ends at the earlier of the chosen horizon and the clinical deadline
  const end = deadline && hEnd ? new Date(Math.min(deadline.getTime(), hEnd.getTime())) : (deadline || hEnd);
  const schedule = buildSchedule({ target: t.target, saved, start, end, cadence: p.cadence, existing });
  const advisories = [];
  if (analysis) {
    for (const n of analysis.notes) advisories.push(n);
    if (analysis.strict) advisories.push(`Plan for a caesarean section: the target is set for a planned caesarean around ${analysis.plannedWeeks} weeks.`);
    if (deadline && hEnd && deadline < hEnd) advisories.push(`Your clinical picture means the money may be needed by ${deadline.toISOString().slice(0, 10)}, earlier than the ${horizon === 'other' ? 'chosen' : horizon + '-month'} horizon; the milestones end there.`);
    if (analysis.gestation && analysis.gestation.weeksToday > 0) advisories.push(`You are about ${Math.round(analysis.gestation.weeksToday)} weeks today; expected due date ${analysis.gestation.edd}.`);
  }
  return { goalLabel: label, scenarios, target: t, deadline: deadline ? deadline.toISOString().slice(0, 10) : null, horizonEnd: hEnd ? hEnd.toISOString().slice(0, 10) : null, end: end ? end.toISOString().slice(0, 10) : null, schedule, advisories, analysis: analysis ? { csProbability: analysis.csProbability, strict: analysis.strict, applied: analysis.applied, gestation: analysis.gestation } : null };
}

// ---- history intelligence ------------------------------------------------------------------------

const KW = {
  cs: [/caesarean/i, /cesarean/i, /\bc\/s\b/i, /\blscs\b/i, /\bcs\b/i, /c-section/i],
  hypertension: [/hypertens/i, /pre-?eclamps/i, /\bpih\b/i, /eclampsia/i, /high blood pressure/i],
  diabetes: [/diabet/i, /\bgdm\b/i, /gestational diabetes/i],
  preterm: [/preterm/i, /premature/i],
  pregnancy: [/pregnan/i, /antenatal/i, /\banc\b/i, /gravid/i, /\blmp\b/i, /\bedd\b/i, /obstetric/i, /trimester/i],
  elective: [/elective/i, /planned (surgery|procedure|operation)/i, /scheduled (surgery|procedure|operation)/i, /booked for/i],
  multiple: [/twin/i, /triplet/i, /multiple pregnancy/i],
  breech: [/breech/i],
  praevia: [/praevia/i, /previa/i],
};
const textOf = (b) => [b.clinical?.diagnosis, b.clinical?.differentialDiagnosis, b.clinical?.complaint, ...(b.lineItems || []).map((i) => i.name)].filter(Boolean).join(' | ');
const hit = (res, t) => res.some((r) => r.test(t));

/** What the platform already knows about this patient (same phone or member id at this hospital, or anywhere if allowed). */
async function inferHistory(tenantId, { phone, memberId }) {
  const ph = phone ? messaging.normalizePhone(phone) : null;
  const bills = (await store.bills.listByTenant(tenantId)).filter((b) => (ph && messaging.normalizePhone(b.patient?.phone) === ph) || (memberId && b.coverage?.memberId === memberId));
  const facts = { previousCs: 0, hypertension: false, diabetes: false, previousPreterm: false, evidence: [] };
  for (const b of bills) {
    const t = textOf(b);
    if (hit(KW.cs, t)) {
      // "x2", "2 previous caesareans", "two previous CS" on one bill count as that many; otherwise one per bill.
      const m = t.match(/(?:caesarean|cesarean|c\/s|lscs|\bcs\b|c-section)[^.;,]{0,25}?x\s*(\d)/i) || t.match(/(\d|two|three|four)\s+(?:previous\s+)?(?:caesarean|cesarean|c\/s|lscs|\bcs\b|c-section)/i);
      const words = { two: 2, three: 3, four: 4 };
      const n = m ? (words[m[1].toLowerCase()] || Number(m[1]) || 1) : 1;
      facts.previousCs += n; facts.evidence.push({ billId: b.id, at: b.createdAt, found: `caesarean section${n > 1 ? ' x' + n : ''}` });
    }
    if (hit(KW.hypertension, t)) { facts.hypertension = true; facts.evidence.push({ billId: b.id, at: b.createdAt, found: 'hypertension in pregnancy' }); }
    if (hit(KW.diabetes, t)) { facts.diabetes = true; facts.evidence.push({ billId: b.id, at: b.createdAt, found: 'diabetes' }); }
    if (hit(KW.preterm, t)) { facts.previousPreterm = true; facts.evidence.push({ billId: b.id, at: b.createdAt, found: 'preterm birth' }); }
  }
  return { facts, billsSeen: bills.length };
}

/** Should the terminal suggest a plan for this bill? */
function suggestionFor(bill, p) {
  const t = textOf(bill);
  if (p.suggestOnPregnancy && hit(KW.pregnancy, t)) {
    const facts = { hypertension: hit(KW.hypertension, t), diabetes: hit(KW.diabetes, t), multiple: hit(KW.multiple, t), breech: hit(KW.breech, t), praevia: hit(KW.praevia, t) };
    return { suggest: true, goal: 'delivery', reason: 'pregnancy diagnosis on this bill', facts };
  }
  if (p.suggestOnElective && hit(KW.elective, t)) return { suggest: true, goal: 'procedure', reason: 'planned / elective procedure mentioned on this bill', facts: {} };
  return { suggest: false };
}

// ---- products / settings ----------------------------------------------------------------------

async function allProducts() { return (await store.products.all()).filter((x) => x.type === 'solution' && x.config?.module === MODULE); }
const isDefault = (x) => x.name === DEFAULT_NAME;
async function productFor(tenantId, productId) {
  const all = await allProducts();
  if (productId) { const p = all.find((x) => x.id === productId && x.status === 'live'); if (p) return p; }
  const own = all.filter((x) => x.status === 'live' && !isDefault(x) && (x.config.tenantIds || []).includes(tenantId))
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))[0];
  if (own) return own;
  const def = all.find(isDefault);
  return def && def.status === 'live' ? def : null;
}
async function ensureDefaultProduct() {
  const found = (await allProducts()).find(isDefault);
  if (found) return found;
  const products = require('./products');
  const payers = await store.payers.all();
  const sponsor = payers.find((x) => x.id === 'cosmopolitan') || payers[0];
  if (!sponsor) return null;
  const created = await products.create(sponsor.id, { type: 'solution', name: DEFAULT_NAME,
    description: 'Default birth-preparedness and procedure savings programme: every hospital can enrol patients; targets from obstetric pathways and the patient\'s history; InsureCredit bridges a shortfall.',
    config: { module: MODULE, params: {}, surfaces: ['patient', 'hospital', 'payer'] } }, 'system');
  await products.setStatus(created.id, 'sandbox', 'system');
  return products.setStatus(created.id, 'live', 'system');
}
async function getSettings() {
  let s = await store.settings.get(KEY);
  if (!s) { s = { hookSecret: crypto.randomBytes(18).toString('hex'), createdAt: now() }; await store.settings.set(KEY, s); }
  return s;
}
async function rotateSecret() { const s = await getSettings(); s.hookSecret = crypto.randomBytes(18).toString('hex'); await store.settings.set(KEY, s); return s.hookSecret; }
async function checkSecret(given) { const s = await getSettings(); const a = Buffer.from(String(given || '')); const b = Buffer.from(s.hookSecret); return a.length === b.length && crypto.timingSafeEqual(a, b); }
async function hookUrls(baseUrl) { const s = await getSettings(); const root = String(baseUrl || base()).replace(/\/$/, ''); return { contribution: `${root}/savings-hooks/${s.hookSecret}/contribution`, plan: `${root}/savings-hooks/${s.hookSecret}/plans/{planNo}` }; }

async function newPlanNo() {
  for (let i = 0; i < 20; i++) { const n = String(crypto.randomInt(10000000, 100000000)); if (!(await store.savingsPlans.byPlanNo(n))) return n; }
  throw err(500, 'plan_number_exhausted');
}

// ---- messaging -----------------------------------------------------------------------------------

async function sendText(p, plan, body) {
  const tenant = await store.tenants.get(plan.tenantId);
  const channels = p.channel === 'both' ? ['sms', 'whatsapp'] : [p.channel || 'sms'];
  const sent = [];
  for (const ch of channels) { const r = await messaging.send({ channel: ch, to: plan.patient.phone, body, tenant }); if (r.ok) sent.push(ch); }
  plan.events.push({ at: now(), type: sent.length ? 'message_sent' : 'message_failed', body: body.slice(0, 160) });
  return sent;
}
const summaryText = (p, plan) => `${p.brandName}: Hi ${firstName(plan.patient.name)}, your plan ${plan.planNo} for ${plan.goalLabel.toLowerCase()} targets GHS ${n2(plan.target.target)}${plan.end ? ` by ${plan.end}` : ''}. Next: GHS ${n2(plan.schedule.find((m) => m.status === 'due')?.amount || 0)} by ${plan.schedule.find((m) => m.status === 'due')?.dueDate || '-'}. Details: ${planLink(plan.token)}`;

// ---- plan lifecycle -------------------------------------------------------------------------------

function applyFacts(existing = {}, incoming = {}) {
  const f = { ...existing };
  for (const [k, v] of Object.entries(incoming)) { if (v === undefined || v === null || v === '') continue; f[k] = v; }
  delete f.evidence;
  return f;
}

/** Enrol a patient. input: { patient:{name,phone,memberId}, goal, horizon, other, facts, answers, billId, useHistory } */
async function enrol({ tenant, product, input = {}, by = 'hospital' }) {
  const p = paramsOf(product);
  const patient = { name: String(input.patient?.name || '').trim(), phone: messaging.toDialable(input.patient?.phone || ''), memberId: input.patient?.memberId || null };
  if (!patient.name) throw err(422, 'patient_name_required');
  if (!/^\+\d{8,15}$/.test(patient.phone)) throw err(422, 'patient_phone_required');
  const goal = GOALS.includes(input.goal) ? input.goal : 'delivery';
  const horizon = HORIZONS.includes(String(input.horizon)) ? String(input.horizon) : 'other';
  const other = input.other || (horizon === 'other' ? { open: true } : null);
  let facts = applyFacts(factsFromAnswers(input.answers || {}), input.facts || {});
  let history = null;
  if (input.useHistory !== false && goal === 'delivery') {
    history = await inferHistory(tenant.id, patient);
    const h = history.facts;
    // Documented history outranks a "no" from the intake: a caesarean on a previous bill is a caesarean.
    facts = applyFacts({ previousCs: h.previousCs || undefined }, facts);
    if ((Number(facts.previousCs) || 0) < h.previousCs) facts.previousCs = h.previousCs;
    for (const k of ['hypertension', 'diabetes', 'previousPreterm']) if (h[k]) facts[k] = true;
  }
  if (input.billId) {
    const bill = await store.bills.get(input.billId);
    if (bill && bill.tenantId === tenant.id) { const sug = suggestionFor(bill, p); if (sug.suggest && sug.goal === 'delivery') facts = applyFacts(Object.fromEntries(Object.entries(sug.facts).filter(([, v]) => v)), facts); }
  }
  const computed = plan(facts, { goal, horizon, other, p });
  const record = {
    id: rid('sav'), planNo: await newPlanNo(), token: shortToken(), tenantId: tenant.id, facility: tenant.name, productId: product.id, programme: p.brandName, partner: p.partnerName,
    patient, goal, goalLabel: computed.goalLabel, horizon, other, facts, history: history ? { billsSeen: history.billsSeen, evidence: history.facts.evidence } : null,
    scenarios: computed.scenarios, target: computed.target, deadline: computed.deadline, horizonEnd: computed.horizonEnd, end: computed.end, schedule: computed.schedule,
    analysis: computed.analysis, advisories: computed.advisories.map((text) => ({ at: now(), text, severity: 'info' })),
    contributions: [], saved: 0, status: 'active', billId: input.billId || null, createdAt: now(), createdBy: by, updatedAt: now(), events: [{ at: now(), type: 'enrolled', by }],
    bridge: null,
  };
  record.bridge = bridgeFor(record, p);
  await store.savingsPlans.insert(record);
  record.sentVia = await sendText(p, record, summaryText(p, record));
  await store.savingsPlans.update(record);
  await notify({ party: 'provider', to: tenant?.contact?.email, subject: `${p.brandName}: ${patient.name} enrolled`, body: `Plan ${record.planNo}: ${record.goalLabel}, target GHS ${n2(record.target.target)}${record.end ? ' by ' + record.end : ''}.`, billId: input.billId || null });
  return record;
}

/** Shortfall at the deadline and what InsureCredit could bridge. */
function bridgeFor(record, p) {
  const due = record.schedule.filter((m) => m.status === 'due').reduce((s, m) => s + m.amount, 0);
  const shortfall = Math.max(0, round2(record.target.target - record.saved));
  const projected = Math.max(0, round2(shortfall - due));
  if (!p.includeInsureCredit) return { shortfall, projectedAtDeadline: projected, insureCredit: null };
  const cap = Math.min(Number(p.insureCreditCap) || 0, 2000);
  return { shortfall, projectedAtDeadline: projected, insureCredit: { eligibleUpTo: round2(Math.min(cap, shortfall)), coversShortfall: shortfall <= cap,
    note: shortfall > 0 ? `If GHS ${n2(shortfall)} is still outstanding when the bill comes, InsureCredit can offer a micro-loan of up to GHS ${n2(Math.min(cap, shortfall))} from the billing terminal.` : 'Fully funded.' } };
}

async function byTokenOrThrow(token) { const r = await store.savingsPlans.byToken(String(token || '')); if (!r) throw err(404, 'plan_not_found'); return r; }
async function productOf(record) { return (await store.products.get(record.productId)) || null; }

/** Re-plan after a clinical change (biller, patient Q&A or chatbot). Keeps contributions and paid milestones. */
async function update(record, { facts = {}, answers = {}, goal, horizon, other, by = 'hospital', note } = {}) {
  const product = await productOf(record); const p = paramsOf(product);
  if (record.status === 'closed' || record.status === 'completed') throw err(409, 'plan_closed');
  const before = { target: record.target.target, goalLabel: record.goalLabel, cs: record.analysis?.csProbability, end: record.end, strict: record.analysis?.strict };
  record.facts = applyFacts(record.facts, applyFacts(factsFromAnswers(answers), facts));
  if (goal && GOALS.includes(goal)) record.goal = goal;
  if (horizon && HORIZONS.includes(String(horizon))) { record.horizon = String(horizon); record.other = other || (record.horizon === 'other' ? (record.other || { open: true }) : null); }
  const computed = plan(record.facts, { goal: record.goal, horizon: record.horizon, other: record.other, p, saved: record.saved, existing: record.schedule });
  Object.assign(record, { goalLabel: computed.goalLabel, scenarios: computed.scenarios, target: computed.target, deadline: computed.deadline, horizonEnd: computed.horizonEnd, end: computed.end, schedule: computed.schedule, analysis: computed.analysis, updatedAt: now() });
  const changes = [];
  if (Math.abs(before.target - record.target.target) >= 1) changes.push(`target ${before.target < record.target.target ? 'raised' : 'lowered'} from GHS ${n2(before.target)} to GHS ${n2(record.target.target)}`);
  if (before.goalLabel !== record.goalLabel) changes.push(`goal is now ${record.goalLabel}`);
  if (record.analysis && before.cs != null && Math.abs(before.cs - record.analysis.csProbability) >= 0.2) changes.push(`chance of a caesarean now ${Math.round(record.analysis.csProbability * 100)}%${record.analysis.strict ? ' (planned)' : ''}`);
  if (before.end !== record.end) changes.push(`money needed by ${record.end || 'no fixed date'}`);
  const text = changes.length ? `Plan re-planned: ${changes.join('; ')}.${note ? ' ' + note : ''}` : `Plan reviewed: no change to the target.${note ? ' ' + note : ''}`;
  record.advisories.push({ at: now(), text, severity: changes.length ? 'change' : 'info' });
  for (const n of computed.advisories) if (!record.advisories.some((a) => a.text === n)) record.advisories.push({ at: now(), text: n, severity: 'info' });
  record.events.push({ at: now(), type: 'replanned', by, changes });
  record.bridge = bridgeFor(record, p);
  if (record.saved >= record.target.target) record.status = 'completed';
  await store.savingsPlans.update(record);
  if (changes.length && p.smsOnChange) await sendText(p, record, `${p.brandName}: ${text} New target GHS ${n2(record.target.target)}${record.end ? ' by ' + record.end : ''}. ${planLink(record.token)}`);
  await store.savingsPlans.update(record);
  return record;
}

/** Record a contribution (cashier, partner webhook). Marks milestones paid in order. */
async function contribute(record, { amount, via = 'cashier', reference = null, by = 'hospital' } = {}) {
  const product = await productOf(record); const p = paramsOf(product);
  const amt = round2(amount);
  if (!(amt > 0)) throw err(422, 'amount_invalid');
  if (amt < Number(p.minContribution)) throw err(422, 'below_minimum_contribution', `minimum is ${p.minContribution}`);
  if (record.status === 'closed') throw err(409, 'plan_closed');
  if (reference && record.contributions.some((c) => c.reference === reference)) return record; // idempotent on partner reference
  record.contributions.push({ id: rid('ctr'), at: now(), amount: amt, via, reference, by });
  record.saved = round2(record.saved + amt);
  let pool = record.saved;
  for (const m of record.schedule) { if (m.openEnded) continue; if (m.status === 'paid') { pool -= m.amount; continue; } if (pool >= m.amount - 0.005) { m.status = 'paid'; m.paidAt = now(); pool -= m.amount; } }
  if (record.saved >= record.target.target - 0.005) { record.status = 'completed'; record.events.push({ at: now(), type: 'completed' }); }
  record.events.push({ at: now(), type: 'contribution', amount: amt, via });
  record.bridge = bridgeFor(record, p);
  record.updatedAt = now();
  await store.savingsPlans.update(record);
  return record;
}

async function setStatus(record, status, by = 'hospital') {
  if (!PLAN_STATUSES.includes(status)) throw err(422, 'invalid_status');
  record.status = status; record.events.push({ at: now(), type: `status_${status}`, by }); record.updatedAt = now();
  await store.savingsPlans.update(record); return record;
}

/** Create an InsureCredit offer for the shortfall against a real bill (delivery / procedure day). */
async function bridgeWithInsureCredit(record, { billId, tenant } = {}) {
  const insurecredit = require('./insurecredit');
  const bill = await store.bills.get(String(billId || record.billId || ''));
  if (!bill || bill.tenantId !== record.tenantId) throw err(404, 'bill_not_found');
  const product = await productOf(record); const p = paramsOf(product);
  const shortfall = Math.max(0, round2(record.target.target - record.saved));
  // The loan covers the part of the shortfall InsureCredit can lend (its cap); the rest stays the patient's.
  const amount = round2(Math.min(shortfall || bill.totals.patientPayable, bill.totals.patientPayable, Number(p.insureCreditCap) || 2000));
  if (!(amount > 0)) throw err(422, 'nothing_to_bridge');
  const r = await insurecredit.offerAsSettlement({ tenant: tenant || await store.tenants.get(record.tenantId), billId: bill.id, amount });
  record.events.push({ at: now(), type: 'insurecredit_offered', billId: bill.id, amount, applicationNo: r.applicationNo || null });
  record.insureCredit = { billId: bill.id, amount, applicationNo: r.applicationNo || null, at: now() };
  await store.savingsPlans.update(record);
  return r;
}

// ---- views ----------------------------------------------------------------------------------------

function progress(record) {
  const t = record.target.target || 0;
  const next = record.schedule.find((m) => m.status === 'due') || null;
  const overdue = record.schedule.filter((m) => m.status === 'due' && new Date(m.dueDate) < new Date()).length;
  return { saved: record.saved, target: t, percent: t ? Math.min(100, Math.round(100 * record.saved / t)) : 0, next, overdueMilestones: overdue, remaining: Math.max(0, round2(t - record.saved)) };
}

/** Hospital / payer / Master Control view. */
function view(record) {
  return { id: record.id, planNo: record.planNo, link: planLink(record.token), status: record.status, facility: record.facility, programme: record.programme, partner: record.partner,
    patient: { name: record.patient.name, phone: maskPhone(record.patient.phone), memberId: record.patient.memberId }, goal: record.goal, goalLabel: record.goalLabel, horizon: record.horizon, other: record.other,
    facts: record.facts, history: record.history, scenarios: record.scenarios, target: record.target, deadline: record.deadline, horizonEnd: record.horizonEnd, end: record.end, schedule: record.schedule,
    analysis: record.analysis, advisories: record.advisories, progress: progress(record), bridge: record.bridge, insureCredit: record.insureCredit || null, contributions: record.contributions,
    createdAt: record.createdAt, updatedAt: record.updatedAt, events: record.events.slice(-20) };
}

/** Patient page: first name only, no member id, no evidence bill ids. */
async function publicView(record) {
  const product = await productOf(record); const p = paramsOf(product);
  return { planNo: record.planNo, status: record.status, programme: record.programme, partner: record.partner, facility: record.facility, firstName: firstName(record.patient.name),
    goal: record.goal, goalLabel: record.goalLabel, horizon: record.horizon, other: record.other, end: record.end, deadline: record.deadline,
    scenarios: record.scenarios.map((s) => ({ label: s.label, date: s.date, probability: s.probability, cost: s.cost, extras: s.extras })),
    target: record.target, schedule: record.schedule, advisories: record.advisories, progress: progress(record), bridge: record.bridge,
    contributions: record.contributions.map((c) => ({ at: c.at, amount: c.amount, via: c.via })), questions: QUESTIONS.filter((q) => record.goal !== 'delivery' ? !['lmp', 'edd', 'previousBirths', 'previousCs', 'hypertension', 'diabetes', 'multiple', 'previousPreterm', 'breech', 'praevia', 'plannedCs'].includes(q.id) : !['procedureName', 'procedureQuote', 'procedureDate', 'otherAmount', 'otherLabel'].includes(q.id)),
    answered: record.facts, disclaimer: p.disclaimer, brand: p.brandName };
}

async function list({ tenantId, productId, status, limit = 200 } = {}) {
  let rows = await store.savingsPlans.all(5000);
  if (tenantId) rows = rows.filter((r) => r.tenantId === tenantId);
  if (productId) rows = rows.filter((r) => r.productId === productId);
  if (status) rows = rows.filter((r) => r.status === status);
  const by = {}; let target = 0; let saved = 0;
  for (const r of rows) { by[r.status] = (by[r.status] || 0) + 1; target += r.target.target; saved += r.saved; }
  return { total: rows.length, byStatus: by, targetTotal: round2(target), savedTotal: round2(saved), rows: rows.slice(0, limit).map(view) };
}
async function findByPhone(tenantId, phone) { const ph = messaging.normalizePhone(phone); return (await store.savingsPlans.all(5000)).filter((r) => r.tenantId === tenantId && messaging.normalizePhone(r.patient.phone) === ph).map(view); }

/** Reminder sweep: milestones due within N days (and overdue ones) get one text each. Idempotent per milestone. */
async function runReminders() {
  const rows = (await store.savingsPlans.all(5000)).filter((r) => r.status === 'active');
  let sent = 0;
  for (const r of rows) {
    const product = await productOf(r); if (!product || product.status !== 'live') continue;
    const p = paramsOf(product);
    const horizon = Date.now() + Number(p.reminderDaysBefore) * DAY;
    for (const m of r.schedule) {
      if (m.status !== 'due' || m.reminded) continue;
      if (new Date(m.dueDate).getTime() > horizon) continue;
      const overdue = new Date(m.dueDate) < new Date();
      await sendText(p, r, `${p.brandName}: ${overdue ? 'A contribution is overdue' : 'Reminder'} - GHS ${n2(m.amount)} ${overdue ? 'was' : 'is'} due ${m.dueDate} for plan ${r.planNo} (${r.goalLabel.toLowerCase()}). Pay at ${r.facility} or via ${r.partner}. ${planLink(r.token)}`);
      m.reminded = now(); sent++;
    }
    await store.savingsPlans.update(r);
  }
  return { plans: rows.length, remindersSent: sent };
}

// ---- Product Lab module run() ----------------------------------------------------------------------

async function run(ctx, p, input = {}) {
  const action = String(input.action || (ctx.surface === 'patient' ? 'status' : 'simulate'));
  if (action === 'simulate') {
    const facts = applyFacts(factsFromAnswers(input.answers || {}), { previousCs: input.previousCs, hypertension: yes(input.hypertension), diabetes: yes(input.diabetes), multiple: yes(input.multiple), plannedCs: yes(input.plannedCs), edd: input.edd, lmp: input.lmp, age: input.age, procedureQuote: input.procedureQuote, procedureName: input.procedureName, procedureDate: input.procedureDate, otherAmount: input.otherAmount, otherLabel: input.otherLabel });
    for (const k of ['hypertension', 'diabetes', 'multiple', 'plannedCs']) if (!facts[k]) delete facts[k];
    const goal = GOALS.includes(input.goal) ? input.goal : 'delivery';
    const horizon = HORIZONS.includes(String(input.horizon)) ? String(input.horizon) : '9';
    const other = horizon === 'other' ? { months: Number(input.otherMonths) || undefined, open: !Number(input.otherMonths) } : null;
    const c = plan(facts, { goal, horizon, other, p });
    return { simulated: true, goal, horizon, facts, ...c, bridge: bridgeFor({ schedule: c.schedule, target: c.target, saved: 0 }, p) };
  }
  if (action === 'questions') return { questions: QUESTIONS };
  if (action === 'list') return list({ tenantId: ctx.surface === 'hospital' ? ctx.tenant?.id : undefined, productId: ctx.product.id, status: input.status });
  if (action === 'status') {
    const r = input.planNo ? await store.savingsPlans.byPlanNo(String(input.planNo).replace(/\D/g, '')) : null;
    const ph = messaging.normalizePhone(input.phone);
    if (!r || !ph || messaging.normalizePhone(r.patient.phone) !== ph) throw err(404, 'plan_not_found');
    return publicView(r);
  }
  if (action === 'enrol') {
    if (ctx.surface !== 'hospital') throw err(403, 'enrolment_is_done_by_the_hospital');
    if (ctx.product.status !== 'live') return { preview: true, notice: 'Test mode: nothing stored or sent.', ...plan(applyFacts(factsFromAnswers(input.answers || {}), input.facts || {}), { goal: input.goal || 'delivery', horizon: input.horizon || '9', other: input.other, p }) };
    return view(await enrol({ tenant: ctx.tenant, product: ctx.product, input }));
  }
  throw err(422, 'unknown_action', 'use simulate | questions | list | status | enrol');
}

module.exports = {
  MODULE, DEFAULT_NAME, PARAMS, GOALS, HORIZONS, QUESTIONS, PATHWAYS, check, paramsOf,
  productFor, defaultProduct: async () => (await allProducts()).find(isDefault) || null, ensureDefaultProduct,
  getSettings, rotateSecret, checkSecret, hookUrls,
  factsFromAnswers, deliveryScenarios, targetFrom, plan, inferHistory, suggestionFor, gestation,
  enrol, update, contribute, setStatus, bridgeWithInsureCredit, byTokenOrThrow, view, publicView, list, findByPhone, runReminders, run,
};
