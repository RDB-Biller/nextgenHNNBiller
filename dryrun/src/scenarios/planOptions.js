'use strict';
/**
 * Plan options and hospital tiers. Members pick between choices on one plan, for example a lower premium with Tier 1 hospitals only,
 * or the standard premium with a few higher-tier hospitals. Higher-tier use costs more per visit, so those members reach their annual
 * cap sooner; members who stay in lower tiers keep their cap for longer. Choices, risk and costs are ASSUMPTIONS until real data replaces them.
 */
const { rng, round } = require('../util');
const normal = (r) => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const poisson = (r, l) => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= r(); } while (p > L && k < 60); return k - 1; };

const DEFAULT_PRODUCT = () => ({ name: 'Outpatient cover (illustrative)', currency: 'GHS', premium: 70, benefitCap: 1800, coPayPct: 0, waitingDays: 30,
  hospitalTiers: [{ name: 'T1', costMultiple: 1 }, { name: 'T2', costMultiple: 1.6 }, { name: 'T3', costMultiple: 2.4 }],
  options: [{ name: 'Essential: Tier 1 hospitals', tiers: ['T1'], premiumAdjPct: -8 }, { name: 'Choice: Tier 1 plus chosen Tier 2', tiers: ['T1', 'T2'], premiumAdjPct: 0 }, { name: 'Open: all hospitals', tiers: ['T1', 'T2', 'T3'], premiumAdjPct: 12 }] });

function run({ product, params = {}, seed = 1 }) {
  const p = product; const opts = p.options && p.options.length ? p.options : [{ name: 'Standard', tiers: [(p.hospitalTiers[0] || {}).name || 'T1'], premiumAdjPct: 0 }];
  if (!p.premium || !p.benefitCap || !(p.hospitalTiers || []).length) throw Object.assign(new Error('The product needs a premium, a benefit cap and hospital tiers.'), { status: 422 });
  const N = Math.min(Number(params.members || 2000), 20000), r = rng(seed), mult = new Map(p.hospitalTiers.map((t) => [t.name, Number(t.costMultiple) || 1]));
  const ty = p.typical || {}; const freq = Number(params.claimsPerMemberYear ?? ty.claimsPerMemberYear ?? 3), med = Number(params.medianClaimCost ?? ty.medianClaimCost ?? 140), sigma = 0.8, higher = Number(params.higherTierUsePct ?? 60) / 100, desire = Number(params.desireHigherTierPct ?? 35) / 100;
  const sens = Number(params.priceSensitivity ?? 1.2), adverse = Number(params.adverseSelection ?? 0.3), targetLR = Number(params.targetLossRatioPct ?? 70), coPay = (Number(p.coPayPct) || 0) / 100;
  const access = opts.map((o) => Math.max(...o.tiers.map((t) => (mult.get(t) || 1))));
  const prem = opts.map((o) => p.premium * (1 + (Number(o.premiumAdjPct) || 0) / 100));
  const agg = opts.map((o, i) => ({ name: o.name, tiers: o.tiers, monthlyPremium: round(prem[i], 2), members: 0, revenue: 0, paid: 0, capHit: 0, monthsSum: 0 }));
  const base = { revenue: 0, paid: 0, capHit: 0 };
  for (let m = 0; m < N; m++) {
    const risk = Math.exp(0.5 * normal(r) - 0.125); const wants = r() < Math.min(1, desire * (1 + adverse * (risk - 1))); const pref = wants ? 1 : 0.15; const ps = sens * Math.exp(0.3 * normal(r));
    let best = 0, bu = -Infinity; opts.forEach((o, i) => { const u = pref * (access[i] - 1) * 1.4 - ps * (prem[i] / p.premium - 1) * 8 + 0.3 * normal(r); if (u > bu) { bu = u; best = i; } });
    const k = poisson(r, freq * risk); const raw = []; for (let c = 0; c < k; c++) raw.push(med * Math.exp(sigma * normal(r))); const useHigh = [r(), r(), r()];
    const cost = (allowed) => { const hi = allowed.filter((t) => (mult.get(t) || 1) > 1); let tot = 0; raw.forEach((c, j) => { const t = hi.length && useHigh[j % 3] < higher && wants ? hi[Math.floor(r() * hi.length)] : allowed[0]; tot += c * (mult.get(t) || 1); }); return tot; };
    const total = cost(opts[best].tiers); const paid = Math.min(p.benefitCap, total * (1 - coPay)); const a = agg[best]; a.members++; a.revenue += prem[best] * 12; a.paid += paid; if (total * (1 - coPay) >= p.benefitCap) a.capHit++; a.monthsSum += total > 0 ? Math.min(12, (p.benefitCap / (total * (1 - coPay))) * 12) : 12;
    const tb = cost([opts[0].tiers[0]]); const pb = Math.min(p.benefitCap, tb * (1 - coPay)); base.revenue += p.premium * 12; base.paid += pb; if (tb * (1 - coPay) >= p.benefitCap) base.capHit++;
  }
  const rows = agg.map((a) => ({ name: a.name, tiers: a.tiers, monthlyPremium: a.monthlyPremium, members: a.members, sharePct: round(100 * a.members / N, 1), revenue: round(a.revenue), claimsPaid: round(a.paid), lossRatioPct: a.revenue ? round(100 * a.paid / a.revenue, 1) : null, capReachedPct: a.members ? round(100 * a.capHit / a.members, 1) : 0, monthsCapLasts: a.members ? round(a.monthsSum / a.members, 1) : null }));
  const rev = agg.reduce((s, a) => s + a.revenue, 0), paid = agg.reduce((s, a) => s + a.paid, 0), hit = agg.reduce((s, a) => s + a.capHit, 0), highMembers = agg.reduce((s, a, i) => s + (access[i] > 1 ? a.members : 0), 0);
  const lr = rev ? 100 * paid / rev : 0, baseLR = base.revenue ? 100 * base.paid / base.revenue : 0;
  return { members: N, options: rows, lossRatioPct: round(lr, 1), margin: round(rev - paid), revenue: round(rev), claimsPaid: round(paid), capReachedPct: round(100 * hit / N, 1), higherTierSharePct: round(100 * highMembers / N, 1),
    baseline: { description: 'Everyone on the standard premium, Tier 1 hospitals only', lossRatioPct: round(baseLR, 1), margin: round(base.revenue - base.paid), capReachedPct: round(100 * base.capHit / N, 1) },
    gate: { targetLossRatioPct: targetLR, passes: lr <= targetLR, explained: lr <= targetLR ? `Loss ratio ${round(lr, 1)}% is within your ${targetLR}% target.` : `Loss ratio ${round(lr, 1)}% is above your ${targetLR}% target.` },
    assumptions: { claimsPerMemberYear: freq, medianClaimCost: med, higherTierUsePct: higher * 100, desireHigherTierPct: desire * 100, priceSensitivity: sens, adverseSelection: adverse }, seed };
}
const headline = (r) => ({ lossRatioPct: r.lossRatioPct, margin: r.margin, capReachedPct: r.capReachedPct, higherTierSharePct: r.higherTierSharePct, revenue: r.revenue });
const DIRECTION = { lossRatioPct: 'lower', margin: 'higher', capReachedPct: 'lower', higherTierSharePct: 'info', revenue: 'info' };
module.exports = { run, headline, DIRECTION, DEFAULT_PRODUCT };
