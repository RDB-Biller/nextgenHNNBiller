'use strict';
/**
 * Workroom. The team's working space inside the Product Lab Library.
 *  - A room for every product or programme (plus General and any guest rooms), with a live thread.
 *  - Comments that point at one parameter, version or run.
 *  - Approval requests that an approver settles inside the thread, and a searchable decision log.
 *  - Tasks and @mentions, with a daily digest.
 *  - A Coach that answers in the room and tries "what if" changes as saved drafts.
 *  - Guest rooms that a chosen partner can see and nothing else.
 * Text of messages stays in the organisation's own storage. SMS texts are sent by the server and never stored.
 */
const orgs = require('./orgs');
const plans = require('./plans');
const assets = require('./assets');
const audit = require('./audit');
const labcoach = require('./labcoach');
const lab = require('./lab');
const { err, iso, id } = require('./util');

const ad = (orgId) => audit.adapter(orgId);
const GENERAL = 'rm_general';
const DATA_KINDS = ['customer_dataset', 'claims_dataset', 'price_book'];
const clip = (s, n) => String(s || '').trim().slice(0, n);
const canPost = (role) => orgs.can(role, 'write') || orgs.can(role, 'approve');

async function ensureRooms(orgId) {
  const rooms = await ad(orgId).list(orgId, 'wr_rooms'); const byId = new Map(rooms.map((r) => [r.id, r]));
  if (!byId.has(GENERAL)) { const r = { id: GENERAL, kind: 'general', name: 'General', createdAt: iso() }; await ad(orgId).put(orgId, 'wr_rooms', r.id, r); byId.set(r.id, r); }
  for (const a of await assets.list(orgId)) {
    if (DATA_KINDS.includes(a.kind) || (a.card && a.card.tags || []).includes('bench')) continue; const rid = 'rm_' + a.id; const cur = byId.get(rid);
    if (!cur) { const r = { id: rid, kind: 'asset', name: a.name, assetId: a.id, assetKind: a.kind, createdAt: iso() }; await ad(orgId).put(orgId, 'wr_rooms', rid, r); byId.set(rid, r); }
    else if (cur.name !== a.name) { cur.name = a.name; await ad(orgId).put(orgId, 'wr_rooms', rid, cur); }
  }
  return [...byId.values()];
}
async function getRoom(orgId, roomId) { await ensureRooms(orgId); const r = await ad(orgId).get(orgId, 'wr_rooms', roomId); if (!r) throw err(404, 'Unknown room.'); return r; }
async function readState(orgId, memberId) { return (await ad(orgId).get(orgId, 'wr_read', memberId)) || { id: memberId, lastRead: {} }; }
async function markRead(orgId, memberId, roomId) { const st = await readState(orgId, memberId); st.lastRead[roomId] = iso(); await ad(orgId).put(orgId, 'wr_read', memberId, st); }

async function allMsgs(orgId) { return (await ad(orgId).list(orgId, 'wr_msgs')).sort((a, b) => a.at.localeCompare(b.at)); }
async function allTasks(orgId) { return ad(orgId).list(orgId, 'wr_tasks'); }

/** Rooms with an unread count and the number of open tasks, for the sidebar. */
async function rooms(orgId, me) {
  const list = await ensureRooms(orgId); const msgs = await allMsgs(orgId); const tasks = await allTasks(orgId); const st = await readState(orgId, me.id);
  return list.map((r) => {
    const mine = msgs.filter((m) => m.roomId === r.id); const since = st.lastRead[r.id] || '';
    return { id: r.id, kind: r.kind, name: r.name, assetId: r.assetId || null, engagementIds: r.engagementIds || [], unread: mine.filter((m) => m.at > since && m.byId !== me.id).length, last: mine.length ? mine[mine.length - 1].at : r.createdAt, openTasks: tasks.filter((t) => t.roomId === r.id && t.status === 'open').length };
  }).sort((a, b) => (a.kind === 'general' ? -1 : b.kind === 'general' ? 1 : b.last.localeCompare(a.last)));
}

/** Members matched by @username or a unique @firstname. */
function mentionsIn(orgId, text) {
  const o = orgs.raw(orgId); const members = Object.values(o.members); const out = new Set(); let coach = false;
  for (const m of String(text || '').matchAll(/@([a-z0-9._-]+)/gi)) {
    const t = m[1].toLowerCase().replace(/[.,;:!?]+$/, ''); if (t === 'coach') { coach = true; continue; }
    const byUser = members.find((x) => (x.username || '').toLowerCase() === t); if (byUser) { out.add(byUser.id); continue; }
    const byFirst = members.filter((x) => String(x.name || '').trim().split(/\s+/)[0].toLowerCase() === t); if (byFirst.length === 1) out.add(byFirst[0].id);
  }
  return { ids: [...out], coach };
}

async function put(orgId, rec) { await ad(orgId).put(orgId, 'wr_msgs', rec.id, rec); return rec; }
const base = (roomId, actor, kind, extra) => ({ id: id('msg'), roomId, at: iso(), byId: actor ? actor.id : null, by: actor ? actor.name : 'Dry Run', kind, ...extra });

/** Messages of a room, oldest first, with the tasks they refer to and a name for each approver decision. */
async function thread(orgId, me, roomId, { guestEid = null } = {}) {
  const room = await getRoom(orgId, roomId);
  if (guestEid && !(room.kind === 'guest' && (room.engagementIds || []).includes(guestEid))) throw err(403, 'This room has not been shared with you.');
  const msgs = (await allMsgs(orgId)).filter((m) => m.roomId === roomId).slice(-300);
  const tasks = (await allTasks(orgId)).filter((t) => t.roomId === roomId);
  let pinned = null;
  if (room.assetId && !guestEid) { try { const d = await assets.detail(orgId, room.assetId, { withData: true }); const last = d.versionList[d.versionList.length - 1]; const data = last.data || {}; const src = data.generatedFrom || data;
    const params = Object.entries(src).filter(([k, v]) => ['string', 'number'].includes(typeof v) && !['name', 'currency', 'archetype', 'id'].includes(k)).slice(0, 12).map(([k, v]) => ({ key: k, value: v }));
    pinned = { assetId: d.id, name: d.name, kind: d.kind, version: last.v, gate: last.gate, params, versions: d.versionList.map((v) => ({ v: v.v, gate: v.gate })) }; } catch { pinned = null; } }
  if (!guestEid) await markRead(orgId, me.id, roomId);
  return { room: { id: room.id, kind: room.kind, name: room.name, assetId: room.assetId || null, engagementIds: room.engagementIds || [] }, messages: msgs, tasks, pinned };
}

async function post(orgId, actor, role, roomId, { text, anchor, guestEid = null } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); const room = await getRoom(orgId, roomId);
  if (guestEid) { if (!(room.kind === 'guest' && (room.engagementIds || []).includes(guestEid))) throw err(403, 'This room has not been shared with you.'); }
  else if (!canPost(role)) throw err(403, 'Your role can read the Workroom but not post.');
  const t = clip(text, 2000); if (!t) throw err(422, 'Write a message first.');
  const men = guestEid ? { ids: [], coach: false } : mentionsIn(orgId, t);
  let a = null; if (anchor && !guestEid) a = { assetId: room.assetId || anchor.assetId || null, version: anchor.version ? Number(anchor.version) : null, param: clip(anchor.param, 60) || null, runId: clip(anchor.runId, 60) || null };
  const msg = await put(orgId, base(roomId, actor, 'text', { text: t, mentions: men.ids, anchor: a && (a.param || a.version || a.runId) ? a : null }));
  return { message: msg, mentioned: men.ids, coach: men.coach, room };
}

// ---- approvals and decisions --------------------------------------------------------------------------------------------------
async function requestApproval(orgId, actor, role, roomId, { assetId, version, note } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'promote')) throw err(403, 'Your role cannot ask for an approval.');
  const room = await getRoom(orgId, roomId); const aid = assetId || room.assetId; if (!aid) throw err(422, 'Open a product room to ask for an approval.');
  const { asset, version: v } = await assets.versionData(orgId, aid, version); const gi = assets.GATES.indexOf(v.gate);
  if (gi >= assets.GATES.length - 1) throw err(409, 'This version is already approved.'); const to = assets.GATES[gi + 1];
  const open = (await allMsgs(orgId)).find((m) => m.kind === 'approval' && m.approval.status === 'open' && m.approval.assetId === asset.id && m.approval.version === v.v);
  if (open) throw err(409, 'An approval for this version is already waiting.');
  const msg = await put(orgId, base(roomId, actor, 'approval', { text: clip(note, 500), approval: { assetId: asset.id, assetName: asset.name, version: v.v, from: v.gate, to, note: clip(note, 500), status: 'open', requestedBy: actor.name, requestedById: actor.id } }));
  const approvers = Object.values(o.members).filter((m) => orgs.can(m.role, 'approve') && m.id !== actor.id);
  return { message: msg, approvers, room };
}
async function decideApproval(orgId, actor, role, msgId, { action, note } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'approve')) throw err(403, 'Only an approver or admin can settle an approval.');
  const m = await ad(orgId).get(orgId, 'wr_msgs', msgId); if (!m || m.kind !== 'approval') throw err(404, 'Unknown approval request.'); if (m.approval.status !== 'open') throw err(409, 'This request has already been settled.');
  const n = clip(note, 500); const ap = m.approval;
  if (action === 'approve') await assets.promote(orgId, actor, role, ap.assetId, ap.version, ap.to, n || 'Approved in the Workroom');
  else if (action === 'send_back') { if (!n) throw err(422, 'Say what needs to change.'); }
  else throw err(422, 'Choose approve or send back.');
  ap.status = action === 'approve' ? 'approved' : 'sent_back'; ap.decidedBy = actor.name; ap.decidedAt = iso(); ap.decisionNote = n; await put(orgId, m);
  const label = ap.to.replace('_', ' ');
  await put(orgId, base(m.roomId, actor, 'system', { text: action === 'approve' ? `${actor.name} approved "${ap.assetName}" v${ap.version} to ${label}.${n ? ' ' + n : ''}` : `${actor.name} sent "${ap.assetName}" v${ap.version} back: ${n}` }));
  await put(orgId, base(m.roomId, actor, 'decision', { text: '', decision: { what: action === 'approve' ? `Moved "${ap.assetName}" v${ap.version} to ${label}` : `Sent "${ap.assetName}" v${ap.version} back (not moved to ${label})`, why: n || (action === 'approve' ? 'Approved' : ''), source: 'approval', assetId: ap.assetId } }));
  return { message: m, requesterId: ap.requestedById, requester: o.members[ap.requestedById] || null, roomId: m.roomId };
}
async function addDecision(orgId, actor, role, roomId, { what, why } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!canPost(role)) throw err(403, 'Your role cannot record decisions.'); const room = await getRoom(orgId, roomId);
  const w = clip(what, 240); if (!w) throw err(422, 'Say what was decided.');
  return put(orgId, base(room.id, actor, 'decision', { text: '', decision: { what: w, why: clip(why, 600), source: 'manual', assetId: room.assetId || null } }));
}
async function decisions(orgId, q) {
  const list = await ensureRooms(orgId); const names = new Map(list.map((r) => [r.id, r.name])); const needle = String(q || '').trim().toLowerCase();
  return (await allMsgs(orgId)).filter((m) => m.kind === 'decision').reverse().map((m) => ({ id: m.id, at: m.at, by: m.by, roomId: m.roomId, room: names.get(m.roomId) || '', what: m.decision.what, why: m.decision.why, source: m.decision.source }))
    .filter((d) => !needle || [d.what, d.why, d.by, d.room].join(' ').toLowerCase().includes(needle));
}

// ---- tasks ----------------------------------------------------------------------------------------------------------------------
async function addTask(orgId, actor, role, roomId, { text, assigneeId, due } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!canPost(role)) throw err(403, 'Your role cannot add tasks.'); const room = await getRoom(orgId, roomId);
  const t = clip(text, 300); if (!t) throw err(422, 'Say what needs doing.'); const as = o.members[assigneeId]; if (!as) throw err(422, 'Choose who it is for.');
  let d = null; if (due) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due))) throw err(422, 'Use a date like 2026-12-01.'); d = String(due); }
  const task = { id: id('tsk'), roomId: room.id, text: t, assigneeId: as.id, assignee: as.name, due: d, status: 'open', createdBy: actor.name, createdById: actor.id, createdAt: iso() };
  await ad(orgId).put(orgId, 'wr_tasks', task.id, task);
  const msg = await put(orgId, base(room.id, actor, 'task', { text: t, taskId: task.id }));
  return { task, message: msg, assignee: as, room };
}
async function setTask(orgId, actor, role, taskId, done) {
  const t = await ad(orgId).get(orgId, 'wr_tasks', taskId); if (!t) throw err(404, 'Unknown task.');
  if (!(t.assigneeId === actor.id || t.createdById === actor.id || orgs.can(role, 'team'))) throw err(403, 'Only the person it is for, the person who set it, or an admin can change it.');
  t.status = done ? 'done' : 'open'; t.doneAt = done ? iso() : null; t.doneBy = done ? actor.name : null; await ad(orgId).put(orgId, 'wr_tasks', t.id, t);
  if (done) await put(orgId, base(t.roomId, actor, 'system', { text: `${actor.name} marked "${t.text}" done.` }));
  return { task: t, creator: orgs.raw(orgId).members[t.createdById] || null };
}

/** What needs me: my open tasks, approvals waiting for me and unread messages that mention me. */
async function mine(orgId, me, role) {
  const msgs = await allMsgs(orgId); const st = await readState(orgId, me.id); const names = new Map((await ensureRooms(orgId)).map((r) => [r.id, r.name]));
  const today = iso().slice(0, 10);
  const tasks = (await allTasks(orgId)).filter((t) => t.assigneeId === me.id && t.status === 'open').map((t) => ({ ...t, room: names.get(t.roomId) || '', overdue: !!t.due && t.due < today })).sort((a, b) => (a.due || '9').localeCompare(b.due || '9'));
  const approvals = orgs.can(role, 'approve') ? msgs.filter((m) => m.kind === 'approval' && m.approval.status === 'open' && m.byId !== me.id).map((m) => ({ id: m.id, roomId: m.roomId, room: names.get(m.roomId) || '', ...m.approval })) : [];
  const mentions = msgs.filter((m) => (m.mentions || []).includes(me.id) && m.byId !== me.id && m.at > (st.lastRead[m.roomId] || '')).map((m) => ({ id: m.id, roomId: m.roomId, room: names.get(m.roomId) || '', by: m.by, text: m.text.slice(0, 140), at: m.at }));
  return { tasks, approvals, mentions, badge: tasks.length + approvals.length + mentions.length };
}
async function digestFor(orgId, member) {
  const m = await mine(orgId, member, member.role); const over = m.tasks.filter((t) => t.overdue).length;
  const parts = []; if (m.tasks.length) parts.push(`${m.tasks.length} task${m.tasks.length === 1 ? '' : 's'}${over ? ` (${over} overdue)` : ''}`); if (m.approvals.length) parts.push(`${m.approvals.length} approval${m.approvals.length === 1 ? '' : 's'} waiting`); if (m.mentions.length) parts.push(`${m.mentions.length} mention${m.mentions.length === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : null;
}

// ---- Coach in the room --------------------------------------------------------------------------------------------------------
const num = (re, s) => { const m = String(s).match(re); return m ? Number(m[1]) : undefined; };
/** Reads a "what if" out of plain words. Returns lab.variation changes, or null. */
function parseWhatIf(text) {
  const s = String(text || '').toLowerCase().replace(/,/g, ''); if (!/(what if|what happens|if we|try|suppose|raise|lower|cut|increase|reduce)/.test(s)) return null; const c = {};
  const down = /(lower|cut|reduce|decrease|drop|less|down|fall|cheaper|smaller)/.test(s);
  const pr = num(/premium[^0-9-]*(-?\d+(?:\.\d+)?)\s*%/, s); if (pr !== undefined) c.premiumPct = down && pr > 0 ? -pr : pr;
  const cp = num(/(?:cap|limit)[^0-9-]*(-?\d+(?:\.\d+)?)\s*%/, s); if (cp !== undefined) c.capPct = down && cp > 0 ? -cp : cp;
  const co = num(/co-?pay(?:ment)?[^0-9]*(\d+(?:\.\d+)?)/, s); if (co !== undefined) c.coPayPct = co;
  const wd = num(/waiting[^0-9]*(\d+)/, s); if (wd !== undefined) c.waitingDays = wd;
  return Object.keys(c).length ? c : null;
}
const fmtN = (v) => (typeof v === 'number' ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100)) : String(v));
async function coachReply(orgId, actor, role, roomId, { text, pack } = {}) {
  const room = await getRoom(orgId, roomId); const q = String(text || '').replace(/@coach/gi, '').trim(); const changes = parseWhatIf(q);
  let reply = ''; let extra = {};
  if (changes && room.assetId) {
    try {
      const v = await lab.variation(orgId, actor, role, room.assetId, { changes });
      const cmp = await lab.compareProducts(orgId, actor, role, [room.assetId, v.asset.id]);
      const lines = (cmp.comparison.metrics || []).slice(0, 4).map((mt) => `${mt.metric.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${fmtN(mt.values[0].value)} -> ${fmtN(mt.values[1].value)}`);
      reply = `I tried it: ${v.changes.join(', ')}.\n${lines.join('\n')}\nRegulator view: ${v.regulatory.summary}\nSaved as a draft, "${v.asset.name}", in your library. Nothing is approved.`; extra = { variationId: v.asset.id };
    } catch (e) { reply = `I could not try that: ${e.message}`; }
  } else if (changes) reply = 'Open a product room and I can try that change on it. Here I can only answer questions.';
  else reply = labcoach.reply({ message: q, pack });
  const msg = await put(orgId, base(roomId, { id: 'coach', name: 'Coach' }, 'coach', { text: reply, ...extra }));
  return msg;
}
async function coachNote(orgId, roomId, text, extra) { const room = await getRoom(orgId, roomId); return put(orgId, base(room.id, { id: 'coach', name: 'Coach' }, 'coach', { text: clip(text, 1800), ...(extra || {}) })); }
async function postRun(orgId, run, assetId) { // a run finished for an asset: say so in its room
  if (!assetId) return null; try { const room = await getRoom(orgId, 'rm_' + assetId); const h = Object.entries(run.headline || {}).slice(0, 4).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${fmtN(v)}`).join(' · ');
    return await put(orgId, base(room.id, { id: 'coach', name: 'Coach' }, 'coach', { text: `Run finished: ${run.name}. ${h}`, anchor: { assetId, runId: run.id } })); } catch { return null; } }

// ---- guest rooms ----------------------------------------------------------------------------------------------------------------
async function createGuestRoom(orgId, actor, role, { name, engagementIds } = {}) {
  const o = orgs.raw(orgId); plans.assertNotDemo(o, 'Guest rooms'); plans.assertWritable(o); if (!orgs.can(role, 'settings')) throw err(403, 'Only an admin can open a guest room.');
  const n = clip(name, 80); if (!n) throw err(422, 'Name the room.'); const eng = require('./engagements'); const mineEng = eng.listFor(orgId).filter((e) => e.clientOrgId === orgId && e.status === 'active').map((e) => e.id);
  const ids = [...new Set(engagementIds || [])].filter((e) => mineEng.includes(e)); if (!ids.length) throw err(422, 'Choose at least one active partner.');
  const r = { id: id('rm'), kind: 'guest', name: n, engagementIds: ids, createdAt: iso(), createdBy: actor.name };
  await ad(orgId).put(orgId, 'wr_rooms', r.id, r); await put(orgId, base(r.id, null, 'system', { text: `${actor.name} opened this room for ${ids.length} partner${ids.length === 1 ? '' : 's'}. They see this room and nothing else in your workspace.` })); return r;
}
async function guestRooms(orgId, eid) { return (await ensureRooms(orgId)).filter((r) => r.kind === 'guest' && (r.engagementIds || []).includes(eid)).map((r) => ({ id: r.id, name: r.name })); }

module.exports = { GENERAL, rooms, thread, post, mentionsIn, requestApproval, decideApproval, addDecision, decisions, addTask, setTask, mine, digestFor, coachReply, coachNote, parseWhatIf, postRun, createGuestRoom, guestRooms, markRead, getRoom };
