'use strict';
/**
 * Expedited settlement. A payer offers providers earlier payment in return for a discount (for example, paid in 14 days for 10% off).
 * Each provider takes the offer that gives it the best annualised return on waiting less, if that beats its own cost of funds.
 * The payer's net benefit is the discount it keeps, less the cost of paying earlier. Costs of funds are ASSUMPTIONS: replace them with
 * the client's real figures before drawing conclusions.
 */
const { rng, round } = require('../util');
function normal(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function run({ claims, plan, params = {}, seed = 1 }) {
  if (!claims || !claims.length) throw Object.assign(new Error('No claims to settle.'), { status: 422 });
  const base = Number(plan.baselineDays || 30); const tiers = (plan.tiers || []).map((t) => ({ days: Number(t.days), discountPct: Number(t.discountPct) })).filter((t) => t.days < base && t.discountPct > 0 && t.discountPct < 100);
  if (!tiers.length) throw Object.assign(new Error('The payment plan needs at least one tier that pays earlier than the baseline.'), { status: 422 });
  const cc = Number(params.payerCostOfCapitalPct ?? 18) / 100, med = Number(params.providerCostOfFundsMedianPct ?? 35) / 100, spread = Number(params.providerCostSpread ?? 0.5);
  const eligible = params.cleanClaimsOnly === false ? claims : claims.filter((c) => c.eligible !== false && (!c.known_issue || c.known_issue === 'none'));
  const r = rng(seed);
  const byProvider = new Map(); for (const c of eligible) { const p = byProvider.get(c.provider) || { claims: 0, value: 0 }; p.claims++; p.value += c.amount; byProvider.set(c.provider, p); }
  const out = tiers.map((t) => ({ ...t, providers: 0, claims: 0, value: 0, discountKept: 0, carryingCost: 0, net: 0, impliedAnnualReturnPct: round(100 * (t.discountPct / 100) / (1 - t.discountPct / 100) * 365 / (base - t.days), 1) }));
  const baselineValue = { providers: 0, claims: 0, value: 0 }; const providers = [];
  for (const [pid, p] of [...byProvider.entries()].sort()) {
    const cost = med * Math.exp(spread * normal(r)); let best = -1, bestRet = cost;
    out.forEach((t, i) => { if (t.impliedAnnualReturnPct / 100 > bestRet) { bestRet = t.impliedAnnualReturnPct / 100; best = i; } });
    if (best < 0) { baselineValue.providers++; baselineValue.claims += p.claims; baselineValue.value += p.value; providers.push({ provider: pid, choice: 'standard terms' }); continue; }
    const t = out[best]; t.providers++; t.claims += p.claims; t.value += p.value;
    t.discountKept += p.value * t.discountPct / 100; t.carryingCost += p.value * (1 - t.discountPct / 100) * cc * (base - t.days) / 365;
    providers.push({ provider: pid, choice: `${t.discountPct}% for ${t.days} days` });
  }
  out.forEach((t) => { t.value = round(t.value); t.discountKept = round(t.discountKept); t.carryingCost = round(t.carryingCost); t.net = round(t.discountKept - t.carryingCost); });
  const total = [...byProvider.values()].reduce((a, p) => a + p.value, 0);
  const net = round(out.reduce((a, t) => a + t.net, 0)); const taking = out.reduce((a, t) => a + t.providers, 0);
  return { claimsConsidered: eligible.length, providersConsidered: byProvider.size, spend: round(total), baselineDays: base,
    tiers: out, standardTerms: { providers: baselineValue.providers, claims: baselineValue.claims, value: round(baselineValue.value) },
    uptakePct: byProvider.size ? round(100 * taking / byProvider.size, 1) : 0, netBenefit: net, netBenefitPctOfSpend: total ? round(100 * net / total, 2) : 0, providerChoices: providers,
    assumptions: { payerCostOfCapitalPct: cc * 100, providerCostOfFundsMedianPct: med * 100, providerCostSpread: spread, cleanClaimsOnly: params.cleanClaimsOnly !== false }, seed };
}
const headline = (r) => ({ uptakePct: r.uptakePct, netBenefit: r.netBenefit, netBenefitPctOfSpend: r.netBenefitPctOfSpend, spend: r.spend });
const DIRECTION = { uptakePct: 'info', netBenefit: 'higher', netBenefitPctOfSpend: 'higher', spend: 'info' };
module.exports = { run, headline, DIRECTION };
