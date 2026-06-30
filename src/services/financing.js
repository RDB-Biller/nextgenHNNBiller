'use strict';

const crypto = require('crypto');
const store = require('../store');
const { executePayerTransfer } = require('./settlement');
const { notify } = require('./notifications');
const ledger = require('./ledger');

/**
 * Finance the patient's share: momo_loan | bank_loan | employer_loan | grant |
 * hospital_credit (full, or part-payment now + remainder on credit).
 * Integrated financiers settle to the clinic over the SBG A2A rail; referral
 * partners hand off externally. The platform holds nothing.
 */
async function createFinancing({ bill, type, financierId, employerId, amount, partPayment = 0, reportId }) {
  const requested = amount != null ? Number(amount) : bill.totals.patientPayable;
  const fin = {
    id: `fin_${crypto.randomBytes(8).toString('hex')}`,
    billId: bill.id, tenantId: bill.tenantId,
    type, reportId: reportId || null,
    amount: requested, currency: bill.currency,
    status: 'requested', createdAt: new Date().toISOString(),
  };

  if (type === 'hospital_credit') {
    const part = Math.max(0, Math.min(Number(partPayment) || 0, requested));
    fin.partPayment = part;
    fin.outstanding = Math.round((requested - part) * 100) / 100;
    fin.financierId = 'hospital';
    fin.status = 'credit_extended';
    await store.tx(async (t) => {
      const b = await t.bills.get(bill.id, { forUpdate: true });
      b.status = 'on_credit';
      b.settlementMethod = 'hospital_credit';
      await t.bills.update(b);
      await t.ledger.insert(ledger.entry({
        tenantId: b.tenantId, billId: b.id, type: 'hospital_credit',
        source: { kind: 'hospital', id: b.tenantId, name: b.provider },
        amount: fin.outstanding, currency: b.currency, cashMovement: false,
        refs: { financingId: fin.id, partPayment: fin.partPayment },
      }));
    });
    await store.financings.insert(fin);
    await notify({ party: 'patient', channel: 'sms', to: bill.patient.phone,
      subject: 'Hospital credit arranged',
      body: `${bill.provider} extended ${bill.currency} ${fin.outstanding.toFixed(2)} as credit${part ? `, after a part-payment of ${bill.currency} ${part.toFixed(2)}` : ''}.`,
      billId: bill.id });
    return fin;
  }

  let source;
  if (type === 'employer_loan') {
    source = await store.payers.get(employerId);
    if (!source || source.kind !== 'employer') { const e = new Error('unknown_employer'); e.status = 422; throw e; }
  } else {
    source = await store.financiers.get(financierId || defaultFinancier(type));
    if (!source) { const e = new Error('unknown_financier'); e.status = 422; throw e; }
  }
  fin.financierId = source.id;
  fin.financierName = source.name;
  fin.terms = source.terms || null;

  if (source.integration === 'referral') {
    fin.status = 'referred';
    fin.referralUrl = source.url;
    await store.financings.insert(fin);
    return fin;
  }

  const tenant = await store.tenants.get(bill.tenantId);
  const transfer = await executePayerTransfer({ bill, payer: source, tenant, amount: requested,
    narration: `${type} ${bill.id} via ${source.name}` });
  fin.serviceRequestId = transfer.serviceRequestId;
  fin.transferReference = transfer.reference;
  fin.status = transfer.status === 'SUCCESS' ? 'settled' : 'submitted';

  if (fin.status === 'settled') {
    const ok = await store.tx(async (t) => {
      const b = await t.bills.get(bill.id, { forUpdate: true });
      if (b && b.status !== 'settled' && b.status !== 'on_credit') {
        b.status = 'settled';
        b.settlementMethod = 'financing';
        await t.bills.update(b);
        await t.ledger.insert(ledger.entry({
          tenantId: b.tenantId, billId: b.id, type: 'financing_disbursement',
          source: { kind: source.kind, id: source.id, name: source.name },
          amount: requested, currency: b.currency, cashMovement: true,
          refs: { financingId: fin.id, financingType: type, serviceRequestId: fin.serviceRequestId, reference: fin.transferReference },
        }));
        return b;
      }
      return null;
    });
    if (ok) {
      await notify({ party: 'provider', to: tenant?.contact?.email,
        subject: `Bill ${bill.id} financed`,
        body: `${source.name} disbursed ${bill.currency} ${requested.toFixed(2)} to your account (${type.replace('_', ' ')}).`, billId: bill.id });
      await notify({ party: 'patient', channel: 'sms', to: bill.patient.phone,
        subject: 'Your financing was approved',
        body: `${source.name} covered ${bill.currency} ${requested.toFixed(2)} at ${bill.provider}.${source.kind === 'grant' ? '' : ' Repayment terms apply.'}`, billId: bill.id });
    }
  }
  await store.financings.insert(fin);
  return fin;
}

function defaultFinancier(type) {
  return ({ momo_loan: 'momo-quickcash', bank_loan: 'medfin-bank', grant: 'hope-grant' })[type];
}

module.exports = { createFinancing };
