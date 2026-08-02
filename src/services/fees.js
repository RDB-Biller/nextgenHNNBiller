'use strict';

const store = require('../store');
const ledger = require('./ledger');
const pricing = require('./pricing');

/**
 * Accrue a computed SaaS fee to the ledger as a receivable owed by `chargeTo`.
 * cashMovement is false: no money moved — this is revenue billed to a party,
 * consistent with the platform never custodying funds.
 */
async function accrue(fee, { bill, currency = 'GHS', refs = {}, collection = null }) {
  if (!fee) return null;
  const entry = ledger.entry({
    tenantId: bill.tenantId,
    billId: bill.id,
    type: `platform_fee_${fee.type}`,
    source: { kind: fee.chargeTo, name: chargeName(fee.chargeTo, bill) },
    amount: fee.amount,
    currency,
    cashMovement: false, // accrued revenue / receivable, not a transfer
    refs: { ...refs, rate: fee.rate, basis: fee.basis, chargeTo: fee.chargeTo, billing: collection || billingMode(fee.chargeTo) },
  });
  await store.ledger.insert(entry);
  return entry;
}

function billingMode(chargeTo) {
  // How the fee is collected from that party.
  if (chargeTo === 'patient' || chargeTo === 'financier') return 'invoice';
  return chargeTo === 'insurer' ? 'reverse_bill'
    : chargeTo === 'member' ? 'netted_from_cashback'
    : 'invoice';
}

function chargeName(chargeTo, bill) {
  if (chargeTo === 'provider' || chargeTo === 'beneficiary') return bill.provider || null;
  if (chargeTo === 'insurer') return bill.coverage?.payerId || null;
  if (chargeTo === 'member') return bill.patient?.name || null;
  return null;
}

/**
 * Expedited-settlement fee, charged when a payer claim settles.
 * NNEST (Narrow Network Expedited Settlement Terms) take precedence: if the payer has
 * live terms with this provider, its rate and charge-to apply. Only genuinely expedited
 * settlements attract the fee — a claim that fell back to standard terms does not.
 */
async function onClaimSettled(claim, bill) {
  const n = claim.nnest;
  if (n && !n.expedited) return null;               // settled, but not expedited: no fee

  let rule;
  if (n && n.inNetwork && n.terms && n.terms.feeRate > 0) {
    rule = { type: 'expedited_settlement', enabled: true, mode: 'percent',
      rate: n.terms.feeRate, chargeTo: n.terms.chargeTo, minFee: 0, maxFee: null };
  } else {
    rule = await pricing.getRule(bill.tenantId, 'expedited_settlement');
  }

  const basis = claim.settlementAmount != null ? claim.settlementAmount : claim.amount;
  const fee = pricing.compute(rule, basis, { event: 'claim_settled' });
  return accrue(fee, { bill, currency: bill.currency,
    refs: { claimId: claim.id, reference: claim.transferReference,
      source: n && n.inNetwork && n.terms ? 'nnest_terms' : 'facility_rule',
      nnest: !!(n && n.inNetwork) } });
}

/**
 * Discount fee, charged on the value of a discount granted to the patient.
 * `discountKind`: standard | referral | linked_payer
 */
async function onDiscountApplied(bill, discountKind = 'standard') {
  const rule = await pricing.getRule(bill.tenantId, 'discount_fee');
  if (rule.appliesTo && !rule.appliesTo.includes(discountKind)) return null;
  const basis = bill.totals?.discount || 0;
  const fee = pricing.compute(rule, basis, { event: 'discount_applied', discountKind });
  return accrue(fee, { bill, currency: bill.currency, refs: { discountKind, discountCode: bill.adjustments?.discountCode } });
}

/**
 * Margin on an NHIS/ClaimIt cashback refunded to a member.
 * `ctx` is a bill, or a bill-like context for externally-settled claims
 * (tenantId, id, provider, currency, patient, coverage).
 */
async function onClaimitCashback(track, ctx) {
  const rule = await pricing.getRule(ctx.tenantId, 'claimit_margin');
  const fee = pricing.compute(rule, track.cashbackAmount, { event: 'claimit_cashback' });
  return accrue(fee, {
    bill: ctx, currency: ctx.currency || 'GHS',
    // A member-charged margin can only be netted when the refund passes through the
    // provider. If the insurer pays the member directly, we never touch it — invoice.
    collection: track.marginCollection || null,
    refs: { claimitId: track.id, refundedBy: track.refundedBy, mode: track.mode,
            refundDestination: track.refundDestination },
  });
}

/** Flat "other charge" for producing a medical report (mini or standard). */
async function onMedicalReport(report, ctx) {
  const type = report.kind === 'detailed' ? 'report_fee_standard' : 'report_fee_mini';
  const rule = await pricing.getRule(ctx.tenantId, type);
  const fee = pricing.compute(rule, null, { event: 'medical_report' });
  return accrue(fee, { bill: ctx, currency: ctx.currency || 'GHS',
    refs: { reportId: report.id, reportKind: report.kind, loanType: report.loanType } });
}

module.exports = { accrue, onClaimSettled, onDiscountApplied, onClaimitCashback, onMedicalReport };
