'use strict';

const express = require('express');
const store = require('../store');
const claimsService = require('../services/claims');
const verification = require('../services/verification');
const priorApproval = require('../services/priorApproval');
const networks = require('../services/networks');
const solutions = require('../services/solutions');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    const payer = await store.payers.byApiKey(req.header('x-payer-key'));
    if (!payer) return res.status(401).json({ error: 'invalid_payer_key' });
    req.payer = payer;
    next();
  } catch (e) { next(e); }
});

async function claimView(c) {
  const bill = await store.bills.get(c.billId);
  const payer = await store.payers.get(c.payerId);
  const v = await verification.forBill(c.billId);
  // Prior approvals this payer already has on file for this member — offered as a
  // one-click override reason so the payer doesn't have to retype/find the id.
  const matchingPriorApprovals = c.memberId ? await priorApproval.activeForMember(c.payerId, c.memberId) : [];
  return {
    claimId: c.id, status: c.status, amount: c.amount, currency: c.currency,
    provider: c.provider || bill?.provider,
    patientName: c.patient?.name || bill?.patient?.name || null,
    memberId: c.memberId,
    sponsor: c.patient?.sponsor || bill?.coverage?.sponsor?.name || null,
    // Itemised breakdown: each line shows what the payer covers vs the patient portion.
    lineItems: (c.lineItems && c.lineItems.length
      ? c.lineItems
      : (bill?.lineItems || []).map((i) => ({ name: i.name, code: i.code || null,
          qty: i.qty || 1, unitPrice: i.unitPrice ?? i.cost, lineTotal: i.cost,
          payerCovers: null, patientPortion: null }))),
    breakdown: c.breakdown || (bill ? {
      subtotal: bill.totals.subtotal, discount: bill.totals.discount,
      net: bill.totals.net, payerShare: bill.totals.payerShare } : null),
    clinical: c.clinical || bill?.clinical || null,
    nnest: c.nnest || null,
    // Whether this payer requires the patient to verify before authorising, and
    // whether that has happened yet — shown so the pending state is visible before
    // an Authorise action is attempted (see services/claims.js authorize()).
    requirePatientVerification: payer?.requirePatientVerification === true,
    patientVerification: v ? { status: v.status, verifiedAt: v.verifiedAt || null, verifiedBy: v.verifiedBy || null, verifiedVia: v.verifiedVia || null, disputeReason: v.disputeReason || null, remindersSent: v.remindersSent || 0, channelsSent: v.channelsSent || [] } : { status: 'not_sent' },
    matchingPriorApprovals: matchingPriorApprovals.map((pa) => ({
      id: pa.id, description: pa.description, amountCap: pa.amountCap, expiresAt: pa.expiresAt, timesUsed: pa.timesUsed })),
    transferReference: c.transferReference || null, beneficiaryName: c.beneficiaryName || null,
    link: c.link, createdAt: c.createdAt,
  };
}

router.get('/me', (req, res) => res.json({ id: req.payer.id, name: req.payer.name, kind: req.payer.kind }));

router.get('/summary', async (req, res, next) => {
  try {
    const cs = await store.claims.listByPayer(req.payer.id);
    const val = (s) => cs.filter((c) => c.status === s).reduce((a, c) => a + c.amount, 0);
    res.json({
      payer: req.payer.name, kind: req.payer.kind,
      pending: cs.filter((c) => c.status === 'pending').length, pendingValue: val('pending'),
      settled: cs.filter((c) => c.status === 'settled').length, settledValue: val('settled'),
      rejected: cs.filter((c) => c.status === 'rejected').length,
    });
  } catch (e) { next(e); }
});

router.get('/claims', async (req, res, next) => {
  try {
    let cs = await store.claims.listByPayer(req.payer.id);
    if (req.query.status) cs = cs.filter((c) => c.status === req.query.status);
    res.json({ payer: req.payer.name, data: await Promise.all(cs.map(claimView)) });
  } catch (e) { next(e); }
});

async function own(req, res) {
  const c = await store.claims.get(req.params.id);
  if (!c || c.payerId !== req.payer.id) { res.status(404).json({ error: 'claim_not_found' }); return null; }
  return c;
}

router.get('/claims/:id', async (req, res, next) => {
  try { const c = await own(req, res); if (c) res.json(await claimView(c)); }
  catch (e) { next(e); }
});

router.post('/claims/:id/authorize', idempotency((r) => `payer:${r.payer.id}:authorize`), async (req, res, next) => {
  try {
    const c = await own(req, res); if (!c) return;
    await claimsService.authorize(c.id);
    res.json(await claimView(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});

router.post('/claims/:id/reject', async (req, res, next) => {
  try {
    const c = await own(req, res); if (!c) return;
    await claimsService.reject(c.id, req.body?.reason);
    res.json(await claimView(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});

// ---- Patient verification: reissue / manual override -------------------------

// Resend the same verification link to the patient — for when the payer's own
// dashboard shows it's still pending and they'd rather nudge than override.
router.post('/claims/:id/verification/reissue', async (req, res, next) => {
  try {
    const c = await own(req, res); if (!c) return;
    const v = await verification.forBill(c.billId);
    if (!v) return res.status(404).json({ error: 'verification_not_found' });
    await verification.reissue(v.id);
    res.json(await claimView(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});

// The payer marks the bill verified themselves — they reviewed the claim directly,
// called the hospital, or the member already has a matching prior approval on file
// (pass priorApprovalId to reference one; it's validated as this payer's own,
// active, and its usage trail is updated).
router.post('/claims/:id/verification/override', async (req, res, next) => {
  try {
    const c = await own(req, res); if (!c) return;
    const v = await verification.forBill(c.billId);
    if (!v) return res.status(404).json({ error: 'verification_not_found' });
    const priorApprovalId = req.body?.priorApprovalId || null;
    if (priorApprovalId) {
      const pa = await store.priorApprovals.get(priorApprovalId);
      if (!pa || pa.payerId !== req.payer.id) return res.status(404).json({ error: 'prior_approval_not_found' });
      if (priorApproval.effectiveStatus(pa) !== 'active') return res.status(409).json({ error: 'prior_approval_not_active' });
      await priorApproval.markUsed(pa.id, c.id);
    }
    await verification.overrideVerify(v.id, { by: req.payer.id, reason: req.body?.reason, priorApprovalId });
    res.json(await claimView(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});

// ---- Prior approvals: payer-recorded pre-authorization ------------------------

router.get('/prior-approvals', async (req, res, next) => {
  try { res.json({ data: await priorApproval.listByPayer(req.payer.id) }); }
  catch (e) { next(e); }
});

router.post('/prior-approvals', async (req, res, next) => {
  try { res.status(201).json(await priorApproval.create(req.payer.id, req.body || {})); }
  catch (e) { next(e); }
});

router.delete('/prior-approvals/:id', async (req, res, next) => {
  try { res.json(await priorApproval.revoke(req.params.id, req.payer.id)); }
  catch (e) { next(e); }
});

// ---- NNEST: Narrow Network Expedited Settlement Terms (payer-operated) -------

// Network posture for this payer.
router.get('/network', async (req, res, next) => {
  try {
    const terms = await networks.listByPayer(req.payer.id);
    res.json({
      payer: req.payer.name,
      networkMode: req.payer.networkMode || 'open',
      outOfNetworkPolicy: req.payer.outOfNetworkPolicy || 'standard',
      // Configurable settlement cycle (gap: beyond immediate) -- set via the
      // same PUT /network/posture and PUT /network/providers/:tenantId below,
      // just with a settlementCycle/defaultSettlementCycle field in the body.
      // See services/networks.js#resolveCycle. settlementRail is HNN's own
      // integration choice (Master Control), shown here read-only for context.
      defaultSettlementCycle: req.payer.defaultSettlementCycle || 'immediate',
      settlementRail: req.payer.settlementRail || 'stanbic',
      settlementCycles: networks.SETTLEMENT_CYCLES,
      caps: { feeRate: networks.MAX_FEE_RATE, promptPaymentDiscount: networks.MAX_PROMPT_DISCOUNT },
      providers: terms.map((t) => ({
        tenantId: t.tenantId, providerName: t.providerName, status: t.status,
        settlement: t.settlement, feeRate: t.feeRate, chargeTo: t.chargeTo,
        promptPaymentDiscountPercent: t.promptPaymentDiscountPercent,
        maxClaimAmount: t.maxClaimAmount, effectiveFrom: t.effectiveFrom, effectiveTo: t.effectiveTo,
        settlementCycle: t.settlementCycle || 'immediate',
        active: networks.isActive(t), updatedAt: t.updatedAt,
      })),
    });
  } catch (e) { next(e); }
});

// Open vs narrow network, and what happens out of network.
router.put('/network/posture', async (req, res, next) => {
  try { res.json(await networks.setPosture(req.payer.id, req.body || {})); }
  catch (e) { next(e); }
});

// Add or update a provider's expedited settlement terms.
router.put('/network/providers/:tenantId', async (req, res, next) => {
  try { res.json(await networks.setTerms(req.payer.id, req.params.tenantId, req.body || {})); }
  catch (e) { next(e); }
});

// Suspend terms (provider stays on record; instant settlement stops).
router.delete('/network/providers/:tenantId', async (req, res, next) => {
  try { res.json(await networks.suspend(req.payer.id, req.params.tenantId)); }
  catch (e) { next(e); }
});

// Dry-run: how would a claim of this size settle for this provider today?
router.post('/network/preview', async (req, res, next) => {
  try {
    res.json(await networks.resolve(req.payer, req.body?.tenantId, Number(req.body?.amount) || 0));
  } catch (e) { next(e); }
});

// ---- Solutions built for this payer in Product Lab (payer surface) -------------

router.get('/solutions', async (req, res, next) => {
  try { res.json({ data: await solutions.listFor('payer', { payerId: req.payer.id }) }); } catch (e) { next(e); }
});

router.post('/solutions/:id/run', async (req, res, next) => {
  try { res.json(await solutions.run(req.params.id, 'payer', { payerId: req.payer.id, input: req.body?.input })); }
  catch (e) { next(e); }
});

module.exports = router;
