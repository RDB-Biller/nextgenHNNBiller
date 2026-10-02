'use strict';

const crypto = require('crypto');
const { SbgClient, sbgData } = require('../sbgClient');
const credentials = require('./credentials');
const operatingMode = require('./operatingMode');

/**
 * The A2A transfer: a PAYER (insurer or employer) pays the CLINIC directly from
 * the payer's own Stanbic account, on the patient's behalf.
 *
 *   payer ──SBG disburse──▶ clinic receiving account
 *
 * Authorised in the payer's context (their credentials / mandate).
 *
 * Sandbox/live is the Settlement rail's own switch in Master Control's
 * Operating Mode (services/operatingMode.js) — independent of the Messaging
 * rail, so e.g. SMS/WhatsApp can go live while Settlement stays sandboxed for
 * further testing, or vice versa. SBG_SANDBOX only seeds the starting value
 * the first time it's read with nothing saved there yet.
 *
 * Credentials: a payer's own Stanbic marketplace username/password, entered
 * via Master Control and stored encrypted at rest (services/credentials.js —
 * same treatment as SMS/WhatsApp provider credentials, and for the same
 * reason: a payer's own bank credentials can't be known at deploy time, and
 * are at least as sensitive as any other secret this app handles). Falls
 * back to the legacy plaintext payer.sbg.{username,password} fields — set
 * directly on the payer object, pre-dating this encrypted path — so existing
 * seed/demo data keeps working without a forced migration.
 */
async function clientForPayer(payer) {
  const sandbox = await operatingMode.isSettlementSandbox();
  let username = payer?.sbg?.username;
  let password = payer?.sbg?.password;
  if (payer?.settlementCredentials?.encrypted) {
    const creds = credentials.decrypt(payer.settlementCredentials.encrypted);
    username = creds?.username;
    password = creds?.password;
  }
  return new SbgClient({ username, password, sandbox });
}

async function executePayerTransfer({ bill, payer, tenant, amount, narration }) {
  const sbg = await clientForPayer(payer);
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
  const sbg = await clientForPayer(payer);
  const res = sbgData(await sbg.getDisbursement(serviceRequestId));
  return res?.status || 'PENDING';
}

module.exports = { executePayerTransfer, transferStatus };
