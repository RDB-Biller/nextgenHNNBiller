'use strict';

const crypto = require('crypto');
const https = require('https');
const store = require('../store');
const config = require('../config');
const messaging = require('./messaging');
const email = require('./email');
const medicalReport = require('./medicalReport');
const { notify } = require('./notifications');

/**
 * InsureCredit -- micro-loans for the patient's out-of-pocket share.
 *
 * An insurer or hospital programs it as a Product Lab solution (module
 * "insurecredit"). It texts the patient a link; the link opens a page that
 * shows the offer and the micro medical report that supports it, takes the
 * patient's consent, and hands them to ConfirmU for credit scoring. The same
 * application can be completed by USSD with a unique application number.
 *
 *  - Up to the cap (default and hard maximum GHS 2,000) the patient applies for
 *    a micro-loan.
 *  - Above the cap the patient is offered a justification note instead: with
 *    their consent the platform sends the micro medical report to a funder they
 *    name (an HR department, a relative, a charity) over email and/or SMS.
 *
 * What this module does NOT do: lend, score or disburse. ConfirmU does that;
 * HNN Biller stays out of the flow of funds. ConfirmU is told about an
 * application by (a) the hand-off link and (b) an optional signed webhook, and
 * reports a decision back on an unguessable callback URL. Their real API was
 * not available when this was built, so the webhook / callback shapes below are
 * HNN's own contract for them to adopt, not something confirmed with ConfirmU.
 *
 * The micro medical report is generated at offer time from the bill (labs,
 * medications, procedures, the clinician's stated diagnosis and complaint). It
 * is flagged as requiring clinician sign-off and is never presented as a
 * diagnostic document.
 */

const KEY = 'insurecredit';
const HARD_CAP = 2000;
const DESIGNS = ['classic', 'stepper', 'compact', 'story'];
const SMS_STYLES = ['standard', 'short', 'friendly', 'custom'];
const MAX_SHARES = 3;
const TERMINAL = ['approved', 'declined', 'cancelled', 'expired'];
const CONSENT_TEXT = {
  scoring: 'I agree that ConfirmU may assess my credit, and that my application number, the loan amount and my micro medical report are shared with ConfirmU to verify my need.',
  report_share: 'I agree that HNN Biller may send my micro medical report and the amount I need to the person I name, so they can consider helping with my bill.',
};
const TEXT_VERSION = 'v1';

const err = (status, message, detail) => { const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e; };
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const n2 = (n) => Number(n).toFixed(2);
const now = () => new Date().toISOString();
const rid = (p, n = 6) => `${p}_${crypto.randomBytes(n).toString('hex')}`;
const base = () => String(config.messaging.publicBaseUrl || '').replace(/\/$/, '');
const maskPhone = (p) => { const s = String(p || ''); return s.length <= 4 ? s : `${'•'.repeat(s.length - 4)}${s.slice(-4)}`; };
const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 2)}***@${d}` : ''; };
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

// ---- module parameter schema (consumed by solutions.js) ---------------------

const PARAMS = [
  { key: 'loanCap', label: 'Micro-loan limit (GHS)', type: 'number', min: 100, max: HARD_CAP, required: true, default: HARD_CAP,
    help: `Up to this amount the patient can apply for a micro-loan. Cannot exceed ${HARD_CAP}. Above it, the patient is offered a medical justification note instead.` },
  { key: 'minAmount', label: 'Smallest out-of-pocket amount to offer (GHS)', type: 'number', min: 1, default: 50 },
  { key: 'overCapPolicy', label: 'Above the limit', type: 'select', options: ['share_only', 'partial_and_share'], default: 'share_only',
    help: 'share_only: offer the justification note only. partial_and_share: also let the patient borrow up to the limit.' },
  { key: 'design', label: 'Page design', type: 'select', options: DESIGNS, default: 'classic',
    help: 'classic: one card · stepper: three steps · compact: dense, data-light · story: big amount and friendly copy' },
  { key: 'accentColor', label: 'Accent colour', type: 'color', default: '#0f766e', pattern: '^#[0-9a-fA-F]{6}$' },
  { key: 'brandName', label: 'Brand name on the page', type: 'text', default: 'InsureCredit' },
  { key: 'headline', label: 'Headline', type: 'text', default: 'Need help with your hospital bill?' },
  { key: 'buttonLabel', label: 'Main button text', type: 'text', default: 'Continue to ConfirmU' },
  { key: 'termsNote', label: 'Terms note shown to the patient', type: 'text', default: 'Loan terms, fees and repayment are set by ConfirmU after your credit check.' },
  { key: 'footnote', label: 'Footnote (optional)', type: 'text', default: '' },
  { key: 'smsStyle', label: 'SMS wording', type: 'select', options: SMS_STYLES, default: 'standard' },
  { key: 'smsTemplate', label: 'Custom SMS (used when wording = custom)', type: 'textarea', default: '',
    help: 'Tokens: {name} {amount} {facility} {link} {appNo} {ussd} {cap}. Must contain {link}.' },
  { key: 'channel', label: 'Send the offer by', type: 'select', options: ['sms', 'whatsapp', 'both'], default: 'sms' },
  { key: 'ussdEnabled', label: 'Offer USSD application', type: 'boolean', default: true },
  { key: 'ussdCode', label: 'USSD short code', type: 'text', default: '*713*55#',
    help: 'Shown in the SMS. It must match the code provisioned on your Africa\'s Talking account.' },
  { key: 'confirmuUrl', label: 'ConfirmU application page', type: 'text', default: 'https://confirmu.com', pattern: '^https://', help: 'Where the patient is sent after consenting.' },
  { key: 'scorerWebhookUrl', label: 'ConfirmU webhook (optional)', type: 'text', default: '', pattern: '^(https://.*)?$',
    help: 'If set, each submitted application, with its micro medical report link, is POSTed here, signed.' },
  { key: 'linkTtlDays', label: 'Offer valid for (days)', type: 'number', min: 1, max: 60, default: 14 },
  { key: 'showReport', label: 'Show the micro medical report to the patient', type: 'boolean', default: true },
  { key: 'funderChannels', label: 'Funder contact needed', type: 'select', options: ['email_or_sms', 'email', 'sms'], default: 'email_or_sms' },
  { key: 'shareTtlDays', label: 'Justification note link valid for (days)', type: 'number', min: 1, max: 60, default: 14 },
  { key: 'autoSend', label: 'Send offers automatically', type: 'boolean', default: false,
    help: 'When live, offers go out on their own for new bills whose out-of-pocket share qualifies. Off = staff send them.' },
  { key: 'autoSendWithinDays', label: 'Only for bills created in the last (days)', type: 'number', min: 1, max: 30, default: 3 },
];

/** Cross-field validation, run by solutions.validateConfig after per-field coercion. */
function check(p) {
  if (p.smsStyle === 'custom') {
    if (!p.smsTemplate || !p.smsTemplate.includes('{link}')) throw err(422, 'param_invalid', 'smsTemplate must contain {link} when wording is custom');
    if (p.smsTemplate.length > 320) throw err(422, 'param_invalid', 'smsTemplate must be 320 characters or fewer');
  }
  if (p.ussdEnabled && !/^\*\d[\d*]*#$/.test(String(p.ussdCode || ''))) throw err(422, 'param_invalid', 'ussdCode must look like *713*55#');
  for (const k of ['brandName', 'headline', 'buttonLabel', 'termsNote', 'footnote']) {
    if (p[k] && String(p[k]).length > 160) throw err(422, 'param_invalid', `${k} must be 160 characters or fewer`);
  }
}

// ---- settings (callback secret) ---------------------------------------------

async function getSettings() {
  let s = await store.settings.get(KEY);
  if (!s) { s = { hookSecret: crypto.randomBytes(18).toString('hex'), createdAt: now() }; await store.settings.set(KEY, s); }
  return s;
}
async function rotateSecret() {
  const s = await getSettings(); s.hookSecret = crypto.randomBytes(18).toString('hex'); await store.settings.set(KEY, s); return s.hookSecret;
}
async function checkSecret(given) {
  const s = await getSettings();
  const a = Buffer.from(String(given || '')); const b = Buffer.from(s.hookSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function hookUrls(baseUrl) {
  const s = await getSettings();
  const root = String(baseUrl || base()).replace(/\/$/, '');
  return {
    ussd: `${root}/ussd/${s.hookSecret}`,
    decision: `${root}/insurecredit-hooks/${s.hookSecret}/decision`,
    verify: `${root}/insurecredit-hooks/${s.hookSecret}/applications/{applicationNo}`,
  };
}

// ---- helpers ------------------------------------------------------------------

async function productOf(app) {
  const p = await store.products.get(app.productId);
  if (!p || p.type !== 'solution' || p.config.module !== 'insurecredit') return null;
  return p;
}
const paramsOf = (product) => product.config.params;

async function newAppNo() {
  for (let i = 0; i < 20; i++) {
    const n = String(crypto.randomInt(10000000, 100000000));
    if (!(await store.credits.byAppNo(n))) return n;
  }
  throw err(500, 'could_not_allocate_application_number');
}
/** "IC-4829 1736", "4829-1736", "48291736" -> "48291736" (or null). */
function parseAppNo(raw) {
  const d = String(raw || '').replace(/^\s*ic[\s-]*/i, '').replace(/\D/g, '');
  return d.length === 8 ? d : null;
}
const addEvent = (app, type, detail) => { (app.events = app.events || []).push({ at: now(), type, ...(detail ? { detail } : {}) }); };

function loanable(p, amount) {
  const cap = Math.min(p.loanCap, HARD_CAP);
  const overCap = amount > cap;
  return { cap, overCap, loanable: overCap ? (p.overCapPolicy === 'partial_and_share' ? cap : 0) : amount };
}

// ---- SMS text -----------------------------------------------------------------

function renderSms(p, ctx) {
  const ussd = p.ussdEnabled ? p.ussdCode : '';
  const t = { name: ctx.first, amount: n2(ctx.amount), facility: ctx.facility, link: ctx.link, appNo: ctx.appNo, ussd, cap: String(ctx.cap) };
  if (ctx.overCap) {
    const hi = ctx.first ? `Hi ${ctx.first}, y` : 'Y';
    return `${hi}our bill of GHS ${t.amount} at ${t.facility} is above the GHS ${t.cap} micro-loan limit. `
      + `${p.overCapPolicy === 'partial_and_share' ? 'You can borrow up to the limit and/or ' : 'You can '}send your medical report as a justification note to your HR or another funder: ${t.link} (ref ${t.appNo})`;
  }
  if (p.smsStyle === 'custom' && p.smsTemplate) return p.smsTemplate.replace(/\{(\w+)\}/g, (m, k) => (k in t ? t[k] : m));
  const ussdLine = ussd ? ` Or dial ${ussd}, enter ${t.appNo}.` : ` Ref ${t.appNo}.`;
  if (p.smsStyle === 'short') return `InsureCredit: GHS ${t.amount} at ${t.facility}? Apply (up to GHS ${t.cap}): ${t.link}${ussdLine}`;
  if (p.smsStyle === 'friendly') {
    return `${ctx.first ? `Hello ${ctx.first}! ` : 'Hello! '}Your hospital bill at ${t.facility} leaves GHS ${t.amount} to pay. We can help spread it with a micro-loan of up to GHS ${t.cap} — a quick check, no paperwork: ${t.link}${ussdLine}`;
  }
  return `${ctx.first ? `Hi ${ctx.first}, n` : 'N'}eed help with your GHS ${t.amount} bill at ${t.facility}? Apply for an InsureCredit micro-loan (up to GHS ${t.cap}): ${t.link}${ussdLine}`;
}

async function sendText(channel, to, body, tenant) {
  const out = []; const results = {};
  const channels = channel === 'both' ? ['sms', 'whatsapp'] : [channel];
  for (const ch of channels) {
    const r = await messaging.send({ channel: ch, to, body, tenant });
    results[ch] = { ok: !!r.ok, sandbox: !!r.sandbox, error: r.ok ? null : (r.error || 'send_failed'), providerMessageId: r.providerMessageId || null };
    if (r.ok) out.push(ch);
  }
  return { sentVia: out, results };
}

// ---- views --------------------------------------------------------------------

function reportSummary(report, { firstNameOnly = false } = {}) {
  if (!report) return null;
  // The applicant link travels by SMS and can be forwarded, so it shows the first name only.
  const full = report.patientName;
  const narrative = (firstNameOnly && full && report.narrative) ? report.narrative.split(full).join(firstName(full)) : report.narrative;
  const names = (a) => (a || []).map((x) => x.name);
  return {
    kind: report.kind, diagnosis: report.diagnosis, narrative,
    investigations: names(report.investigations), medications: names(report.medications),
    procedures: names(report.procedures), other: names(report.other),
    signedOff: !!report.signedOff, disclaimer: report.disclaimer, createdAt: report.createdAt,
  };
}

function designOf(p, product) {
  return {
    variant: p.design, accent: p.accentColor, brand: p.brandName, headline: p.headline, buttonLabel: p.buttonLabel,
    termsNote: p.termsNote, footnote: p.footnote, title: product?.config?.title || null, intro: product?.config?.intro || null,
  };
}

/** What the applicant (holding the link) sees. First name only; never the member id or full phone. */
async function publicView(app, { markOpened = false } = {}) {
  const product = await productOf(app);
  if (!product) throw err(404, 'offer_not_found');
  const p = paramsOf(product);
  if (markOpened && app.status === 'offered') { app.status = 'opened'; addEvent(app, 'opened'); await store.credits.update(app); }
  const expired = new Date(app.expiresAt) < new Date() && !TERMINAL.includes(app.status) && app.status !== 'submitted_to_scorer';
  const report = p.showReport ? reportSummary(await store.reports.get(app.reportId), { firstNameOnly: true }) : null;
  return {
    applicationNo: app.appNo, status: expired ? 'expired' : app.status, facility: app.facility, currency: app.currency,
    patientFirstName: firstName(app.patient?.name), phoneHint: maskPhone(app.patient?.phone),
    amount: app.amount, loanCap: app.cap, overCap: app.overCap, loanableAmount: app.loanable,
    overCapPolicy: p.overCapPolicy, expiresAt: app.expiresAt, live: product.status === 'live',
    design: designOf(p, product),
    ussd: p.ussdEnabled ? { code: p.ussdCode, instructions: `Dial ${p.ussdCode} and enter application number ${app.appNo}.` } : null,
    funderChannels: p.funderChannels,
    consent: { scoring: (app.consents || []).some((c) => c.type === 'scoring'), texts: CONSENT_TEXT },
    report,
    shares: (app.shares || []).map((s) => ({ id: s.id, to: s.recipientHint, channels: s.channels, sentAt: s.sentAt, expiresAt: s.expiresAt, revoked: !!s.revoked })),
    decision: app.decision ? { decision: app.decision.decision, approvedAmount: app.decision.approvedAmount ?? null, at: app.decision.at } : null,
  };
}

/** Same facts a scorer (or the hospital) needs to verify the need: bill totals, what was billed, the report, and consent trail. */
async function verificationPacket(app) {
  const bill = await store.bills.get(app.billId);
  const report = await store.reports.get(app.reportId);
  const pv = bill ? await store.verifications.byBill(bill.id) : null;
  const patientVerification = Array.isArray(pv) ? pv[0] : pv;
  const checks = {
    reportPresent: !!report,
    reportKind: report?.kind || null,
    reportSignedOff: !!report?.signedOff,
    amountWithinPatientShare: !!bill && app.amount <= round2(bill.totals.patientPayable) + 0.005,
    billStatus: bill?.status || null,
    patientVerifiedBill: patientVerification ? patientVerification.status : 'no_verification_on_file',
    consentToScoringOnFile: (app.consents || []).some((c) => c.type === 'scoring'),
  };
  checks.passed = checks.reportPresent && checks.amountWithinPatientShare && checks.consentToScoringOnFile
    && checks.patientVerifiedBill !== 'disputed';
  return {
    applicationNo: app.appNo, status: app.status, requestedAmount: app.amount, currency: app.currency,
    loanableAmount: app.loanable, overCap: app.overCap, facility: app.facility,
    patient: { name: app.patient?.name || null, phoneHint: maskPhone(app.patient?.phone) },
    bill: bill ? { id: bill.id, totals: { net: bill.totals.net, payerShare: bill.totals.payerShare, patientPayable: bill.totals.patientPayable },
      diagnosis: bill.clinical?.diagnosis || null, complaint: bill.clinical?.complaint || null } : null,
    report: report ? { ...reportSummary(report), qa: report.qa, id: report.id } : null,
    checks,
    consents: (app.consents || []).map((c) => ({ type: c.type, at: c.at, textVersion: c.textVersion, via: c.via })),
    events: app.events || [],
  };
}

// ---- offers -------------------------------------------------------------------

function allowedFor(ctx, bill, product) {
  if (ctx.surface === 'hospital' && bill.tenantId !== ctx.tenant?.id) throw err(404, 'bill_not_found');
  if (ctx.surface === 'payer' && bill.coverage?.payerId !== ctx.payerId) throw err(404, 'bill_not_found');
  const ids = product.config.tenantIds || [];
  if (ids.length && !ids.includes(bill.tenantId)) throw err(422, 'hospital_not_covered_by_this_product');
}

function dialable(raw) {
  const d = messaging.toDialable(raw || '');
  return /^\+\d{8,15}$/.test(d) ? d : null;
}

/**
 * Create (and send) an offer for a bill. A non-live product only previews:
 * nothing is stored, no report is generated, no message is sent.
 */
async function createOffer({ product, ctx, input = {} }) {
  const p = paramsOf(product);
  const bill = await store.bills.get(String(input.billId || ''));
  if (!bill) throw err(404, 'bill_not_found');
  allowedFor(ctx, bill, product);
  const amount = round2(input.amount != null && input.amount !== '' ? Number(input.amount) : bill.totals.patientPayable);
  if (!Number.isFinite(amount) || amount <= 0) throw err(422, 'amount_invalid');
  if (input.amount != null && input.amount !== '' && amount > round2(bill.totals.patientPayable) + 0.005) throw err(422, 'amount_exceeds_patient_share', `out-of-pocket share is ${n2(bill.totals.patientPayable)}`);
  if (amount < p.minAmount) throw err(422, 'amount_below_minimum', `minimum is ${p.minAmount}`);
  const phone = dialable(input.phone || bill.patient?.phone);
  if (!phone) throw err(422, 'patient_phone_required');
  const l = loanable(p, amount);
  const tenant = await store.tenants.get(bill.tenantId);
  const appNoPreview = product.status === 'live' ? await newAppNo() : '(assigned when live)';
  const ctxSms = { first: firstName(bill.patient?.name), amount, facility: bill.provider, link: `${base()}/credit/?t=…`, appNo: appNoPreview, cap: l.cap, overCap: l.overCap };

  if (product.status !== 'live') {
    return { preview: true, notice: 'Test mode: nothing was stored or sent. Move the product to live to send real offers.',
      amount, loanableAmount: l.loanable, overCap: l.overCap, loanCap: l.cap, to: maskPhone(phone), channel: input.channel || p.channel,
      sms: renderSms(p, ctxSms), smsLength: renderSms(p, ctxSms).length, design: designOf(p, product) };
  }

  const existing = (await store.credits.byBill(bill.id)).find((a) => a.productId === product.id && !TERMINAL.includes(a.status));
  if (existing && !input.resend) {
    return { reused: true, ...(await summary(existing)), notice: 'An offer for this bill already exists. Send again with resend=true to text it again.' };
  }
  if (existing && input.resend) return resend(existing, { product, ctx, input });

  const qa = [];
  if (bill.clinical?.complaint) qa.push({ id: 'complaint', a: bill.clinical.complaint });
  const report = await medicalReport.generate({ bill, kind: 'micro', diagnosis: bill.clinical?.diagnosis, qa,
    amountRequested: amount, loanType: 'momo_loan', clinicianName: bill.clinical?.clinician });
  const app = {
    id: rid('ic', 8), appNo: appNoPreview, token: crypto.randomBytes(18).toString('base64url'),
    productId: product.id, payerId: product.payerId, tenantId: bill.tenantId, billId: bill.id,
    status: 'offered', amount, loanable: l.loanable, overCap: l.overCap, cap: l.cap, currency: bill.currency,
    facility: bill.provider, patient: { name: bill.patient?.name || null, phone },
    reportId: report.id, consents: [], shares: [], events: [],
    createdAt: now(), createdBy: ctx.surface || 'master',
    expiresAt: new Date(Date.now() + p.linkTtlDays * 86400000).toISOString(),
  };
  addEvent(app, 'offered', { by: app.createdBy, amount, overCap: l.overCap });
  await store.credits.insert(app);
  await dispatch(app, product, tenant, input.channel);
  return summary(app, { withLink: true });
}

async function dispatch(app, product, tenant, channelOverride) {
  const p = paramsOf(product);
  const link = `${base()}/credit/?t=${app.token}`;
  const body = renderSms(p, { first: firstName(app.patient?.name), amount: app.amount, facility: app.facility, link, appNo: app.appNo, cap: app.cap, overCap: app.overCap });
  const channel = ['sms', 'whatsapp', 'both'].includes(channelOverride) ? channelOverride : p.channel;
  const r = await sendText(channel, app.patient.phone, body, tenant);
  app.lastSms = { at: now(), body, channel, sentVia: r.sentVia, results: r.results };
  addEvent(app, r.sentVia.length ? 'offer_sent' : 'offer_send_failed', { channel, results: r.results });
  await store.credits.update(app);
  return r;
}

async function resend(app, { product, ctx, input }) {
  if (TERMINAL.includes(app.status)) throw err(409, 'application_closed');
  const tenant = await store.tenants.get(app.tenantId);
  app.expiresAt = new Date(Date.now() + paramsOf(product).linkTtlDays * 86400000).toISOString(); // a resend restarts the clock
  await dispatch(app, product, tenant, input?.channel);
  return summary(app, { withLink: true, resent: true });
}

async function summary(app, { withLink = false, resent = false } = {}) {
  const out = {
    applicationNo: app.appNo, status: app.status, amount: app.amount, loanableAmount: app.loanable, overCap: app.overCap,
    currency: app.currency, facility: app.facility, to: maskPhone(app.patient?.phone), expiresAt: app.expiresAt,
    sentVia: app.lastSms?.sentVia || [], sendResults: app.lastSms?.results || null, billId: app.billId, reportId: app.reportId,
    createdAt: app.createdAt,
  };
  if (resent) out.resent = true;
  if (withLink) out.link = `${base()}/credit/?t=${app.token}`;
  return out;
}

// ---- applicant actions (token = bearer) -----------------------------------------

async function byTokenOrThrow(token) {
  const app = await store.credits.byToken(String(token || ''));
  if (!app) throw err(404, 'offer_not_found');
  return app;
}
async function liveProduct(app) {
  const product = await productOf(app);
  if (!product) throw err(404, 'offer_not_found');
  if (product.status !== 'live') throw err(409, 'offers_paused', 'this offer is not currently open');
  return product;
}
function assertOpen(app) {
  if (TERMINAL.includes(app.status)) throw err(409, 'application_closed', app.status);
  if (new Date(app.expiresAt) < new Date() && app.status !== 'submitted_to_scorer') throw err(410, 'offer_expired');
}

async function view(token) { return publicView(await byTokenOrThrow(token), { markOpened: true }); }

async function consent(token, { scoring, ip, via = 'web' } = {}) {
  const app = await byTokenOrThrow(token); await liveProduct(app); assertOpen(app);
  if (scoring !== true) throw err(422, 'consent_required');
  if (!(app.consents || []).some((c) => c.type === 'scoring')) {
    app.consents.push({ type: 'scoring', at: now(), textVersion: TEXT_VERSION, ip: ip || null, via });
    addEvent(app, 'consent_scoring', { via });
  }
  if (['offered', 'opened'].includes(app.status)) app.status = 'consented';
  await store.credits.update(app);
  return publicView(app);
}

function scorerUrl(p, app, report) {
  const u = new URL(p.confirmuUrl);
  u.searchParams.set('ref', app.appNo);
  u.searchParams.set('amount', n2(app.loanable));
  u.searchParams.set('source', 'hnn-insurecredit');
  if (report?.shareToken) u.searchParams.set('report', `${base()}/report/?token=${report.shareToken}`);
  return u.toString();
}

let _post = (url, { headers, body }) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = https.request({ hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, method: 'POST', headers }, (res) => {
    let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.setTimeout(10000, () => req.destroy(new Error('request_timeout')));
  req.on('error', reject); req.write(body); req.end();
});
function _setPostImplForTests(fn) { _post = fn || _post; }

async function pushToScorer(p, app, report) {
  if (!p.scorerWebhookUrl) return { pushed: false };
  const secret = (await getSettings()).hookSecret;
  const payload = JSON.stringify({
    event: 'application.submitted', applicationNo: app.appNo, amount: app.loanable, currency: app.currency, facility: app.facility,
    reportUrl: report?.shareToken ? `${base()}/report/?token=${report.shareToken}` : null,
    verifyUrl: `${base()}/insurecredit-hooks/{secret}/applications/${app.appNo}`,
    decisionUrl: `${base()}/insurecredit-hooks/{secret}/decision`,
    note: 'Replace {secret} with the shared callback secret agreed with HNN Biller.',
    submittedAt: now(),
  });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    const r = await _post(p.scorerWebhookUrl, { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-hnn-signature': `sha256=${sig}` }, body: payload });
    return { pushed: r.status >= 200 && r.status < 300, status: r.status };
  } catch (e) { return { pushed: false, error: e.message || 'webhook_failed' }; }
}

/** Submit to ConfirmU (web or USSD). Needs the scoring consent on file. */
async function submit(app, product, { via = 'web' } = {}) {
  const p = paramsOf(product);
  assertOpen(app);
  if (app.status === 'submitted_to_scorer') return { already: true };
  if (!(app.consents || []).some((c) => c.type === 'scoring')) throw err(409, 'consent_required');
  if (app.loanable <= 0) throw err(409, 'above_loan_limit', 'this amount is above the micro-loan limit; share the medical report instead');
  const report = await store.reports.get(app.reportId);
  app.status = 'submitted_to_scorer'; app.submittedAt = now(); app.submittedVia = via;
  addEvent(app, 'submitted_to_scorer', { via, amount: app.loanable });
  const push = await pushToScorer(p, app, report);
  addEvent(app, push.pushed ? 'scorer_webhook_ok' : (p.scorerWebhookUrl ? 'scorer_webhook_failed' : 'scorer_webhook_skipped'), push.error || push.status || undefined);
  await store.credits.update(app);
  const tenant = await store.tenants.get(app.tenantId);
  await notify({ party: 'provider', to: tenant?.contact?.email, subject: `InsureCredit application ${app.appNo} submitted`,
    body: `${app.patient?.name || 'A patient'} applied for a micro-loan of ${app.currency} ${n2(app.loanable)} towards their bill at ${app.facility} (application ${app.appNo}).`, billId: app.billId });
  return { redirectUrl: scorerUrl(p, app, report), applicationNo: app.appNo, amount: app.loanable, webhook: push };
}

async function apply(token, { ip } = {}) {
  const app = await byTokenOrThrow(token); const product = await liveProduct(app);
  const r = await submit(app, product, { via: 'web' });
  if (r.already) { const p = paramsOf(product); return { redirectUrl: scorerUrl(p, app, await store.reports.get(app.reportId)), applicationNo: app.appNo, amount: app.loanable, already: true }; }
  return r;
}

// ---- over-cap: justification note to a funder -----------------------------------

async function share(token, { name, email: to, phone, relationship, consent: agreed, ip } = {}) {
  const app = await byTokenOrThrow(token); const product = await liveProduct(app); assertOpen(app);
  const p = paramsOf(product);
  if (!app.overCap) throw err(409, 'not_above_loan_limit', 'a justification note is only offered above the micro-loan limit');
  if (agreed !== true) throw err(422, 'consent_required');
  if ((app.shares || []).filter((s) => !s.revoked).length >= MAX_SHARES) throw err(429, 'share_limit_reached', `at most ${MAX_SHARES} recipients`);
  const wantEmail = ['email_or_sms', 'email'].includes(p.funderChannels);
  const wantSms = ['email_or_sms', 'sms'].includes(p.funderChannels);
  const mail = to ? String(to).trim() : '';
  const tel = phone ? dialable(phone) : null;
  if (mail && (!wantEmail || !email.isEmail(mail))) throw err(422, 'invalid_email');
  if (phone && (!wantSms || !tel)) throw err(422, 'invalid_phone');
  if (!mail && !tel) throw err(422, 'recipient_required', p.funderChannels === 'email' ? 'an email address is needed' : p.funderChannels === 'sms' ? 'a phone number is needed' : 'an email address or phone number is needed');

  const s = {
    id: rid('shr', 5), token: crypto.randomBytes(18).toString('base64url'),
    recipientName: String(name || '').slice(0, 80) || null, relationship: String(relationship || '').slice(0, 60) || null,
    recipientHint: [mail ? maskEmail(mail) : null, tel ? maskPhone(tel) : null].filter(Boolean).join(' · '),
    recipientHash: crypto.createHash('sha256').update(`${mail}|${tel}`).digest('hex').slice(0, 16),
    channels: [], sentAt: null, expiresAt: new Date(Date.now() + p.shareTtlDays * 86400000).toISOString(),
    accessCount: 0, lastAccessAt: null, revoked: false, createdAt: now(), errors: {},
  };
  const link = `${base()}/credit/?s=${s.token}`;
  const patient = app.patient?.name || 'A patient';
  const until = s.expiresAt.slice(0, 10);
  const tenant = await store.tenants.get(app.tenantId);
  if (mail) {
    const r = await email.send({ to: mail, subject: `Medical justification note for ${patient}: request for financial assistance`,
      text: `Hello${s.recipientName ? ` ${s.recipientName}` : ''},\n\n${patient} has asked HNN Biller to send you a medical justification note. They are seeking financial assistance of ${app.currency} ${n2(app.amount)} towards a hospital bill at ${app.facility}, and they gave their consent for this note to be shared with you.\n\nOpen it here (link valid until ${until}):\n${link}\n\nThe note is compiled by HNN Biller from the hospital's billing and clinical records. It is not a diagnostic document. HNN Biller does not lend or hold money and will never ask you for a payment.\n\nIf you were not expecting this message, you can ignore it.\n\nSent by HNN Biller on behalf of ${patient}.` });
    if (r.ok) s.channels.push('email'); else s.errors.email = r.error;
  }
  if (tel) {
    const r = await messaging.send({ channel: 'sms', to: tel, tenant,
      body: `${firstName(patient) || 'A patient'} has asked HNN Biller to share a medical justification note (GHS ${n2(app.amount)}, ${app.facility}) with you, with their consent: ${link} (valid to ${until}).` });
    if (r.ok) s.channels.push('sms'); else s.errors.sms = r.error;
  }
  if (!s.channels.length) {
    addEvent(app, 'share_failed', s.errors); await store.credits.update(app);
    throw err(502, 'share_not_delivered', Object.values(s.errors).join('; ') || 'could not send');
  }
  s.sentAt = now();
  app.shares.push(s);
  app.consents.push({ type: 'report_share', at: now(), textVersion: TEXT_VERSION, ip: ip || null, via: 'web', recipient: s.recipientHint, shareId: s.id });
  addEvent(app, 'report_shared', { shareId: s.id, to: s.recipientHint, channels: s.channels });
  if (!['submitted_to_scorer', 'approved'].includes(app.status)) app.status = 'funder_report_sent';
  await store.credits.update(app);
  await notify({ party: 'provider', to: tenant?.contact?.email, subject: `InsureCredit: ${patient} shared a justification note`,
    body: `At the patient's request, the micro medical report for their ${app.currency} ${n2(app.amount)} bill at ${app.facility} was sent to a funder (application ${app.appNo}).`, billId: app.billId });
  return publicView(app);
}

async function revokeShare(token, shareId) {
  const app = await byTokenOrThrow(token);
  const s = (app.shares || []).find((x) => x.id === shareId);
  if (!s) throw err(404, 'share_not_found');
  s.revoked = true; s.revokedAt = now(); addEvent(app, 'share_revoked', { shareId });
  await store.credits.update(app);
  return publicView(app);
}

/** What the funder opens: the micro medical report as a justification note. Counts every view. */
async function shareView(shareToken) {
  const app = await store.credits.byShareToken(String(shareToken || ''));
  if (!app) throw err(404, 'note_not_found');
  const s = app.shares.find((x) => x.token === shareToken);
  if (s.revoked) throw err(410, 'note_withdrawn');
  if (new Date(s.expiresAt) < new Date()) throw err(410, 'note_expired');
  s.accessCount++; s.lastAccessAt = now();
  if (!s.firstAccessAt) { s.firstAccessAt = now(); addEvent(app, 'share_opened', { shareId: s.id }); }
  await store.credits.update(app);
  const report = await store.reports.get(app.reportId);
  const product = await productOf(app);
  return {
    kind: 'justification_note', requestedAmount: app.amount, currency: app.currency, facility: app.facility,
    requestedBy: app.patient?.name || null, relationship: s.relationship, recipientName: s.recipientName,
    expiresAt: s.expiresAt, report: reportSummary(report),
    design: product ? designOf(paramsOf(product), product) : null,
    statement: 'Shared at the patient\'s request and with their consent. Compiled by HNN Biller from the hospital\'s billing and clinical records; not a diagnostic document. HNN Biller does not lend or hold money.',
  };
}

// ---- scorer callbacks -----------------------------------------------------------

async function recordDecision(appNoRaw, { decision, approvedAmount, reference, reason } = {}) {
  const appNo = parseAppNo(appNoRaw);
  const app = appNo ? await store.credits.byAppNo(appNo) : null;
  if (!app) throw err(404, 'application_not_found');
  const d = String(decision || '').toLowerCase();
  if (!['approved', 'declined'].includes(d)) throw err(422, 'decision_must_be_approved_or_declined');
  if (!['submitted_to_scorer', 'approved', 'declined'].includes(app.status)) throw err(409, 'application_not_submitted');
  const amt = approvedAmount != null && approvedAmount !== '' ? round2(Number(approvedAmount)) : null;
  if (d === 'approved' && amt != null && (!(amt > 0) || amt > app.loanable + 0.005)) throw err(422, 'approved_amount_invalid');
  app.status = d; app.decision = { decision: d, approvedAmount: d === 'approved' ? (amt ?? app.loanable) : null, reference: reference ? String(reference).slice(0, 80) : null,
    reason: reason ? String(reason).slice(0, 200) : null, at: now() };
  addEvent(app, `decision_${d}`, { reference: app.decision.reference });
  await store.credits.update(app);
  const tenant = await store.tenants.get(app.tenantId);
  const product = await productOf(app);
  const text = d === 'approved'
    ? `InsureCredit: your micro-loan of GHS ${n2(app.decision.approvedAmount)} for your bill at ${app.facility} was approved (ref ${app.appNo}). ConfirmU will contact you about repayment.`
    : `InsureCredit: ConfirmU could not approve your micro-loan this time (ref ${app.appNo}).${product ? ' You can still ask the hospital about other ways to pay.' : ''}`;
  const r = await messaging.send({ channel: 'sms', to: app.patient.phone, body: text, tenant });
  addEvent(app, r.ok ? 'decision_sms_sent' : 'decision_sms_failed', r.ok ? undefined : r.error);
  await store.credits.update(app);
  await notify({ party: 'provider', to: tenant?.contact?.email, subject: `InsureCredit ${app.appNo}: ${d}`,
    body: `The micro-loan application for ${app.patient?.name || 'your patient'} (${app.currency} ${n2(app.loanable)}) was ${d} by ConfirmU.`, billId: app.billId });
  return { applicationNo: app.appNo, status: app.status };
}

async function verifyByAppNo(appNoRaw) {
  const n = parseAppNo(appNoRaw);
  const app = n ? await store.credits.byAppNo(n) : null;
  if (!app) throw err(404, 'application_not_found');
  return verificationPacket(app);
}

// ---- USSD (Africa's Talking) ----------------------------------------------------

/**
 * Africa's Talking USSD callback: form fields sessionId, serviceCode, phoneNumber,
 * networkCode and text (every answer so far joined by "*"). Reply "CON ..." to keep
 * the session open or "END ..." to close it. Stateless: the whole session is
 * re-derived from `text`. The network supplies phoneNumber, so only the phone the
 * offer was sent to can act on an application.
 */
async function ussd({ phoneNumber, text } = {}) {
  const steps = String(text || '').split('*').map((s) => s.trim());
  const sameNumber = (a, b) => messaging.normalizePhone(a) === messaging.normalizePhone(b);
  if (!steps[0]) return 'CON InsureCredit\nEnter your 8-digit application number:';
  const appNo = parseAppNo(steps[0]);
  const app = appNo ? await store.credits.byAppNo(appNo) : null;
  if (!app || !sameNumber(app.patient?.phone, phoneNumber)) return 'END We could not find that application for this phone number. Check the number in your SMS.';
  const product = await productOf(app);
  if (!product || product.status !== 'live') return 'END This offer is not open right now. Please ask the hospital.';
  if (TERMINAL.includes(app.status)) return `END This application is ${app.status}.`;
  if (new Date(app.expiresAt) < new Date() && app.status !== 'submitted_to_scorer') return 'END This offer has expired. Ask the hospital to send a new one.';
  if (app.status === 'submitted_to_scorer') return `END Application ${app.appNo} is already with ConfirmU. You will get an SMS with the result.`;
  if (app.overCap && app.loanable <= 0) {
    return `END Your bill of GHS ${n2(app.amount)} is above the GHS ${app.cap} micro-loan limit. Open the link in your SMS to send your medical report to your HR or another funder.`;
  }
  if (steps.length === 1) {
    return `CON Application ${app.appNo}\nGHS ${n2(app.loanable)} for your bill at ${app.facility}.\n1. Apply (I agree to a ConfirmU credit check and to share my medical report with them)\n2. Cancel`;
  }
  if (steps[1] === '2') { app.status = 'cancelled'; addEvent(app, 'cancelled', { via: 'ussd' }); await store.credits.update(app); return 'END Cancelled. No application was made.'; }
  if (steps[1] !== '1') return 'END Invalid choice. Dial again to restart.';
  if (!(app.consents || []).some((c) => c.type === 'scoring')) {
    app.consents.push({ type: 'scoring', at: now(), textVersion: TEXT_VERSION, ip: null, via: 'ussd' });
    addEvent(app, 'consent_scoring', { via: 'ussd' });
  }
  if (['offered', 'opened'].includes(app.status)) app.status = 'consented';
  await store.credits.update(app);
  try {
    const r = await submit(app, product, { via: 'ussd' });
    const tenant = await store.tenants.get(app.tenantId);
    await messaging.send({ channel: 'sms', to: app.patient.phone, tenant,
      body: `InsureCredit: application ${app.appNo} for GHS ${n2(app.loanable)} was sent to ConfirmU. Finish your credit check here: ${r.redirectUrl}` });
    return `END Done. Application ${app.appNo} was sent to ConfirmU. We have texted you a link to finish the credit check.`;
  } catch (e) { return `END Sorry, we could not submit that now (${e.message}).`; }
}

// ---- Master Control / hospital / payer actions ------------------------------------

async function list({ tenantId, payerId, productId, status, limit = 100 } = {}) {
  let rows = await store.credits.all(5000);
  if (tenantId) rows = rows.filter((a) => a.tenantId === tenantId);
  if (payerId) rows = rows.filter((a) => a.payerId === payerId);
  if (productId) rows = rows.filter((a) => a.productId === productId);
  if (status) rows = rows.filter((a) => a.status === status);
  const by = {}; let requested = 0; let approved = 0;
  for (const a of rows) { by[a.status] = (by[a.status] || 0) + 1; requested += a.loanable || 0; if (a.status === 'approved') approved += a.decision?.approvedAmount || 0; }
  return {
    total: rows.length, byStatus: by, requestedTotal: round2(requested), approvedTotal: round2(approved),
    sharedNotes: rows.reduce((n, a) => n + (a.shares || []).filter((s) => !s.revoked).length, 0),
    rows: await Promise.all(rows.slice(0, limit).map((a) => summary(a))),
  };
}

/** The module's run(): called by solutions.run for hospital / payer / master surfaces. */
async function run(ctx, p, input) {
  const product = ctx.product;
  const action = String(input.action || 'list');
  const scope = { tenantId: ctx.surface === 'hospital' ? ctx.tenant?.id : undefined, payerId: ctx.surface === 'payer' ? ctx.payerId : undefined, productId: product.id };
  if (action === 'offer') return createOffer({ product, ctx, input });
  if (action === 'preview') {
    const amount = Number(input.amount || 0);
    if (!(amount > 0)) throw err(422, 'amount_invalid');
    const l = loanable(p, amount);
    const sms = renderSms(p, { first: firstName(input.name) || 'Ama', amount, facility: input.facility || 'City Clinic', link: `${base()}/credit/?t=…`, appNo: '48291736', cap: l.cap, overCap: l.overCap });
    return { preview: true, amount, loanableAmount: l.loanable, overCap: l.overCap, loanCap: l.cap, sms, smsLength: sms.length, design: designOf(p, product),
      ussd: p.ussdEnabled ? p.ussdCode : null };
  }
  if (action === 'list') return list({ ...scope, status: input.status });
  if (action === 'verify') {
    const n = parseAppNo(input.applicationNo); const app = n ? await store.credits.byAppNo(n) : null;
    if (!app || app.productId !== product.id) throw err(404, 'application_not_found');
    if (ctx.surface === 'hospital' && app.tenantId !== ctx.tenant?.id) throw err(404, 'application_not_found');
    if (ctx.surface === 'payer' && app.payerId !== ctx.payerId) throw err(404, 'application_not_found');
    return verificationPacket(app);
  }
  if (action === 'resend') {
    const n = parseAppNo(input.applicationNo); const app = n ? await store.credits.byAppNo(n) : null;
    if (!app || app.productId !== product.id) throw err(404, 'application_not_found');
    if (ctx.surface === 'hospital' && app.tenantId !== ctx.tenant?.id) throw err(404, 'application_not_found');
    if (ctx.surface === 'payer' && app.payerId !== ctx.payerId) throw err(404, 'application_not_found');
    if (product.status !== 'live') throw err(409, 'offers_paused');
    return resend(app, { product, ctx, input });
  }
  throw err(422, 'unknown_action', 'use offer | preview | list | verify | resend');
}

/** Patient surface of the module: look up your own application (number + phone). */
async function patientStatus(product, input = {}) {
  const n = parseAppNo(input.applicationNo);
  const app = n ? await store.credits.byAppNo(n) : null;
  const phone = messaging.normalizePhone(input.phone);
  if (!app || app.productId !== product.id || !phone || messaging.normalizePhone(app.patient?.phone) !== phone) throw err(404, 'application_not_found');
  return { applicationNo: app.appNo, status: app.status, amount: app.amount, loanableAmount: app.loanable, overCap: app.overCap, facility: app.facility,
    decision: app.decision ? { decision: app.decision.decision, approvedAmount: app.decision.approvedAmount } : null, expiresAt: app.expiresAt };
}

/**
 * Background pass for live products with autoSend: offer to new bills whose
 * out-of-pocket share qualifies. Idempotent -- a bill that already has an offer
 * from the product is skipped, so overlapping runs never text anyone twice.
 */
async function runAutoSend() {
  const products = (await store.products.all()).filter((x) => x.type === 'solution' && x.config.module === 'insurecredit'
    && x.status === 'live' && x.config.params.autoSend);
  const out = { products: products.length, offered: 0, skipped: 0, failed: 0 };
  if (!products.length) return out;
  const bills = await store.bills.all(3000);
  for (const product of products) {
    const p = paramsOf(product); const since = Date.now() - p.autoSendWithinDays * 86400000;
    for (const bill of bills) {
      if (bill.coverage?.payerId !== product.payerId) continue;
      if ((product.config.tenantIds || []).length && !product.config.tenantIds.includes(bill.tenantId)) continue;
      if (new Date(bill.createdAt).getTime() < since) continue;
      if (!['open', 'awaiting_payer'].includes(bill.status)) continue;
      if (!(bill.totals?.patientPayable >= p.minAmount) || !dialable(bill.patient?.phone)) { out.skipped++; continue; }
      if ((await store.credits.byBill(bill.id)).some((a) => a.productId === product.id)) continue;
      try { await createOffer({ product, ctx: { surface: 'master' }, input: { billId: bill.id } }); out.offered++; }
      catch (_e) { out.failed++; }
    }
  }
  return out;
}

module.exports = {
  HARD_CAP, PARAMS, check, DESIGNS, SMS_STYLES, CONSENT_TEXT,
  getSettings, rotateSecret, checkSecret, hookUrls, parseAppNo, loanable, renderSms,
  createOffer, view, consent, apply, share, revokeShare, shareView, recordDecision, verifyByAppNo, ussd,
  list, run, patientStatus, runAutoSend, publicView, verificationPacket, _setPostImplForTests,
};
