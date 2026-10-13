'use strict';
// Smoke test for BirthPrep savings plans (services/savingsPlans.js, Product Lab module
// "birthprep"): obstetric pathway targets, horizons, schedules, history inference,
// re-planning on clinical change, contributions, reminders, the partner webhook and
// the InsureCredit bridge. In-memory store; SMS faked.   node scripts/smoke-savings.js

process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';

const store = require('../src/store');
const operatingMode = require('../src/services/operatingMode');
const messaging = require('../src/services/messaging');
const messagingAccount = require('../src/services/messagingAccount');
const products = require('../src/services/products');
const solutions = require('../src/services/solutions');
const sav = require('../src/services/savingsPlans');
const insurecredit = require('../src/services/insurecredit');
const { createBill } = require('../src/services/billing');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const rejects = async (fn, status, label) => {
  try { await fn(); ok(false, `${label} (did not throw)`); } catch (e) { ok(!status || e.status === status, `${label} -> ${e.message}`); }
};
const sms = [];
messaging._setRequestImplForTests(async (url, opts) => {
  const f = new URLSearchParams(opts.body); sms.push({ to: f.get('to'), message: f.get('message') });
  return { status: 201, body: JSON.stringify({ SMSMessageData: { Recipients: [{ number: f.get('to'), status: 'Success', messageId: `ATXid_${sms.length}` }] } }) };
});
const lastSms = () => sms[sms.length - 1];
const DAY = 86400000; const WEEK = 7 * DAY;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const T = 'tenant_euracare';
let seq = 0;
async function mkBill({ diagnosis, items, phone = '0244000900', name = 'Akosua Boateng', memberId = 'ACA-9' } = {}) {
  seq++;
  const b = createBill({ provider: 'Euracare Hospital', patient: { name, phone }, items: items || [{ name: 'Antenatal visit', cost: 150 }], adjustments: { copayPercent: 100 }, insurance: { payerId: 'acacia', memberId }, clinical: { diagnosis } });
  b.tenantId = T; await store.bills.insert(b); return b;
}

(async () => {
  await store.init();
  await operatingMode.set({ settlement: { sandbox: true }, messaging: { sandbox: false } });
  await messagingAccount.set({ provider: 'africastalking', credentials: { apiKey: 'at-sandbox-key', username: 'sandbox' }, active: true });
  const tenant = await store.tenants.get(T);

  // ===== 1. module + default product =========================================================
  const reg = solutions.registry().find((m) => m.key === 'birthprep');
  ok(reg && reg.scope === 'none' && reg.surfaces.includes('patient') && reg.params.some((x) => x.key === 'costCs') && reg.params.some((x) => x.key === 'pathwayJson'), 'birthprep is a Product Lab module with tariff and pathway parameters');
  const def = await sav.ensureDefaultProduct();
  ok(def && def.status === 'live' && def.name === sav.DEFAULT_NAME && (await sav.ensureDefaultProduct()).id === def.id, 'a live default BirthPrep programme exists, created once');
  ok((await sav.productFor(T)).id === def.id, 'every hospital gets the default unless it has its own live programme');
  await rejects(() => Promise.resolve(solutions.validateConfig({ module: 'birthprep', params: { pathwayJson: '{not json' } })), 422, 'bad pathway JSON is refused');
  await rejects(() => Promise.resolve(solutions.validateConfig({ module: 'birthprep', params: { costCs: 100, costSvd: 500 } })), 422, 'a caesarean package below the vaginal package is refused');
  const p = sav.paramsOf(def);

  // ===== 2. the obstetric pathway rules ===========================================================
  const edd = iso(Date.now() + 20 * WEEK); // 20 weeks today
  const base = sav.plan({ edd }, { goal: 'delivery', horizon: '9', p });
  ok(base.analysis.csProbability === 0.2 && base.scenarios[0].mode === 'vaginal' && base.target.target > base.target.expected && base.target.expected < p.costCs, 'baseline pregnancy: mostly vaginal, target = expected cost + buffer');
  const cs2 = sav.plan({ edd, previousCs: 2 }, { goal: 'delivery', horizon: '9', p });
  ok(cs2.analysis.strict && cs2.analysis.csProbability >= 0.95 && cs2.scenarios[0].mode === 'caesarean' && cs2.scenarios[0].weeks < 39 && cs2.target.target > p.costCs && cs2.advisories.some((x) => /two or more previous caesarean/i.test(x)), 'two previous caesareans: a planned repeat caesarean (strict) drives the target');
  const cs1 = sav.plan({ edd, previousCs: 1 }, { goal: 'delivery', horizon: '9', p });
  ok(cs1.analysis.csProbability === 0.6 && !cs1.analysis.strict, 'one previous caesarean: more likely than not, not strict');
  const pih = sav.plan({ edd, hypertension: true }, { goal: 'delivery', horizon: '9', p });
  const w32 = pih.scenarios.filter((s) => s.weeks === 32); const w34 = pih.scenarios.filter((s) => s.weeks === 34);
  ok(w32.length && w34.length && w32.every((s) => s.extras.includes('antenatal steroids')) && w32[0].cost > p.costSvd + 10 * p.costNicuPerDay && w32.some((s) => s.label.includes('expedited')), 'hypertension in pregnancy: expedited delivery scenarios at 32 and 34 weeks with steroids and newborn special care priced in');
  ok(pih.deadline && new Date(pih.deadline) < new Date(iso(Date.now() + 12 * WEEK)) && pih.end === pih.deadline && pih.schedule.length < base.schedule.length, 'the money is needed before the earliest plausible (34-week) delivery, so the milestones end earlier than the 9-month horizon');
  ok(pih.target.worstCase > pih.target.expected && pih.target.target > base.target.target, 'the hypertension target is higher than baseline; the worst case (expedited caesarean with special care) is shown');
  const gdm = sav.plan({ edd, diabetes: true }, { goal: 'delivery', horizon: '9', p });
  ok(gdm.analysis.csProbability === 0.45 && gdm.scenarios.some((s) => s.weeks <= 37.5) && gdm.advisories.some((x) => /bigger/i.test(x)) && gdm.deadline < base.deadline, 'diabetes in pregnancy: earlier delivery and a higher caesarean chance; advisory mentions bigger babies');
  const both = sav.plan({ edd, hypertension: true, previousCs: 2 }, { goal: 'delivery', horizon: '9', p });
  ok(both.scenarios.every((s) => s.mode === 'caesarean' || s.probability < 0.05) && both.target.target > pih.target.target, 'combined: hypertension + two previous caesareans -> early caesarean scenarios, highest target');
  const twins = sav.plan({ edd, multiple: true }, { goal: 'delivery', horizon: '9', p });
  ok(twins.analysis.csProbability === 0.6 && twins.scenarios.some((s) => s.weeks === 34), 'twins: earlier delivery and more caesareans');
  const worst = sav.plan({ edd, hypertension: true }, { goal: 'delivery', horizon: '9', p: { ...p, planningBasis: 'worst_case' } });
  ok(worst.target.basisAmount === pih.target.worstCase, 'planning basis is configurable (worst case)');
  const override = sav.plan({ edd, previousCs: 2 }, { goal: 'delivery', horizon: '9', p: { ...p, pathwayJson: JSON.stringify({ previousCs2: { cs: 0.5, note: 'custom' } }) } });
  ok(override.analysis.csProbability === 0.5 && override.advisories.includes('custom'), 'the pathway table can be overridden per product (pathwayJson)');

  // ===== 3. horizons, procedures, other goals =====================================================
  const h3 = sav.plan({ edd: iso(Date.now() + 30 * WEEK) }, { goal: 'delivery', horizon: '3', p });
  ok(h3.horizonEnd && Math.abs(new Date(h3.horizonEnd) - (Date.now() + 91 * DAY)) < 4 * DAY && h3.end === h3.horizonEnd && h3.schedule.length === 3, '3-month horizon: three monthly milestones ending at the horizon when delivery is further away');
  const h6 = sav.plan({ otherAmount: 1200, otherLabel: 'Health fund' }, { goal: 'other', horizon: '6', p: { ...p, cadence: 'biweekly' } });
  ok(h6.schedule.length >= 12 && Math.abs(h6.schedule.reduce((s, m) => s + m.amount, 0) - 1200) < 0.01, '6-month biweekly plan for another goal: milestones sum exactly to the target');
  const yrs = sav.plan({ otherAmount: 5000, otherLabel: 'School fees' }, { goal: 'other', horizon: 'other', other: { years: 2 }, p });
  ok(yrs.schedule.length === 24 && yrs.horizonEnd && yrs.end === yrs.horizonEnd, '"other": two years -> 24 monthly milestones');
  const open = sav.plan({ otherAmount: 3000 }, { goal: 'other', horizon: 'other', other: { open: true }, p });
  ok(!open.end && open.schedule.length === 1 && open.schedule[0].openEnded, 'open-ended plan: one rolling milestone at a time');
  const proc = sav.plan({ procedureQuote: 4000, procedureName: 'Hernia repair', procedureDate: iso(Date.now() + 10 * WEEK) }, { goal: 'procedure', horizon: '9', p });
  ok(proc.target.target === 4800 && proc.deadline === iso(new Date(iso(Date.now() + 10 * WEEK)).getTime() - 2 * WEEK) && proc.goalLabel === 'Hernia repair', 'elective procedure: quote + contingency, due two weeks before the planned date');
  await rejects(() => Promise.resolve(sav.plan({}, { goal: 'procedure', horizon: '9', p })), 422, 'a procedure plan needs a quote');
  await rejects(() => Promise.resolve(sav.plan({ otherAmount: 100 }, { goal: 'other', horizon: 'other', other: { months: 0 }, p })), 422, 'an invalid custom horizon is refused');

  // ===== 4. history intelligence + suggestions =====================================================
  await mkBill({ diagnosis: 'Term pregnancy, delivered by emergency caesarean section', items: [{ name: 'Caesarean section', cost: 6000 }] });
  await mkBill({ diagnosis: 'Elective repeat LSCS', items: [{ name: 'Caesarean section', cost: 6500 }] });
  await mkBill({ diagnosis: 'Pre-eclampsia in previous pregnancy follow-up' });
  const hist = await sav.inferHistory(T, { phone: '0244000900' });
  ok(hist.facts.previousCs === 2 && hist.facts.hypertension === true && hist.facts.diabetes === false && hist.facts.evidence.length === 3, 'history: two caesareans and hypertension inferred from the patient\'s previous bills');
  const ancBill = await mkBill({ diagnosis: 'Pregnancy, 18 weeks, routine ANC' });
  const sug = sav.suggestionFor(ancBill, p);
  ok(sug.suggest && sug.goal === 'delivery', 'a bill with a pregnancy diagnosis triggers the savings suggestion');
  ok(sav.suggestionFor(await mkBill({ diagnosis: 'Inguinal hernia, booked for elective repair', items: [{ name: 'Surgical consult', cost: 200 }] }), p).goal === 'procedure', 'a bill mentioning an elective procedure suggests a procedure plan');
  ok(!sav.suggestionFor(await mkBill({ diagnosis: 'Malaria', items: [{ name: 'Coartem', cost: 200 }] }), p).suggest, 'an ordinary bill does not');
  ok(!sav.suggestionFor(ancBill, { ...p, suggestOnPregnancy: false }).suggest, 'the suggestion is configurable per product');

  // ===== 5. enrol: history + answers + bill -> plan, SMS ==============================================
  const smsB = sms.length;
  const rec = await sav.enrol({ tenant, product: def, input: { patient: { name: 'Akosua Boateng', phone: '0244000900', memberId: 'ACA-9' }, goal: 'delivery', horizon: '9', billId: ancBill.id, answers: { edd, previousBirths: '2', hypertension: 'no' } } });
  ok(/^\d{8}$/.test(rec.planNo) && rec.status === 'active' && rec.facts.previousCs === 2 && rec.facts.hypertension === true && rec.analysis.strict, 'enrolment merges history (2 caesareans, hypertension from bills) with the answers; planned caesarean drives the target');
  ok(rec.history.evidence.length === 3 && rec.history.billsSeen >= 3, 'the plan records the evidence it used');
  ok(sms.length === smsB + 1 && lastSms().to === '+233244000900' && lastSms().message.includes(rec.planNo) && lastSms().message.includes(`/s/${rec.token}`) && lastSms().message.includes('GHS'), 'the patient is texted the plan number, target and a short link');
  ok(rec.bridge.insureCredit && rec.bridge.insureCredit.eligibleUpTo === 2000 && rec.bridge.shortfall === rec.target.target, 'the InsureCredit bridge shows up to GHS 2,000 of the shortfall');
  const pv = await sav.publicView(rec);
  ok(pv.firstName === 'Akosua' && !JSON.stringify(pv).includes('ACA-9') && !JSON.stringify(pv).includes('bill_') && pv.questions.length && pv.disclaimer, 'patient page: first name only, no member id or bill ids, with the Q&A and the disclaimer');
  await rejects(() => sav.enrol({ tenant, product: def, input: { patient: { name: 'X', phone: '123' }, goal: 'delivery', horizon: '9' } }), 422, 'a valid phone is required');

  // ===== 6. contributions, milestones, completion ====================================================
  const m1 = rec.schedule[0].amount;
  await sav.contribute(rec, { amount: m1, via: 'cashier' });
  ok(rec.saved === m1 && rec.schedule[0].status === 'paid' && rec.schedule[1].status === 'due' && rec.progress === undefined, 'a cashier contribution marks the first milestone paid');
  await rejects(() => sav.contribute(rec, { amount: 5 }), 422, 'below the minimum contribution');
  const v = sav.view(rec);
  ok(v.progress.percent > 0 && v.progress.remaining === Math.round((rec.target.target - m1) * 100) / 100 && v.patient.phone.startsWith('•'), 'hospital view shows progress with the phone masked');
  await sav.contribute(rec, { amount: 100, via: 'partner', reference: 'TMS-1' });
  await sav.contribute(rec, { amount: 100, via: 'partner', reference: 'TMS-1' });
  ok(rec.contributions.length === 2 && rec.saved === Math.round((m1 + 100) * 100) / 100, 'partner contributions are idempotent on their reference');

  // ===== 7. re-planning when the clinical picture changes =============================================
  const rec2 = await sav.enrol({ tenant, product: def, input: { patient: { name: 'Efua Mensah', phone: '0244000901' }, goal: 'delivery', horizon: '9', facts: { edd }, useHistory: false } });
  const t0 = rec2.target.target; const smsC = sms.length;
  await sav.contribute(rec2, { amount: 300 });
  await sav.update(rec2, { facts: { plannedCs: true }, by: 'hospital', note: 'Clinician booked a caesarean.' });
  ok(rec2.target.target > t0 * 1.5 && rec2.analysis.strict && rec2.saved === 300 && rec2.advisories.some((x) => x.severity === 'change' && /raised/.test(x.text)), 'SVD -> planned caesarean: target raised, contributions kept, change advisory added');
  ok(sms.length === smsC + 1 && /re-planned/.test(lastSms().message) && /raised/.test(lastSms().message), 'the patient is texted the re-plan');
  ok(rec2.schedule.filter((m) => m.status === 'due').reduce((s, m) => s + m.amount, 0) === Math.round((rec2.target.target - 300) * 100) / 100, 'remaining milestones cover exactly the new remaining amount');
  const endBefore = rec2.end;
  await sav.update(rec2, { answers: { hypertension: 'yes' }, by: 'patient' });
  ok(rec2.facts.hypertension === true && new Date(rec2.end) < new Date(endBefore) && rec2.advisories.some((x) => /needed by/.test(x.text)), 'a patient answer (hypertension) pulls the deadline earlier and re-shapes the schedule');
  const smsD = sms.length;
  await sav.update(rec2, { note: 'routine review' });
  ok(sms.length === smsD && rec2.advisories[rec2.advisories.length - 1].text.startsWith('Plan reviewed: no change'), 'a review without change does not text the patient');
  await sav.update(rec2, { goal: 'procedure', facts: { procedureQuote: 2500, procedureName: 'Myomectomy', procedureDate: iso(Date.now() + 8 * WEEK) } });
  ok(rec2.goal === 'procedure' && rec2.target.target === 3000 && rec2.goalLabel === 'Myomectomy', 'the goal itself can change');

  // ===== 8. reminders, status, bridge with InsureCredit ================================================
  rec.schedule.find((m) => m.status === 'due').dueDate = iso(Date.now() + 2 * DAY); await store.savingsPlans.update(rec);
  const smsE = sms.length; const r1 = await sav.runReminders(); const r2 = await sav.runReminders();
  ok(r1.remindersSent >= 1 && sms.length > smsE && /Reminder/.test(sms[smsE].message) && r2.remindersSent === 0, 'milestone reminders go out once per milestone');
  await sav.setStatus(rec2, 'paused');
  ok(rec2.status === 'paused' && (await sav.runReminders()).remindersSent === 0, 'a paused plan gets no reminders');
  await insurecredit.ensureDefaultProduct();
  const deliveryBill = await mkBill({ diagnosis: 'Delivery by caesarean section', items: [{ name: 'Caesarean section package', cost: 6500 }] });
  const smsF = sms.length;
  const offer = await sav.bridgeWithInsureCredit(rec, { billId: deliveryBill.id, tenant });
  ok(offer.applicationNo && offer.amount <= 2000 && rec.insureCredit.applicationNo === offer.applicationNo && sms.length === smsF + 1 && /InsureCredit/.test(lastSms().message), 'the shortfall is bridged with an InsureCredit offer against the delivery bill');

  // ===== 9. product resolution, hooks, Product Lab run ==================================================
  const own = await products.create('acacia', { type: 'solution', name: 'Euracare BirthPrep', config: { module: 'birthprep', params: { costCs: 8000, brandName: 'Euracare BabyFund' }, tenantIds: [T] } }, 'test');
  await products.setStatus(own.id, 'sandbox', 'test'); await products.setStatus(own.id, 'live', 'test');
  ok((await sav.productFor(T)).id === own.id && (await sav.productFor('tenant_nyaho')).id === def.id, "a hospital's own live programme overrides the default for that hospital only");
  const sim = await solutions.run(own.id, 'hospital', { tenant, input: { action: 'simulate', goal: 'delivery', horizon: '6', edd, previousCs: 2, hypertension: 'yes' } });
  ok(sim.result.simulated && sim.result.target.target > 8000 && sim.result.schedule.length, 'Product Lab simulate uses the product\'s own tariff');
  const st = await solutions.run(def.id, 'patient', { input: { planNo: rec.planNo, phone: '0244000900' } });
  ok(st.result.firstName === 'Akosua' && st.result.progress.saved === rec.saved, 'patients can look up their plan by number + phone');
  await rejects(() => solutions.run(def.id, 'patient', { input: { planNo: rec.planNo, phone: '0244000999' } }), 404, 'wrong phone opens nothing');
  ok(await sav.checkSecret((await sav.getSettings()).hookSecret) && !(await sav.checkSecret('nope')), 'partner webhook secret check');
  const urls = await sav.hookUrls('https://x.test'); const old = (await sav.getSettings()).hookSecret; await sav.rotateSecret();
  ok(urls.contribution.startsWith('https://x.test/savings-hooks/') && !(await sav.checkSecret(old)), 'rotating the secret invalidates old URLs');
  const lst = await sav.list({ tenantId: T });
  ok(lst.total === 2 && lst.savedTotal > 0 && lst.rows.every((r) => r.patient.phone.startsWith('•')), 'listing by hospital with totals');

  console.log(`\nBIRTHPREP SAVINGS CHECK: ${a} assertions${process.exitCode ? ' — FAILURES ABOVE' : ' passed'}`);
})().catch((e) => { console.error(e); process.exit(1); });
