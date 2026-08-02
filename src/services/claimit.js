'use strict';

const crypto = require('crypto');
const store = require('../store');
const fees = require('./fees');
const pricing = require('./pricing');

/**
 * NHIS ClaimIt tracker — supports TWO operating modes.
 *
 *  1. mode: 'routed'   — the bill was raised in HNN Biller and routed to the
 *     NHIS ClaimIt tab. We derive the claim from that bill.
 *
 *  2. mode: 'external' — THE COMMON CASE. The NHIS claim is submitted and settled
 *     elsewhere (the EMR or the ClaimIt portal itself). HNN Biller simply RECEIVES
 *     the claim data — how much is being claimed, for whom — and tracks the refund
 *     and cashback. No bill is required; a billId may optionally be linked.
 *
 * Either way the refund from the sponsoring insurer (e.g. Acacia, up to 100% of the
 * NHIS amount) becomes the member's cashback, and the configured `claimit_margin`
 * pricing rule is accrued as SaaS revenue.
 *
 * REFUND DESTINATION — who actually receives the insurer's refund:
 *   'provider' (default) : it lands with the clinic, who passes the cashback to the
 *                          member. A member-charged margin can be NETTED at source.
 *   'member'             : the insurer pays the member directly. We never touch that
 *                          money, so a member-charged margin cannot be netted — it is
 *                          INVOICED to the member instead. The provider owes nothing on.
 *
 * Lifecycle: submitted -> acknowledged -> refunded | rejected
 */

const round = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Create a tracking record.
 * Routed:   track({ bill, ... })
 * External: track({ tenantId, provider, nhisAmount, patientName, memberId, ... })
 */
async function track(input = {}) {
  const { bill } = input;
  const mode = input.mode || (bill ? 'routed' : 'external');

  const tenantId = bill ? bill.tenantId : input.tenantId;
  if (!tenantId) { const e = new Error('tenant_required'); e.status = 422; throw e; }

  const amount = Number(input.nhisAmount != null ? input.nhisAmount : (bill ? bill.totals.net : NaN));
  if (!Number.isFinite(amount) || amount <= 0) {
    const e = new Error('nhisAmount_required'); e.status = 422; throw e;
  }

  const provider = input.provider || (bill ? bill.provider : null);
  if (!provider) { const e = new Error('provider_required'); e.status = 422; throw e; }

  // Idempotent on the NHIS claim number, so repeated EMR pushes don't duplicate.
  if (input.nhisClaimNumber) {
    const existing = await store.claimit.byClaimNumber(tenantId, input.nhisClaimNumber);
    if (existing) return existing;
  }

  const pct = Math.min(100, Math.max(0, Number(input.refundPercent ?? 100))) / 100;
  const rec = {
    id: `cit_${crypto.randomBytes(7).toString('hex')}`,
    mode,
    tenantId,
    billId: bill ? bill.id : (input.billId || null),
    provider,
    patientName: input.patientName || (bill ? bill.patient?.name : null) || null,
    memberId: input.memberId || (bill ? bill.coverage?.memberId : null) || null,
    nhisClaimNumber: input.nhisClaimNumber || null,
    externalRef: input.externalRef || null,   // the EMR's own id for this claim
    source: input.source || (mode === 'external' ? 'emr' : 'hnn_biller'),
    nhisAmount: round(amount),                // amount being claimed
    refundPercent: pct,
    refundedBy: input.refundedBy || 'acacia',
    refundDestination: input.refundDestination === 'member' ? 'member' : 'provider',
    expectedRefund: round(amount * pct),
    claimedAt: input.claimedAt || new Date().toISOString(),
    cashbackAmount: 0,
    marginFee: 0,
    netCashbackToMember: 0,
    cashbackOwedToMember: 0,
    marginCollection: null,
    currency: input.currency || (bill ? bill.currency : 'GHS'),
    status: input.status || 'submitted',
    createdAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), status: input.status || 'submitted', note: `${mode} intake` }],
  };
  await store.claimit.insert(rec);
  return rec;
}

/**
 * Bulk intake from an EMR / ClaimIt export. Idempotent on nhisClaimNumber.
 */
async function ingest(tenantId, rows = []) {
  const created = [], duplicates = [], errors = [];
  for (const row of rows) {
    try {
      const before = row.nhisClaimNumber
        ? await store.claimit.byClaimNumber(tenantId, row.nhisClaimNumber) : null;
      const rec = await track({ ...row, tenantId, mode: 'external' });
      (before ? duplicates : created).push(rec);
    } catch (e) {
      errors.push({ row, error: e.message });
    }
  }
  return { received: rows.length, created: created.length, duplicates: duplicates.length, errors, data: created };
}

async function setStatus(id, status, note) {
  const rec = await store.claimit.get(id);
  if (!rec) { const e = new Error('claimit_not_found'); e.status = 404; throw e; }
  rec.status = status;
  rec.history.push({ at: new Date().toISOString(), status, note: note || null });
  await store.claimit.update(rec);
  return rec;
}

/** Record the refund received; computes cashback and accrues the SaaS margin. */
async function recordRefund(id, { amount, reference } = {}) {
  const rec = await store.claimit.get(id);
  if (!rec) { const e = new Error('claimit_not_found'); e.status = 404; throw e; }
  if (rec.status === 'refunded') return rec; // idempotent

  const refund = round(amount != null ? Number(amount) : rec.expectedRefund);
  rec.cashbackAmount = refund;
  rec.refundReference = reference || null;

  const rule = await pricing.getRule(rec.tenantId, 'claimit_margin');
  const fee = pricing.compute(rule, refund, { event: 'claimit_cashback' });
  rec.marginFee = fee ? fee.amount : 0;
  rec.marginChargedTo = fee ? fee.chargeTo : null;

  // Destination decides how a member-charged margin is collected.
  const paidDirectToMember = rec.refundDestination === 'member';
  rec.marginCollection = !fee ? null
    : rec.marginChargedTo === 'member'
      ? (paidDirectToMember ? 'invoice' : 'netted_from_cashback')
      : (rec.marginChargedTo === 'insurer' ? 'reverse_bill' : 'invoice');

  // The member's net economic position, whichever way the money arrived.
  rec.netCashbackToMember = round(rec.marginChargedTo === 'member' ? refund - rec.marginFee : refund);
  // What the provider still has to hand over. Zero if the insurer paid the member direct.
  rec.cashbackOwedToMember = paidDirectToMember ? 0 : rec.netCashbackToMember;
  rec.status = 'refunded';
  rec.refundedAt = new Date().toISOString();
  rec.history.push({ at: rec.refundedAt, status: 'refunded',
    note: `refund ${refund} to ${rec.refundDestination}${rec.marginFee ? ` · margin ${rec.marginFee} (${rec.marginCollection})` : ''}` });
  await store.claimit.update(rec);

  if (fee) {
    // Works for both modes: use the bill when we have one, else a bill-like context.
    const bill = rec.billId ? await store.bills.get(rec.billId) : null;
    const ctx = bill || {
      tenantId: rec.tenantId, id: null, provider: rec.provider, currency: rec.currency,
      patient: { name: rec.patientName }, coverage: { payerId: rec.refundedBy },
    };
    await fees.onClaimitCashback(rec, ctx);
  }
  return rec;
}

async function listByTenant(tenantId) { return store.claimit.listByTenant(tenantId); }

async function summary(tenantId) {
  const rows = await listByTenant(tenantId);
  const sum = (f) => round(rows.reduce((s, r) => s + (Number(f(r)) || 0), 0));
  return {
    tracked: rows.length,
    routed: rows.filter((r) => r.mode === 'routed').length,
    external: rows.filter((r) => r.mode === 'external').length,
    submitted: rows.filter((r) => r.status === 'submitted').length,
    refunded: rows.filter((r) => r.status === 'refunded').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
    nhisValue: sum((r) => r.nhisAmount),
    expectedRefunds: sum((r) => (r.status === 'refunded' ? 0 : r.expectedRefund)),
    cashbackPaid: sum((r) => r.cashbackAmount),
    cashbackOwedToMembers: sum((r) => r.cashbackOwedToMember),
    refundToProvider: rows.filter((r) => r.refundDestination !== 'member').length,
    refundToMember: rows.filter((r) => r.refundDestination === 'member').length,
    marginRevenue: sum((r) => r.marginFee),
  };
}

module.exports = { track, ingest, setStatus, recordRefund, listByTenant, summary };
