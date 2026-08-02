'use strict';

const crypto = require('crypto');
const { SbgClient, sbgData } = require('../sbgClient');

/**
 * The A2A transfer: a PAYER (insurer or employer) pays the CLINIC directly from
 * the payer's own Stanbic account, on the patient's behalf.
 *
 *   payer ──SBG disburse──▶ clinic receiving account
 *
 * Authorised in the payer's context (their credentials / mandate). Sandbox mocks.
 */
function clientForPayer(payer) {
  return new SbgClient({ username: payer?.sbg?.username, password: payer?.sbg?.password });
}

async function executePayerTransfer({ bill, payer, tenant, amount, narration }) {
  const sbg = clientForPayer(payer);
  const acct = tenant.receivingAccount || {};

  // 1) Validate the clinic's receiving account — this MINTS the serviceRequestId (ticket).
  const validation = sbgData(await sbg.validateAccount({
    category: acct.category || 'BANKS',
    serviceRoutingCode: acct.serviceRoutingCode,
    beneficiaryAccount: acct.beneficiaryAccount,
  }));
  const serviceRequestId =
    validation?.serviceRequestId || `S${Date.now()}${crypto.randomInt(1000, 9999)}`;

  // 2) Charge applicable to the amount, keyed by that ticket.
  const charge = sbgData(await sbg.getServiceCharge({ serviceRequestId, amount }));

  // 3) Confirm the transfer (the payout).
  const disbursement = sbgData(await sbg.disburse({
    serviceRequestId,
    narration: (narration || `${payer.kind} settlement ${bill.id} via ${payer.name}`).slice(0, 100),
    extraDetails: bill.id,
  }));

  return {
    serviceRequestId,
    sourcePayer: payer.id,
    beneficiaryName: validation?.beneficiaryName ?? null,
    serviceCharge: charge?.charge ?? null,
    status: disbursement?.status || 'PENDING',
    reference: disbursement?.reference ?? null,
  };
}

async function transferStatus(payer, serviceRequestId) {
  const sbg = clientForPayer(payer);
  const res = sbgData(await sbg.getDisbursement(serviceRequestId));
  return res?.status || 'PENDING';
}

module.exports = { executePayerTransfer, transferStatus };
