'use strict';

/**
 * Product Development Environment — metric library.
 *
 * A non-technical product manager builds a VBC program (or a campaign, or a
 * loyalty program) in services/products.js by picking FROM this library
 * rather than inventing metrics from scratch — the "guided templates" half of
 * the hybrid builder you asked for. What they *can* configure per metric is
 * its weight (VBC) and a few threshold params (metricParams on the product);
 * the clinical/behavioural definition of the metric itself is fixed here so
 * two programs that both pick "HbA1c at target" are measuring the same thing.
 *
 * Every metric's compute(ctx) returns one of:
 *   - a 0..1 rate                 — the normal case; see rateOf()
 *   - null                        — not computable yet (no observations of
 *                                    that type at all) — the caller (see
 *                                    services/incentives.js#weightedScore)
 *                                    must EXCLUDE a null metric from the
 *                                    weighted score, never treat it as 0.
 *                                    Zero genuine events (e.g. truly zero
 *                                    complications among enrollees) is a real
 *                                    0, not null — rateOf() only returns null
 *                                    when the denominator itself is 0.
 *   - a raw count (`rawScore`)    — campaign/loyalty "how many times did this
 *                                    happen" metrics. These are reporting/
 *                                    dashboard numbers, not inputs to the VBC
 *                                    weighted score — see incentives.js for
 *                                    why campaigns and loyalty programs price
 *                                    off a flat per-action reward instead of
 *                                    a composite score (that's what actually
 *                                    fits "pay $X per completed screening" /
 *                                    "$X per wellness visit", vs. VBC's
 *                                    "pay on a blended outcome score").
 *
 * ctx passed into compute(): { observations, enrolledCount, params }
 *   - observations : clinical_observations rows already filtered to this
 *     product's payer + condition + measurement period (services/
 *     incentives.js does that filtering; this file never touches the store).
 *   - enrolledCount: population size for this period, when the caller knows
 *     it explicitly (e.g. a payer's declared enrollment list); falls back to
 *     the distinct member count seen in `observations` when omitted — the
 *     attribution model this app uses by default (see services/products.js).
 *   - params       : the product's own metricParams (clinical thresholds) —
 *     falls back to the defaults noted next to each helper below.
 */

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** A rate is only meaningful once there's a denominator — 0/0 is "no data
 *  yet", not "0%". Callers must treat null as "exclude", not "score zero". */
function rateOf(numerator, denominator) {
  if (!denominator) return null;
  return round2(numerator / denominator);
}

function distinctMemberCount(observations) {
  return new Set(observations.map((o) => o.memberId)).size;
}

function countByType(observations, type) {
  return observations.filter((o) => o.type === type).length;
}

// Blood pressure "at target": systolic/diastolic below the given thresholds.
// Defaults (140/90) mirror the common primary-care hypertension-control
// benchmark; a program can tighten/loosen via metricParams.
function bpControlRate(observations, params = {}) {
  const sysTarget = params.systolicTarget || 140;
  const diaTarget = params.diastolicTarget || 90;
  const readings = observations.filter((o) => o.type === 'blood_pressure');
  if (!readings.length) return null;
  const atTarget = readings.filter((o) => {
    const sys = o.systolic != null ? Number(o.systolic) : Number(o.value);
    const dia = o.diastolic != null ? Number(o.diastolic) : null;
    return Number.isFinite(sys) && sys < sysTarget && (dia == null || dia < diaTarget);
  });
  return rateOf(atTarget.length, readings.length);
}

// HbA1c "at target" — default 7.0%, a standard general-population diabetes
// control benchmark; override per program via metricParams.hba1cTarget.
function hba1cControlRate(observations, params = {}) {
  const target = params.hba1cTarget || 7.0;
  const readings = observations.filter((o) => o.type === 'hba1c');
  if (!readings.length) return null;
  return rateOf(readings.filter((o) => Number(o.value) <= target).length, readings.length);
}

// LDL "at target" — default 100 mg/dL, a common primary-prevention benchmark;
// override per program via metricParams.ldlTarget.
function lipidControlRate(observations, params = {}) {
  const target = params.ldlTarget || 100;
  const readings = observations.filter((o) => o.type === 'ldl');
  if (!readings.length) return null;
  return rateOf(readings.filter((o) => Number(o.value) <= target).length, readings.length);
}

// Lower is better (flipped to a "good outcome" direction by incentives.js,
// not here — this returns the plain rate). Denominator is the enrolled
// population, not the observation count, so "nobody had a complication" is a
// real, meaningful 0 whenever there's an enrolled population to measure.
function complicationRate(observations, { enrolledCount } = {}) {
  const denom = enrolledCount || distinctMemberCount(observations);
  return rateOf(countByType(observations, 'complication'), denom);
}

// expectedPerEnrollee is a program-level assumption (default: quarterly
// follow-up, i.e. 4/year) about how many follow-ups a well-managed enrollee
// should have in the measurement period — override via metricParams.
function followupAdherenceRate(observations, { enrolledCount, params = {} } = {}) {
  const expected = params.expectedFollowupsPerEnrollee || 4;
  const denom = (enrolledCount || distinctMemberCount(observations)) * expected;
  return rateOf(countByType(observations, 'followup_visit'), denom);
}

// Campaign reporting metric: what fraction of the target population
// completed the tracked action (e.g. a breast-screening visit).
function completionRate(observations, { enrolledCount, targetType = 'screening_completed' } = {}) {
  const completedMembers = new Set(
    observations.filter((o) => o.type === targetType).map((o) => o.memberId));
  const denom = enrolledCount || distinctMemberCount(observations);
  return rateOf(completedMembers.size, denom);
}

const METRICS = [
  // ---- Hypertension ----
  { id: 'htn_bp_control_rate', domain: 'vbc', condition: 'hypertension', label: 'Blood pressure at target', unit: 'rate', higherIsBetter: true,
    compute: (ctx) => bpControlRate(ctx.observations, ctx.params) },
  { id: 'htn_complication_rate', domain: 'vbc', condition: 'hypertension', label: 'Complications per enrollee', unit: 'rate', higherIsBetter: false,
    compute: (ctx) => complicationRate(ctx.observations, ctx) },
  { id: 'htn_followup_adherence', domain: 'vbc', condition: 'hypertension', label: 'Follow-up visit adherence', unit: 'rate', higherIsBetter: true,
    compute: (ctx) => followupAdherenceRate(ctx.observations, ctx) },

  // ---- Diabetes ----
  { id: 'dm_hba1c_control_rate', domain: 'vbc', condition: 'diabetes', label: 'HbA1c at target', unit: 'rate', higherIsBetter: true,
    compute: (ctx) => hba1cControlRate(ctx.observations, ctx.params) },
  { id: 'dm_complication_rate', domain: 'vbc', condition: 'diabetes', label: 'Complications per enrollee', unit: 'rate', higherIsBetter: false,
    compute: (ctx) => complicationRate(ctx.observations, ctx) },
  { id: 'dm_followup_adherence', domain: 'vbc', condition: 'diabetes', label: 'Follow-up visit adherence', unit: 'rate', higherIsBetter: true,
    compute: (ctx) => followupAdherenceRate(ctx.observations, ctx) },

  // ---- Dyslipidemia ----
  { id: 'dlp_lipid_control_rate', domain: 'vbc', condition: 'dyslipidemia', label: 'LDL at target', unit: 'rate', higherIsBetter: true,
    compute: (ctx) => lipidControlRate(ctx.observations, ctx.params) },
  { id: 'dlp_complication_rate', domain: 'vbc', condition: 'dyslipidemia', label: 'Complications per enrollee', unit: 'rate', higherIsBetter: false,
    compute: (ctx) => complicationRate(ctx.observations, ctx) },
  { id: 'dlp_followup_adherence', domain: 'vbc', condition: 'dyslipidemia', label: 'Follow-up visit adherence', unit: 'rate', higherIsBetter: true,
    compute: (ctx) => followupAdherenceRate(ctx.observations, ctx) },

  // ---- Promotional campaigns (reporting only — see incentives.js) ----
  { id: 'campaign_completion_rate', domain: 'campaign', condition: null, label: 'Target action completion', unit: 'rate', higherIsBetter: true,
    compute: (ctx) => completionRate(ctx.observations, ctx) },

  // ---- Loyalty / wellbeing programs (reporting only — see incentives.js) ----
  { id: 'loyalty_action_count', domain: 'loyalty', condition: null, label: 'Qualifying actions (count)', unit: 'count', higherIsBetter: true, rawScore: true,
    compute: (ctx) => countByType(ctx.observations, ctx.params?.qualifyingAction || 'wellness_visit') },
];

const CONDITIONS = [
  { id: 'hypertension', label: 'Hypertension' },
  { id: 'diabetes', label: 'Diabetes' },
  { id: 'dyslipidemia', label: 'Dyslipidemia' },
];

function listMetrics({ domain, condition } = {}) {
  return METRICS.filter((m) =>
    (!domain || m.domain === domain) && (condition === undefined || m.condition === condition));
}

function getMetric(id) {
  return METRICS.find((m) => m.id === id) || null;
}

module.exports = { METRICS, CONDITIONS, listMetrics, getMetric, rateOf, distinctMemberCount };
