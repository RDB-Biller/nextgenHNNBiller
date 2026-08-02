'use strict';

const crypto = require('crypto');
const { findItem } = require('./catalog');

const toPesewas = (ghs) => Math.round(Number(ghs) * 100);
const toGhs = (p) => Math.round(p) / 100;

/**
 * Build a bill and apply the TMS adjustments: discount code, copay % (patient
 * share of net), cashback % (credited to patient). The remainder of net is the
 * PAYER SHARE — what an insurer or employer settles via A2A.
 */
function createBill(input) {
  const {
    provider, patient = {}, items = [], adjustments = {}, routing = 'Regular',
    insurance = {},
  } = input;

  const lineItems = items.map((it) => {
    let { name, cost } = it;
    let category = null;
    const cat = findItem(it.code || it.name);
    if (cat) { name = name || cat.name; cost = cost != null ? cost : cat.price; category = cat.category; }
    if (name == null || cost == null) {
      throw badRequest(`Line item needs a known code or explicit name+cost: ${JSON.stringify(it)}`);
    }
    return { name, cost: Number(cost), category };
  });

  const subtotalP = lineItems.reduce((s, i) => s + toPesewas(i.cost), 0);
  const discountPercent = resolveDiscount(adjustments.discountCode);
  const copayPercent = adjustments.copayPercent == null ? 1 : clampPct(adjustments.copayPercent);
  const cashbackPercent = clampPct(adjustments.cashbackPercent);

  const discountP = Math.round(subtotalP * discountPercent);
  const netP = subtotalP - discountP;
  const patientBeforeCashbackP = Math.round(netP * copayPercent);
  const payerShareP = netP - patientBeforeCashbackP;
  const cashbackP = Math.round(patientBeforeCashbackP * cashbackPercent);
  const patientPayableP = Math.max(0, patientBeforeCashbackP - cashbackP);

  const bill = {
    id: `bill_${crypto.randomBytes(8).toString('hex')}`,
    createdAt: new Date().toISOString(),
    status: 'open', // open -> awaiting_payer | paid -> settled | rejected
    settlementMethod: null, // patient_momo | patient_card | cash | payer_a2a
    provider, patient, routing, currency: 'GHS', lineItems,
    // The payer the patient named (insurer or employer) + policy/sponsor info.
    coverage: {
      payerId: insurance.payerId || insurance.insurerId || null,
      memberId: insurance.memberId || insurance.insuranceNumber || null,
      sponsor: insurance.employer || insurance.sponsor || null, // {name,email} if a 3rd party sponsors the policy
    },
    adjustments: { discountCode: adjustments.discountCode || null, discountPercent, copayPercent, cashbackPercent,
      discountKind: adjustments.discountKind || 'standard', referredBy: adjustments.referredBy || null,
      linkedMemberId: adjustments.linkedMemberId || null },
    totals: {
      subtotal: toGhs(subtotalP), discount: toGhs(discountP), net: toGhs(netP),
      payerShare: toGhs(payerShareP), cashback: toGhs(cashbackP), patientPayable: toGhs(patientPayableP),
    },
  };
  return bill;
}

function resolveDiscount(code) {
  if (!code) return 0;
  return ({ WELCOME10: 0.1, STAFF20: 0.2, NHIS5: 0.05 })[String(code).toUpperCase()] || 0;
}
function clampPct(v) {
  if (v == null) return 0;
  const n = Number(v); if (Number.isNaN(n)) return 0;
  const frac = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, frac));
}
function badRequest(m) { const e = new Error(m); e.status = 400; return e; }

module.exports = { createBill, toPesewas, toGhs };
