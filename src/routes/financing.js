'use strict';

const express = require('express');
const store = require('../store');
const report = require('../services/medicalReport');
const { createFinancing } = require('../services/financing');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
async function ownBill(req, id) {
  const b = await store.bills.get(id);
  return b && b.tenantId === req.tenant.id ? b : null;
}

router.get('/questions', (req, res) => {
  const kind = req.query.kind === 'detailed' ? 'detailed' : 'micro';
  res.json({ kind, questions: report.questions(kind) });
});

router.post('/reports', async (req, res, next) => {
  try {
    const bill = await ownBill(req, req.body.billId);
    if (!bill) return res.status(404).json({ error: 'bill_not_found' });
    const r = await report.generate({
      bill, kind: req.body.kind, diagnosis: req.body.diagnosis, qa: req.body.qa || [],
      amountRequested: req.body.amountRequested, loanType: req.body.loanType, clinicianName: req.body.clinicianName,
    });
    res.status(201).json(r);
  } catch (e) { next(e); }
});

router.get('/reports/:id', async (req, res, next) => {
  try {
    const r = await store.reports.get(req.params.id);
    if (!r || r.tenantId !== req.tenant.id) return res.status(404).json({ error: 'report_not_found' });
    res.json(r);
  } catch (e) { next(e); }
});

router.post('/', idempotency((r) => `tenant:${r.tenant.id}:financing`), async (req, res, next) => {
  try {
    const bill = await ownBill(req, req.body.billId);
    if (!bill) return res.status(404).json({ error: 'bill_not_found' });
    const fin = await createFinancing({
      bill, type: req.body.type, financierId: req.body.financierId, employerId: req.body.employerId,
      amount: req.body.amount, partPayment: req.body.partPayment, reportId: req.body.reportId,
    });
    res.status(201).json(fin);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const f = await store.financings.get(req.params.id);
    if (!f || f.tenantId !== req.tenant.id) return res.status(404).json({ error: 'financing_not_found' });
    res.json(f);
  } catch (e) { next(e); }
});

module.exports = router;
