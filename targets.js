'use strict';

const store = require('./../store');

/**
 * Volume targets for payers (insurers/employers). The platform owner sets a target
 * amount over a window (monthly, 6-monthly, yearly, or a custom date range) and
 * tracks how much that payer has actually processed — i.e. the sum of its SETTLED
 * claims (real A2A money moved to clinics) within the window.
 *
 * Progress is measured from the ledger's payer_settlement entries, filtered to the
 * payer and the current period. Targets are stored on the payer record.
 */

const r2 = (n) => Math.round(Number(n) * 100) / 100;

// Compute the [start, end) of the CURRENT period for a target, relative to `now`.
function currentPeriod(target, now = new Date()) {
  const anchor = target.anchor ? new Date(target.anchor) : new Date(now.getFullYear(), 0, 1);
  const period = target.period || 'monthly';

  if (period === 'custom' && target.startDate && target.endDate) {
    return { start: new Date(target.startDate), end: new Date(target.endDate) };
  }

  const monthsPer = period === 'monthly' ? 1 : period === 'sixmonth' ? 6 : 12;
  // How many whole windows have elapsed since the anchor?
  const monthsElapsed = (now.getFullYear() - anchor.getFullYear()) * 12 + (now.getMonth() - anchor.getMonth());
  const windowsElapsed = Math.floor(monthsElapsed / monthsPer);
  const start = new Date(anchor);
  start.setMonth(anchor.getMonth() + windowsElapsed * monthsPer);
  const end = new Date(start);
  end.setMonth(start.getMonth() + monthsPer);
  return { start, end };
}

const LABEL = { monthly: 'Monthly', sixmonth: 'Every 6 months', yearly: 'Yearly', custom: 'Custom period' };

async function setTarget(payerId, { amount, period = 'monthly', anchor = null, startDate = null, endDate = null, currency = 'GHS' }) {
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('payer_not_found'); e.status = 404; throw e; }
  payer.target = {
    amount: Math.max(0, Number(amount) || 0),
    period: ['monthly', 'sixmonth', 'yearly', 'custom'].includes(period) ? period : 'monthly',
    anchor: anchor || new Date().toISOString(),
    startDate: startDate || null,
    endDate: endDate || null,
    currency,
    setAt: new Date().toISOString(),
  };
  await store.payers.save(payer);
  return payer.target;
}

async function clearTarget(payerId) {
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('payer_not_found'); e.status = 404; throw e; }
  delete payer.target;
  await store.payers.save(payer);
  return { cleared: true };
}

/** Sum of settled claim value for a payer within [start, end). */
async function processedInWindow(payerId, start, end) {
  // Ledger is the source of truth: payer_settlement entries are real money moved.
  const rows = await store.ledger.all(50000);
  let total = 0;
  let count = 0;
  for (const e of rows) {
    if (e.type !== 'payer_settlement') continue;
    if (e.source?.id !== payerId) continue;
    const at = new Date(e.createdAt || e.at || 0);
    if (at >= start && at < end) { total += Number(e.amount) || 0; count += 1; }
  }
  return { total: r2(total), count };
}

/** Progress for one payer's target. */
async function progress(payerId, now = new Date()) {
  const payer = await store.payers.get(payerId);
  if (!payer || !payer.target) return null;
  const t = payer.target;
  const { start, end } = currentPeriod(t, now);
  const { total, count } = await processedInWindow(payerId, start, end);
  const pct = t.amount > 0 ? Math.round((total / t.amount) * 1000) / 10 : 0;
  const daysLeft = Math.max(0, Math.ceil((end - now) / 86400000));
  return {
    payerId, payerName: payer.name,
    target: t.amount, currency: t.currency || 'GHS',
    period: t.period, periodLabel: LABEL[t.period] || t.period,
    processed: total, claims: count,
    remaining: r2(Math.max(0, t.amount - total)),
    percent: pct,
    onTrack: pct >= 100 ? true : null, // simple flag; UI can refine vs time elapsed
    periodStart: start.toISOString(), periodEnd: end.toISOString(), daysLeft,
  };
}

/** Progress for every payer that has a target. */
async function allProgress(now = new Date()) {
  const payers = (await store.payers.all()).filter((p) => !p.tenantId && p.target);
  return Promise.all(payers.map((p) => progress(p.id, now)));
}

module.exports = { setTarget, clearTarget, progress, allProgress, currentPeriod };
