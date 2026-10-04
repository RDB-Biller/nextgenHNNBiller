'use strict';

const crypto = require('crypto');
const store = require('../store');
const messaging = require('./messaging');
const campaigns = require('./campaigns');
const clinicalLinks = require('./clinicalLinks');
const verification = require('./verification');

/**
 * SMS Dashboard -- the Master Control reproduction of the standalone Africa's
 * Talking dashboard (bulk send with CSV/XLSX numbers, message log with search
 * + pagination, inbound inbox, analytics, CSV export, callback URLs).
 *
 * It rides the same seam as every other message in the product: sending goes
 * through messaging.sendBulk (sandbox/live toggle, tenant-or-platform
 * credentials), and credentials are never handled here -- they stay in Master
 * Control's encrypted storage. Delivery reports, inbound replies and opt-outs
 * arrive on unguessable-URL webhooks (routes/smsHooks.js): Africa's Talking
 * cannot send custom headers, so the secret lives in the URL path.
 */

const KEY = 'sms_dashboard';
const MAX_PER_REQUEST = 1000;
const CHUNK = 500;
const MAX_MESSAGE = 1600;
const id = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const bad = (code, status = 422) => { const e = new Error(code); e.status = status; return e; };

async function getSettings() {
  let s = await store.settings.get(KEY);
  if (!s) {
    s = { hookSecret: crypto.randomBytes(18).toString('hex'), optOuts: [], createdAt: new Date().toISOString() };
    await store.settings.set(KEY, s);
  }
  return s;
}
async function rotateSecret() {
  const s = await getSettings();
  s.hookSecret = crypto.randomBytes(18).toString('hex');
  await store.settings.set(KEY, s);
  return s.hookSecret;
}
async function checkSecret(given) {
  const s = await getSettings();
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(s.hookSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function hookUrls(baseUrl) {
  const s = await getSettings();
  const root = `${String(baseUrl || '').replace(/\/$/, '')}/sms-hooks/${s.hookSecret}`;
  return { delivery: `${root}/delivery`, inbox: `${root}/inbox`, optout: `${root}/optout` };
}

/** Pasted/uploaded numbers -> { valid[], invalid[], duplicates }. Splits on
 * commas/semicolons/whitespace/newlines; everything normalises to +233 form. */
function parseNumbers(input) {
  // Entries are separated by commas/semicolons/newlines. A pasted number may
  // itself contain spaces ("+233 24 400 0002"), so whitespace only splits an
  // entry when the entry as a whole is not already a valid number.
  const raw = Array.isArray(input) ? input : String(input || '').split(/[,;\n\r]+/);
  const seen = new Set();
  const valid = [];
  const invalid = [];
  let duplicates = 0;
  const take = (t) => {
    const n = campaigns.toE164Ghana(t);
    if (!n) { invalid.push(t); return; }
    if (seen.has(n)) { duplicates++; return; }
    seen.add(n);
    valid.push(n);
  };
  for (const r of raw) {
    const t = String(r || '').trim();
    if (!t) continue;
    if (campaigns.toE164Ghana(t) || !/\s/.test(t)) take(t);
    else t.split(/\s+/).filter(Boolean).forEach(take);
  }
  return { valid, invalid, duplicates };
}

async function optOutSet() { return new Set((await getSettings()).optOuts || []); }

async function send({ message, numbers, actor } = {}) {
  const text = String(message || '').trim();
  if (!text) throw bad('message_required');
  if (text.length > MAX_MESSAGE) throw bad('message_too_long');
  const parsed = parseNumbers(numbers);
  if (!parsed.valid.length) throw bad('no_valid_numbers');
  if (parsed.valid.length > MAX_PER_REQUEST) throw bad('too_many_recipients_max_1000');

  const optedOut = await optOutSet();
  const targets = parsed.valid.filter((n) => !optedOut.has(n));
  const skipped = parsed.valid.filter((n) => optedOut.has(n));
  const batchId = id('smsb');
  const now = () => new Date().toISOString();
  const rows = [];

  for (const n of skipped) {
    const row = { id: id('sms'), batchId, direction: 'out', to: n, message: text, status: 'skipped_optout',
      error: 'recipient_opted_out', createdAt: now(), actor: actor || null };
    await store.smsLog.insert(row); rows.push(row);
  }
  let mode = null;
  let batchError = null;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const r = await messaging.sendBulk({ to: chunk, body: text });
    mode = r.sandbox ? 'sandbox' : 'live';
    if (!r.ok) batchError = r.error;
    const results = r.ok ? r.results : chunk.map((n) => ({ to: n, ok: false, error: r.error }));
    for (const x of results) {
      const row = {
        id: id('sms'), batchId, direction: 'out', to: x.to, message: text,
        status: x.ok ? (r.sandbox ? 'sandbox' : 'sent') : 'failed',
        providerMessageId: x.providerMessageId || null, cost: x.cost || null,
        error: x.ok ? null : x.error || 'send_failed', createdAt: now(), actor: actor || null,
      };
      await store.smsLog.insert(row); rows.push(row);
    }
  }
  const count = (st) => rows.filter((r) => r.status === st).length;
  return {
    batchId, mode,
    requested: parsed.valid.length, invalid: parsed.invalid, duplicatesRemoved: parsed.duplicates,
    accepted: count('sent') + count('sandbox'), failed: count('failed'), skippedOptOut: count('skipped_optout'),
    error: batchError,
  };
}

function matches(row, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return [row.to, row.from, row.message, row.text, row.status, row.error, row.providerMessageId]
    .some((v) => v && String(v).toLowerCase().includes(s));
}

async function logs({ q, status, page = 1, pageSize = 20 } = {}) {
  let rows = await store.smsLog.all(5000);
  if (status) rows = rows.filter((r) => r.status === status);
  rows = rows.filter((r) => matches(r, q));
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 200);
  const total = rows.length;
  const pages = Math.max(Math.ceil(total / size), 1);
  const p = Math.min(Math.max(Number(page) || 1, 1), pages);
  return { total, page: p, pages, pageSize: size, data: rows.slice((p - 1) * size, p * size) };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
async function logsCsv({ q, status } = {}) {
  let rows = await store.smsLog.all(5000);
  if (status) rows = rows.filter((r) => r.status === status);
  rows = rows.filter((r) => matches(r, q));
  const head = ['id', 'batchId', 'createdAt', 'to', 'status', 'message', 'providerMessageId', 'cost', 'error'];
  return [head.join(','), ...rows.map((r) => head.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n';
}

/** Africa's Talking delivery report: id, status, phoneNumber, networkCode, failureReason, retryCount. */
async function recordDeliveryReport(b = {}) {
  const pid = b.id;
  if (!pid) throw bad('missing_id');
  const row = await store.smsLog.byProviderId(String(pid));
  if (!row) return { matched: false };
  const st = String(b.status || '').toLowerCase();
  row.status = st === 'success' ? 'delivered' : (st === 'sent' || st === 'submitted' || st === 'buffered' ? 'sent' : 'failed');
  row.providerStatus = b.status || null;
  if (b.failureReason) row.error = b.failureReason;
  row.networkCode = b.networkCode || row.networkCode || null;
  row.deliveredAt = row.status === 'delivered' ? new Date().toISOString() : row.deliveredAt || null;
  await store.smsLog.update(row);
  return { matched: true, status: row.status };
}

/** Africa's Talking inbound message: date, from, id, linkId, text, to, cost, networkCode. Also offered to the
 * existing reply handlers (clinical -> campaign -> verification) so a shared shortcode keeps working. */
async function recordInbound(b = {}) {
  const from = b.from || b.phoneNumber || '';
  const text = b.text || '';
  if (!from) throw bad('missing_from');
  const row = {
    id: id('in'), from, to: b.to || null, text, providerMessageId: b.id || null, linkId: b.linkId || null,
    cost: b.cost || null, networkCode: b.networkCode || null, receivedAt: b.date || new Date().toISOString(),
    createdAt: new Date().toISOString(), outcome: null,
  };
  if (text) {
    try {
      const result = (await clinicalLinks.handleInboundReply({ from, text, channel: 'sms' }))
        || (await campaigns.handleInboundReply({ from, text, channel: 'sms' }))
        || (await verification.handleInboundReply({ from, text, channel: 'sms' }));
      row.outcome = result?.outcome || null;
      if (result?.reply) await messaging.send({ channel: 'sms', to: from, body: result.reply });
    } catch (_e) { row.outcome = 'handler_error'; }
  }
  await store.smsInbox.insert(row);
  return row;
}

async function recordOptOut(b = {}) {
  const n = campaigns.toE164Ghana(b.phoneNumber || b.from || '');
  if (!n) throw bad('invalid_phone');
  const s = await getSettings();
  if (!s.optOuts.includes(n)) { s.optOuts.push(n); await store.settings.set(KEY, s); }
  return { optedOut: n };
}
async function removeOptOut(raw) {
  const n = campaigns.toE164Ghana(raw);
  const s = await getSettings();
  s.optOuts = (s.optOuts || []).filter((x) => x !== n);
  await store.settings.set(KEY, s);
  return { removed: n };
}
async function listOptOuts() { return (await getSettings()).optOuts || []; }

async function inbox({ q, page = 1, pageSize = 20 } = {}) {
  const rows = (await store.smsInbox.all(5000)).filter((r) => matches(r, q));
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 200);
  const pages = Math.max(Math.ceil(rows.length / size), 1);
  const p = Math.min(Math.max(Number(page) || 1, 1), pages);
  return { total: rows.length, page: p, pages, pageSize: size, data: rows.slice((p - 1) * size, p * size) };
}

async function analytics({ days = 14 } = {}) {
  const rows = await store.smsLog.all(5000);
  const inb = await store.smsInbox.all(5000);
  const by = {};
  let cost = 0;
  for (const r of rows) {
    by[r.status] = (by[r.status] || 0) + 1;
    const c = parseFloat(String(r.cost || '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(c)) cost += c;
  }
  const attempted = rows.filter((r) => r.status !== 'skipped_optout').length;
  const delivered = by.delivered || 0;
  const daily = new Map();
  for (let i = days - 1; i >= 0; i--) {
    daily.set(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), { date: null, sent: 0, failed: 0, inbound: 0 });
  }
  for (const [d, v] of daily) v.date = d;
  for (const r of rows) { const v = daily.get(String(r.createdAt).slice(0, 10)); if (v) { if (r.status === 'failed') v.failed++; else if (r.status !== 'skipped_optout') v.sent++; } }
  for (const r of inb) { const v = daily.get(String(r.createdAt).slice(0, 10)); if (v) v.inbound++; }
  return {
    totalOutbound: rows.length, attempted, byStatus: by, inbound: inb.length,
    deliveryRate: attempted ? Math.round((delivered / attempted) * 1000) / 10 : null,
    totalCost: Math.round(cost * 100) / 100,
    optOuts: (await listOptOuts()).length,
    daily: [...daily.values()],
  };
}

module.exports = {
  KEY, MAX_PER_REQUEST, getSettings, rotateSecret, checkSecret, hookUrls, parseNumbers, send,
  logs, logsCsv, inbox, analytics, recordDeliveryReport, recordInbound, recordOptOut, removeOptOut, listOptOuts,
};
