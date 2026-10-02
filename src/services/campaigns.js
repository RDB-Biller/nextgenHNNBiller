'use strict';

/**
 * Prospecting campaigns — Master Control's "Campaigns" tab. Separate from the
 * Product Development Environment (services/products.js): that engine runs
 * value-based-care / loyalty programs against a tenant's EXISTING patients;
 * this one sends a plain bulk SMS/WhatsApp blast to a list of phone numbers
 * that have no bill, tenant, or patient record at all — prospective clients
 * (hospitals, pharmacies, etc.) HNN wants to invite into a trial.
 *
 * A group holds contacts (seeded once from the CSV HNN supplied — see
 * data/campaignSeed.js — or added by pasting numbers in Master Control). A
 * campaign is one send of one message to one group, run through the same
 * messaging.send() seam as everything else in this codebase, with no tenant
 * attached — resolveSender() then falls back straight to the platform's
 * shared test account, which is exactly right for a platform-wide send that
 * doesn't belong to any one client (see messaging.js#resolveSender).
 *
 * Sending a few hundred messages takes minutes, not milliseconds, so
 * createCampaign() returns immediately (status 'sending') and the actual
 * sends run in the background with a small delay between each — both to be
 * gentle on the provider and because this is, bluntly, an unsolicited
 * message to a third party, not a transactional receipt; it is never kicked
 * off by anything other than a deliberate click in Master Control.
 */
const crypto = require('crypto');
const store = require('../store');
const config = require('../config');
const messaging = require('./messaging');
const { GHANA_HEALTH_PROVIDERS } = require('../data/campaignSeed');

const SEED_GROUP_ID = 'ghana-health-providers';
const SEND_DELAY_MS = 300; // pacing between sends, see header comment
const SMS_ADVISORY_LIMIT = 120; // matches the Master Control compose box's own warning threshold

// Same reply-matching convention as services/verification.js#YES_WORDS, kept
// as its own copy rather than importing a private const from that module.
const YES_WORDS = new Set(['YES', 'Y', 'CONFIRM', 'CONFIRMED', 'OK', 'OKAY']);

const rand = () => crypto.randomBytes(5).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ghana-specific local-format -> E.164 normalizer (not messaging.normalizePhone,
 * which deliberately throws away the country code for *comparison* purposes —
 * this is for producing a number actually dialable by Twilio/etc). Accepts
 * "0XXXXXXXXX", "233XXXXXXXXX", "+233XXXXXXXXX" or a bare 9-digit subscriber
 * number; anything else returns null rather than guessing. */
function toE164Ghana(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  let d = digits;
  if (d.startsWith('233')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  if (d.length !== 9 || !/^[2-9]/.test(d)) return null;
  return `+233${d}`;
}

/** Creates the seeded "Ghana health service providers" group + its 752
 * contacts the first time the server boots with it absent. Idempotent —
 * safe to call on every boot (store.init already follows this pattern for
 * tenants/payers/financiers; see store.js#seedInto). */
async function ensureSeedGroup() {
  const existing = await store.campaignGroups.get(SEED_GROUP_ID);
  if (existing) return existing;
  const group = {
    id: SEED_GROUP_ID,
    name: 'Ghana health service providers (initial list)',
    description: 'Hospitals, clinics, pharmacies and other providers supplied for the first HNN Biller trial invite.',
    source: 'csv_upload',
    createdAt: new Date().toISOString(),
  };
  await store.campaignGroups.save(group);
  for (const row of GHANA_HEALTH_PROVIDERS) {
    await store.campaignContacts.insert({
      id: `cc_${rand()}`, groupId: group.id,
      phone: row.phone, phoneNormalized: messaging.normalizePhone(row.phone),
      region: row.region || null, suburb: row.suburb || null,
      suppressed: false, lastSentAt: null, lastSentStatus: null, lastSentChannel: null,
      createdAt: new Date().toISOString(),
    });
  }
  return group;
}

/** contactCount is everyone in the group; eligibleCount/suppressedCount split
 * that by the do-not-contact flag, so callers (the group picker, the send
 * confirmation) can show how many a blast would actually reach without a
 * second round trip to list every contact. */
async function groupCounts(groupId) {
  const rows = await store.campaignContacts.listByGroup(groupId);
  const suppressedCount = rows.filter((c) => c.suppressed).length;
  return { contactCount: rows.length, suppressedCount, eligibleCount: rows.length - suppressedCount };
}

async function listGroups() {
  const groups = await store.campaignGroups.all();
  return Promise.all(groups.map(async (g) => ({ ...g, ...(await groupCounts(g.id)) })));
}

async function getGroup(id) {
  const g = await store.campaignGroups.get(id);
  if (!g) return null;
  return { ...g, ...(await groupCounts(id)) };
}

/** Body: { name, numbers: "one per line, or comma-separated" }. Each number is
 * normalized with toE164Ghana(); anything that doesn't resolve is dropped and
 * reported back rather than silently kept as junk. */
async function createGroup({ name, numbers }) {
  if (!name || !String(name).trim()) { const e = new Error('name_required'); e.status = 422; throw e; }
  const raw = String(numbers || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const group = {
    id: `cg_${rand()}`, name: String(name).trim(), description: null,
    source: 'manual_paste', createdAt: new Date().toISOString(),
  };
  await store.campaignGroups.save(group);
  let added = 0; const rejected = [];
  for (const cand of raw) {
    const phone = toE164Ghana(cand);
    if (!phone) { rejected.push(cand); continue; }
    await store.campaignContacts.insert({
      id: `cc_${rand()}`, groupId: group.id, phone, phoneNormalized: messaging.normalizePhone(phone),
      region: null, suburb: null,
      suppressed: false, lastSentAt: null, lastSentStatus: null, lastSentChannel: null,
      createdAt: new Date().toISOString(),
    });
    added++;
  }
  return { group: await getGroup(group.id), added, rejected };
}

function contactView(c) {
  return {
    id: c.id, groupId: c.groupId, phone: c.phone, region: c.region || null, suburb: c.suburb || null,
    suppressed: !!c.suppressed,
    lastSentAt: c.lastSentAt || null, lastSentStatus: c.lastSentStatus || null, lastSentChannel: c.lastSentChannel || null,
  };
}

async function listContacts(groupId, limit = 500) {
  const rows = await store.campaignContacts.listByGroup(groupId);
  return rows.slice(0, limit).map(contactView);
}

/** Flips a single contact's do-not-contact flag. Enforced in both
 * createCampaign() (blasts silently skip a suppressed contact, counted in
 * suppressedCount) and sendIndividual() (refuses outright, 422), so marking a
 * number here takes it out of reach of both sending paths the same way. */
async function setContactSuppressed(contactId, suppressed) {
  const contact = await store.campaignContacts.get(contactId);
  if (!contact) { const e = new Error('contact_not_found'); e.status = 404; throw e; }
  contact.suppressed = !!suppressed;
  await store.campaignContacts.update(contact);
  return contactView(contact);
}

function campaignView(c) {
  return {
    id: c.id, groupId: c.groupId, groupName: c.groupName, body: c.body, channel: c.channel,
    status: c.status, totalRecipients: c.totalRecipients, suppressedCount: c.suppressedCount || 0,
    sentCount: c.sentCount, failedCount: c.failedCount,
    createdAt: c.createdAt, startedAt: c.startedAt, completedAt: c.completedAt, createdBy: c.createdBy,
    overLength: c.channel === 'sms' && (c.body || '').length > SMS_ADVISORY_LIMIT,
  };
}

async function listCampaigns() {
  return (await store.campaigns.all()).map(campaignView);
}

async function getCampaign(id) {
  const c = await store.campaigns.get(id);
  if (!c) return null;
  return campaignView(c);
}

/** Body: { groupId, body, channel: 'sms'|'whatsapp', createdBy }. Returns
 * immediately with status 'sending'; see runSend() for the actual dispatch,
 * which this kicks off but does not wait for. */
async function createCampaign({ groupId, body, channel, createdBy }) {
  if (!['sms', 'whatsapp'].includes(channel)) { const e = new Error('invalid_channel'); e.status = 422; throw e; }
  const text = String(body || '').trim();
  if (!text) { const e = new Error('body_required'); e.status = 422; throw e; }
  const group = await store.campaignGroups.get(groupId);
  if (!group) { const e = new Error('group_not_found'); e.status = 404; throw e; }
  const allContacts = await store.campaignContacts.listByGroup(groupId);
  if (!allContacts.length) { const e = new Error('group_has_no_contacts'); e.status = 422; throw e; }
  // Do-not-contact numbers (see setContactSuppressed) never receive a blast —
  // dropped here, before totalRecipients is even computed, rather than sent
  // to and then filtered out of runSend().
  const contacts = allContacts.filter((c) => !c.suppressed);
  const suppressedCount = allContacts.length - contacts.length;
  if (!contacts.length) { const e = new Error('group_has_no_eligible_contacts'); e.status = 422; throw e; }

  const campaign = {
    id: `camp_${rand()}`, groupId, groupName: group.name, body: text, channel,
    status: 'sending', totalRecipients: contacts.length, suppressedCount, sentCount: 0, failedCount: 0,
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null,
    createdBy: createdBy || 'HNN',
  };
  await store.campaigns.insert(campaign);
  runSend(campaign.id, contacts).catch((e) => {
    // eslint-disable-next-line no-console
    console.error(`[campaigns] background send crashed for ${campaign.id}:`, e);
  });
  return campaignView(campaign);
}

async function runSend(campaignId, contacts) {
  let sent = 0, failed = 0;
  for (const contact of contacts) {
    const campaign = await store.campaigns.get(campaignId);
    if (!campaign) return; // deleted mid-run (not currently possible via the API, but don't assume)
    const r = await messaging.send({ channel: campaign.channel, to: contact.phone, body: campaign.body, tenant: null });
    if (r.ok) sent++; else failed++;
    await store.campaignSends.insert({
      id: `cs_${rand()}`, campaignId, contactId: contact.id,
      phone: contact.phone, phoneNormalized: contact.phoneNormalized,
      channel: campaign.channel, status: r.ok ? 'sent' : 'failed',
      providerMessageId: r.providerMessageId || null, error: r.error || null,
      sandbox: !!r.sandbox, createdAt: new Date().toISOString(),
    });
    campaign.sentCount = sent; campaign.failedCount = failed;
    await store.campaigns.update(campaign);
    await sleep(SEND_DELAY_MS);
  }
  const final = await store.campaigns.get(campaignId);
  if (final) { final.status = 'completed'; final.completedAt = new Date().toISOString(); await store.campaigns.update(final); }
}

async function listSends(campaignId, limit = 1000) {
  return (await store.campaignSends.listByCampaign(campaignId)).slice(0, limit);
}

/**
 * One-off send to a single contact — the "individually" counterpart to a
 * group blast (createCampaign). Unlike a campaign, there's exactly one
 * message to deliver, so this runs synchronously and returns the outcome
 * directly rather than kicking off a background job. A do-not-contact
 * contact (see setContactSuppressed) is refused outright with 422 rather
 * than silently skipped, since a one-off send is already a single
 * deliberate click naming that one number.
 *
 * Recorded through the same campaignSends table as a blast (with
 * campaignId: null) so this phone counts as "a past campaign recipient" for
 * handleInboundReply() below just as a blast recipient would — someone who
 * only ever got a one-off invite can still text YES and get the
 * registration link back.
 */
async function sendIndividual({ contactId, body, channel, createdBy }) {
  if (!['sms', 'whatsapp'].includes(channel)) { const e = new Error('invalid_channel'); e.status = 422; throw e; }
  const text = String(body || '').trim();
  if (!text) { const e = new Error('body_required'); e.status = 422; throw e; }
  const contact = await store.campaignContacts.get(contactId);
  if (!contact) { const e = new Error('contact_not_found'); e.status = 404; throw e; }
  if (contact.suppressed) { const e = new Error('contact_suppressed'); e.status = 422; throw e; }

  const r = await messaging.send({ channel, to: contact.phone, body: text, tenant: null });
  await store.campaignSends.insert({
    id: `cs_${rand()}`, campaignId: null, contactId: contact.id,
    phone: contact.phone, phoneNormalized: contact.phoneNormalized,
    channel, status: r.ok ? 'sent' : 'failed',
    providerMessageId: r.providerMessageId || null, error: r.error || null,
    sandbox: !!r.sandbox, createdBy: createdBy || 'HNN', createdAt: new Date().toISOString(),
  });
  contact.lastSentAt = new Date().toISOString();
  contact.lastSentStatus = r.ok ? 'sent' : 'failed';
  contact.lastSentChannel = channel;
  await store.campaignContacts.update(contact);
  return { ok: r.ok, error: r.error || null, sandbox: !!r.sandbox, contact: contactView(contact) };
}

/**
 * Inbound "YES" reply handler — see routes/webhooks.js for where this slots
 * into the clinicalLinks -> campaigns -> verification chain. Deliberately
 * defers (returns null) whenever the phone has a pending BILL verification,
 * so a patient confirming their own bill is never misread as campaign
 * interest just because that same number happens to be in a contact list
 * from a past campaign. Only claims the message when (a) it's a bare
 * YES-shaped reply and (b) this phone was actually sent a campaign before —
 * a stranger texting YES out of the blue still falls through to
 * verification's own generic "nothing pending" reply, unchanged.
 */
async function handleInboundReply({ from, text, channel }) {
  const phoneNormalized = messaging.normalizePhone(from);
  const upper = String(text || '').trim().toUpperCase();
  if (!YES_WORDS.has(upper)) return null;
  if (!phoneNormalized) return null;

  const pendingVerifications = await store.verifications.listPendingByPhone(phoneNormalized);
  if (pendingVerifications.length > 0) return null; // let verification.js own this reply

  const sends = await store.campaignSends.listSentByPhone(phoneNormalized);
  if (!sends.length) return null; // never a campaign recipient — not ours to answer

  const alreadyRegistered = await store.trialRegistrations.listByPhone(phoneNormalized);
  const link = `${config.messaging.publicBaseUrl}/register/`;
  const reply = alreadyRegistered.length
    ? "Thanks again for your interest — we have your registration and our team will reach out shortly."
    : `Great — register your facility for a free HNN Biller trial here: ${link} (choose Hospital, Pharmacy, or Other).`;
  return { outcome: 'campaign_interested', reply };
}

module.exports = {
  SEED_GROUP_ID, SMS_ADVISORY_LIMIT, toE164Ghana,
  ensureSeedGroup, listGroups, getGroup, createGroup, listContacts, setContactSuppressed,
  createCampaign, listCampaigns, getCampaign, listSends, sendIndividual,
  handleInboundReply,
};
