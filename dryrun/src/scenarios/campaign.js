'use strict';
/**
 * Marketing campaign. Picks the audience from a customer list, sends over the chosen channels, and estimates responses, sign-ups,
 * cost and first-year margin. Response rates and the effect of an offer are ASSUMPTIONS until a small live test replaces them.
 */
const { rng, round } = require('../util');
const DEFAULT_CAMPAIGN = () => ({ name: 'Win-back and new member offer (illustrative)', audience: { segment: 'prospect', minAge: 22, maxAge: 55, regions: [] },
  channels: [{ channel: 'sms', costPerContact: 0.05, responseRatePct: 2.5 }, { channel: 'whatsapp', costPerContact: 0.08, responseRatePct: 4 }], offer: { discountPct: 5 },
  product: { monthlyPremium: 60, marginPct: 22, firstYearRetentionPct: 70 }, budget: 2000 });

function run({ customers, campaign, params = {}, seed = 1 }) {
  if (!customers || !customers.length) throw Object.assign(new Error('No customers to target.'), { status: 422 });
  const c = campaign; const a = c.audience || {}; const r = rng(seed); const lift = Number(params.responseLiftPerDiscountPoint ?? 6) / 100;
  const pool = customers.filter((x) => (!a.segment || a.segment === 'all' || String(x.segment || x.plan_status || 'prospect') === a.segment) && (a.minAge == null || Number(x.age) >= a.minAge) && (a.maxAge == null || Number(x.age) <= a.maxAge) && (!(a.regions || []).length || a.regions.includes(x.region)));
  const chans = c.channels || []; if (!chans.length) throw Object.assign(new Error('The campaign needs at least one channel.'), { status: 422 });
  const disc = Number((c.offer || {}).discountPct) || 0, prem = Number((c.product || {}).monthlyPremium) || 0, mg = (Number((c.product || {}).marginPct) || 0) / 100, ret = (Number((c.product || {}).firstYearRetentionPct) || 100) / 100;
  const budget = Number(c.budget) || Infinity; let spent = 0; const out = chans.map((ch) => ({ channel: ch.channel, contacted: 0, responses: 0, signups: 0, cost: 0 }));
  const order = [...pool].sort((x, y) => String(x.pid).localeCompare(String(y.pid))); let reached = 0;
  for (const cust of order) {
    const i = Math.floor(r() * chans.length), ch = chans[i], cost = Number(ch.costPerContact) || 0; if (spent + cost > budget) continue; spent += cost; reached++;
    const age = Number(cust.age) || 35, fit = 1 + (age >= 25 && age <= 45 ? 0.25 : -0.1) + (Number(cust.tenure_months) > 12 ? 0.1 : 0); const pResp = Math.min(0.6, (Number(ch.responseRatePct) / 100) * fit * (1 + lift * disc));
    const o = out[i]; o.contacted++; o.cost += cost; if (r() < pResp) { o.responses++; if (r() < 0.35) o.signups++; }
  }
  const signups = out.reduce((s, o) => s + o.signups, 0), responses = out.reduce((s, o) => s + o.responses, 0);
  const revenue = signups * prem * (1 - disc / 100) * 12 * ret, margin = revenue * mg - spent;
  const per = out.map((o) => ({ ...o, cost: round(o.cost), cpa: o.signups ? round(o.cost / o.signups) : null, responseRatePct: o.contacted ? round(100 * o.responses / o.contacted, 2) : 0 }));
  return { audienceSize: pool.length, reached, responses, signups, spend: round(spent), firstYearRevenue: round(revenue), margin: round(margin), roiPct: spent ? round(100 * margin / spent, 1) : null, costPerSignup: signups ? round(spent / signups) : null, byChannel: per, discountPct: disc,
    budgetUsedPct: Number.isFinite(budget) ? round(100 * spent / budget, 1) : null, assumptions: { responseLiftPerDiscountPoint: lift * 100, signupShareOfResponders: 35, note: 'Illustrative. Run a small live test and put the real rates in.' }, seed };
}
const headline = (r) => ({ signups: r.signups, spend: r.spend, margin: r.margin, roiPct: r.roiPct, costPerSignup: r.costPerSignup });
const DIRECTION = { signups: 'higher', spend: 'info', margin: 'higher', roiPct: 'higher', costPerSignup: 'lower' };
module.exports = { run, headline, DIRECTION, DEFAULT_CAMPAIGN };
