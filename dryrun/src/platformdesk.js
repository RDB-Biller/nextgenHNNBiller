'use strict';
/**
 * Platform desk: how the platform owner talks to teams, and the Platform assistant that helps with that.
 *  - Notices: the owner sends an announcement or a suggestion to one team, several, or all. It lands in each team's General room
 *    as "Platform team". Members mark it Helpful or Not for us, and the owner sees the counts. The owner cannot read a team's rooms.
 *  - Help requests: a team asks the platform for help and ticks exactly what it is willing to share. Nothing else is read.
 *  - Platform assistant: drafts a contribution for ONE open help request, from the question and the shared items only. It cannot be
 *    pointed at a team that has not asked. The owner reads, edits and sends the draft; nothing goes out on its own.
 * The assistant is rule-based (no outside AI service, no data leaves the platform). A hosted model can replace draft() behind the same shape.
 */
const reg = require('./registry'); const orgs = require('./orgs'); const plans = require('./plans'); const workroom = require('./workroom'); const bench = require('./bench'); const iterfeedback = require('./iterfeedback'); const audit = require('./audit'); const messaging = require('./messaging');
const { err, iso, id } = require('./util');
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const store = (k) => { const r = reg.load(); r[k] = r[k] || {}; return r[k]; };
const KINDS = ['announcement', 'suggestion'], SHARES = ['product', 'rules', 'customers', 'chat'];
const MAX_OPEN = 5;

// ---- notices -------------------------------------------------------------------------------------------------------------------
const PLAT_ACTOR = { id: 'platform', name: 'Platform owner' };
/** Every message the platform sends is kept in full, with who it reached, how, and what each team answered. */
function logLine(type, detail) { const l = store('log'); const k = id('log'); l[k] = { id: k, at: iso(), type, ...detail }; reg.save(); }
async function deliverTo(n, ids, alsoText) {
  for (const oid of ids) {
    let o = null; try { o = orgs.raw(oid); } catch { /* unknown */ } if (!o) { n.skipped.push({ orgId: oid, why: 'Unknown team' }); continue; }
    if (n.sent.some((x) => x.orgId === oid)) continue;
    try { const m = await workroom.platformNote(oid, { kind: n.kind === 'reply' ? 'suggestion' : n.kind, title: n.title, text: n.text, noticeId: n.id, helpId: n.helpId }); const rec = { orgId: oid, name: o.name, msgId: m.id, sms: [] };
      if (alsoText) for (const mem of Object.values(o.members).filter((q) => q.role === 'admin' && q.phone)) { try { const d = await messaging.deliver({ phone: mem.phone, channels: { sms: true, whatsapp: false }, text: `${o.name}: new ${n.kind} from the platform team in your Workroom General room: ${n.title}`.slice(0, 300), orgId: o.id, orgName: o.name, who: 'admin', purpose: 'platform notice' }); rec.sms.push({ ok: d.length > 0 && d.every((x) => x.ok) }); } catch { rec.sms.push({ ok: false }); } }
      n.sent.push(rec); await audit.log(oid, PLAT_ACTOR, 'platform.' + n.kind, { noticeId: n.id, title: n.title });
    } catch (e) { n.skipped.push({ orgId: oid, name: o.name, why: e.message }); }
  }
}
async function sendNotice({ to, kind, title, text, alsoText } = {}) {
  if (!KINDS.includes(kind)) throw err(422, 'Choose announcement or suggestion.'); const t = clip(title, 80), x = clip(text, 1500); if (!t) throw err(422, 'Give it a short title.'); if (x.length < 10) throw err(422, 'Write the message first.');
  const ids = to === 'all' ? orgs.list().map((o) => o.id) : Array.isArray(to) ? to : []; if (!ids.length) throw err(422, 'Choose who it goes to.');
  const n = { id: id('ntc'), root: null, at: iso(), kind, title: t, text: x, sent: [], skipped: [], texted: !!alsoText }; n.root = n.id; await deliverTo(n, ids, alsoText);
  store('notices')[n.id] = n; logLine('notice.send', { noticeId: n.id, kind, title: t, teams: n.sent.map((s) => s.name), skipped: n.skipped.length }); reg.save(); return n;
}
/** Send the same message to other teams, for example a team that answered "Not for us". A team that already got it (in any send) is not sent it twice. */
async function resendNotice(noticeId, { to, alsoText } = {}) {
  const src = store('notices')[noticeId]; if (!src) throw err(404, 'That message is not here.'); if (src.kind === 'reply') throw err(422, 'A reply to a help request belongs to that team. Write a new suggestion instead.');
  const ids = to === 'all' ? orgs.list().map((o) => o.id) : Array.isArray(to) ? to : []; if (!ids.length) throw err(422, 'Choose which teams to send it to.');
  const got = new Set(Object.values(store('notices')).filter((x) => x.root === src.root).flatMap((x) => x.sent.map((s) => s.orgId))); const fresh = ids.filter((i) => !got.has(i));
  const n = { id: id('ntc'), root: src.root, again: src.id, at: iso(), kind: src.kind, title: src.title, text: src.text, sent: [], skipped: ids.filter((i) => got.has(i)).map((i) => ({ orgId: i, why: 'Already received this message' })), texted: !!alsoText };
  if (!fresh.length) throw err(409, 'Every team you chose has already received this message.'); await deliverTo(n, fresh, alsoText); store('notices')[n.id] = n; logLine('notice.resend', { noticeId: n.id, from: src.id, title: n.title, teams: n.sent.map((s) => s.name) }); reg.save(); return n;
}
async function listNotices() {
  const out = [];
  for (const n of Object.values(store('notices')).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100)) {
    const teams = []; let helpful = 0, notNow = 0;
    for (const s of n.sent) { let h = 0, nn = 0; try { const m = await audit.adapter(s.orgId).get(s.orgId, 'wr_msgs', s.msgId); for (const v of Object.values((m && m.notice.responses) || {})) v === 'helpful' ? h++ : nn++; } catch { /* team gone */ } helpful += h; notNow += nn; teams.push({ orgId: s.orgId, name: s.name, helpful: h, notNow: nn, answer: h + nn === 0 ? 'none' : nn > 0 && h === 0 ? 'not_now' : h > 0 && nn === 0 ? 'helpful' : 'mixed', texted: s.sms.length ? s.sms.every((x) => x.ok) ? 'delivered' : 'failed' : null }); }
    out.push({ id: n.id, root: n.root, again: n.again || null, at: n.at, kind: n.kind, title: n.title, text: n.text, texted: n.texted, skipped: n.skipped, teams, helpful, notNow, sent: n.sent }); }
  return out;
}
/** The complete record as a spreadsheet file. */
async function logCsv() { const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; const rows = [['Sent at', 'Kind', 'Title', 'Message', 'Team', 'Team answer', 'Text to admins', 'Resent from']]; for (const n of await listNotices()) { if (!n.teams.length) rows.push([n.at, n.kind, n.title, n.text, '(no team reached)', '', '', n.again || '']); for (const t of n.teams) rows.push([n.at, n.kind, n.title, n.text, t.name, { none: 'No answer yet', helpful: 'Helpful', not_now: 'Not for us', mixed: 'Mixed' }[t.answer], t.texted || '', n.again || '']); } return rows.map((r) => r.map(q).join(',')).join('\n'); }
const logList = () => Object.values(store('log')).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);

// ---- help requests (from teams) ----------------------------------------------------------------------------------------------------
async function snapshot(orgId, share, assetId, roomId) {
  const c = {}; if (share.product || share.rules) { if (!assetId) throw err(422, 'Open a product room to share the product or its rules.'); const hist = await bench.history(orgId, assetId); const last = hist[0];
    if (share.product) { const v = last && last.variants && last.variants[0]; c.product = last ? { lastTested: last.at.slice(0, 10), ruleCount: last.ruleCount, winner: last.winnerId === assetId ? 'the current product' : last.winnerId ? 'a variation' : 'none', variantsTried: last.variants.length, metrics: v ? v.metrics : null } : { note: 'No bench runs yet.' }; }
    if (share.rules) { const cons = await bench.constraints(orgId, assetId); c.rules = { rules: cons.rules.map((r) => r.label), failing: last && last.variants[0] ? last.variants[0].checks.filter((k) => k.status === 'fail').map((k) => k.label) : [] }; } }
  if (share.customers) c.customers = (await iterfeedback.listInsights(orgId)).slice(0, 3).map((i) => ({ title: i.title, responses: i.responses, lines: i.lines.slice(0, 4) }));
  if (share.chat) { c.chat = (await workroom.recentText(orgId, roomId || workroom.GENERAL, 6)).map((m) => ({ by: m.by, text: clip(m.text, 300) })); }
  return c;
}
async function ask(orgId, actor, role, { question, share, assetId, roomId } = {}) {
  const o = orgs.raw(orgId); plans.assertNotDemo(o, 'Asking the platform team'); if (!orgs.can(role, 'iterate')) throw err(403, 'Viewers can read but not ask the platform team for help.');
  const q = clip(question, 800); if (q.length < 10) throw err(422, 'Say what you would like help with.'); const sh = {}; for (const k of SHARES) sh[k] = !!(share && share[k]);
  const reqs = Object.values(store('help')); if (reqs.filter((r) => r.orgId === orgId && r.status === 'open').length >= MAX_OPEN) throw err(429, `You already have ${MAX_OPEN} open requests. Wait for answers first.`);
  const r = { id: id('hlp'), orgId, orgName: o.name, at: iso(), by: actor.name, byId: actor.id, question: q, shared: sh, context: await snapshot(orgId, sh, assetId, roomId), status: 'open', draft: null, answer: null }; store('help')[r.id] = r; reg.save();
  await workroom.coachNote(orgId, workroom.GENERAL, `${actor.name} asked the platform team for help. You chose to share: ${SHARES.filter((k) => sh[k]).map((k) => ({ product: 'product results', rules: 'rules', customers: 'customer feedback', chat: 'recent chat' }[k])).join(', ') || 'nothing beyond the question'}. The platform team replies in this room.`); return view(r, true);
}
const view = (r, team) => ({ id: r.id, orgId: team ? undefined : r.orgId, orgName: team ? undefined : r.orgName, at: r.at, by: r.by, question: r.question, shared: r.shared, context: team ? undefined : r.context, status: r.status, answer: r.answer, answeredAt: r.answeredAt || null, draft: team ? undefined : r.draft });
const mine = (orgId) => Object.values(store('help')).filter((r) => r.orgId === orgId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20).map((r) => view(r, true));
const inbox = () => Object.values(store('help')).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.at.localeCompare(a.at)).slice(0, 100).map((r) => view(r, false));

// ---- Platform assistant ------------------------------------------------------------------------------------------------------------
const TOPICS = [
  ['pricing', /price|premium|tariff|loading|margin|loss ratio|profit/i, 'On price, move one lever at a time in the test bench and keep the change to a few percent, so the effect on loss ratio and margin is clear. Re-run it with "Market factors" ticked so competitor and cost assumptions are visible.'],
  ['rules', /constraint|rule|regulat|compliance|fail|limit/i, 'If a rule fails, look at which input drives it before changing the rule. Rules your team set are meant to protect you. Add the regulator check in the bench before asking for approval, and keep the approval request to one version at a time.'],
  ['customers', /customer|survey|feedback|market|prospect|social/i, 'For customer feedback, ask about two or three options, not more, and share the survey on the channel your customers actually use. Wait for at least 5 answers before relying on it. Read customers and non-customers separately: they often disagree, and both matter.'],
  ['iteration', /iterat|DRI|connect|site|signing|preview/i, 'Make small, named iterations and let the team vote on the ones that matter. If you genuinely control the web application, DRI signing gives exact structure and a live preview, which makes every later step more reliable.'],
  ['hardware', /print|robot|cad|stl|gcode|arduino|3d|sensor|motor/i, 'For hardware, run the G-code safety scan before any send, start with the printer in direct mode with local limits, and test robot programs in the simulator before they touch a device.'],
  ['approval', /approv|promot|gate|sign.?off/i, 'Ask for approval with a short note that names what changed and what the bench showed. One version per request keeps the decision record clear.']];
function lint(text) { const w = []; const t = String(text || ''); if (t.length > 1200) w.push('This is long. A short message is more likely to be read.'); if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(t)) w.push('It contains an email address. Remove it unless it is meant to be shared with the whole team.'); if (/\b(drs_|drt_|dr_[0-9a-f]{8}|sk_live|password)/i.test(t)) w.push('It looks like it contains a key or password. Remove it.'); if (/\b(guarantee|will definitely|always works)\b/i.test(t)) w.push('Avoid promises. Say what you saw and how sure you are.'); if (!/[?.!]$/.test(t.trim())) w.push('End with a clear next step the team can take.'); return w; }
/** Draft a reply for one open request. It reads only the question and what the team chose to share. */
function draft(helpId) {
  const r = store('help')[helpId]; if (!r) throw err(404, 'That request is not here.'); if (r.status !== 'open') throw err(409, 'That request is already answered. The assistant only helps with requests teams have asked for.');
  const q = r.question, c = r.context || {}; const parts = [`Hello ${r.by.split(' ')[0]}, thanks for asking.`]; const notes = [];
  const hit = TOPICS.filter((t) => t[1].test(q)); for (const t of hit.slice(0, 2)) parts.push(t[2]);
  if (c.product && c.product.metrics) { const m = c.product.metrics; parts.push(`From the bench results you shared (last run ${c.product.lastTested}): loss ratio ${m.lossRatioPct}%, margin ${m.margin}, ${c.product.variantsTried} version${c.product.variantsTried === 1 ? '' : 's'} tried, best choice: ${c.product.winner}.`); } else if (c.product) notes.push('You shared the product, but it has no bench runs yet. Suggest running the bench first.');
  if (c.rules) { if (c.rules.failing.length) parts.push(`These rules failed on the current product: ${c.rules.failing.slice(0, 4).join('; ')}. Start with the first one.`); else if (c.rules.rules.length) parts.push(`Your ${c.rules.rules.length} rule${c.rules.rules.length === 1 ? '' : 's'} all pass on the latest run.`); else parts.push('You have no rules set yet. Add two or three first so the bench can tell you what is acceptable.'); }
  if (c.customers && c.customers.length) parts.push(`Customer feedback you shared: ${c.customers[0].title} (${c.customers[0].responses} answers). ${c.customers[0].lines[0] || ''}`.trim());
  if (c.chat && c.chat.length) notes.push(`The team's recent chat was shared (${c.chat.length} messages). Read it before sending so your reply fits the thread.`);
  if (!hit.length) { parts.push('Here is how I would approach it: say what outcome you want, pick one thing to change, test it in the bench, then ask the team for a view.'); notes.push('No known topic matched the question. This is general guidance, so add something specific before you send.'); }
  const nothingShared = !SHARES.some((k) => r.shared[k]); if (nothingShared) notes.push('The team shared nothing beyond the question, so this draft cannot refer to their numbers.');
  parts.push('Tell us what you find and we will help with the next step.'); const text = parts.join('\n\n'); r.draft = { text, at: iso() }; reg.save(); return { text, notes, warnings: lint(text), basedOn: ['the question', ...SHARES.filter((k) => r.shared[k]).map((k) => ({ product: 'product results', rules: 'rules', customers: 'customer feedback', chat: 'recent chat' }[k]))] };
}
async function answer(helpId, text) {
  const r = store('help')[helpId]; if (!r) throw err(404, 'That request is not here.'); if (r.status !== 'open') throw err(409, 'That request is already answered.'); const t = clip(text, 1500); if (t.length < 10) throw err(422, 'Write the reply first.');
  const n = { id: id('ntc'), at: iso(), kind: 'reply', title: 'Reply to your request', text: t, helpId: r.id, sent: [], skipped: [], texted: false }; n.root = n.id; await deliverTo(n, [r.orgId], false); if (!n.sent.length) throw err(502, 'Could not post the reply to the team. ' + ((n.skipped[0] || {}).why || '')); store('notices')[n.id] = n; r.status = 'answered'; r.answer = t; r.answeredAt = iso(); logLine('help.answer', { noticeId: n.id, helpId: r.id, team: r.orgName }); reg.save(); return { request: view(r, false), msgId: n.sent[0].msgId, warnings: lint(t) };
}
function close(helpId) { const r = store('help')[helpId]; if (!r) throw err(404, 'That request is not here.'); r.status = 'closed'; reg.save(); return view(r, false); }
module.exports = { resendNotice, logCsv, logList, sendNotice, listNotices, ask, mine, inbox, draft, answer, close, lint, KINDS, SHARES };
