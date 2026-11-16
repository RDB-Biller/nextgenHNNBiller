'use strict';
/**
 * Plans are settings, not code. The platform owner can extend a trial, switch an organisation to paid, override any limit,
 * and cap how many free organisations exist at once.
 */
const { err } = require('./util');
const PLANS = {
  free_trial:     { label: 'Free trial',     limits: { members: 3,  assets: 60,   runsPerMonth: 100,  datasetRows: 20000, surveyResponses: 500 } },
  extended_trial: { label: 'Extended trial', limits: { members: 6,  assets: 150,  runsPerMonth: 300,  datasetRows: 50000, surveyResponses: 2000 } },
  demo:           { label: 'Demo',           limits: { members: 1,  assets: 30,   runsPerMonth: 40,   datasetRows: 3000,  surveyResponses: 30 } },
  paid:           { label: 'Paid',           limits: { members: 50, assets: 2000, runsPerMonth: 5000, datasetRows: 500000, surveyResponses: 50000 } },
};
const isFree = (org) => org.plan !== 'paid' && org.plan !== 'demo';
const isDemo = (org) => org.plan === 'demo';
function assertNotDemo(org, what) { if (org.plan === 'demo') throw err(403, `${what} is turned off in the demo. Request an account to use it.`); }
const limitsFor = (org) => ({ ...(PLANS[org.plan] || PLANS.free_trial).limits, ...(org.limitOverrides || {}) });
const DAY = 86400000;

/** active | grace (still works, warns) | read_only (view and export only) | suspended */
function statusOf(org, now = Date.now()) {
  if (org.suspended) return 'suspended';
  if (org.plan === 'paid' || !org.trialEndsAt) return 'active';
  const end = Date.parse(org.trialEndsAt);
  if (now <= end) return 'active';
  if (now <= end + (org.graceDays ?? 30) * DAY) return 'grace';
  return 'read_only';
}
function daysLeft(org, now = Date.now()) { if (org.plan === 'paid' || !org.trialEndsAt) return null; return Math.ceil((Date.parse(org.trialEndsAt) - now) / DAY); }
function assertWritable(org) {
  const s = statusOf(org);
  if (s === 'suspended') throw err(403, 'This workspace is suspended. Contact the platform owner.');
  if (s === 'read_only') throw err(402, 'The trial has ended and the grace period is over. The workspace is read-only: you can view and export, but not change anything. Ask the platform owner to extend or switch to paid.');
}
function assertRoom(org, what, current) {
  const lim = limitsFor(org)[what];
  if (lim !== undefined && current >= lim) throw err(402, `Your ${PLANS[org.plan].label.toLowerCase()} plan allows ${lim} ${what.replace(/([A-Z])/g, ' $1').toLowerCase()}. Ask the platform owner to raise the limit or switch to paid.`);
}
module.exports = { isDemo, assertNotDemo, PLANS, isFree, limitsFor, statusOf, daysLeft, assertWritable, assertRoom, DAY };
