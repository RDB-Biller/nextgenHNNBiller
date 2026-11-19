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
    try { const m = await workroom.platformNote(oid, { kind: n.kind === 'reply' ? 'suggestion' : n.kind, title: n.title, text: n.text, noticeId: n.id, helpId: n.helpId, chief: n.chief }); const rec = { orgId: oid, name: o.name, msgId: m.id, sms: [] };
      if (alsoText) for (const mem of Object.values(o.members).filter((q) => q.role === 'admin' && q.phone)) { try { const d = await messaging.deliver({ phone: mem.phone, channels: { sms: true, whatsapp: false }, text: `${o.name}: new ${n.kind} from the platform team in your Workroom General room: ${n.title}`.slice(0, 300), orgId: o.id, orgName: o.name, who: 'admin', purpose: 'platform notice' }); rec.sms.push({ ok: d.length > 0 && d.every((x) => x.ok) }); } catch { rec.sms.push({ ok: false }); } }
      n.sent.push(rec); await audit.log(oid, PLAT_ACTOR, 'platform.' + n.kind, { noticeId: n.id, title: n.title });
    } catch (e) { n.skipped.push({ orgId: oid, name: o.name, why: e.message }); }
  }
}
async function sendNotice({ to, kind, title, text, alsoText, chief } = {}) {
  if (!KINDS.includes(kind)) throw err(422, 'Choose announcement or suggestion.'); const t = clip(title, 80), x = clip(text, 1500); if (!t) throw err(422, 'Give it a short title.'); if (x.length < 10) throw err(422, 'Write the message first.');
  const ids = to === 'all' ? orgs.list().map((o) => o.id) : Array.isArray(to) ? to : []; if (!ids.length) throw err(422, 'Choose who it goes to.');
  const n = { id: id('ntc'), root: null, at: iso(), kind, title: t, text: x, sent: [], skipped: [], texted: !!alsoText, chief: !!chief }; n.root = n.id; await deliverTo(n, ids, alsoText);
  store('notices')[n.id] = n; logLine('notice.send', { noticeId: n.id, kind, title: t, teams: n.sent.map((s) => s.name), skipped: n.skipped.length }); reg.save(); return n;
}
/** Send the same message to other teams, for example a team that answered "Not for us". A team that already got it (in any send) is not sent it twice. */
async function resendNotice(noticeId, { to, alsoText, title, text } = {}) {
  const src = store('notices')[noticeId]; if (!src) throw err(404, 'That message is not here.'); if (src.kind === 'reply') throw err(422, 'A reply to a help request belongs to that team. Write a new suggestion instead.');
  const ids = to === 'all' ? orgs.list().map((o) => o.id) : Array.isArray(to) ? to : []; if (!ids.length) throw err(422, 'Choose which teams to send it to.');
  const got = new Set(Object.values(store('notices')).filter((x) => x.root === src.root).flatMap((x) => x.sent.map((s) => s.orgId))); const fresh = ids.filter((i) => !got.has(i));
  const n = { id: id('ntc'), root: src.root, again: src.id, at: iso(), kind: src.kind, title: clip(title, 80) || src.title, text: clip(text, 1500) || src.text, edited: false, sent: [], skipped: ids.filter((i) => got.has(i)).map((i) => ({ orgId: i, why: 'Already received this message' })), texted: !!alsoText, chief: !!src.chief };
  if (!fresh.length) throw err(409, 'Every team you chose has already received this message.'); if (n.title.length < 1 || n.text.length < 10) throw err(422, 'The message is too short.'); n.edited = n.title !== src.title || n.text !== src.text; await deliverTo(n, fresh, alsoText); store('notices')[n.id] = n; logLine('notice.resend', { noticeId: n.id, from: src.id, edited: n.edited, title: n.title, teams: n.sent.map((s) => s.name) }); reg.save(); return n;
}
async function listNotices() {
  const out = [];
  for (const n of Object.values(store('notices')).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100)) {
    const teams = []; let helpful = 0, notNow = 0;
    for (const s of n.sent) { let h = 0, nn = 0, ch = null; try { const m = await audit.adapter(s.orgId).get(s.orgId, 'wr_msgs', s.msgId); ch = (m && m.notice && m.notice.chief && m.notice.chief.status) || null; for (const v of Object.values((m && m.notice.responses) || {})) v === 'helpful' ? h++ : nn++; } catch { /* team gone */ } helpful += h; notNow += nn; teams.push({ orgId: s.orgId, name: s.name, chief: ch, helpful: h, notNow: nn, answer: h + nn === 0 ? 'none' : nn > 0 && h === 0 ? 'not_now' : h > 0 && nn === 0 ? 'helpful' : 'mixed', adopted: await (async () => { try { return (await audit.adapter(s.orgId).list(s.orgId, 'wr_ideas')).some((x) => x.msgId === s.msgId); } catch { return false; } })(), texted: s.sms.length ? s.sms.every((x) => x.ok) ? 'delivered' : 'failed' : null }); }
    out.push({ chief: !!n.chief, id: n.id, root: n.root, again: n.again || null, edited: !!n.edited, at: n.at, kind: n.kind, title: n.title, text: n.text, texted: n.texted, skipped: n.skipped, teams, helpful, notNow, sent: n.sent }); }
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
  await alertOwner('help', 'help:' + r.id, `${o.name} asked the platform team for help.`);
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
// ---- text the owner when a team responds ---------------------------------------------------------------------------------------------
const EVENTS = { answer: 'A team answered Helpful or Not for us', adopted: 'A team added your suggestion to its plan', help: 'A team asked for help', chief: 'A team decided on DRI Chief' };
const DAILY_CAP = 20;
const alertCfg = () => { const r = reg.load(); r.deskAlerts = r.deskAlerts || { on: false, phone: '', events: { answer: true, adopted: true, help: true, chief: true }, sent: {}, day: '', count: 0 }; return r.deskAlerts; };
const alertView = () => { const a = alertCfg(); return { on: a.on, phone: a.phone ? messaging.mask(a.phone) : '', hasPhone: !!a.phone, events: a.events, labels: EVENTS, today: a.day === iso().slice(0, 10) ? a.count : 0, cap: DAILY_CAP }; }
function setAlerts({ on, phone, events } = {}) { const a = alertCfg(); if (phone !== undefined && phone !== '') { if (!messaging.validPhone(phone)) throw err(422, 'That phone number does not look right. Use 024… or +233….'); a.phone = String(phone).trim(); } if (phone === '') a.phone = ''; if (on !== undefined) { if (on && !a.phone) throw err(422, 'Add your phone number first.'); a.on = !!on; } if (events && typeof events === 'object') for (const k of Object.keys(EVENTS)) if (k in events) a.events[k] = !!events[k]; reg.save(); return alertView(); }
const siteUrl = () => (process.env.DRYRUN_PUBLIC_URL || 'https://dryrun.hnnworld.com') + '/app.html';
/** One text per team and message and kind of response, so a busy team does not flood the owner. Never throws: a failed text must not hold up a team. */
async function alertOwner(event, key, text) {
  try { const a = alertCfg(); if (!a.on || !a.phone || !a.events[event]) return { sent: false, why: 'off' }; if (a.sent[key]) return { sent: false, why: 'already told you' };
    const day = iso().slice(0, 10); if (a.day !== day) { a.day = day; a.count = 0; } if (a.count >= DAILY_CAP) return { sent: false, why: 'daily limit' };
    a.sent[key] = iso(); const keys = Object.keys(a.sent); if (keys.length > 2000) for (const k of keys.slice(0, 500)) delete a.sent[k]; a.count++; reg.save();
    const d = await Promise.race([messaging.deliver({ phone: a.phone, channels: { sms: true, whatsapp: false }, text: `Dry Run: ${text} Open Team messages: ${siteUrl()}`.slice(0, 300), orgId: null, orgName: 'Platform', who: 'owner', purpose: 'owner alert' }), new Promise((r) => setTimeout(() => r([{ ok: false }]), 5000))]);
    const ok = d.length > 0 && d.every((x) => x.ok); logLine('owner.alert', { event, ok }); return { sent: ok };
  } catch { return { sent: false, why: 'error' }; }
}
async function testAlert() { const a = alertCfg(); if (!a.phone) throw err(422, 'Add your phone number first.'); const d = await messaging.deliver({ phone: a.phone, channels: { sms: true, whatsapp: false }, text: 'Dry Run: this is a test. You will get a text like this when a team responds to your messages.', orgId: null, orgName: 'Platform', who: 'owner', purpose: 'owner alert test' }); const ok = d.length > 0 && d.every((x) => x.ok); if (!ok) throw err(502, (d.find((x) => !x.ok) || {}).error || 'The text could not be sent.'); return { ok: true }; }
const teamName = (orgId) => { try { return orgs.raw(orgId).name; } catch { return 'A team'; } };
/** Called when a member marks a platform message Helpful or Not for us. */
const onResponse = (orgId, msg, response) => alertOwner('answer', `answer:${msg.notice.id || msg.id}:${orgId}`, `${teamName(orgId)} said "${response === 'helpful' ? 'Helpful' : 'Not for us'}" to "${msg.notice.title}".`);
const onAdopted = (orgId, idea, use) => alertOwner('adopted', `adopted:${idea.noticeId || idea.msgId}:${orgId}:${use}`, `${teamName(orgId)} added "${idea.title}" to its ${use === 'design' ? 'design considerations' : 'iteration ideas'}.`);

const CHIEF_NAME = 'DRI Chief';
const chiefOf = (o) => Object.values(o.members).find((m) => m.role === 'contributor' && m.name === CHIEF_NAME) || null;
/** The team's admin decides. Approving adds a limited seat (look, iterate, vote, post); the team can remove it at any time. */
async function decideChief(orgId, actor, role, msgId, decision) {
  if (!orgs.can(role, 'team')) throw err(403, 'Only an admin can decide this.'); if (!['approve', 'decline'].includes(decision)) throw err(422, 'Choose approve or decline.');
  const o = orgs.raw(orgId); const m = await audit.adapter(orgId).get(orgId, 'wr_msgs', msgId); if (!m || m.kind !== 'platform' || !m.notice.chief) throw err(404, 'That request is not here.'); if (m.notice.chief.status !== 'pending') throw err(409, 'This has already been decided.');
  if (decision === 'approve') { if (chiefOf(o)) { m.notice.chief = { status: 'approved', by: actor.name, at: iso() }; } else { plans.assertWritable(o); try { const added = orgs.addMember(orgId, { name: CHIEF_NAME, email: `dri-chief@${orgId}.platform.invalid`, role: 'contributor' }, 'approved by ' + actor.name); orgs.memberRaw(orgId, added.id).mustChange = false; reg.save(); /* no one knows its password: the owner gets in only through a short session */ } catch (e) { throw err(e.status || 422, e.message); } m.notice.chief = { status: 'approved', by: actor.name, at: iso() }; } }
  else m.notice.chief = { status: 'declined', by: actor.name, at: iso() };
  await audit.adapter(orgId).put(orgId, 'wr_msgs', m.id, m); await audit.log(orgId, actor, 'chief.' + (decision === 'approve' ? 'approved' : 'declined'), { msgId }); await alertOwner('chief', 'chief:' + msgId, `${o.name} ${decision === 'approve' ? 'approved' : 'declined'} adding DRI Chief.`); logLine('chief.' + decision, { team: o.name, by: actor.name }); return m;
}
/** Teams that currently have a DRI Chief seat. */
const chiefSeats = () => orgs.list().map((o) => { const r = orgs.raw(o.id); const c = chiefOf(r); return c ? { orgId: o.id, name: o.name } : null; }).filter(Boolean);
function openChief(orgId) { const o = orgs.raw(orgId); const c = chiefOf(o); if (!c) throw err(404, 'This team has not approved a DRI Chief, or has removed it.'); logLine('chief.open', { team: o.name }); return { key: orgs.openSession(orgId, c.id), team: o.name }; }
module.exports = { alertView, setAlerts, testAlert, onResponse, onAdopted, decideChief, chiefSeats, openChief, resendNotice, logCsv, logList, sendNotice, listNotices, ask, mine, inbox, draft, answer, close, lint, KINDS, SHARES };
