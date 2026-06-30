'use strict';

const crypto = require('crypto');
const { SbgClient } = require('../sbgClient');

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
  const validation = await sbg.validateAccount({
    serviceRoutingCode: tenant.receivingAccount.serviceRoutingCode,
    beneficiaryAccount: tenant.receivingAccount.beneficiaryAccount,
  });
  const serviceRequestId =
    validation?.data?.serviceRequestId || `S${Date.now()}${crypto.randomInt(1000, 9999)}`;
  const charge = await sbg.getServiceCharge({ serviceRequestId, amount });
  const disbursement = await sbg.disburse({
    serviceRequestId,
    narration: narration || `${payer.kind} settlement ${bill.id} via ${payer.name}`,
    extraDetails: bill.id,
  });
  return {
    serviceRequestId,
    sourcePayer: payer.id,
    beneficiaryName: validation?.data?.accountName ?? null,
    serviceCharge: charge?.data?.charge ?? null,
    status: disbursement?.data?.status || 'PENDING',
    reference: disbursement?.data?.reference ?? null,
  };
}

async function transferStatus(payer, serviceRequestId) {
  const sbg = clientForPayer(payer);
  const res = await sbg.getDisbursement(serviceRequestId);
  return res?.data?.status || 'PENDING';
}

module.exports = { executePayerTransfer, transferStatus };
