'use strict';

const crypto = require('crypto');
const store = require('../store');
const { notify } = require('./notifications');
const ledger = require('./ledger');

/** Patient self-pay (patient -> clinic). MoMo/card via gateway; cash immediate. */
async function createPaymentIntent({ bill, method = 'mtn-momo', payerPhone }) {
  const intent = {
    id: `pay_${crypto.randomBytes(8).toString('hex')}`,
    billId: bill.id, amount: bill.totals.patientPayable, currency: bill.currency,
    method, payerPhone: payerPhone || bill.patient.phone || null,
    status: method === 'cash' ? 'paid' : 'requires_payment',
    createdAt: new Date().toISOString(),
  };
  await store.payments.insert(intent);
  if (method === 'cash') await settleSelfPay(intent, 'CASH');
  return intent;
}

async function charge(intent) {
  if (intent.status === 'paid') return intent;
  intent.status = 'processing';
  await store.payments.update(intent);
  // TODO: call real MoMo/card collection gateway; it confirms via webhook.
  return intent;
}

async function markPaid(intentId, gatewayRef) {
  const intent = await store.payments.get(intentId);
  if (!intent) return null;
  if (intent.status !== 'paid') await settleSelfPay(intent, gatewayRef);
  return intent;
}

async function settleSelfPay(intent, ref) {
  intent.status = 'paid';
  intent.gatewayRef = ref || null;
  intent.paidAt = new Date().toISOString();
  await store.payments.update(intent);

  // Lock the bill so a concurrent payer/financing path can't double-settle it.
  const settled = await store.tx(async (t) => {
    const bill = await t.bills.get(intent.billId, { forUpdate: true });
    if (bill && ['open', 'awaiting_payer'].includes(bill.status)) {
      bill.status = 'settled';
      bill.settlementMethod =
        intent.method === 'cash' ? 'cash' : intent.method === 'card' ? 'patient_card' : 'patient_momo';
      await t.bills.update(bill);
      await t.ledger.insert(ledger.entry({
        tenantId: bill.tenantId, billId: bill.id, type: 'patient_payment',
        source: { kind: 'patient', name: bill.patient?.name || null },
        amount: intent.amount, currency: bill.currency, cashMovement: true,
        refs: { paymentId: intent.id, method: intent.method, gatewayRef: intent.gatewayRef },
      }));
      return bill;
    }
    return null;
  });
  if (settled) {
    await notify({ party: 'patient', channel: 'sms', to: settled.patient.phone,
      subject: 'Payment received', body: `${settled.currency} ${intent.amount.toFixed(2)} paid to ${settled.provider}. Thank you.`, billId: settled.id });
    await notify({ party: 'provider', to: null,
      subject: `Bill ${settled.id} paid by patient`, body: `${intent.method} payment of ${settled.currency} ${intent.amount.toFixed(2)} received.`, billId: settled.id });
  }
}

module.exports = { createPaymentIntent, charge, markPaid };
