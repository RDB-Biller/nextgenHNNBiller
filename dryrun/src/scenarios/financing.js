'use strict';
/**
 * Financing for insurance customers. Two facilities a fintech can design and offer through an insurer:
 *  - premium_financing: the premium is paid in instalments (for example quarterly) by auto-debit. When the wallet is short on the debit date,
 *    an overdraft is raised automatically so the instalment is paid and the cover does not lapse.
 *  - copay_cash: short cash advances for co-payments and for services the plan does not cover.
 * Wallet balances, repayment and take-up behaviour are ASSUMPTIONS until real wallet data replaces them. Nothing here is a credit decision.
 */
const { rng, round } = require('../util');

const DEFAULT_OFFER = () => ({
  name: 'Instalment premium with overdraft, and cover cash (illustrative)', currency: 'GHS',
  premiumOverdraft: { enabled: true, installments: 4, loadingPct: 6, feePct: 3, termDays: 30, limitMultiple: 1, eligibleSharePct: 65 },
  coverCash: { enabled: true, feePct: 6, repayDays: 30, maxAdvance: 800 },
});
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Premium paid in instalments with an automatic overdraft on the debit date. Same customers and same wallet draws with and without the overdraft. */
function runPremium({ offer, params = {}, seed = 1 }) {
  const po = (offer && offer.premiumOverdraft) || {}; if (po.enabled === false) throw Object.assign(new Error('Premium overdraft is switched off in this offer.'), { status: 422 });
  const n = Math.max(1, Math.round(Number(po.installments) || 4)), loading = Number(po.loadingPct ?? 6) / 100, fee = Number(po.feePct ?? 2.5) / 100, term = Number(po.termDays ?? 30), limitX = Number(po.limitMultiple ?? 1);
  const members = clamp(Math.round(Number(params.members ?? 2000)), 100, 20000), P = Number(params.annualPremium ?? 840), lowShare = Number(params.lowWageSharePct ?? 55) / 100, med = Number(params.medianMonthlyIncome ?? 1800);
  const eligible = Number(po.eligibleSharePct ?? params.eligibleSharePct ?? 65) / 100, cof = Number(params.costOfFundsPct ?? 24) / 100, maxExtra = Number(params.maxExtraCostPct ?? 12);
  const r = rng(seed); const due = (P * (1 + loading)) / n;
  let buyersAnnual = 0, buyersInst = 0, premiumDue = 0, paidOwn = 0, paidWith = 0, lapseWithout = 0, lapseWith = 0, adv = 0, advVol = 0, feeRev = 0, loss = 0, lowAdv = 0, lowN = 0;
  for (let i = 0; i < members; i++) {
    const low = r() < lowShare; const income = med * (low ? 0.45 + 0.4 * r() : 1.3 + 1.2 * r()); const ok = r() < eligible; const repayP = clamp(Number(params.repayRatePct ?? 96) / 100 + (low ? -0.04 : 0.03), 0.5, 0.995);
    const bal0 = income * (low ? r() ** 1.5 : 0.3 + 0.9 * r()); if (bal0 >= P) buyersAnnual++;
    if (low) lowN++;
    // would they buy? Anyone who can meet one instalment at purchase, and a share who cannot but are willing to try with an overdraft behind it.
    const canStart = bal0 >= due; const tries = r(); const buysInst = canStart || (tries < 0.35 && ok); if (!buysInst) continue; buyersInst++;
    let lapsedA = false, lapsedB = false; let paid = 0, paidB = 0;
    for (let k = 0; k < n; k++) {
      premiumDue += due; const bal = income * (low ? 0.05 + 0.9 * r() ** 1.7 : 0.25 + 0.9 * r()); const shock = r(), retry = r(), repay = r();
      if (!lapsedA) { if (bal >= due) paid += due; else if (retry < 0.35) paid += due; else lapsedA = true; }
      if (!lapsedB) {
        if (bal >= due) paidB += due;
        else if (ok && due - bal <= due * limitX + 1e-9) { const a = due - bal; adv++; advVol += a; feeRev += a * fee; paidB += due; if (low) lowAdv++; if (repay > repayP) loss += a; }
        else if (retry < 0.35) paidB += due; else lapsedB = true;
      }
      void shock;
    }
    paidOwn += paid; paidWith += paidB; if (lapsedA) lapseWithout++; if (lapsedB) lapseWith++;
  }
  const cofCost = advVol * cof * (term / 365), net = feeRev - loss - cofCost;
  const avgFeeCostPct = advVol && premiumDue ? 100 * feeRev / (premiumDue) : 0, extra = loading * 100 + avgFeeCostPct;
  return {
    members, buyersAnnualUpfront: buyersAnnual, buyersInstalments: buyersInst, extraMembersReached: Math.max(0, buyersInst - buyersAnnual), installments: n, instalmentAmount: round(due), annualPremium: P,
    collectedPctWithoutOverdraft: premiumDue ? round(100 * paidOwn / premiumDue, 1) : 0, collectedPct: premiumDue ? round(100 * paidWith / premiumDue, 1) : 0,
    lapsePctWithoutOverdraft: buyersInst ? round(100 * lapseWithout / buyersInst, 1) : 0, lapsePct: buyersInst ? round(100 * lapseWith / buyersInst, 1) : 0,
    advances: adv, advanceVolume: round(advVol), lowWageShareOfAdvancesPct: adv ? round(100 * lowAdv / adv, 1) : 0, feeRevenue: round(feeRev), creditLoss: round(loss), costOfFunds: round(cofCost), fintechNet: round(net),
    creditLossPctOfAdvances: advVol ? round(100 * loss / advVol, 2) : 0, overdraftAprPct: round(fee * 100 * 365 / term, 0), customerExtraCostPct: round(extra, 2),
    gate: { passes: extra <= maxExtra, explained: extra <= maxExtra ? `Extra cost to the customer (${round(extra, 1)}% of the premium) is within the ${maxExtra}% limit.` : `Extra cost to the customer (${round(extra, 1)}% of the premium) is above the ${maxExtra}% limit you set.` },
    caution: 'Instalments with a loading, and any overdraft, are consumer credit. Confirm licensing, disclosure and interest rules with your regulator and insurer before launch.',
    assumptions: { repayRatePct: Number(params.repayRatePct ?? 96), costOfFundsPct: cof * 100, lowWageSharePct: lowShare * 100, medianMonthlyIncome: med, note: 'Wallet balances and repayment are illustrative. Replace them with real wallet data from a small pilot.' }, seed,
  };
}
const headlinePremium = (r) => ({ collectedPct: r.collectedPct, lapsePct: r.lapsePct, extraMembersReached: r.extraMembersReached, fintechNet: r.fintechNet, creditLossPctOfAdvances: r.creditLossPctOfAdvances, customerExtraCostPct: r.customerExtraCostPct });
const DIRPREM = { collectedPct: 'higher', lapsePct: 'lower', extraMembersReached: 'higher', fintechNet: 'higher', creditLossPctOfAdvances: 'lower', customerExtraCostPct: 'lower' };

/** Cash advances for co-payments and for services the plan does not cover. */
function runCover({ offer, params = {}, seed = 1 }) {
  const cc = (offer && offer.coverCash) || {}; if (cc.enabled === false) throw Object.assign(new Error('Cover cash is switched off in this offer.'), { status: 422 });
  const fee = Number(cc.feePct ?? 6) / 100, repayDays = Number(cc.repayDays ?? 30), maxAdv = Number(cc.maxAdvance ?? 800);
  const members = clamp(Math.round(Number(params.members ?? 2000)), 100, 20000), copayEvents = Number(params.copayEventsPerYear ?? 1.2), avgCopay = Number(params.avgCopay ?? 25), uncEvents = Number(params.uncoveredEventsPerYear ?? 0.35), avgUnc = Number(params.avgUncovered ?? 350);
  const affordPct = Number(params.canPayNowPct ?? 40) / 100, uptake = Number(params.advanceUptakePct ?? 30) / 100, repayP = Number(params.repayRatePct ?? 92) / 100, cof = Number(params.costOfFundsPct ?? 24) / 100, provMargin = Number(params.providerMarginPct ?? 30) / 100;
  const r = rng(seed + 7); const sens = Math.max(0.1, 1 - 0.04 * (fee * 100 - 4)); let adv = 0, vol = 0, feeRev = 0, loss = 0, extra = 0, extraRev = 0, copayAdv = 0, uncAdv = 0;
  const poisson = (l) => { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= r(); } while (p > L); return k - 1; };
  for (let i = 0; i < members; i++) {
    const nc = poisson(copayEvents), nu = poisson(uncEvents);
    for (let e = 0; e < nc; e++) { const amt = avgCopay * (0.4 + 1.2 * r()); const can = r() < affordPct + 0.3; if (!can && r() < uptake * sens && amt <= maxAdv) { adv++; copayAdv++; vol += amt; feeRev += amt * fee; if (r() > repayP) loss += amt; } else if (can && r() < 0.05 * uptake * sens) { adv++; copayAdv++; vol += amt; feeRev += amt * fee; if (r() > repayP) loss += amt; } }
    for (let e = 0; e < nu; e++) { const amt = avgUnc * (0.3 + 1.4 * r()); const can = r() < affordPct; if (can) continue; if (amt <= maxAdv && r() < uptake * sens * 1.6) { adv++; uncAdv++; vol += amt; feeRev += amt * fee; extra++; extraRev += amt; if (r() > repayP) loss += amt; } }
  }
  const cofCost = vol * cof * (repayDays / 365), net = feeRev - loss - cofCost;
  return { members, advances: adv, copayAdvances: copayAdv, uncoveredAdvances: uncAdv, advanceVolume: round(vol), averageAdvance: adv ? round(vol / adv) : 0, feeRevenue: round(feeRev), creditLoss: round(loss), costOfFunds: round(cofCost), fintechNet: round(net),
    creditLossPctOfAdvances: vol ? round(100 * loss / vol, 2) : 0, extraServicesEnabled: extra, providerExtraRevenue: round(extraRev), providerExtraMargin: round(extraRev * provMargin), feeAprPct: round(fee * 100 * 365 / repayDays, 0),
    gate: { passes: loss / (vol || 1) <= 0.1, explained: vol && loss / vol > 0.1 ? 'Credit loss is above 10% of advances. Tighten who can borrow or lower the maximum advance.' : 'Credit loss is within 10% of advances.' },
    caution: 'Cash advances are consumer credit. Confirm licensing, fee disclosure and interest rules before launch.',
    assumptions: { canPayNowPct: affordPct * 100, advanceUptakePct: uptake * 100, repayRatePct: repayP * 100, costOfFundsPct: cof * 100, note: 'Behaviour is illustrative. Put real take-up and repayment in after a small pilot.' }, seed };
}
const headlineCover = (r) => ({ advances: r.advances, advanceVolume: r.advanceVolume, fintechNet: r.fintechNet, creditLossPctOfAdvances: r.creditLossPctOfAdvances, extraServicesEnabled: r.extraServicesEnabled });
const DIRCOVER = { advances: 'info', advanceVolume: 'info', fintechNet: 'higher', creditLossPctOfAdvances: 'lower', extraServicesEnabled: 'higher' };

/** The Coach searches fee, loading and limit for the best fintech result that keeps the customer's extra cost inside the limit. */
function coachPremium(offer, params, seed, base) {
  const maxExtra = Number(params.maxExtraCostPct ?? 12); const fast = { ...params, members: Math.min(Number(params.members || 2000), 1500) }; let best = null, tried = 0;
  for (const loadingPct of [2, 4, 6, 8, 10]) for (const feePct of [1, 1.5, 2, 2.5, 3, 4, 5]) for (const limitMultiple of [0.5, 1, 1.5]) {
    const cand = { ...offer, premiumOverdraft: { ...offer.premiumOverdraft, loadingPct, feePct, limitMultiple } }; const r = runPremium({ offer: cand, params: fast, seed }); tried++;
    if (r.customerExtraCostPct > maxExtra) continue; const score = r.fintechNet + 4 * (base.lapsePctWithoutOverdraft - r.lapsePct) * 100; if (!best || score > best.score) best = { cand, r, score };
  }
  if (!best || best.r.fintechNet <= base.fintechNet * 1.02) return { suggestions: [], message: `Searched ${tried} combinations of loading, fee and overdraft limit. None did clearly better within the ${maxExtra}% extra-cost limit.` };
  const p0 = offer.premiumOverdraft, p1 = best.cand.premiumOverdraft; const changes = [];
  if (p0.loadingPct !== p1.loadingPct) changes.push(`Instalment loading ${p0.loadingPct}% → ${p1.loadingPct}%`); if (p0.feePct !== p1.feePct) changes.push(`Overdraft fee ${p0.feePct}% → ${p1.feePct}%`); if (p0.limitMultiple !== p1.limitMultiple) changes.push(`Overdraft limit ${p0.limitMultiple}× → ${p1.limitMultiple}× the instalment`);
  return { suggestions: [{ title: 'A better balance of cost to the customer and return', changes, expected: { fintechNet: { from: base.fintechNet, to: best.r.fintechNet }, lapsePct: { from: base.lapsePct, to: best.r.lapsePct }, customerExtraCostPct: { from: base.customerExtraCostPct, to: best.r.customerExtraCostPct } },
    confidence: 'Based on assumed wallet balances and repayment. Pilot before relying on it.', draft: { kind: 'finance_offer', data: best.cand } }], message: `Searched ${tried} combinations within your ${maxExtra}% extra-cost limit.` };
}
function coachCover(offer, params, seed, base) {
  const fast = { ...params, members: Math.min(Number(params.members || 2000), 1500) }; let best = null, tried = 0;
  for (const feePct of [3, 4, 5, 6, 8, 10]) for (const maxAdvance of [300, 500, 800, 1200]) { const cand = { ...offer, coverCash: { ...offer.coverCash, feePct, maxAdvance } }; const r = runCover({ offer: cand, params: fast, seed }); tried++; if (r.creditLossPctOfAdvances > 10) continue; if (!best || r.fintechNet > best.r.fintechNet) best = { cand, r }; }
  if (!best || best.r.fintechNet <= base.fintechNet * 1.02) return { suggestions: [], message: `Searched ${tried} fee and limit combinations. None did clearly better.` };
  const c0 = offer.coverCash, c1 = best.cand.coverCash; const changes = []; if (c0.feePct !== c1.feePct) changes.push(`Fee ${c0.feePct}% → ${c1.feePct}%`); if (c0.maxAdvance !== c1.maxAdvance) changes.push(`Maximum advance ${c0.maxAdvance} → ${c1.maxAdvance}`);
  return { suggestions: [{ title: 'A better fee and advance limit', changes, expected: { fintechNet: { from: base.fintechNet, to: best.r.fintechNet }, creditLossPctOfAdvances: { from: base.creditLossPctOfAdvances, to: best.r.creditLossPctOfAdvances } }, confidence: 'Based on assumed take-up and repayment. Pilot before relying on it.', draft: { kind: 'finance_offer', data: best.cand } }], message: `Searched ${tried} fee and limit combinations (credit loss kept under 10% of advances).` };
}
module.exports = { DEFAULT_OFFER, runPremium, runCover, headlinePremium, DIRPREM, headlineCover, DIRCOVER, coachPremium, coachCover,
  premiumEngine: { run: (a) => runPremium(a), headline: headlinePremium, DIRECTION: DIRPREM }, coverEngine: { run: (a) => runCover(a), headline: headlineCover, DIRECTION: DIRCOVER } };
