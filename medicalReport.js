'use strict';

const crypto = require('crypto');
const { findItem } = require('./catalog');
const store = require('../store');
const fees = require('./fees');

/**
 * Generate a medical report to support a financing request (loan or grant).
 *
 *  - "micro"   : short summary for small facilities (e.g. a MoMo loan).
 *  - "detailed": full report for larger loans/grants.
 *
 * The report is ASSEMBLED from real inputs, never invented:
 *   - the bill's line items, categorised into investigations / medications /
 *     procedures & consultations (corroborating what care was actually billed),
 *   - the clinician's stated diagnosis,
 *   - answers to a structured clinical Q&A.
 * A narrative is composed from those facts. It is auto-generated and explicitly
 * requires clinician sign-off before use. We never assert clinical findings the
 * inputs don't support.
 */

const QUESTIONS = {
  micro: [
    { id: 'complaint', q: 'Main presenting complaint?' },
    { id: 'urgency', q: 'Is treatment urgent or routine?' },
    { id: 'outcome', q: 'Expected outcome with the billed treatment?' },
  ],
  detailed: [
    { id: 'complaint', q: 'Presenting complaint and duration?' },
    { id: 'history', q: 'Relevant history / comorbidities?' },
    { id: 'findings', q: 'Key examination / investigation findings?' },
    { id: 'urgency', q: 'Clinical urgency and risk if untreated?' },
    { id: 'plan', q: 'Treatment plan and why the billed items are needed?' },
    { id: 'prognosis', q: 'Prognosis and expected recovery / follow-up?' },
  ],
};

function questions(kind) { return QUESTIONS[kind] || QUESTIONS.micro; }

// Decide report depth from the financed amount unless explicitly set.
function suggestKind(amount, microThreshold = 500) {
  return Number(amount) <= microThreshold ? 'micro' : 'detailed';
}

function categorise(lineItems = []) {
  const investigations = [], medications = [], procedures = [], other = [];
  for (const it of lineItems) {
    const cat = it.category || (findItem(it.code || it.name) || {}).category;
    const entry = { name: it.name, cost: it.cost };
    if (cat === 'lab') investigations.push(entry);
    else if (cat === 'drug') medications.push(entry);
    else if (cat === 'service') procedures.push(entry);
    else other.push(entry); // custom / unlisted item
  }
  return { investigations, medications, procedures, other };
}

/**
 * Pluggable narrative composer. Default is deterministic so the platform runs
 * offline with no AI keys. To use a real model, set composeNarrative.impl to a
 * function that takes the structured report and returns a string (e.g. an
 * Anthropic API call); see README "AI narrative".
 */
function defaultNarrative(r) {
  const list = (arr) => arr.map((x) => x.name).join(', ') || 'none recorded';
  const lines = [];
  lines.push(`${r.patientName || 'The patient'} was assessed at ${r.provider}${r.diagnosis ? ` with a working diagnosis of ${r.diagnosis}` : ''}.`);
  const a = Object.fromEntries((r.qa || []).map((x) => [x.id, x.a]));
  if (a.complaint) lines.push(`Presenting complaint: ${a.complaint}.`);
  if (a.history) lines.push(`History: ${a.history}.`);
  lines.push(`Investigations billed: ${list(r.investigations)}. Medications: ${list(r.medications)}. Procedures/consultations: ${list(r.procedures)}.`);
  if (a.findings) lines.push(`Findings: ${a.findings}.`);
  if (a.urgency) lines.push(`Urgency: ${a.urgency}.`);
  if (a.plan) lines.push(`Plan: ${a.plan}.`);
  if (a.prognosis) lines.push(`Prognosis: ${a.prognosis}.`);
  lines.push(`The billed items corroborate the care described and support the financing request of ${r.currency} ${Number(r.amountRequested).toFixed(2)} (${r.loanType.replace('_', ' ')}).`);
  return lines.join(' ');
}
const composeNarrative = (r) => (composeNarrative.impl || defaultNarrative)(r);
composeNarrative.impl = null;

async function generate({ bill, kind, diagnosis, qa = [], amountRequested, loanType, clinicianName }) {
  const cats = categorise(bill.lineItems);
  const reportKind = kind || suggestKind(amountRequested ?? bill.totals.patientPayable);
  const base = {
    provider: bill.provider,
    patientName: bill.patient?.name || null,
    diagnosis: diagnosis || null,
    currency: bill.currency,
    amountRequested: amountRequested ?? bill.totals.patientPayable,
    loanType: loanType || 'momo_loan',
    qa: questions(reportKind).map((q) => ({ id: q.id, q: q.q, a: (qa.find((x) => x.id === q.id) || {}).a || null })),
    ...cats,
  };
  const token = crypto.randomBytes(18).toString('base64url');
  const report = {
    id: `rpt_${crypto.randomBytes(8).toString('hex')}`,
    billId: bill.id, tenantId: bill.tenantId,
    kind: reportKind,
    ...base,
    narrative: composeNarrative(base),
    clinicianName: clinicianName || null,
    signedOff: false,
    disclaimer:
      'Auto-generated from billed items and clinician inputs to support a financing request. ' +
      'Not a diagnostic document; requires clinician verification and sign-off. Loan terms are set by the financier.',
    shareToken: token,
    createdAt: new Date().toISOString(),
  };
  await store.reports.insert(report);
  // Other charges: flat fee for producing the report, if configured.
  await fees.onMedicalReport(report, bill);
  return report;
}

const getByToken = (token) => store.reports.byToken(token);

module.exports = { generate, questions, suggestKind, getByToken, composeNarrative };
