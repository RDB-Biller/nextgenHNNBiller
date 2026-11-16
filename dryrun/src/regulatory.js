'use strict';
/**
 * Sorts every change to a product into: none (can go ahead), notify (tell the regulator or your compliance team), or regulator
 * (needs approval first). These are STARTING ASSUMPTIONS for an insurer, editable per organisation. They are not legal advice:
 * the organisation's compliance team confirms them against the regulator's current rules (in Ghana, the National Insurance Commission).
 */
const DEFAULTS = {
  maxDiscountPct: 10,
  levels: {
    premium_increase: 'regulator', premium_cut_beyond_limit: 'regulator', benefit_cap_decrease: 'regulator', benefit_cap_increase: 'notify',
    copay_increase: 'regulator', copay_decrease: 'notify', waiting_increase: 'regulator', waiting_decrease: 'notify',
    exclusion_added: 'regulator', exclusion_removed: 'notify', category_added: 'regulator', category_removed: 'regulator',
    hospital_access_widened: 'none', hospital_access_narrowed: 'regulator', hospital_not_approved: 'regulator',
    option_added_within_limits: 'none', option_added_outside_limits: 'regulator', option_removed: 'regulator', option_price_increase: 'regulator',
    vas_added: 'none', vas_removed: 'notify',
  },
};
const RANK = { none: 0, notify: 1, regulator: 2 };
const merge = (o) => ({ maxDiscountPct: o && o.maxDiscountPct != null ? Number(o.maxDiscountPct) : DEFAULTS.maxDiscountPct, levels: { ...DEFAULTS.levels, ...((o && o.levels) || {}) } });
const arr = (x) => (Array.isArray(x) ? x : []);
const names = (xs) => arr(xs).map((x) => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
const diff = (a, b) => b.filter((x) => !a.includes(x));
const NOTE = 'Starting assumption. Confirm with your compliance team.';

function classify(prev, next, rulesIn) {
  const R = merge(rulesIn); const L = R.levels;
  if (!prev) return { overall: 'baseline', changes: [], summary: 'First version. This is treated as your current in-market product, so nothing is compared.', rules: R };
  const ch = []; const add = (field, key, from, to, why) => ch.push({ field, level: L[key], from, to, reason: why, rule: key });
  const n = (x) => (x === undefined || x === null || x === '' ? null : Number(x));
  const p0 = n(prev.premium), p1 = n(next.premium);
  if (p0 !== null && p1 !== null && p1 !== p0) {
    if (p1 > p0) add('premium', 'premium_increase', p0, p1, 'A higher premium for the same cover.');
    else { const cut = (100 * (p0 - p1)) / p0; if (cut > R.maxDiscountPct) add('premium', 'premium_cut_beyond_limit', p0, p1, `A ${cut.toFixed(1)}% cut is beyond the ${R.maxDiscountPct}% you treat as a discount.`); else ch.push({ field: 'premium', level: 'none', from: p0, to: p1, reason: `A ${cut.toFixed(1)}% reduction, within the ${R.maxDiscountPct}% discount limit.`, rule: 'discount_within_limit' }); }
  }
  const d1 = n(next.discountPct); if (d1 !== null && d1 > R.maxDiscountPct) add('discountPct', 'premium_cut_beyond_limit', n(prev.discountPct), d1, `A ${d1}% discount is beyond the ${R.maxDiscountPct}% limit.`);
  const c0 = n(prev.benefitCap), c1 = n(next.benefitCap); if (c0 !== null && c1 !== null && c1 !== c0) c1 < c0 ? add('benefitCap', 'benefit_cap_decrease', c0, c1, 'Less cover than before.') : add('benefitCap', 'benefit_cap_increase', c0, c1, 'More cover than before.');
  const k0 = n(prev.coPayPct), k1 = n(next.coPayPct); if (k0 !== null && k1 !== null && k1 !== k0) k1 > k0 ? add('coPayPct', 'copay_increase', k0, k1, 'Members pay a larger share.') : add('coPayPct', 'copay_decrease', k0, k1, 'Members pay a smaller share.');
  const w0 = n(prev.waitingDays), w1 = n(next.waitingDays); if (w0 !== null && w1 !== null && w1 !== w0) w1 > w0 ? add('waitingDays', 'waiting_increase', w0, w1, 'A longer wait before cover starts.') : add('waitingDays', 'waiting_decrease', w0, w1, 'A shorter wait before cover starts.');
  const e0 = arr(prev.exclusions), e1 = arr(next.exclusions); const ea = diff(e0, e1), er = diff(e1, e0);
  if (ea.length) add('exclusions', 'exclusion_added', null, ea.join(', '), 'Something is no longer covered.'); if (er.length) add('exclusions', 'exclusion_removed', er.join(', '), null, 'Something is now covered.');
  const b0 = arr(prev.benefitCategories), b1 = arr(next.benefitCategories); const ba = diff(b0, b1), br = diff(b1, b0);
  if (ba.length) add('benefitCategories', 'category_added', null, ba.join(', '), 'A new benefit category.'); if (br.length) add('benefitCategories', 'category_removed', br.join(', '), null, 'A benefit category is removed.');
  const t0 = names(prev.hospitalTiers), t1 = names(next.hospitalTiers); const ta = diff(t0, t1), tr = diff(t1, t0);
  const approved = new Set(names(next.approvedHospitalTiers || next.hospitalTiers));
  if (ta.length) add('hospitalTiers', 'hospital_access_widened', null, ta.join(', '), 'More hospitals reachable on the same cap. Members reach their cap sooner.');
  if (tr.length) add('hospitalTiers', 'hospital_access_narrowed', tr.join(', '), null, 'Fewer hospitals reachable.');
  const o0 = new Map(arr(prev.options).map((o) => [o.name, o])), o1 = new Map(arr(next.options).map((o) => [o.name, o]));
  for (const [name, o] of o1) {
    const out = arr(o.tiers).filter((t) => !approved.has(t)); const adj = n(o.premiumAdjPct) || 0; const before = o0.get(name);
    if (!before) { if (out.length) add('options', 'hospital_not_approved', null, `${name}: ${out.join(', ')}`, 'Includes hospitals the insurer has not approved on this plan.'); else if (adj < -R.maxDiscountPct) add('options', 'option_added_outside_limits', null, name, `Priced ${Math.abs(adj)}% below the standard premium, beyond the ${R.maxDiscountPct}% discount limit.`); else ch.push({ field: 'options', level: L.option_added_within_limits, from: null, to: name, reason: `A new choice using approved hospitals, priced within the ${R.maxDiscountPct}% discount limit.`, rule: 'option_added_within_limits' }); }
    else { const bt = arr(before.tiers), nt = arr(o.tiers); const tw = diff(bt, nt), tn = diff(nt, bt); if (tw.length) add('options', 'hospital_access_widened', `${name}: ${bt.join(', ')}`, `${name}: ${nt.join(', ')}`, 'More hospitals reachable on the same cap. Members reach their cap sooner.'); if (tn.length) add('options', 'hospital_access_narrowed', `${name}: ${bt.join(', ')}`, `${name}: ${nt.join(', ')}`, 'Fewer hospitals reachable.'); const b = n(before.premiumAdjPct) || 0; if (adj > b) add('options', 'option_price_increase', `${name}: ${b}%`, `${name}: ${adj}%`, 'The price of this choice goes up.'); else if (adj < b && adj < -R.maxDiscountPct) add('options', 'option_added_outside_limits', `${name}: ${b}%`, `${name}: ${adj}%`, `A cut beyond the ${R.maxDiscountPct}% limit.`); if (out.length) add('options', 'hospital_not_approved', null, `${name}: ${out.join(', ')}`, 'Includes hospitals the insurer has not approved on this plan.'); }
  }
  for (const name of o0.keys()) if (!o1.has(name)) add('options', 'option_removed', name, null, 'A choice members had is withdrawn.');
  const v0 = names(prev.vas), v1 = names(next.vas); const va = diff(v0, v1), vr = diff(v1, v0);
  if (va.length) add('vas', 'vas_added', null, va.join(', '), 'A new optional extra.'); if (vr.length) add('vas', 'vas_removed', vr.join(', '), null, 'An optional extra is withdrawn.');
  for (const c of ch) c.note = NOTE;
  const overall = ch.reduce((m, c) => (RANK[c.level] > RANK[m] ? c.level : m), 'none');
  const count = (l) => ch.filter((c) => c.level === l).length;
  const summary = !ch.length ? 'No difference from the version it was compared with.' : overall === 'regulator' ? `${count('regulator')} change(s) need regulator approval before launch.` : overall === 'notify' ? `No approval needed, but ${count('notify')} change(s) should be notified.` : 'Nothing here needs regulator approval.';
  return { overall, changes: ch, summary, rules: R };
}
module.exports = { DEFAULTS, classify, merge };
