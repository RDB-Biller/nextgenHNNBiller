'use strict';

const crypto = require('crypto');
const { SbgClient, sbgData } = require('../sbgClient');
const credentials = require('./credentials');
const operatingMode = require('./operatingMode');

/**
 * The A2A transfer: a PAYER (insurer or employer) pays the CLINIC directly from
 * the payer's own account, on the patient's behalf.
 *
 *   payer ──disburse──▶ clinic receiving account
 *
 * Authorised in the payer's context (their credentials / mandate).
 *
 * Sandbox/live is the Settlement rail's own switch in Master Control's
 * Operating Mode (services/operatingMode.js) — independent of the Messaging
 * rail, so e.g. SMS/WhatsApp can go live while Settlement stays sandboxed for
 * further testing, or vice versa. SBG_SANDBOX only seeds the starting value
 * the first time it's read with nothing saved there yet.
 *
 * RAIL: a payer picks which disbursement rail settles its claims
 * (payer.settlementRail, default 'stanbic' — unset behaves exactly as before
 * this field existed). 'hubtel' and 'momo' exist as NAMED CHOICES because
 * they were raised on the call, but HNN has no real Hubtel/MoMo payout
 * credentials or API integration today — see StubPayoutClient below. Picking
 * either always simulates (same deterministic-mock shape as Stanbic's own
 * sandbox mode), REGARDLESS of the live/sandbox switch, and every reference
 * it returns is prefixed "STUB-" so a simulated transfer is never mistaken
 * for a real one in the ledger or a reconciliation export. Wiring a real
 * Hubtel/MoMo payout API later means replacing StubPayoutClient's body for
 * that rail with real HTTP calls — the dispatch and claim-flow code around it
 * does not need to change.
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

const RAILS = ['stanbic', 'hubtel', 'momo'];

/** Same four-method shape as SbgClient (validateAccount/getServiceCharge/disburse/
 * getDisbursement), always sandbox-like, for a rail with no real API behind it yet. */
class StubPayoutClient {
  constructor({ rail }) { this.rail = rail; }
  async validateAccount({ beneficiaryAccount }) {
    return { responseBody: { data: {
      serviceRequestId: `STUB-${this.rail}-${Date.now()}${crypto.randomInt(1000, 9999)}`,
      beneficiaryAccount, beneficiaryName: null,
    } } };
  }
  async getServiceCharge({ amount }) {
    return { responseBody: { data: { currency: 'GHS', amount: Number(amount), charge: 0 } } };
  }
  async disburse({ serviceRequestId, narration }) {
    return { responseBody: { data: {
      serviceRequestId, status: 'SUCCESS', narration, reference: `STUB-${this.rail}-${Date.now()}`,
      createdDate: new Date().toISOString(),
    } } };
  }
  async getDisbursement(serviceRequestId) {
    return { responseBody: { data: { serviceRequestId, status: 'SUCCESS', lastModifiedDate: new Date().toISOString() } } };
  }
}

function railOf(payer) {
  return RAILS.includes(payer?.settlementRail) ? payer.settlementRail : 'stanbic';
}

/** Build a client from any entity carrying settlementRail/settlementCredentials/sbg -- a payer or a funder (see funderOverride below). */
async function buildClient(entity) {
  const rail = railOf(entity);
  if (rail !== 'stanbic') return { client: new StubPayoutClient({ rail }), rail, stub: true };

  const sandbox = await operatingMode.isSettlementSandbox();
  let username = entity?.sbg?.username;
  let password = entity?.sbg?.password;
  if (entity?.settlementCredentials?.encrypted) {
    const creds = credentials.decrypt(entity.settlementCredentials.encrypted);
    username = creds?.username;
    password = creds?.password;
  }
  return { client: new SbgClient({ username, password, sandbox }), rail, stub: false };
}

/**
 * TPA override (services/funders.js — the Ghana Medical Trust Fund example
 * from the call): a payer administering claims on behalf of a funder that has
 * its OWN settlement account configured disburses from that account/rail
 * instead of its own. Lazy require: funders.js never requires this file back,
 * so there's no cycle either way -- this just keeps the edge easy to spot.
 * No payer.tpaForFunderId, or a linked funder with no account of its own,
 * returns null and the payer's own account pays exactly as before this
 * existed.
 */
async function funderOverride(payer) {
  if (!payer?.tpaForFunderId) return null;
  const funders = require('./funders');
  return funders.ownAccountFunder(payer.tpaForFunderId);
}

async function clientForPayer(payer) {
  const funder = await funderOverride(payer);
  if (funder) return { ...(await buildClient(funder)), funderId: funder.id, funderName: funder.name };
  return buildClient(payer);
}

async function executePayerTransfer({ bill, payer, tenant, amount, narration, extraDetails }) {
  const { client, rail, stub, funderId, funderName } = await clientForPayer(payer);
  const acct = tenant.receivingAccount || {};

  // 1) Validate the clinic's receiving account — this MINTS the serviceRequestId (ticket).
  const validation = sbgData(await client.validateAccount({
    category: acct.category || 'BANKS',
    serviceRoutingCode: acct.serviceRoutingCode,
    beneficiaryAccount: acct.beneficiaryAccount,
  }));
  const serviceRequestId =
    validation?.serviceRequestId || `S${Date.now()}${crypto.randomInt(1000, 9999)}`;

  // 2) Charge applicable to the amount, keyed by that ticket.
  const charge = sbgData(await client.getServiceCharge({ serviceRequestId, amount }));

  // 3) Confirm the transfer (the payout).
  const disbursement = sbgData(await client.disburse({
    serviceRequestId,
    narration: (narration || `${payer.kind} settlement ${bill.id} via ${payer.name}`).slice(0, 100),
    extraDetails: extraDetails != null ? extraDetails : bill.id,
  }));

  return {
    serviceRequestId,
    sourcePayer: payer.id,
    rail, stub,
    funderId: funderId || null, funderName: funderName || null,
    beneficiaryName: validation?.beneficiaryName ?? null,
    serviceCharge: charge?.charge ?? null,
    status: disbursement?.status || 'PENDING',
    reference: disbursement?.reference ?? null,
  };
}

async function transferStatus(payer, serviceRequestId) {
  const { client } = await clientForPayer(payer);
  const res = sbgData(await client.getDisbursement(serviceRequestId));
  return res?.status || 'PENDING';
}

module.exports = { executePayerTransfer, transferStatus, RAILS, railOf };
