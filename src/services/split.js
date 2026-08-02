'use strict';

/**
 * Multi-payer split allocation.
 *
 * A bill's NET splits into two parts:
 *   - patientShare  = net * copayPercent   (the patient's own copay, may be 0)
 *   - payerShare    = net - patientShare   (what payers cover between them)
 *
 * The payerShare can be divided among ONE OR MORE payers (insurer + insurer,
 * insurer + employer, etc.). Each payer's portion is expressed as either a
 * percentage of the payerShare or an explicit amount. This module resolves those
 * into exact pesewa amounts that sum precisely to the payerShare (remainder placed
 * on the last payer), so the separate claims never over- or under-pay the bill.
 *
 * Shapes accepted (all optional — a plain single-insurer bill needs none of this):
 *   split: {
 *     payers: [
 *       { payerId, memberId?, percent }   // percent of the payerShare (0..100)
 *       { payerId, memberId?, amount }    // explicit GHS amount
 *     ]
 *   }
 * A payer with `paying:false` (from a UI checkbox) is dropped from the split.
 */

const toPesewas = (ghs) => Math.round(Number(ghs) * 100);
const toGhs = (p) => Math.round(p) / 100;

/**
 * Resolve the split into concrete per-payer amounts.
 * @param payerShareGhs  the covered portion to divide (GHS)
 * @param split          { payers: [...] } or null
 * @param fallbackPayer  { payerId, memberId } used when no split is given (single payer)
 * @returns { payers: [{payerId, memberId, amount, percent}], total, valid, error }
 */
function allocate(payerShareGhs, split, fallbackPayer) {
  const payerShareP = toPesewas(payerShareGhs || 0);

  // No split: the whole payer share goes to the single named payer.
  const list = (split && Array.isArray(split.payers) ? split.payers : [])
    .filter((p) => p && p.payerId && p.paying !== false);

  if (list.length === 0) {
    if (!fallbackPayer || !fallbackPayer.payerId) {
      return { payers: [], total: 0, valid: false, error: 'no_payer' };
    }
    return {
      payers: [{ payerId: fallbackPayer.payerId, memberId: fallbackPayer.memberId || null,
        amount: toGhs(payerShareP), percent: 100 }],
      total: toGhs(payerShareP), valid: true, single: true,
    };
  }

  // Two modes: explicit amounts, or percentages. If any entry has an amount we treat
  // the whole split as amount-based; otherwise percentage-based.
  const amountBased = list.some((p) => p.amount != null);
  let allocatedP = 0;
  const out = [];

  if (amountBased) {
    for (const p of list) {
      const aP = toPesewas(p.amount || 0);
      allocatedP += aP;
      out.push({ payerId: p.payerId, memberId: p.memberId || null, amount: toGhs(aP),
        percent: payerShareP > 0 ? Math.round((aP / payerShareP) * 1000) / 10 : 0 });
    }
    // Amount-based splits must sum to the payer share exactly.
    if (allocatedP !== payerShareP) {
      return { payers: out, total: toGhs(allocatedP), valid: false,
        error: 'split_amounts_do_not_match_payer_share',
        expected: toGhs(payerShareP), got: toGhs(allocatedP) };
    }
    return { payers: out, total: toGhs(allocatedP), valid: true };
  }

  // Percentage-based. Percentages should sum to ~100; we normalise defensively and
  // put any rounding remainder on the last payer so the total is exact.
  const pctSum = list.reduce((s, p) => s + (Number(p.percent) || 0), 0) || 100;
  list.forEach((p, idx) => {
    let aP;
    if (idx === list.length - 1) {
      aP = payerShareP - allocatedP; // remainder to the last payer
    } else {
      aP = Math.round(payerShareP * ((Number(p.percent) || 0) / pctSum));
      allocatedP += aP;
    }
    out.push({ payerId: p.payerId, memberId: p.memberId || null, amount: toGhs(aP),
      percent: Math.round(((Number(p.percent) || 0) / pctSum) * 1000) / 10 });
  });
  return { payers: out, total: toGhs(payerShareP), valid: true };
}

/** Validate a split without allocating (for a preview/checkbox UI). */
function validate(payerShareGhs, split, fallbackPayer) {
  const r = allocate(payerShareGhs, split, fallbackPayer);
  return { valid: r.valid, error: r.error || null, payers: r.payers, total: r.total };
}

module.exports = { allocate, validate, toPesewas, toGhs };
