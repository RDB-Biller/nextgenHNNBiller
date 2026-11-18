'use strict';
/** Starting guidance from common practice for health-type cover. Not advice: confirm with your actuary and compliance team. */
const NOTE = 'Starting guidance from common practice. Confirm with your actuary.';
function check(d, h, a) {
  const out = []; const add = (id, level, text) => out.push({ id, level, text });
  const lr = h.lossRatioPct; if (lr != null) { if (lr > 85) add('loss_ratio', 'warn', `Loss ratio ${lr}% is high. Cover usually aims for roughly 55-80%.`); else if (lr < 45) add('loss_ratio', 'warn', `Loss ratio ${lr}% is low. Members may feel poor value, which raises lapses.`); else add('loss_ratio', 'ok', `Loss ratio ${lr}% is in the usual 45-85% band.`); }
  if (d.waitingDays != null) { if (d.waitingDays < 14) add('waiting', 'warn', `A ${d.waitingDays}-day waiting period invites people to buy only when they are ill. 30-90 days is common.`); else if (d.waitingDays > 180) add('waiting', 'warn', `A ${d.waitingDays}-day waiting period is long and may put buyers off.`); else add('waiting', 'ok', `Waiting period of ${d.waitingDays} days is within the usual range.`); }
  if (d.coPayPct != null) { if (d.coPayPct > 30) add('copay', 'warn', `A ${d.coPayPct}% co-pay is high. Above about 30% it tends to cut take-up and satisfaction.`); else add('copay', 'ok', `Co-pay of ${d.coPayPct}% is within the usual range.`); }
  if (h.capReachedPct != null) { if (h.capReachedPct > 30) add('cap', 'warn', `${h.capReachedPct}% of members reach the benefit cap. The cap may be too low for how people use the cover.`); else add('cap', 'ok', `${h.capReachedPct}% reach the cap, which is a reasonable share.`); }
  const income = Number(a.avg_monthly_income); if (income > 0 && d.premium) { const pct = Math.round(1000 * d.premium / income) / 10; add('affordability', pct > 5 ? 'warn' : 'ok', pct > 5 ? `The premium is ${pct}% of the average monthly income you gave. Above about 5% affordability becomes the main barrier.` : `The premium is ${pct}% of average monthly income, which is affordable.`); }
  const lapse = Number(a.lapse_pct); if (lapse > 0) add('lapse', lapse > 25 ? 'warn' : 'ok', lapse > 25 ? `An assumed ${lapse}% yearly lapse is high. Check the first-year value members will see.` : `An assumed ${lapse}% yearly lapse is acceptable.`);
  return out;
}
const PLAN = ['Loss ratio in a healthy band (about 45-85%)', 'Waiting period in the usual range (14-180 days)', 'Co-pay not above about 30%', 'Share of members who reach the benefit cap', 'Premium against average income, if you give it', 'Yearly lapse, if you give it'];
module.exports = { check, PLAN, NOTE };
