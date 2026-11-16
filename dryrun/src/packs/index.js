'use strict';
/**
 * Packs add a sector to the same engine: vocabulary, the asset kinds that matter, the scenarios on offer, and the pace checklists.
 * A new sector is a new entry here (or a JSON file in packs/), not new platform code.
 */
const { err } = require('../util');
const ladder = require('../scenarios/adjudicationLadder');
const settle = require('../scenarios/expeditedSettlement');

const SCENARIOS = {
  adjudication_ladder: {
    key: 'adjudication_ladder', label: 'AI adjudication ladder', engine: ladder,
    summary: 'How much of your claims volume can be auto-approved, safely? Sends each claim to auto, assist or escalate and checks what an auto rule would let through.',
    inputs: [{ kind: 'claims_dataset', required: true, syntheticOk: true }, { kind: 'rule_set', required: true, syntheticOk: true }, { kind: 'price_book', required: false, syntheticOk: true }],
    params: [{ key: 'trainSplit', label: 'Holdout split (0 = replay everything; 0.8 = learn on 80%, test on 20%)', default: 0.8 }],
    pace: {
      days: ['Upload 10 to 50 anonymised claims (or use synthetic)', 'Write 2 or 3 auto-approve rules', 'Run, read the lanes and what was flagged', 'Adjust one rule and run again; compare', 'Agree the next step with your team'],
      weeks: ['Week 1: interview claims officers and map the real journey', 'Week 1: upload a labelled sample and your price book', 'Week 2: write the first rule set and run a holdout test', 'Week 3: iterate with the Coach; compare versions', 'Week 4: move the best version to shadow and review with finance and compliance'],
      months: ['Month 1: discovery and data preparation', 'Month 2: build rule sets per product and provider type', 'Month 3: shadow mode against live decisions; measure agreement', 'Month 4: autonomy gate review with management and compliance', 'Month 5 onward: widen the auto lane step by step'],
    },
  },
  expedited_settlement: {
    key: 'expedited_settlement', label: 'Expedited settlement', engine: settle,
    summary: 'What happens if you pay providers earlier for a discount? Estimates which providers take the offer and what it nets you after the cost of paying sooner.',
    inputs: [{ kind: 'claims_dataset', required: true, syntheticOk: true }, { kind: 'payment_plan', required: true, syntheticOk: true }],
    params: [{ key: 'payerCostOfCapitalPct', label: 'Your annual cost of capital, %', default: 18 }, { key: 'providerCostOfFundsMedianPct', label: 'Typical provider cost of funds, % a year (assumption)', default: 35 }, { key: 'providerCostSpread', label: 'Spread between providers', default: 0.5 }],
    pace: {
      days: ['Upload claims or use synthetic', 'Enter your standard payment days and one early-pay tier', 'Run and read uptake and net benefit', 'Try a second tier and compare', 'Decide what to test with real providers'],
      weeks: ['Week 1: confirm your real payment terms and cost of capital', 'Week 2: upload claims by provider and model the tiers', 'Week 3: replace assumptions with provider conversations', 'Week 4: compare, choose, and set the rule by provider category'],
      months: ['Month 1: gather payment history by provider', 'Month 2: model tiers per provider category', 'Month 3: pilot with a few providers', 'Month 4: review actual uptake against the model and recalibrate'],
    },
  },
};
const shell = (key, label, vocab, extra = {}) => ({ key, label, status: 'shell', vocab, scenarios: [], templates: [], note: 'The pack is set up (vocabulary and asset types) with no scenarios yet. Scenarios are added as clients in this sector come on board.', ...extra });
const PACKS = {
  insurer: { key: 'insurer', label: 'Health and general insurers', status: 'ready', vocab: { customer: 'member', transaction: 'claim', provider: 'provider', product: 'plan' }, scenarios: ['adjudication_ladder', 'expedited_settlement'], templates: [{ kind: 'rule_set', name: 'Starter outpatient auto-approve rules', fromSynthetic: true }, { kind: 'payment_plan', name: 'Starter early-pay tiers', data: { baselineDays: 30, tiers: [{ days: 14, discountPct: 10 }, { days: 1, discountPct: 15 }] } }] },
  bank: shell('bank', 'Banks', { customer: 'customer', transaction: 'loan', provider: 'branch', product: 'loan product' }),
  fintech: shell('fintech', 'Fintechs, credit scoring and payment providers', { customer: 'user', transaction: 'transaction', provider: 'partner', product: 'product' }),
  mfi: shell('mfi', 'Microfinance institutions', { customer: 'client', transaction: 'loan', provider: 'field officer', product: 'loan product' }),
  telco: shell('telco', 'Telcos and mobile money', { customer: 'subscriber', transaction: 'transaction', provider: 'agent', product: 'bundle or service' }),
  hospital: shell('hospital', 'Hospitals and clinics', { customer: 'patient', transaction: 'bill', provider: 'department', product: 'service' }),
  pharmacy: shell('pharmacy', 'Pharmacies', { customer: 'customer', transaction: 'sale', provider: 'branch', product: 'medicine or service' }),
  school: shell('school', 'Schools', { customer: 'parent or student', transaction: 'fee payment', provider: 'campus', product: 'fee plan' }),
};
const get = (k) => PACKS[k] || null;
const list = () => Object.values(PACKS).map((p) => ({ key: p.key, label: p.label, status: p.status, scenarios: p.scenarios.length }));
function detail(k) { const p = get(k); if (!p) throw err(404, 'Unknown pack.'); return { ...p, scenarios: p.scenarios.map((s) => { const x = SCENARIOS[s]; return { key: x.key, label: x.label, summary: x.summary, inputs: x.inputs, params: x.params }; }) }; }
function scenario(k) { const s = SCENARIOS[k]; if (!s) throw err(404, 'Unknown scenario.'); return s; }
module.exports = { get, list, detail, scenario, PACKS };
