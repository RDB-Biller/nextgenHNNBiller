'use strict';

const crypto = require('crypto');
const store = require('../store');
const messaging = require('./messaging');
const email = require('./email');

/**
 * Fan-out log AND dispatch. References, amounts, and links only -- never member IDs or clinical detail.
 *
 * Until now this only wrote a log row: the patient/insurer/provider messages
 * it describes ("claim submitted", "payment received", "financing approved"...)
 * were recorded as delivered but nothing was ever sent. It now also hands
 * sms / whatsapp messages to the messaging seam (sandbox/live switch, tenant or
 * platform credentials, number normalisation all apply) and email to the email
 * transport, and records the honest outcome on the row. It is best-effort: a
 * delivery failure NEVER throws or blocks the billing step that raised it.
 *
 * `dispatch: false` records without sending, for callers that already send
 * their own richer message (patient bill verification does).
 */
async function notify({ party, channel = 'email', to, subject, body, claimId, billId, verificationId, dispatch = true, tenant }) {
  const n = {
    id: `ntf_${crypto.randomBytes(5).toString('hex')}`,
    party, channel, to: mask(to), subject, body,
    claimId: claimId || null, billId: billId || null, verificationId: verificationId || null,
    createdAt: new Date().toISOString(), delivered: true,
  };
  if (dispatch && to) {
    try {
      const r = await deliver({ channel, to, subject, body, billId, tenant });
      n.delivery = { status: r.status, error: r.error || null, providerMessageId: r.providerMessageId || null };
      n.delivered = r.status === 'sent' || r.status === 'sandbox';
    } catch (e) {
      n.delivery = { status: 'failed', error: e.message || 'delivery_error', providerMessageId: null };
      n.delivered = false;
    }
  } else if (dispatch && !to) {
    n.delivery = { status: 'no_recipient', error: null, providerMessageId: null };
    n.delivered = false;
  }
  await store.notifications.insert(n);
  return n;
}

async function deliver({ channel, to, subject, body, billId, tenant }) {
  if (channel === 'email') {
    const r = await email.send({ to, subject, text: body });
    return { status: r.ok ? (r.sandbox ? 'sandbox' : 'sent') : (r.error === 'email_provider_not_configured' ? 'not_configured' : 'failed'),
      error: r.error, providerMessageId: r.providerMessageId };
  }
  if (channel === 'sms' || channel === 'whatsapp') {
    let t = tenant || null;
    if (!t && billId) {
      const bill = await store.bills.get(billId);
      if (bill?.tenantId) t = await store.tenants.get(bill.tenantId);
    }
    const r = await messaging.send({ channel, to, body, tenant: t });
    return { status: r.ok ? (r.sandbox ? 'sandbox' : 'sent') : (r.error === 'messaging_provider_not_configured' ? 'not_configured' : 'failed'),
      error: r.error, providerMessageId: r.providerMessageId };
  }
  return { status: 'logged_only', error: null };
}

/** Ask the patient to verify a freshly-created bill, right away. */
async function notifyPatientVerification(verification, bill) {
  const amount = `${bill.currency} ${(bill.totals?.net ?? 0).toFixed(2)}`;
  await notify({ party: 'patient', channel: 'sms', to: bill.patient?.phone,
    subject: 'Please verify your bill',
    body: `Please verify your bill of ${amount} at ${bill.provider}. This confirms the charges are correct before your insurer or other payer is asked to pay: ${verification.link}`,
    billId: bill.id, verificationId: verification.id, dispatch: false });
}

/** Tell the provider when a patient disputes their bill instead of verifying it. */
async function notifyVerificationOutcome(verification, bill, outcome) {
  if (outcome !== 'disputed') return;
  const tenants = await store.tenants.all();
  const tenant = tenants.find((t) => t.id === bill.tenantId);
  await notify({ party: 'provider', to: tenant?.contact?.email,
    subject: `Patient disputed bill ${bill.id}`,
    body: `${bill.patient?.name || 'The patient'} disputed the charges on their bill at ${bill.provider}. Reason: ${verification.disputeReason || 'not specified'}. Please review before any payer is asked to approve it.`,
    billId: bill.id, verificationId: verification.id });
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

module.exports = { notify, notifyClaimOutcome, notifyPatientVerification, notifyVerificationOutcome };
