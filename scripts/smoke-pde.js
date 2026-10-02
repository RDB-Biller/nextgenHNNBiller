'use strict';
// Smoke test for the Product Development Environment: clinical observations
// (services/observations.js), the product builder (services/products.js),
// the metric library (services/metricsLibrary.js), and the incentive engine
// (services/incentives.js) -- covering all three product types (VBC,
// promotional campaign, loyalty/discount program) end to end against the
// in-memory store. Run: node scripts/smoke-pde.js

const store = require('../src/store');
const products = require('../src/services/products');
const observations = require('../src/services/observations');
const incentives = require('../src/services/incentives');
const metricsLibrary = require('../src/services/metricsLibrary');

let a = 0;
const ok = (cond, label) => {
  a++;
  if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else { console.log(`ok  : ${label}`); }
};
const approx = (x, y, eps = 0.01) => Math.abs(Number(x) - Number(y)) <= eps;

const EMR = { id: 'emr_test_1', name: 'Test EMR Partner', apiKey: 'emr_test_key' };
const DAY = (n) => new Date(Date.UTC(2026, 0, n)).toISOString();

async function seed() {
  await store.payers.save({ id: 'pay_vbc', kind: 'insurer', name: 'VBC Test Insurer' });
  await store.tenants.save({ id: 'ten_good', name: 'Good Outcomes Hospital' });
  await store.tenants.save({ id: 'ten_bad', name: 'Struggling Clinic' });
  await store.emrPartners.save(EMR);
}

// ---- 1. Observations ingestion ---------------------------------------------
async function observationsChecks() {
  const o = await observations.record(EMR, {
    payerId: 'pay_vbc', memberId: 'mem_1', tenantId: 'ten_good',
    condition: 'hypertension', type: 'blood_pressure', systolic: 128, diastolic: 80, recordedAt: DAY(5),
  });
  ok(o.id.startsWith('obs_') && o.emrPartnerId === EMR.id, 'record() stores an observation tagged to the sending EMR partner');

  let threw = null;
  try { await observations.record(EMR, { payerId: 'pay_vbc', memberId: 'mem_1', type: 'not_a_real_type' }); }
  catch (e) { threw = e; }
  ok(threw && threw.status === 422, 'record() rejects an unknown observation type');

  threw = null;
  try { await observations.record(EMR, { payerId: 'pay_nonexistent', memberId: 'mem_1', type: 'blood_pressure' }); }
  catch (e) { threw = e; }
  ok(threw && threw.status === 404, 'record() rejects an observation for an unknown payer');

  const batch = await observations.recordBatch(EMR, { observations: [
    { payerId: 'pay_vbc', memberId: 'mem_2', type: 'hba1c', value: 6.5, condition: 'diabetes', recordedAt: DAY(1) },
    { payerId: 'pay_vbc', memberId: 'mem_3', type: 'hba1c', value: 9.1, condition: 'diabetes', recordedAt: DAY(1) },
  ] });
  ok(batch.length === 2, 'recordBatch() accepts {observations:[...]} and records each one');
}

// ---- 2. Product builder validation -----------------------------------------
async function productValidationChecks() {
  let threw = null;
  try { await products.create('pay_vbc', { type: 'vbc', name: 'Bad', config: { condition: 'hypertension', metrics: [{ metricId: 'dm_hba1c_control_rate', weight: 1 }] } }); }
  catch (e) { threw = e; }
  ok(threw && threw.status === 422 && threw.message === 'metric_condition_mismatch',
    'create() rejects a diabetes metric on a hypertension program');

  threw = null;
  try { await products.create('pay_vbc', { type: 'vbc', name: 'Bad', config: { condition: 'hypertension', metrics: [{ metricId: 'no_such_metric', weight: 1 }] } }); }
  catch (e) { threw = e; }
  ok(threw && threw.message === 'unknown_metric', 'create() rejects an unknown metric id');

  threw = null;
  try { await products.create('pay_vbc', { type: 'homeopathy', name: 'Bad', config: {} }); }
  catch (e) { threw = e; }
  ok(threw && threw.message === 'invalid_type', 'create() rejects a type outside vbc/campaign/loyalty');

  threw = null;
  try { await products.create('pay_does_not_exist', { type: 'vbc', name: 'x', config: { condition: 'hypertension', metrics: [{ metricId: 'htn_bp_control_rate', weight: 1 }] } }); }
  catch (e) { threw = e; }
  ok(threw && threw.status === 404, 'create() rejects an unknown payer');
}

// ---- 3. VBC: hypertension program with two providers of different quality --
async function vbcChecks() {
  const program = await products.create('pay_vbc', {
    type: 'vbc', name: 'Hypertension VBC Pilot',
    config: {
      condition: 'hypertension',
      providers: ['ten_good', 'ten_bad'],
      metrics: [
        { metricId: 'htn_bp_control_rate', weight: 0.5 },
        { metricId: 'htn_complication_rate', weight: 0.3 },
        { metricId: 'htn_followup_adherence', weight: 0.2 },
      ],
      metricParams: { expectedFollowupsPerEnrollee: 2 },
      providerTiers: [
        { kind: 'bonus', minScore: 75, amount: 500, currency: 'GHS' },
        { kind: 'penalty', maxScore: 40, amount: 200, currency: 'GHS' },
      ],
      patientCashback: { minScore: 80, amount: 20, currency: 'GHS' },
    },
  }, 'pm@insurer');
  ok(program.status === 'draft' && program.config.metrics.length === 3, 'create() builds a VBC program in draft status with 3 weighted metrics');

  let threw = null;
  try { await products.setStatus(program.id, 'live', 'pm@insurer'); }
  catch (e) { threw = e; }
  ok(threw && threw.message === 'invalid_transition', 'setStatus() refuses to skip draft -> live without passing through sandbox');

  await products.setStatus(program.id, 'sandbox', 'pm@insurer');
  const live = await products.setStatus(program.id, 'live', 'pm@insurer');
  ok(live.status === 'live' && !!live.publishedAt, 'setStatus() allows draft -> sandbox -> live and stamps publishedAt once');

  // ten_good: 4 enrollees, mostly at target, 1 complication, decent follow-up.
  const goodObs = [
    { payerId: 'pay_vbc', memberId: 'g1', tenantId: 'ten_good', condition: 'hypertension', type: 'blood_pressure', systolic: 125, diastolic: 78, recordedAt: DAY(10) },
    { payerId: 'pay_vbc', memberId: 'g2', tenantId: 'ten_good', condition: 'hypertension', type: 'blood_pressure', systolic: 130, diastolic: 82, recordedAt: DAY(10) },
    { payerId: 'pay_vbc', memberId: 'g3', tenantId: 'ten_good', condition: 'hypertension', type: 'blood_pressure', systolic: 118, diastolic: 75, recordedAt: DAY(10) },
    { payerId: 'pay_vbc', memberId: 'g4', tenantId: 'ten_good', condition: 'hypertension', type: 'blood_pressure', systolic: 145, diastolic: 92, recordedAt: DAY(10) },
    { payerId: 'pay_vbc', memberId: 'g1', tenantId: 'ten_good', condition: 'hypertension', type: 'followup_visit', recordedAt: DAY(11) },
    { payerId: 'pay_vbc', memberId: 'g2', tenantId: 'ten_good', condition: 'hypertension', type: 'followup_visit', recordedAt: DAY(11) },
    { payerId: 'pay_vbc', memberId: 'g3', tenantId: 'ten_good', condition: 'hypertension', type: 'followup_visit', recordedAt: DAY(11) },
    { payerId: 'pay_vbc', memberId: 'g4', tenantId: 'ten_good', condition: 'hypertension', type: 'followup_visit', recordedAt: DAY(11) },
    { payerId: 'pay_vbc', memberId: 'g1', tenantId: 'ten_good', condition: 'hypertension', type: 'followup_visit', recordedAt: DAY(20) },
  ];
  // ten_bad: 4 enrollees, mostly off target, 3 complications, weak follow-up.
  const badObs = [
    { payerId: 'pay_vbc', memberId: 'b1', tenantId: 'ten_bad', condition: 'hypertension', type: 'blood_pressure', systolic: 160, diastolic: 98, recordedAt: DAY(10) },
    { payerId: 'pay_vbc', memberId: 'b2', tenantId: 'ten_bad', condition: 'hypertension', type: 'blood_pressure', systolic: 155, diastolic: 95, recordedAt: DAY(10) },
    { payerId: 'pay_vbc', memberId: 'b3', tenantId: 'ten_bad', condition: 'hypertension', type: 'blood_pressure', systolic: 128, diastolic: 80, recordedAt: DAY(10) },
    { payerId: 'pay_vbc', memberId: 'b4', tenantId: 'ten_bad', condition: 'hypertension', type: 'blood_pressure', systolic: 170, diastolic: 100, recordedAt: DAY(10) },
    { payerId: 'pay_vbc', memberId: 'b1', tenantId: 'ten_bad', condition: 'hypertension', type: 'complication', recordedAt: DAY(12) },
    { payerId: 'pay_vbc', memberId: 'b2', tenantId: 'ten_bad', condition: 'hypertension', type: 'complication', recordedAt: DAY(13) },
    { payerId: 'pay_vbc', memberId: 'b4', tenantId: 'ten_bad', condition: 'hypertension', type: 'complication', recordedAt: DAY(14) },
  ];
  for (const o of [...goodObs, ...badObs]) await observations.record(EMR, o);

  const period = { from: DAY(1), to: DAY(31) };
  const result = await incentives.compute(live, period);
  const good = result.providers.find((p) => p.tenantId === 'ten_good');
  const bad = result.providers.find((p) => p.tenantId === 'ten_bad');

  ok(good.score > bad.score, `the better-performing provider scores higher (good=${good.score}, bad=${bad.score})`);
  ok(good.kind === 'bonus' && good.amount === 500, 'the good provider lands in the bonus tier at the configured amount');
  ok(bad.kind === 'penalty' && bad.amount === 200, 'the struggling provider lands in the penalty tier at the configured amount');

  // Patient cashback: g1/g2/g3 are at BP target (the program's first metric) -> qualify; g4 and all of ten_bad's members are not.
  const qualifyingIds = result.patients.map((p) => p.memberId).sort();
  ok(qualifyingIds.includes('g1') && qualifyingIds.includes('g3') && !qualifyingIds.includes('g4') && !qualifyingIds.includes('b1'),
    'patient cashback is judged per member on their own BP reading, not the provider average');

  const { accrued } = await incentives.accrue(live, period, 'pm@insurer');
  ok(accrued.some((r) => r.beneficiaryType === 'provider' && r.beneficiaryId === 'ten_good' && r.amount === 500), 'accrue() writes the provider bonus row');
  ok(accrued.some((r) => r.beneficiaryType === 'provider' && r.beneficiaryId === 'ten_bad' && r.amount === 200 && r.kind === 'penalty'), 'accrue() writes the provider penalty row');
  ok(accrued.some((r) => r.beneficiaryType === 'patient' && r.beneficiaryId === 'g1' && r.amount === 20), 'accrue() writes a patient cashback row');
  ok(accrued.every((r) => r.productType === 'vbc' && r.productId === live.id), 'every accrual is tagged back to this exact product');

  const byProduct = await incentives.listAccrualsByProduct(live.id);
  ok(byProduct.length === accrued.length, 'listAccrualsByProduct() reflects what accrue() just wrote');

  // Null-exclusion: a metric nobody has reported data for must be EXCLUDED,
  // never scored as 0 -- otherwise a provider with no HbA1c readings at all
  // on a hypertension program would unfairly look identical to "0% at target".
  const noDataScore = incentives.weightedScore(
    [{ metricId: 'dm_hba1c_control_rate', weight: 1 }],
    { observations: [], enrolledCount: 0, params: {} });
  ok(noDataScore.score === null, 'weightedScore() returns null (not 0) when the selected metric has no observations at all');
}

// ---- 4. Promotional campaign: breast screening -----------------------------
async function campaignChecks() {
  const campaign = await products.create('pay_vbc', {
    type: 'campaign', name: 'Breast Screening Drive',
    config: {
      targetAction: 'screening_completed',
      startDate: DAY(1), endDate: DAY(28),
      providers: ['ten_good'],
      patientReward: { amount: 15, currency: 'GHS' },
      providerReward: { amount: 8, currency: 'GHS' },
    },
  }, 'pm@insurer');
  await products.setStatus(campaign.id, 'sandbox', 'pm@insurer');

  await observations.record(EMR, { payerId: 'pay_vbc', memberId: 'c1', tenantId: 'ten_good', type: 'screening_completed', recordedAt: DAY(10) });
  await observations.record(EMR, { payerId: 'pay_vbc', memberId: 'c2', tenantId: 'ten_good', type: 'screening_completed', recordedAt: DAY(15) });
  // Outside the campaign window -- must not count.
  await observations.record(EMR, { payerId: 'pay_vbc', memberId: 'c3', tenantId: 'ten_good', type: 'screening_completed', recordedAt: DAY(40) });

  const result = await incentives.compute(campaign, { from: DAY(1), to: DAY(60) });
  ok(result.patients.length === 2, 'only completions inside the campaign window count, even though the compute period is wider');
  ok(result.providers[0].amount === 16, 'the provider is paid per completion (2 x GHS 8 = GHS 16)');

  const { accrued } = await incentives.accrue(campaign, { from: DAY(1), to: DAY(60) }, 'pm@insurer');
  ok(accrued.filter((r) => r.kind === 'bonus' && r.beneficiaryType === 'patient').length === 2, 'each completing patient gets their own reward row');
}

// ---- 5. Loyalty / wellbeing: spa discount program --------------------------
async function loyaltyChecks() {
  const loyalty = await products.create('pay_vbc', {
    type: 'loyalty', name: 'Wellbeing Spa Cashback',
    config: {
      qualifyingAction: 'wellness_visit', partnerCategory: 'spa',
      rewardPerAction: { amount: 10, currency: 'GHS' },
      capPerPeriod: { amount: 25, periodDays: 30 },
    },
  }, 'pm@insurer');
  await products.setStatus(loyalty.id, 'sandbox', 'pm@insurer');

  for (let i = 0; i < 4; i++) {
    await observations.record(EMR, { payerId: 'pay_vbc', memberId: 'l1', type: 'wellness_visit', recordedAt: DAY(2 + i) });
  }
  await observations.record(EMR, { payerId: 'pay_vbc', memberId: 'l2', type: 'wellness_visit', recordedAt: DAY(5) });

  const result = await incentives.compute(loyalty, { from: DAY(1), to: DAY(31) });
  const l1 = result.patients.find((p) => p.memberId === 'l1');
  const l2 = result.patients.find((p) => p.memberId === 'l2');
  ok(l1.actionCount === 4 && l1.amount === 25, 'l1 earned 4 x GHS10 = GHS40 but is capped at the configured GHS25/period');
  ok(l2.amount === 10, 'l2, under the cap, earns the plain per-visit amount');
}

async function main() {
  await seed();
  await observationsChecks();
  await productValidationChecks();
  await vbcChecks();
  await campaignChecks();
  await loyaltyChecks();

  console.log(`\n${a} checks run.`);
  console.log(process.exitCode === 1 ? '\nPDE CHECK: FAILED' : '\nPDE CHECK: ALL PASSED');
}

main().catch((e) => { console.error('PDE CHECK CRASHED:', e); process.exit(1); });
