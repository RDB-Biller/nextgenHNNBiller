'use strict';

const express = require('express');
const store = require('../store');
const claimsService = require('../services/claims');
const verification = require('../services/verification');
const priorApproval = require('../services/priorApproval');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
async function load(req, res) {
  const c = await claimsService.getByToken(req.params.token);
  if (!c) { res.status(404).json({ error: 'claim_not_found' }); return null; }
  return c;
}
async function view(c) {
  const bill = await store.bills.get(c.billId);
  const payer = await store.payers.get(c.payerId);
  const v = await verification.forBill(c.billId);
  const matchingPriorApprovals = c.memberId ? await priorApproval.activeForMember(c.payerId, c.memberId) : [];
  return {
    claimId: c.id, status: c.status, payer: payer?.name, payerKind: payer?.kind,
    provider: c.provider || bill?.provider, amount: c.amount, currency: c.currency,
    patientName: c.patient?.name || bill?.patient?.name || null, memberId: c.memberId,
    sponsor: c.patient?.sponsor || bill?.coverage?.sponsor?.name || null,
    lineItems: (c.lineItems && c.lineItems.length
      ? c.lineItems
      : (bill?.lineItems || []).map((i) => ({ name: i.name, code: i.code || null,
          qty: i.qty || 1, unitPrice: i.unitPrice ?? i.cost, lineTotal: i.cost }))),
    breakdown: c.breakdown || null,
    clinical: c.clinical || bill?.clinical || null,
    // Same verification-pending signal exposed to the payer console UI (payers.html)
    // via the Payer API; here for the secure-link claim page (claim.html).
    requirePatientVerification: payer?.requirePatientVerification === true,
    patientVerification: v ? { status: v.status, verifiedAt: v.verifiedAt || null, verifiedBy: v.verifiedBy || null, disputeReason: v.disputeReason || null, remindersSent: v.remindersSent || 0 } : { status: 'not_sent' },
    matchingPriorApprovals: matchingPriorApprovals.map((pa) => ({
      id: pa.id, description: pa.description, amountCap: pa.amountCap, expiresAt: pa.expiresAt, timesUsed: pa.timesUsed })),
    transferReference: c.transferReference || null, beneficiaryName: c.beneficiaryName || null,
  };
}

router.get('/:token', async (req, res, next) => {
  try { const c = await load(req, res); if (c) res.json(await view(c)); } catch (e) { next(e); }
});
router.post('/:token/authorize', idempotency((r) => `claimlink:${r.params.token}`), async (req, res, next) => {
  try {
    const c = await load(req, res); if (!c) return;
    await claimsService.authorize(c.id);
    res.json(await view(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});
router.post('/:token/reject', async (req, res, next) => {
  try {
    const c = await load(req, res); if (!c) return;
    await claimsService.reject(c.id, req.body?.reason);
    res.json(await view(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});

// Resend the patient's verification link from the payer's secure claim page.
router.post('/:token/verification/reissue', async (req, res, next) => {
  try {
    const c = await load(req, res); if (!c) return;
    const v = await verification.forBill(c.billId);
    if (!v) return res.status(404).json({ error: 'verification_not_found' });
    await verification.reissue(v.id);
    res.json(await view(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});

// Mark verified without the patient's own confirmation — reviewed directly, phoned
// the hospital, or backed by a prior approval already on file for this member.
router.post('/:token/verification/override', async (req, res, next) => {
  try {
    const c = await load(req, res); if (!c) return;
    const v = await verification.forBill(c.billId);
    if (!v) return res.status(404).json({ error: 'verification_not_found' });
    const priorApprovalId = req.body?.priorApprovalId || null;
    if (priorApprovalId) {
      const pa = await store.priorApprovals.get(priorApprovalId);
      if (!pa || pa.payerId !== c.payerId) return res.status(404).json({ error: 'prior_approval_not_found' });
      if (priorApproval.effectiveStatus(pa) !== 'active') return res.status(409).json({ error: 'prior_approval_not_active' });
      await priorApproval.markUsed(pa.id, c.id);
    }
    await verification.overrideVerify(v.id, { by: c.payerId, reason: req.body?.reason, priorApprovalId });
    res.json(await view(await store.claims.get(c.id)));
  } catch (e) { next(e); }
});

module.exports = router;
