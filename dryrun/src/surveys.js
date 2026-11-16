'use strict';
/**
 * Demand discovery. An organisation asks the people it hopes to serve what they want, through a link anyone can open (no sign-in).
 * No names, phone numbers or emails are stored with answers; free-text answers have anything that looks like a phone number or email removed.
 */
const orgs = require('./orgs');
const plans = require('./plans');
const audit = require('./audit');
const messaging = require('./messaging');
const { err, iso, id, newKey, round, median } = require('./util');
const adapter = (orgId) => audit.adapter(orgId);
const MIN_SHOWN = 5;
const hits = new Map();

function cleanQuestions(qs) {
  if (!Array.isArray(qs) || !qs.length) throw err(422, 'Add at least one question.');
  if (qs.length > 20) throw err(422, 'A survey can have up to 20 questions.');
  return qs.map((q, i) => {
    if (!q.prompt) throw err(422, `Question ${i + 1} needs wording.`); const type = q.type || 'choice';
    if (!['choice', 'rating', 'number', 'text'].includes(type)) throw err(422, `Question ${i + 1}: type must be choice, rating, number or text.`);
    if (type === 'choice' && (!Array.isArray(q.options) || q.options.length < 2)) throw err(422, `Question ${i + 1} needs at least two options.`);
    return { id: q.id || `q${i + 1}`, type, prompt: String(q.prompt).slice(0, 300), options: type === 'choice' ? q.options.map(String) : undefined, feeds: q.feeds && q.feeds.param ? { param: String(q.feeds.param), option: q.feeds.option != null ? String(q.feeds.option) : undefined } : undefined };
  });
}
async function create(orgId, actor, { title, purpose = '', questions } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!title) throw err(422, 'Give the survey a title.');
  const s = { id: id('svy'), token: `${orgId}.${newKey('s').slice(2, 22)}`, title: String(title).slice(0, 120), purpose: String(purpose).slice(0, 400), status: 'open', questions: cleanQuestions(questions), createdAt: iso(), createdBy: actor ? actor.name : 'platform owner' };
  await adapter(orgId).put(orgId, 'surveys', s.id, s); await audit.log(orgId, actor, 'survey.create', { surveyId: s.id, title: s.title }); return pub(s);
}
const pub = (s, n) => ({ id: s.id, token: s.token, title: s.title, purpose: s.purpose, status: s.status, questions: s.questions, createdAt: s.createdAt, createdBy: s.createdBy, ...(n !== undefined ? { responses: n } : {}) });
async function list(orgId) { const ad = adapter(orgId); const all = await ad.list(orgId, 'surveys'); const rs = await ad.list(orgId, 'responses'); return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => pub(s, rs.filter((r) => r.surveyId === s.id).length)); }
async function setStatus(orgId, actor, surveyId, status) { const o = orgs.raw(orgId); plans.assertWritable(o); const s = await adapter(orgId).get(orgId, 'surveys', surveyId); if (!s) throw err(404, 'Unknown survey.'); if (!['open', 'closed'].includes(status)) throw err(422, 'status must be open or closed.'); s.status = status; await adapter(orgId).put(orgId, 'surveys', s.id, s); await audit.log(orgId, actor, 'survey.status', { surveyId, status }); return pub(s); }

// ---- public side -----------------------------------------------------------------------------------------------------------------
async function byToken(token) {
  const orgId = String(token || '').split('.')[0]; let o; try { o = orgs.raw(orgId); } catch { throw err(404, 'This survey link is not valid.'); }
  const s = (await adapter(orgId).list(orgId, 'surveys')).find((x) => x.token === token); if (!s) throw err(404, 'This survey link is not valid.'); return { o, orgId, s };
}
async function publicView(token) { const { o, s } = await byToken(token); return { title: s.title, purpose: s.purpose, organisation: o.name, open: s.status === 'open' && !['suspended', 'read_only'].includes(plans.statusOf(o)), questions: s.questions.map(({ id: i, type, prompt, options }) => ({ id: i, type, prompt, options })) }; }
const scrub = (t) => String(t || '').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[removed]').replace(/\+?\d[\d\s().-]{6,}\d/g, '[removed]').slice(0, 500);
async function submit(token, answers, ip) {
  const { o, orgId, s } = await byToken(token); const st = plans.statusOf(o);
  if (s.status !== 'open' || st === 'suspended' || st === 'read_only') throw err(410, 'This survey is closed.');
  const k = token + '|' + ip, now = Date.now(); const h = (hits.get(k) || []).filter((t) => now - t < 3600000); if (h.length >= 20) throw err(429, 'Too many answers from this device. Try again later.'); h.push(now); hits.set(k, h);
  const ad = adapter(orgId); const rs = (await ad.list(orgId, 'responses')); const lim = plans.limitsFor(o).surveyResponses; if (lim !== undefined && rs.length >= lim) throw err(402, 'This organisation has reached its survey response limit.');
  const clean = {}; for (const q of s.questions) { const v = (answers || {})[q.id]; if (v === undefined || v === null || v === '') continue;
    if (q.type === 'choice') { if (!q.options.includes(String(v))) throw err(422, `Pick one of the listed answers for "${q.prompt}".`); clean[q.id] = String(v); }
    else if (q.type === 'rating') { const n = Number(v); if (!(n >= 1 && n <= 5)) throw err(422, 'Ratings go from 1 to 5.'); clean[q.id] = n; }
    else if (q.type === 'number') { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 1e7) throw err(422, 'Enter a number.'); clean[q.id] = n; } else clean[q.id] = scrub(v); }
  if (!Object.keys(clean).length) throw err(422, 'Answer at least one question.');
  const rid = id('rsp'); await ad.put(orgId, 'responses', rid, { id: rid, surveyId: s.id, at: iso(), answers: clean }); return { thanks: true };
}

// ---- results ---------------------------------------------------------------------------------------------------------------------
async function results(orgId, surveyId) {
  const ad = adapter(orgId); const s = await ad.get(orgId, 'surveys', surveyId); if (!s) throw err(404, 'Unknown survey.'); const rs = (await ad.list(orgId, 'responses')).filter((r) => r.surveyId === s.id);
  const qs = s.questions.map((q) => {
    const vals = rs.map((r) => r.answers[q.id]).filter((v) => v !== undefined); const n = vals.length; const base = { id: q.id, type: q.type, prompt: q.prompt, answered: n };
    if (n < MIN_SHOWN && q.type !== 'text') return { ...base, hidden: `Waiting for at least ${MIN_SHOWN} answers before showing results.` };
    if (q.type === 'choice') return { ...base, counts: q.options.map((op) => ({ option: op, count: vals.filter((v) => v === op).length, pct: round(100 * vals.filter((v) => v === op).length / n, 1) })) };
    if (q.type === 'rating') return { ...base, average: round(vals.reduce((a, b) => a + b, 0) / n, 2), counts: [1, 2, 3, 4, 5].map((k) => ({ option: String(k), count: vals.filter((v) => v === k).length })) };
    if (q.type === 'number') return { ...base, average: round(vals.reduce((a, b) => a + b, 0) / n, 2), median: round(median(vals), 2) };
    return { ...base, answers: vals.slice(-20).reverse() };
  });
  const feeds = s.questions.filter((q) => q.feeds && q.type === 'choice').map((q) => { const r = qs.find((x) => x.id === q.id); const c = r && r.counts && r.counts.find((x) => x.option === q.feeds.option); return c ? { param: q.feeds.param, value: c.pct, answered: r.answered, from: q.prompt } : null; }).filter(Boolean);
  return { survey: pub(s, rs.length), questions: qs, feeds };
}
/** Send the link to a short list of people. Numbers are not stored; only the count and the masked log entries. */
async function invite(orgId, actor, surveyId, url, { phones, channels }, inviteUrl) {
  const o = orgs.raw(orgId); plans.assertWritable(o); plans.assertNotDemo(o, 'Sending messages'); const s = await adapter(orgId).get(orgId, 'surveys', surveyId); if (!s) throw err(404, 'Unknown survey.');
  const list = [...new Set((phones || []).map(String).map((x) => x.trim()).filter(Boolean))]; if (!list.length) throw err(422, 'Add at least one phone number.'); if (list.length > 50) throw err(422, 'Send to at most 50 numbers at a time.');
  const text = messaging.surveyText({ org: o.name, url, inviteUrl }); let sent = 0, failed = 0;
  for (const p of list) { const r = await messaging.deliver({ phone: p, channels: channels || { sms: true }, text, orgId, orgName: o.name, who: 'survey', purpose: 'survey invite' }); if (r.length && r.every((x) => x.ok)) sent++; else failed++; }
  await audit.log(orgId, actor, 'survey.invite', { surveyId, sent, failed }); return { sent, failed };
}
module.exports = { create, list, setStatus, publicView, submit, results, invite, MIN_SHOWN };
