'use strict';
/**
 * AI adjudication ladder. Sends each claim to one of three lanes and measures how far auto-approval can safely go.
 *   auto      clean claims that match an auto-approve rule settle straight through
 *   assist    flagged claims go to a reviewer with the reasons
 *   escalate  suspected fraud, ineligible members or limit breaches go to medical review / investigation
 * With a labelled sample (a known_issue column) it also reports how many bad claims an auto rule would have let through.
 */
const { rng, median, round } = require('../util');

function shuffle(a, seed) { const r = rng(seed); const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }
const dayOf = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? Math.floor(t / 86400000) : null; };

function medians(ref) { const by = {}; for (const c of ref) (by[c.diagnosis] = by[c.diagnosis] || []).push(c.amount); const m = {}; for (const k of Object.keys(by)) m[k] = median(by[k]); return m; }

function evaluate(claims, ruleSet, priceBook, ref, mult = 1) {
  const st = { tariffTolerancePct: 20, outlierMultiple: 2.5, duplicateWindowDays: 7, ...(ruleSet.settings || {}) };
  const med = medians(ref); const price = new Map((priceBook || []).map((p) => [p.code, p.price]));
  const seen = new Map(); const out = [];
  const sorted = [...claims].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.claim_id).localeCompare(String(b.claim_id)));
  for (const c of sorted) {
    const flags = [];
    if (c.eligible === false) flags.push('ineligible');
    if (c.benefit_limit != null && c.amount > c.benefit_limit) flags.push('over_limit');
    const p = price.get(c.service_code); if (p !== undefined && c.amount > p * (1 + st.tariffTolerancePct / 100)) flags.push('tariff');
    const m = med[c.diagnosis]; if (m && c.amount > m * st.outlierMultiple) flags.push('outlier');
    const key = `${c.member_id}|${c.provider}|${c.service_code}`; const d = dayOf(c.date);
    if (seen.has(key)) { const prev = seen.get(key); if (d !== null && prev !== null && Math.abs(d - prev) <= st.duplicateWindowDays) flags.push('duplicate'); }
    seen.set(key, d);
    let lane, rule = null;
    if (flags.some((f) => ['ineligible', 'duplicate', 'over_limit'].includes(f))) lane = 'escalate';
    else if (flags.length) lane = 'assist';
    else {
      rule = (ruleSet.rules || []).find((r) => (r.icdPrefixes || []).some((pf) => String(c.diagnosis).startsWith(pf)) && c.amount <= r.maxAmount * mult);
      lane = rule ? 'auto' : 'assist'; if (!rule) flags.push('no_auto_rule');
    }
    out.push({ c, lane, flags, rule: rule && rule.name });
  }
  return out;
}
const pct = (n, d) => (d ? round((100 * n) / d, 1) : 0);
function summarise(rows, priceBook) {
  const n = rows.length; const lanes = { auto: 0, assist: 0, escalate: 0 }; const value = { auto: 0, assist: 0, escalate: 0 }; const reasons = {}; const price = new Map((priceBook || []).map((p) => [p.code, p.price]));
  let leakage = 0; const byDx = {}; const labelled = rows.some((r) => r.c.known_issue);
  let tp = 0, fp = 0, fn = 0, missedAuto = 0, issues = 0;
  for (const r of rows) {
    lanes[r.lane]++; value[r.lane] += r.c.amount; for (const f of r.flags) reasons[f] = (reasons[f] || 0) + 1;
    const p = price.get(r.c.service_code);
    if (r.flags.includes('duplicate')) leakage += r.c.amount; else if (r.flags.includes('tariff') && p !== undefined) leakage += r.c.amount - p; else if (r.flags.includes('over_limit') && r.c.benefit_limit != null) leakage += r.c.amount - r.c.benefit_limit; else if (r.flags.includes('ineligible')) leakage += r.c.amount;
    const d = (byDx[r.c.diagnosis] = byDx[r.c.diagnosis] || { claims: 0, auto: 0 }); d.claims++; if (r.lane === 'auto') d.auto++;
    if (labelled) { const bad = r.c.known_issue && r.c.known_issue !== 'none'; if (bad) issues++; const flagged = r.lane !== 'auto'; if (bad && flagged) tp++; else if (!bad && flagged) fp++; else if (bad && !flagged) { fn++; missedAuto++; } }
  }
  const res = { claims: n, lanes: { auto: lanes.auto, assist: lanes.assist, escalate: lanes.escalate }, lanePct: { auto: pct(lanes.auto, n), assist: pct(lanes.assist, n), escalate: pct(lanes.escalate, n) },
    value: { auto: round(value.auto), assist: round(value.assist), escalate: round(value.escalate) }, estimatedLeakage: round(leakage), reasons,
    byDiagnosis: Object.entries(byDx).map(([diagnosis, v]) => ({ diagnosis, claims: v.claims, autoPct: pct(v.auto, v.claims) })).sort((a, b) => b.claims - a.claims) };
  if (labelled) res.calibration = { labelledIssues: issues, flaggedCorrectly: tp, flaggedButClean: fp, missedAndAutoApproved: missedAuto, recallPct: pct(tp, tp + fn), precisionPct: pct(tp, tp + fp), missRatePctOfAuto: pct(missedAuto, lanes.auto) };
  return res;
}
function run({ claims, ruleSet, priceBook, params = {}, seed = 1 }) {
  if (!claims || !claims.length) throw Object.assign(new Error('No claims to adjudicate.'), { status: 422 });
  const split = Number(params.trainSplit || 0); let ref = claims, test = claims, mode = 'replay';
  if (split > 0 && split < 1 && claims.length >= 10) { const s = shuffle(claims, seed); const k = Math.floor(s.length * split); ref = s.slice(0, k); test = s.slice(k); mode = `holdout ${Math.round(split * 100)}/${Math.round((1 - split) * 100)}`; }
  // Duplicate checks use the whole history; only the held-out claims are scored.
  const testIds = new Set(test.map((c) => c.claim_id)); const score = (m) => evaluate(claims, ruleSet, priceBook, ref, m).filter((r) => testIds.has(r.c.claim_id));
  const rows = score(1); const result = summarise(rows, priceBook);
  const target = (ruleSet.settings && ruleSet.settings.autonomyTargetPct) ?? 30, maxMiss = (ruleSet.settings && ruleSet.settings.maxMissRatePct) ?? 0.5;
  const miss = result.calibration ? result.calibration.missRatePctOfAuto : null;
  result.evaluatedOn = test.length; result.method = mode;
  result.ladder = [0.5, 1, 1.5, 2, 3].map((m) => { const s = summarise(score(m), priceBook); return { ruleLimitMultiple: m, autoPct: s.lanePct.auto, missRatePctOfAuto: s.calibration ? s.calibration.missRatePctOfAuto : null }; });
  result.gate = { autonomyTargetPct: target, maxMissRatePct: maxMiss, autoPct: result.lanePct.auto, missRatePct: miss, passes: result.lanePct.auto >= target && (miss === null || miss <= maxMiss), explained: `${result.lanePct.auto >= target ? 'Auto-approval target met' : 'Auto-approval below target'}${miss === null ? '; no labelled issues, so safety was not measured' : (miss <= maxMiss ? '; missed issues within the limit' : '; too many bad claims would be auto-approved')}.` };
  return result;
}
const headline = (r) => ({ autoPct: r.lanePct.auto, assistPct: r.lanePct.assist, escalatePct: r.lanePct.escalate, estimatedLeakage: r.estimatedLeakage, missRatePctOfAuto: r.calibration ? r.calibration.missRatePctOfAuto : null, recallPct: r.calibration ? r.calibration.recallPct : null, gatePasses: r.gate.passes ? 1 : 0 });
const DIRECTION = { autoPct: 'higher', assistPct: 'lower', escalatePct: 'lower', estimatedLeakage: 'info', missRatePctOfAuto: 'lower', recallPct: 'higher', gatePasses: 'higher' };
module.exports = { run, headline, DIRECTION, evaluate, summarise, medians };
