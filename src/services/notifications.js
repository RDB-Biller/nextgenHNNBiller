'use strict';

const crypto = require('crypto');
const store = require('../store');

/** Fan-out log. References, amounts, and links only — never member IDs or clinical detail. */
async function notify({ party, channel = 'email', to, subject, body, claimId, billId }) {
  const n = {
    id: `ntf_${crypto.randomBytes(5).toString('hex')}`,
    party, channel, to: mask(to), subject, body,
    claimId: claimId || null, billId: billId || null,
    createdAt: new Date().toISOString(), delivered: true,
  };
  await store.notifications.insert(n);
  return n;
}

/** Notify the parties for a claim outcome (provider, patient, payer, sponsor employer). */
async function notifyClaimOutcome(claim, bill, outcome) {
  const payer = await store.payers.get(claim.payerId);
  const tenants = await store.tenants.all();
  const tenant = tenants.find((t) => t.id === bill.tenantId);
  const amount = `${bill.currency} ${claim.amount.toFixed(2)}`;
  const payerParty = payer?.kind === 'employer' ? 'employer' : 'insurer';
  const sponsor = bill.coverage.sponsor;
  const sponsorIsSeparate = sponsor && payer?.kind !== 'employer';

  if (outcome === 'submitted') {
    await notify({ party: payerParty, to: payer?.contact?.email,
      subject: `New claim to authorise: ${amount}`,
      body: `A claim from ${bill.provider} awaits your authorisation. Open the secure link (or your dashboard/API) to review and pay.`,
      claimId: claim.id, billId: bill.id });
    await notify({ party: 'patient', channel: 'sms', to: bill.patient.phone,
      subject: 'Claim submitted to your payer',
      body: `Your bill of ${amount} at ${bill.provider} was sent to ${payer?.name} for approval.`,
      claimId: claim.id, billId: bill.id });
  } else if (outcome === 'settled') {
    await notify({ party: 'provider', to: tenant?.contact?.email,
      subject: `Payment received for bill ${bill.id}`,
      body: `${payer?.name} transferred ${amount} to your account for ${bill.patient.name || 'a patient'}.`,
      claimId: claim.id, billId: bill.id });
    await notify({ party: 'patient', channel: 'sms', to: bill.patient.phone,
      subject: 'Your bill has been settled',
      body: `${payer?.name} paid ${amount} to ${bill.provider} on your behalf.`,
      claimId: claim.id, billId: bill.id });
    await notify({ party: payerParty, to: payer?.contact?.email,
      subject: `Transfer confirmed: claim ${claim.id}`,
      body: `Your authorised transfer of ${amount} to ${bill.provider} succeeded.`,
      claimId: claim.id, billId: bill.id });
    if (sponsorIsSeparate) {
      await notify({ party: 'employer', to: sponsor.email,
        subject: `Cover used: ${bill.patient.name || 'employee'}`,
        body: `A claim of ${amount} on the policy you sponsor was settled at ${bill.provider}.`,
        claimId: claim.id, billId: bill.id });
    }
  } else if (outcome === 'rejected') {
    await notify({ party: 'provider', to: tenant?.contact?.email,
      subject: `Claim ${claim.id} declined by ${payer?.name}`,
      body: `Reason: ${claim.rejectionReason || 'not specified'}. Collect from patient instead.`,
      claimId: claim.id, billId: bill.id });
    await notify({ party: 'patient', channel: 'sms', to: bill.patient.phone,
      subject: 'Claim declined',
      body: `${payer?.name} could not cover ${amount}. Please arrange payment with ${bill.provider}.`,
      claimId: claim.id, billId: bill.id });
  }
}

function mask(v) {
  if (!v) return null;
  const s = String(v);
  if (s.includes('@')) { const [u, d] = s.split('@'); return `${u.slice(0, 2)}***@${d}`; }
  return s.length <= 4 ? s : `${'•'.repeat(s.length - 4)}${s.slice(-4)}`;
}

module.exports = { notify, notifyClaimOutcome };
