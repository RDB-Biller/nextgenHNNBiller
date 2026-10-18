'use strict';

/**
 * Public trial sign-ups — the landing page a campaign's "YES" reply links to
 * (register.html / routes/registerPortal.js), also reachable directly. Pure
 * lead capture: submitting here never creates a tenant/API key by itself —
 * an HNN admin reviews the queue in Master Control and, if it's a good fit,
 * creates the client the normal way (Master Control's existing "Add a
 * client" form). Keeping those two steps separate means a fully public,
 * unauthenticated form can never hand out platform access on its own.
 */
const crypto = require('crypto');
const store = require('../store');
const messaging = require('./messaging');
const email = require('./email');
const config = require('../config');

const ORG_TYPES = ['hospital', 'pharmacy', 'other'];
const STATUSES = ['new', 'contacted', 'approved', 'declined'];

const rand = () => crypto.randomBytes(5).toString('hex');

function err(status, message) { const e = new Error(message); e.status = status; return e; }

/** Body: { orgName, orgType, contactName, phone, email?, region?, notes?, source? }. */
async function submit(body = {}) {
  const orgName = String(body.orgName || '').trim();
  const orgType = ORG_TYPES.includes(body.orgType) ? body.orgType : null;
  const contactName = String(body.contactName || '').trim();
  const phone = String(body.phone || '').trim();
  if (!orgName) throw err(422, 'org_name_required');
  if (!orgType) throw err(422, 'org_type_must_be_hospital_pharmacy_or_other');
  if (!contactName) throw err(422, 'contact_name_required');
  if (!phone) throw err(422, 'phone_required');

  const reg = {
    id: `reg_${rand()}`,
    orgName, orgType, contactName,
    phone, phoneNormalized: messaging.normalizePhone(phone),
    email: String(body.email || '').trim() || null,
    region: String(body.region || '').trim() || null,
    notes: String(body.notes || '').trim() || null,
    source: body.source === 'campaign' ? 'campaign' : 'direct',
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  await store.trialRegistrations.insert(reg);
  // Tell us there is a new lead (best effort: never blocks or fails the visitor's submission).
  const to = process.env.SUPPORT_EMAIL || 'ekforson@hnnworld.com';
  email.send({ to, subject: `New trial request: ${orgName}`, text: `${contactName} at ${orgName} (${orgType}) asked for a trial.\nPhone: ${phone}\nEmail: ${reg.email || '-'}\nRegion: ${reg.region || '-'}\nNotes: ${reg.notes || '-'}\nSource: ${reg.source}\n\nReview it in Master Control, Leads / trial requests.` })
    .then((r) => { if (!r.ok) console.log(`[trial] admin email not sent (${r.error})`); }).catch(() => {});
  return reg;
}

async function list() { return store.trialRegistrations.all(); }
async function get(id) { return store.trialRegistrations.get(id); }

/**
 * Approving gives the applicant their own login: an evaluator account (a private practice copy of Master Control, nothing real is touched).
 * They get a link by text (and email if they gave one) to choose their own password, then sign in with their phone or email.
 * Sending again after they have set a password only reminds them where to sign in; it never resets the password.
 */
async function notifyApproved(reg) {
  const subAdmins = require('./subAdmins');
  const base = String(config.publicBaseUrl || '').replace(/\/$/, '');
  const first = String(reg.contactName || '').split(' ')[0] || 'there';
  const out = { at: new Date().toISOString(), account: null, sms: null, email: null };
  let link = null; let existing = null;
  try {
    if (reg.adminId) existing = (await subAdmins.list()).find((x) => x.id === reg.adminId) || null;
    if (existing && existing.status === 'active') out.account = { ok: true, state: 'already_active' };
    else if (existing) { const r = await subAdmins.reinvite(reg.adminId, false); link = r.inviteLink; out.account = { ok: true, state: 'invite_renewed' }; }
    else {
      const r = await subAdmins.invite({ name: reg.contactName, phone: reg.phone, email: reg.email || undefined, preset: 'evaluator' }, 'trial');
      reg.adminId = r.account.id; link = r.inviteLink; out.account = { ok: true, state: 'created' };
    }
  } catch (e) { out.account = { ok: false, error: e.message }; }
  const signIn = `${base}/app/platform.html`;
  const smsBody = link
    ? `Hello ${first}, your HNN Biller trial for ${reg.orgName} is approved. Open ${link} to choose your password, then sign in with this phone number${reg.email ? ' or your email' : ''}. The link works for 7 days.`
    : out.account && out.account.ok
      ? `Hello ${first}, your HNN Biller trial for ${reg.orgName} is approved. Sign in at ${signIn} with this phone number${reg.email ? ' or your email' : ''} and the password you chose.`
      : `Hello ${first}, your HNN Biller trial request for ${reg.orgName} is approved. Our team will contact you to finish set-up. Look around meanwhile: ${signIn}`;
  const sms = await messaging.send({ channel: 'sms', to: reg.phone, body: smsBody, tenant: null });
  out.sms = { ok: !!sms.ok, sandbox: !!sms.sandbox, error: sms.ok ? null : (sms.error || 'send_failed') };
  if (reg.email) {
    const mail = await email.send({ to: reg.email, subject: `Your HNN Biller trial for ${reg.orgName} is approved`, text: `${smsBody}\n\nHNN Biller` });
    out.email = { ok: !!mail.ok, sandbox: !!mail.sandbox, error: mail.ok ? null : (mail.error || 'send_failed') };
  }
  if (!sms.ok) console.error(`[trial] approval SMS to ${reg.orgName} failed: ${sms.error}`);
  return out;
}

async function setStatus(id, status, by) {
  if (!STATUSES.includes(status)) throw err(422, 'invalid_status');
  const reg = await store.trialRegistrations.get(id);
  if (!reg) throw err(404, 'registration_not_found');
  const was = reg.status;
  reg.status = status;
  reg.statusUpdatedAt = new Date().toISOString();
  reg.statusUpdatedBy = by || 'HNN';
  if (status === 'approved' && was !== 'approved') reg.notified = await notifyApproved(reg);
  await store.trialRegistrations.update(reg);
  return reg;
}

async function renotify(id) {
  const reg = await store.trialRegistrations.get(id);
  if (!reg) throw err(404, 'registration_not_found');
  if (reg.status !== 'approved') throw err(409, 'approve_first');
  reg.notified = await notifyApproved(reg);
  await store.trialRegistrations.update(reg);
  return reg;
}

module.exports = { ORG_TYPES, STATUSES, submit, list, get, setStatus, renotify };
