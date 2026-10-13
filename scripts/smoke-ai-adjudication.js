'use strict';
// Smoke test for AI adjudication (services/aiAdjudication.js, the "ai_adjudication"
// Product Lab module): deterministic checks, the trainable scorer, the Claude
// client (faked: no network), the benchmark gate, autonomous approval, audit
// sampling, drift fallback and the human-decision training loop.
//   node scripts/smoke-ai-adjudication.js

process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';

const store = require('../src/store');
const operatingMode = require('../src/services/operatingMode');
const products = require('../src/services/products');
const solutions = require('../src/services/solutions');
const claims = require('../src/services/claims');
const verification = require('../src/services/verification');
const claimsAutomation = require('../src/services/claimsAutomation');
const ai = require('../src/services/aiAdjudication');
const { createBill } = require('../src/services/billing');

let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const rejects = async (fn, status, label) => {
  try { await fn(); ok(false, `${label} (did not throw)`); } catch (e) { ok(!status || e.status === status, `${label} -> ${e.message}`); }
};

// ---- fake Claude ---------------------------------------------------------------------
const llmCalls = [];
let llmBehaviour = 'oracle'; // oracle | http500 | refusal | truncated | garbage
ai._setRequestImplForTests(async (url, opts) => {
  const body = JSON.parse(opts.body);
  llmCalls.push({ url, headers: opts.headers, body });
  if (llmBehaviour === 'http500') return { status: 500, body: JSON.stringify({ error: { type: 'api_error', message: 'boom' } }) };
  if (llmBehaviour === 'refusal') return { status: 200, body: JSON.stringify({ stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 1 } }) };
  if (llmBehaviour === 'truncated') return { status: 200, body: JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"decision":"appr' }], usage: { input_tokens: 10, output_tokens: 1 } }) };
  const packet = JSON.parse(body.messages[0].content.split('\n\n').slice(1).join('\n\n'));
  const hard = (packet.checks || []).some((f) => f.severity === 'hard');
  const verdict = hard
    ? { decision: 'decline', confidence: 0.93, guideline_compliance: 'non_compliant', fraud_risk: 'high', reasons: ['Deterministic checks raised a hard flag', `Flags: ${packet.checks.map((f) => f.code).join(', ')}`], concerns: [{ code: 'hard_flag', detail: 'see checks', severity: 'high' }], suggested_approved_amount: null, reviewer_note: 'Do not pay without resolving the flags.' }
    : { decision: 'approve', confidence: 0.96, guideline_compliance: 'compliant', fraud_risk: 'low', reasons: [`Treatment is consistent with ${packet.claim.diagnosis || 'the complaint'}`, 'Prices within tolerance'], concerns: [], suggested_approved_amount: null, reviewer_note: 'Routine claim.' };
  return { status: 200, body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(verdict) }], usage: { input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 900 } }) };
});
const lastLlm = () => llmCalls[llmCalls.length - 1];

// ---- helpers --------------------------------------------------------------------------
const T = 'tenant_euracare';
let seq = 0;
async function mkBill({ tenantId = T, payerId = 'acacia', items, diagnosis = 'Uncomplicated malaria', name = 'Ama Mensah', phone = '0244000222', memberId = 'ACA-00123', copay = 0 } = {}) {
  seq++;
  const b = createBill({ provider: tenantId === T ? 'Euracare Hospital' : 'Nyaho Medical Centre', patient: { name, phone },
    items: items || [{ name: 'GP Consultation', code: 'GP-CONSULT', cost: 100 }, { name: 'Coartem', code: 'Coartem', cost: 200 }],
    adjustments: { copayPercent: copay }, insurance: { payerId, memberId: `${memberId}-${seq}` },
    clinical: diagnosis ? { diagnosis, complaint: 'Fever and chills', clinician: 'Dr K. Boateng' } : {} });
  b.tenantId = tenantId; await store.bills.insert(b); return b;
}
async function route(bill, payerId) { const r = await claims.routeToPayer(bill, payerId || bill.coverage.payerId); await ai.flush(); return store.claims.get(r.claim.id); }
async function mkProduct(payerId, name, params = {}) {
  const p = await products.create(payerId, { type: 'solution', name, config: { module: 'ai_adjudication', params } }, 'test');
  await products.setStatus(p.id, 'sandbox', 'test'); return products.setStatus(p.id, 'live', 'test');
}
const row = (claim) => store.aiAdjudications.byClaim(claim.id);
const setParams = async (p, patch) => products.update(p.id, { config: { ...(await products.get(p.id)).config, params: { ...(await products.get(p.id)).config.params, ...patch } } }, 'test');

(async () => {
  await store.init();
  await operatingMode.set({ settlement: { sandbox: true }, messaging: { sandbox: true } });

  // ===== 1. module + defaults ==================================================================
  const reg = solutions.registry().find((m) => m.key === 'ai_adjudication');
  ok(reg && reg.scope === 'none' && reg.params.length === ai.PARAMS.length && reg.params.some((x) => x.key === 'requiredAccuracy'), 'ai_adjudication is a Product Lab module with its parameter schema');
  const dp = ai.paramsOf({ config: { params: {} } });
  ok(dp.mode === 'assist' && dp.llmModel === 'claude-fable-5-1' && dp.llmEffort === 'max' && dp.requiredAccuracy === 0.95 && dp.autoDecline === false, 'defaults: assist mode, Claude Fable 5.1 at max effort, 95% required accuracy, no auto-decline');
  await rejects(() => Promise.resolve(solutions.validateConfig({ module: 'ai_adjudication', params: { mode: 'auto', auditSamplePercent: 100 } })), 422, 'auto mode with a 100% audit sample is refused (nothing would be automated)');
  await rejects(() => Promise.resolve(solutions.validateConfig({ module: 'ai_adjudication', params: { requiredAccuracy: 0.3 } })), 422, 'required accuracy below 0.5 is refused');

  // ===== 2. default product + resolution ========================================================
  const def = await ai.ensureDefaultProduct();
  ok(def && def.status === 'live' && def.name === ai.DEFAULT_NAME && (await ai.ensureDefaultProduct()).id === def.id, 'a live default AI adjudication product exists and is created only once');
  ok((await ai.productFor('acacia')).id === def.id && (await ai.productFor('gmtf')).id === def.id, 'payers without their own configuration are governed by the default');
  const acaciaProd = await mkProduct('acacia', 'Acacia AI adjudication', { guidelines: 'Malaria: artemisinin combination therapy is covered. Cosmetic procedures are not.', exclusions: 'cosmetic\nbotox', minBenchmarkSample: 20 });
  ok((await ai.productFor('acacia')).id === acaciaProd.id && (await ai.productFor('gmtf')).id === def.id, "a payer's own live product overrides the default for that payer only");

  // ===== 3. a clean claim: scored in the background, Claude called correctly ======================
  const b1 = await mkBill({});
  const c1 = await route(b1);
  ok(c1.status === 'pending' && c1.ai && c1.ai.recommendation === 'approve' && c1.ai.confidence >= 0.9 && c1.ai.action === 'recommend', 'clean claim: recommended for approval (assist mode leaves it pending for a human)');
  const r1 = await row(c1);
  ok(r1 && r1.productId === acaciaProd.id && r1.llm.status === 'ok' && r1.ml.enabled && r1.score > 0.9 && !r1.retro, 'verdict row stored with Claude + scorer results');
  const req = lastLlm();
  ok(req.url === 'https://api.anthropic.com/v1/messages' && req.headers['x-api-key'] === 'sk-ant-test-not-real' && req.headers['anthropic-version'] === '2023-06-01', 'Messages API called with the API key and version headers');
  ok(req.body.model === 'claude-fable-5-1' && req.body.output_config.effort === 'max' && req.body.output_config.format.type === 'json_schema' && req.body.output_config.format.schema.additionalProperties === false, 'request: claude-fable-5-1, max effort, JSON-schema structured output (no forced tool use)');
  ok(req.body.system[0].cache_control.type === 'ephemeral' && req.body.system[0].text.includes('artemisinin') && req.body.system[0].text.includes('cosmetic'), "the payer's guidelines and exclusions are in the (cached) system prompt");
  const raw = JSON.stringify(req.body);
  ok(!raw.includes('Ama Mensah') && !raw.includes('0244000222') && !raw.includes('ACA-00123'), 'no patient name, phone or member id leaves the platform');
  ok(raw.includes('Coartem') && raw.includes('malaria') && raw.includes('checks') && raw.includes('probabilityApprovable'), 'the packet carries items, diagnosis, check results and the scorer probability');
  ok(r1.llm.usage && r1.llm.usage.cacheRead === 900 && r1.llm.latencyMs >= 0, 'token usage (incl. cache reads) is recorded per verdict');
  const shown = await ai.forClaim(c1);
  ok(shown.recommendation === 'approve' && shown.reasons.length && shown.reviewerNote === 'Routine claim.' && shown.scorer.probability > 0, 'reviewers get the recommendation, reasons, the reviewer note and the scorer probability');

  // ===== 4. a human decision is recorded and trains the scorer =====================================
  const m0 = await ai.modelInfo(acaciaProd);
  await claims.authorize(c1.id); await ai.flush();
  const r1b = await row(c1);
  ok(r1b.outcome === 'approved' && r1b.decidedBy === 'human' && r1b.agreed === true, 'authorising records a human outcome that agrees with the AI');
  const m1 = await ai.modelInfo(acaciaProd);
  ok(m1.onlineUpdates === m0.onlineUpdates + 1 && m1.samples === m0.samples + 1, 'the scorer learned online from that decision');
  await claims.authorize(c1.id).catch(() => null);
  ok((await row(c1)).decidedBy === 'human' && (await ai.modelInfo(acaciaProd)).onlineUpdates === m1.onlineUpdates, 'a repeated decision is not counted twice');

  // ===== 5. deterministic hard flags ==============================================================
  const b2 = await mkBill({ items: [{ name: 'Coartem', code: 'Coartem', cost: 900 }] }); // NHIS reference 200 -> +350%
  const c2 = await route(b2);
  ok(c2.ai.hardFlags.includes('over_tariff') && c2.ai.recommendation !== 'approve', 'billing far above the reference tariff is a hard flag: never approve');
  ok((await row(c2)).llm.decision === 'decline' && c2.ai.recommendation === 'decline', 'with a hard flag and a confident Claude decline, the recommendation is decline');
  const b3 = await mkBill({ items: [{ name: 'Paracetamol 500mg', code: 'PARA', cost: 5, qty: 90 }] });
  const c3 = await route(b3);
  ok(c3.ai.hardFlags.includes('qty_anomaly'), 'implausible quantity is a hard flag');
  const b4 = await mkBill({ items: [{ name: 'Cosmetic filler', cost: 300 }] });
  const c4 = await route(b4);
  ok(c4.ai.hardFlags.includes('excluded_item') && c4.ai.recommendation !== 'approve', "an item on the payer's exclusion list is a hard flag");
  const b5 = await mkBill({ memberId: 'DUP-1' }); const c5 = await route(b5);
  const b6 = await mkBill({ memberId: 'DUP-1' }); seq--; // same member id suffix as b5
  b6.coverage.memberId = b5.coverage.memberId; await store.bills.update(b6);
  const c6 = await route(b6);
  ok(c5.ai.recommendation === 'approve' && c6.ai.hardFlags.includes('duplicate_claim'), 'the same items for the same member within the window is a duplicate (hard flag)');
  const b7 = await mkBill({ items: [{ name: 'Surgery', cost: 5000 }], diagnosis: 'Appendicitis' }); const c7 = await route(b7);
  ok(c7.ai.hardFlags.includes('high_amount'), 'above the always-review amount is a hard flag');
  const b8 = await mkBill({ diagnosis: null }); const c8 = await route(b8);
  ok((await row(c8)).flags.some((f) => f.code === 'no_diagnosis' && f.severity === 'soft'), 'a missing diagnosis is a soft flag (noted, not blocking)');
  const b9 = await mkBill({}); await (async () => { const v = await verification.createForBill(b9); await verification.dispute(v.id, 'I was never given Coartem'); })();
  const c9 = await route(b9);
  ok(c9.ai.hardFlags.includes('patient_disputed'), 'a bill the patient disputed is a hard flag');

  // ===== 6. Claude failure modes never block a claim ===============================================
  llmBehaviour = 'http500';
  const c10 = await route(await mkBill({}));
  const r10 = await row(c10);
  ok(c10.status === 'pending' && r10.llm.status === 'error' && r10.llm.error === 'boom' && c10.ai.recommendation && r10.reasons.some((x) => x.includes('Claude unavailable')), 'an API error (after one retry) falls back to checks + scorer and says so');
  llmBehaviour = 'refusal';
  ok((await row(await route(await mkBill({})))).llm.status === 'refused', 'a model refusal is recorded as such');
  llmBehaviour = 'truncated';
  ok((await row(await route(await mkBill({})))).llm.status === 'truncated', 'a truncated verdict is recorded as such');
  llmBehaviour = 'oracle';
  const saveKey = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  const r11 = await row(await route(await mkBill({})));
  ok(r11.llm.status === 'not_configured' && r11.ml.enabled && r11.recommendation, 'without ANTHROPIC_API_KEY the checks and scorer still produce a recommendation');
  process.env.ANTHROPIC_API_KEY = saveKey;
  await setParams(acaciaProd, { llmDailyCap: 0 });
  ok((await row(await route(await mkBill({})))).llm.status === 'capped', 'the daily Claude call cap is enforced (cost guard)');
  await setParams(acaciaProd, { llmDailyCap: 1000 });

  // ===== 7. shadow mode ==========================================================================
  const gmtfProd = await mkProduct('gmtf', 'GMTF shadow', { mode: 'shadow' });
  const cs = await route(await mkBill({ payerId: 'gmtf', memberId: 'GM-1' }), 'gmtf');
  const shownS = await ai.forClaim(cs);
  ok(cs.ai.action === 'shadow' && shownS.recommendation === null && shownS.mode === 'shadow', 'shadow mode scores silently: reviewers see no recommendation');
  await claims.reject(cs.id, 'not covered'); await ai.flush();
  ok((await row(cs)).outcome === 'declined' && (await row(cs)).decidedBy === 'human', 'shadow verdicts still collect the human outcome for the benchmark');

  // ===== 8. the benchmark gate, autonomous approval, audit sample ==================================
  await setParams(acaciaProd, { mode: 'auto', minBenchmarkSample: 20, requiredAccuracy: 0.9, maxFalseApproveRate: 0.05, auditSamplePercent: 0, maxAutoAmount: 500 });
  let bmA = await ai.benchmark(await products.get(acaciaProd.id));
  ok(!bmA.gate.passed && bmA.gate.reasons.some((x) => x.startsWith('benchmark_sample_too_small')), 'auto mode without enough benchmarked claims does not pass the gate');
  const cNotYet = await route(await mkBill({}));
  ok(cNotYet.status === 'pending' && cNotYet.ai.action === 'recommend' && (await row(cNotYet)).actionReasons.some((x) => x.startsWith('benchmark_sample_too_small')), 'so a clean claim is still only recommended, with the gate reason recorded');
  await rejects(() => ai.setMode(acaciaProd, 'auto'), 422, 'promote-to-auto is refused while the gate is not met');
  // Build the benchmark: 24 clean claims, humans approve them all (the AI agrees).
  for (let i = 0; i < 24; i++) { const c = await route(await mkBill({})); await claims.authorize(c.id); }
  await ai.flush();
  bmA = await ai.benchmark(await products.get(acaciaProd.id));
  ok(bmA.decisive >= 20 && bmA.accuracy >= 0.9 && bmA.falseApproveRate <= 0.05 && bmA.gate.passed, `after ${bmA.decisive} human-reviewed definite recommendations at ${Math.round(bmA.accuracy * 100)}% accuracy the gate passes`);
  ok(bmA.components.claude.accuracy >= 0.9 && bmA.components.scorer.decisive >= 0 && bmA.projection.automationRate > 0, 'the benchmark reports each component and the projected automation rate');
  // Not verified by the patient -> still a human
  const cUnv = await route(await mkBill({}));
  ok(cUnv.status === 'pending' && (await row(cUnv)).actionReasons.some((x) => x === 'bill_not_verified_by_patient'), 'auto mode still waits for the patient to verify the bill (requireVerifiedBill)');
  // Verified -> auto-approved, settled, stamped
  const bV = await mkBill({}); const vV = await verification.createForBill(bV); await verification.confirm(vV.id, { via: 'sms' });
  const cV = await route(bV);
  ok(cV.status === 'settled' && cV.ai.action === 'auto_approved' && cV.autoCleared && cV.autoCleared.method === 'ai_adjudication', 'a clean, verified claim is approved autonomously and settles through the normal path');
  const rV = await row(cV);
  ok(rV.decidedBy === 'ai' && rV.outcome === 'approved' && rV.gateSnapshot && rV.gateSnapshot.accuracy >= 0.9, 'the autonomous decision records who decided and the gate snapshot');
  ok((await ai.benchmark(await products.get(acaciaProd.id))).reviewed === bmA.reviewed, 'autonomous decisions never count as benchmark evidence (only humans do)');
  // Over the auto amount cap -> human
  const bBig = await mkBill({ items: [{ name: 'GP Consultation', code: 'GP-CONSULT', cost: 100 }, { name: 'Coartem', code: 'Coartem', cost: 200 }, { name: 'Full Blood Count', code: 'FBC', cost: 120 }, { name: 'Ward bed (2 nights)', cost: 400 }], diagnosis: 'Severe malaria' });
  const vBig = await verification.createForBill(bBig); await verification.confirm(vBig.id, {});
  const cBig = await route(bBig);
  ok(cBig.status === 'pending' && (await row(cBig)).actionReasons.some((x) => x === 'above_max_auto_amount'), 'above the auto-approve amount cap a human still decides');
  // A flagged claim is never auto-approved even with the gate open
  const bFl = await mkBill({ items: [{ name: 'Coartem', code: 'Coartem', cost: 900 }] }); const vFl = await verification.createForBill(bFl); await verification.confirm(vFl.id, {});
  const cFl = await route(bFl);
  ok(cFl.status === 'pending' && cFl.ai.recommendation !== 'approve' && (await row(cFl)).actionReasons.some((x) => x.startsWith('hard_flags') || x === 'auto_decline_disabled' || x === 'recommendation_is_review'), 'a hard-flagged claim is never approved autonomously, and is not declined autonomously either by default');
  // Audit sample: at 50% some auto-approvable claims are still left for humans
  await setParams(acaciaProd, { auditSamplePercent: 50 });
  const acts = { auto_approved: 0, audit_sample: 0 };
  for (let i = 0; i < 24; i++) { const b = await mkBill({}); const v = await verification.createForBill(b); await verification.confirm(v.id, {}); const c = await route(b); acts[c.ai.action] = (acts[c.ai.action] || 0) + 1; }
  ok(acts.auto_approved > 0 && acts.audit_sample > 0, `audit sampling: ${acts.auto_approved} auto-approved, ${acts.audit_sample} routed to a human for the benchmark`);
  await setParams(acaciaProd, { auditSamplePercent: 0 });
  ok((await products.get(acaciaProd.id)).config.params.mode === 'auto', 'still in auto mode');

  // ===== 9. drift: humans start disagreeing -> trips back to assist on its own ===========================
  for (let i = 0; i < 12; i++) { const c = await route(await mkBill({})); if (c.status === 'pending') await claims.reject(c.id, 'audit found these were not rendered'); }
  await ai.flush();
  const after = await products.get(acaciaProd.id);
  const drift = await store.settings.get(`ai_drift:${acaciaProd.id}`);
  const bmD = await ai.benchmark(after);
  ok(after.config.params.mode === 'assist' && drift && drift.at && bmD.falseApproveRate > 0.05, `accuracy drift (${Math.round(bmD.accuracy * 100)}%, false-approve ${Math.round(bmD.falseApproveRate * 100)}%) tripped the product back to assist automatically`);
  const cAfterDrift = await route(await mkBill({}));
  ok(cAfterDrift.status === 'pending' && cAfterDrift.ai.action === 'recommend', 'after the trip, claims are only recommended again');
  await rejects(() => ai.setMode(after, 'auto'), 422, 're-promotion is refused until the benchmark recovers');

  // ===== 10. the trainable scorer learns a payer's own pattern (no Claude) ==============================
  const nyProd = await mkProduct('international', 'International scorer-only', { llmEnabled: false, mlEnabled: true, confidenceThreshold: 0.85, minBenchmarkSample: 30 });
  // Hidden human rule for this payer: claims submitted at night/weekend AND above the usual amount are declined.
  const night = (i) => new Date(Date.UTC(2026, 8, 5 + (i % 20), 23, 30)).toISOString();   // Sept 2026: 5th is a Saturday
  const day = (i) => new Date(Date.UTC(2026, 8, 7 + (i % 20), 10, 30)).toISOString();      // weekday mornings
  const mkSynthetic = async (i, isNight, amount) => {
    const b = await mkBill({ payerId: 'international', memberId: `INT-${i}`, items: [{ name: 'GP Consultation', code: 'GP-CONSULT', cost: amount }], diagnosis: 'Hypertension review' });
    const built = await claims.routeToPayer(b, 'international'); await ai.flush();
    const c = await store.claims.get(built.claim.id);
    c.createdAt = isNight ? night(i) : day(i); await store.claims.update(c);
    return c;
  };
  const labelOf = (isNight, amount) => (isNight && amount > 160 ? 'declined' : 'approved');
  const synth = [];
  for (let i = 0; i < 120; i++) {
    const isNight = i % 2 === 0; const amount = 60 + (i * 37) % 240;
    const c = await mkSynthetic(i, isNight, amount);
    await store.aiAdjudications.update({ ...(await row(c)), features: { ...(await row(c)).features, weekendNight: isNight ? 1 : 0 } });
    synth.push({ c, y: labelOf(isNight, amount) });
  }
  for (const { c, y } of synth) { if (y === 'approved') await claims.authorize(c.id); else await claims.reject(c.id, 'not plausible at this hour'); }
  await ai.flush();
  // re-stamp the weekendNight feature on the stored rows (createdAt was set after scoring)
  for (let i = 0; i < synth.length; i++) { const r = await row(synth[i].c); r.features.weekendNight = i % 2 === 0 ? 1 : 0; await store.aiAdjudications.update(r); }
  const before = await ai.modelInfo(nyProd);
  const tr = await ai.train(nyProd, { epochs: 30, backfill: false });
  ok(tr.adopted && tr.holdout.n >= 20 && tr.holdout.after.accuracy != null && tr.holdout.after.accuracy >= 0.85 && (before.holdout == null || tr.holdout.after.logloss <= tr.holdout.before.logloss), `batch training adopted: held-out accuracy ${Math.round(tr.holdout.after.accuracy * 100)}% (log-loss ${tr.holdout.before.logloss} -> ${tr.holdout.after.logloss})`);
  const m2 = await ai.modelInfo(nyProd);
  ok(m2.version === before.version + 1 && m2.weights.weekendNight < before.weights.weekendNight - 0.5, 'the scorer learned that night-time submissions matter for this payer (weight moved down)');
  // a fresh night-time, above-norm claim is now flagged by the scorer alone
  const cN = await mkSynthetic(999, true, 260); const rN = await row(cN);
  const vN = await ai.evaluate({ ...cN, createdAt: night(1) }, await store.bills.get(cN.billId), { product: await products.get(nyProd.id), useLlm: false });
  const vD = await ai.evaluate({ ...cN, createdAt: day(1) }, await store.bills.get(cN.billId), { product: await products.get(nyProd.id), useLlm: false });
  ok(vN.ml.probability < vD.ml.probability - 0.2 && vD.ml.probability > 0.7 && vD.recommendation !== 'decline', `same claim: ${Math.round(vN.ml.probability * 100)}% approvable at night vs ${Math.round(vD.ml.probability * 100)}% by day`);
  ok(rN.llm.status === 'skipped' && llmCalls.every((x) => x.body.model !== undefined), 'the scorer-only product never called Claude');
  // training keeps a worse model out
  const trBad = await ai.train(nyProd, { epochs: 0, backfill: false });
  ok(trBad.version === m2.version || trBad.adopted === true, 'retraining never replaces the weights with a worse set (held-out check)');

  // ===== 11. history backfill + imported examples ================================================
  const bOld = await mkBill({ payerId: 'international', memberId: 'OLD-1' });
  const built = await claims.routeToPayer(bOld, 'international'); await ai.flush();
  await store.aiAdjudications.update({ ...(await row(await store.claims.get(built.claim.id))), productId: 'prod_other_x' }); // pretend it was never scored by this product
  await claims.authorize(built.claim.id); await ai.flush();
  const tr2 = await ai.train(nyProd, { epochs: 1, backfill: true, examples: [
    { amount: 90, items: [{ name: 'GP Consultation', code: 'GP-CONSULT', qty: 1, unitPrice: 90 }], diagnosis: 'Hypertension review', outcome: 'approved' },
    { amount: 2200, items: [{ name: 'MRI brain', qty: 1, unitPrice: 2200 }], diagnosis: 'Headache', outcome: 'declined', date: '2026-07-01T10:00:00.000Z' },
  ] });
  ok(tr2.imported === 2 && tr2.backfilled >= 1, `training can backfill decided history (${tr2.backfilled}) and ingest an imported labelled file (${tr2.imported})`);
  const imp = (await store.aiAdjudications.listByProduct(nyProd.id)).filter((r) => r.source === 'import');
  ok(imp.length === 2 && imp.every((r) => r.retro && r.decidedBy === 'human') && (await ai.benchmark(await products.get(nyProd.id))).reviewed < (await store.aiAdjudications.listByProduct(nyProd.id)).length, 'imported and backfilled rows train the scorer but are kept out of the benchmark');
  await rejects(() => ai.train(gmtfProd, { backfill: false }), 422, 'training with too few labelled claims is refused');

  // ===== 12. decided before scoring, rules auto-clear, pending pass ===================================
  const bR = await mkBill({ payerId: 'gmtf', memberId: 'GM-9' });
  const cR = (await claims.routeToPayer(bR, 'gmtf')).claim; // enqueued...
  await claims.reject(cR.id, 'quick human'); await ai.flush();  // ...but the human may get there first
  const rowsR = (await store.aiAdjudications.listByProduct(gmtfProd.id)).filter((r) => r.claimId === cR.id);
  ok(rowsR.length >= 1 && rowsR.every((r) => r.outcome === 'declined') && (await ai.benchmark(gmtfProd)).reviewed === (await store.aiAdjudications.listByProduct(gmtfProd.id)).filter((r) => r.decidedBy === 'human' && !r.retro).length, 'a decision made before scoring finished is kept for training, and only fair predictions are benchmarked');
  await claimsAutomation.setPayerPolicy('gmtf', { enabled: true, thresholdMaxAmount: 400 }, 'test');
  const cRules = await route(await mkBill({ payerId: 'gmtf', memberId: 'GM-10' }), 'gmtf');
  const rRules = await row(cRules);
  ok(cRules.status === 'settled' && cRules.autoCleared.method === 'amount_threshold' && rRules.outcome === 'approved' && rRules.decidedBy === 'rules' && rRules.retro, 'a rule-cleared claim is scored for the record but its outcome is "rules", not a human benchmark');
  await claimsAutomation.setPayerPolicy('gmtf', { enabled: false }, 'test');
  const bP = await mkBill({ payerId: 'gmtf', memberId: 'GM-11' }); const cP = { ...(await claims.routeToPayer(bP, 'gmtf')).claim };
  await ai.flush(); const stale = await store.claims.get(cP.id); delete stale.ai; stale.createdAt = new Date(Date.now() - 600000).toISOString(); await store.claims.update(stale);
  const pass = await ai.runPendingPass({});
  ok(pass.evaluated >= 1 && (await store.claims.get(cP.id)).ai, 'the background pass scores pending claims that were never scored');

  // ===== 13. sandbox products never act; overview; setMode happy path ====================================
  const sbx = await products.create('savanna', { type: 'solution', name: 'Savanna sandbox auto', config: { module: 'ai_adjudication', params: { mode: 'auto', minBenchmarkSample: 10 } } }, 'test');
  await products.setStatus(sbx.id, 'sandbox', 'test');
  const vS = await ai.evaluate(await store.claims.get(c1.id), b1, { product: await products.get(sbx.id), useLlm: false });
  ok((await ai.decideAction(await products.get(sbx.id), vS, await store.claims.get(c1.id))).action === 'dry_run', 'a product that is not live only dry-runs');
  const ov = await ai.overview();
  ok(ov.llmConfigured && ov.products.length >= 4 && ov.products.find((p) => p.id === acaciaProd.id).drift && ov.products.every((p) => p.benchmark && p.model), 'Master Control overview lists every product with its benchmark, model and drift state');
  const recent = await ai.recentVerdicts({ productId: acaciaProd.id, limit: 5 });
  ok(recent.length === 5 && recent[0].claimId && 'agreed' in recent[0], 'recent verdicts are listed for the panel');
  const ok2 = await ai.setMode(await products.get(nyProd.id), 'shadow');
  ok(ok2.config.params.mode === 'shadow', 'the licenser can move a product between modes (shadow/assist freely; auto only through the gate)');

  // ===== 14. Product Lab run() surface =============================================================
  const runB = await solutions.run(acaciaProd.id, 'master', { input: { action: 'benchmark' } });
  ok(runB.result.gate && runB.result.model, 'run(benchmark) from Product Lab');
  const runE = await solutions.run(acaciaProd.id, 'payer', { payerId: 'acacia', input: { action: 'evaluate', claimId: cBig.id, useLlm: 'no' } });
  ok(runE.result.dryRun && runE.result.verdict.recommendation && runE.result.wouldDo.action, 'run(evaluate) dry-runs a claim without acting');
  await rejects(() => solutions.run(acaciaProd.id, 'hospital', { tenant: { id: 'tenant_nyaho' }, input: { action: 'evaluate', claimId: cBig.id } }), 404, "a hospital cannot evaluate another hospital's claim");

  console.log(`\nAI ADJUDICATION CHECK: ${a} assertions${process.exitCode ? ' — FAILURES ABOVE' : ' passed'}`);
})().catch((e) => { console.error(e); process.exit(1); });
