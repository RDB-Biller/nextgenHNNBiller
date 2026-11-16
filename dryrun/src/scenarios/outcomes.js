'use strict';
/**
 * Outcomes-based care. Providers are scored on their OWN patients using a few clinical measures, blended into one 0 to 100 score.
 * The score places each provider in a bonus or penalty band that adjusts what they are paid. Under plain fee-for-service a provider can earn
 * MORE when patients have complications; this shows that, and what changes when pay follows outcomes. How providers respond, and every rate here, are ASSUMPTIONS.
 */
const { rng, round } = require('../util');
const normal = (r) => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const METRICS = {
  hypertension: [{ key: 'control', label: 'Blood pressure under control', base: 52, spread: 12 }, { key: 'adherence', label: 'Follow-up visits kept', base: 60, spread: 14 }, { key: 'screening', label: 'Kidney and heart screening done', base: 40, spread: 12 }, { key: 'complications', label: 'Complications (lower is better)', base: 6, spread: 2.2, lower: true }],
  diabetes: [{ key: 'control', label: 'HbA1c under control', base: 45, spread: 12 }, { key: 'adherence', label: 'Follow-up visits kept', base: 58, spread: 14 }, { key: 'screening', label: 'Eye and foot checks done', base: 35, spread: 12 }, { key: 'complications', label: 'Complications (lower is better)', base: 8, spread: 2.6, lower: true }],
  dyslipidemia: [{ key: 'control', label: 'LDL under control', base: 48, spread: 12 }, { key: 'adherence', label: 'Medicine taken as prescribed', base: 55, spread: 14 }, { key: 'screening', label: 'Annual heart-risk check done', base: 38, spread: 12 }, { key: 'complications', label: 'Heart events (lower is better)', base: 4, spread: 1.6, lower: true }],
};
const DEFAULT_PROGRAMME = () => ({ name: 'Hypertension outcomes programme (illustrative)', condition: 'hypertension', weights: { control: 40, adherence: 25, screening: 10, complications: 25 },
  bands: [{ minScore: 80, adjPct: 10 }, { minScore: 65, adjPct: 5 }, { minScore: 50, adjPct: 0 }, { minScore: 35, adjPct: -3 }, { minScore: 0, adjPct: -6 }], patientCashback: { enabled: true, amount: 8 }, complicationClawbackPct: 30 });
function scoreOf(prog, rates) { const m = METRICS[prog.condition], w = prog.weights || {}; let num = 0, den = 0; for (const x of m) { const wt = Number(w[x.key]) || 0; den += wt; num += wt * (x.lower ? clamp(100 - 10 * rates[x.key], 0, 100) : rates[x.key]); } return den ? num / den : 0; }
const bandOf = (prog, score) => [...prog.bands].sort((a, b) => b.minScore - a.minScore).find((b) => score >= b.minScore) || { minScore: 0, adjPct: 0 };
function run({ programme, params = {}, seed = 1 }) {
  const prog = programme; if (!METRICS[prog.condition]) throw Object.assign(new Error('Pick hypertension, diabetes or dyslipidemia.'), { status: 422 }); if (!(prog.bands || []).length) throw Object.assign(new Error('Add at least one pay band.'), { status: 422 });
  const N = clamp(Math.round(Number(params.providers ?? 20)), 3, 200), panel = clamp(Math.round(Number(params.patientsPerProvider ?? 150)), 20, 5000), fee = Number(params.feePerPatientYear ?? 900), compCost = Number(params.complicationCost ?? 4000), compBill = Number(params.extraBillPerComplication ?? 1500);
  const response = Number(params.providerResponse ?? 0.6), cashAmt = (prog.patientCashback && prog.patientCashback.enabled) ? Number(prog.patientCashback.amount) || 0 : 0, r = rng(seed); const M = METRICS[prog.condition];
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length; const rows = []; for (let i = 0; i < N; i++) {
    const q = normal(r) * 0.9; const rate = (qq) => Object.fromEntries(M.map((m) => [m.key, clamp(m.base + (m.lower ? -1 : 1) * qq * m.spread, m.lower ? 0.5 : 2, m.lower ? 30 : 98)]));
    const r0 = rate(q), s0 = scoreOf(prog, r0), b0 = bandOf(prog, s0); const q1 = q + response * (Math.abs(b0.adjPct) / 10) * (b0.adjPct < 0 ? 1.4 : 0.8) + response * 0.15; const r1 = rate(q1), s1 = scoreOf(prog, r1), b1 = bandOf(prog, s1);
    const ffs = panel * fee + panel * (r0.complications / 100) * compBill; const base = panel * fee; const adj = base * b1.adjPct / 100; const claw = clamp(Number(prog.complicationClawbackPct) || 0, 0, 100) / 100; const prem = base + adj + panel * (r1.complications / 100) * compBill * (1 - claw);
    rows.push({ id: `P${String(i + 1).padStart(2, '0')}`, scoreBefore: round(s0, 1), score: round(s1, 1), adjPct: b1.adjPct, complicationRateBefore: round(r0.complications, 2), complicationRate: round(r1.complications, 2), controlPct: round(r1.control, 1), ffsRevenue: round(ffs), outcomesRevenue: round(prem), change: round(prem - ffs) });
  }
  const bonus = rows.reduce((s, x) => s + Math.max(0, x.adjPct) * panel * fee / 100, 0), penal = rows.reduce((s, x) => s + Math.max(0, -x.adjPct) * panel * fee / 100, 0);
  const avoided = rows.reduce((s, x) => s + panel * (x.complicationRateBefore - x.complicationRate) / 100, 0), savings = avoided * compCost; const cashEligible = rows.reduce((s, x) => s + panel * x.controlPct / 100, 0), cashCost = cashEligible * cashAmt;
  const _q = 0; const quart = (key) => { const o = [...rows].sort((a, b) => a.complicationRateBefore - b.complicationRateBefore); const k = Math.max(1, Math.floor(N / 4)); return [mean(o.slice(0, k).map((x) => x[key])), mean(o.slice(-k).map((x) => x[key]))]; };
  const corr = (xs, ys) => { const mx = mean(xs), my = mean(ys); let n = 0, dx = 0, dy = 0; xs.forEach((x, i) => { n += (x - mx) * (ys[i] - my); dx += (x - mx) ** 2; dy += (ys[i] - my) ** 2; }); return dx && dy ? n / Math.sqrt(dx * dy) : 0; };
  const clawed = rows.reduce((t, x) => t + panel * (x.complicationRate / 100) * compBill * (clamp(Number(prog.complicationClawbackPct) || 0, 0, 100) / 100), 0); const net = savings + clawed - (bonus - penal) - cashCost; const inPen = rows.filter((x) => x.adjPct < 0).length, inBon = rows.filter((x) => x.adjPct > 0).length;
  return { condition: prog.condition, providers: N, patientsPerProvider: panel, measures: M.map((m) => ({ key: m.key, label: m.label, weight: Number((prog.weights || {})[m.key]) || 0 })), avgScoreBefore: round(mean(rows.map((x) => x.scoreBefore)), 1), avgScore: round(mean(rows.map((x) => x.score)), 1), providersInBonusPct: round(100 * inBon / N, 1), providersInPenaltyPct: round(100 * inPen / N, 1),
    bonusPaid: round(bonus), penaltiesRecouped: round(penal), complicationBillingTakenBack: round(clawed), complicationsAvoided: round(avoided, 1), savings: round(savings), patientCashbackCost: round(cashCost), insurerNet: round(net),
    feeForServiceTrap: { extraPaidToHighComplicationProvidersPct: round(100 * (quart('ffsRevenue')[1] - quart('ffsRevenue')[0]) / quart('ffsRevenue')[0], 1), outcomesGapPct: round(100 * (quart('outcomesRevenue')[1] - quart('outcomesRevenue')[0]) / quart('outcomesRevenue')[0], 1), clawbackPct: clamp(Number(prog.complicationClawbackPct) || 0, 0, 100), explained: 'Under fee-for-service, the providers whose patients have the most complications are paid more. Under outcomes pay, a negative gap means more complications now pay LESS, which is the aim.' },
    bands: [...prog.bands].sort((a, b) => b.minScore - a.minScore).map((b) => ({ ...b, providers: rows.filter((x) => x.adjPct === b.adjPct).length })), topProviders: [...rows].sort((a, b) => b.score - a.score).slice(0, 5), bottomProviders: [...rows].sort((a, b) => a.score - b.score).slice(0, 5),
    gate: { passes: net > 0 && inPen / N <= 0.3, explained: net <= 0 ? 'The programme costs more than the complications it avoids. Lower the bonuses or widen the gap between bands.' : inPen / N > 0.3 ? 'More than 30% of providers land in a penalty band. That is likely to be seen as unfair. Soften the lowest bands.' : 'Net saving is positive and no more than 30% of providers are penalised.' },
    assumptions: { providerResponse: response, complicationCost: compCost, extraBillPerComplication: compBill, note: 'Provider response to bonuses is an assumption. Score each provider only on its own patients and check a pilot before paying on real results.' }, seed };
}
const headline = (r) => ({ avgScore: r.avgScore, complicationsAvoided: r.complicationsAvoided, bonusPaid: r.bonusPaid, insurerNet: r.insurerNet, providersInPenaltyPct: r.providersInPenaltyPct });
const DIRECTION = { avgScore: 'higher', complicationsAvoided: 'higher', bonusPaid: 'info', insurerNet: 'higher', providersInPenaltyPct: 'lower' };
function coach(programme, params, seed, base) {
  let best = null, tried = 0; for (const top of [4, 6, 8, 10, 12, 15]) for (const bottom of [0, 3, 5, 8]) for (const cut of [70, 75, 80, 85]) {
    const cand = { ...programme, bands: [{ minScore: cut, adjPct: top }, { minScore: cut - 15, adjPct: round(top / 2, 1) }, { minScore: cut - 30, adjPct: 0 }, { minScore: cut - 45, adjPct: -round(bottom / 2, 1) }, { minScore: 0, adjPct: -bottom }] }; const r = run({ programme: cand, params, seed }); tried++;
    if (r.providersInPenaltyPct > 30) continue; if (!best || r.insurerNet > best.r.insurerNet) best = { cand, r };
  }
  if (!best || best.r.insurerNet <= base.insurerNet * 1.02) return { suggestions: [], message: `Searched ${tried} band designs. None did clearly better while keeping penalised providers under 30%.` };
  return { suggestions: [{ title: 'Better bonus and penalty bands', changes: best.cand.bands.map((b) => `Score ${b.minScore}+: ${b.adjPct > 0 ? '+' : ''}${b.adjPct}% of the base fee`), expected: { insurerNet: { from: base.insurerNet, to: best.r.insurerNet }, providersInPenaltyPct: { from: base.providersInPenaltyPct, to: best.r.providersInPenaltyPct } }, confidence: 'Based on an assumed provider response. Pilot before paying on real results.', draft: { kind: 'outcomes_programme', data: best.cand } }], message: `Searched ${tried} band designs, keeping penalised providers under 30%.` };
}
module.exports = { run, headline, DIRECTION, DEFAULT_PROGRAMME, METRICS, coach };
