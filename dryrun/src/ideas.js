'use strict';
/**
 * Ideas from the platform team. A team decides what to do with each suggestion, nothing is applied for them:
 *  - "design": the idea becomes a design consideration the test bench can list next to regulator rules, best practice, market and customer feedback.
 *  - "iteration": the idea waits in the team's iteration ideas, ready to turn into an iteration on a connected site.
 * An idea can be both. Removing it takes it out of both. The platform sees only that a team added it, never how it was used.
 */
const audit = require('./audit'); const orgs = require('./orgs'); const plans = require('./plans'); const workroom = require('./workroom');
const { err, iso, id } = require('./util');
const COL = 'wr_ideas'; const ad = (o) => audit.adapter(o); const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const list = async (orgId) => (await ad(orgId).list(orgId, COL)).sort((a, b) => b.at.localeCompare(a.at));
async function add(orgId, actor, role, { msgId, use } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'iterate')) throw err(403, 'Viewers can read suggestions but not act on them.'); if (!['design', 'iteration'].includes(use)) throw err(422, 'Choose design considerations or iteration ideas.');
  const m = await ad(orgId).get(orgId, 'wr_msgs', msgId); if (!m || m.kind !== 'platform' || !m.notice) throw err(404, 'That suggestion is not here.');
  let idea = (await list(orgId)).find((x) => x.msgId === msgId);
  if (!idea) { const changes = workroom.parseWhatIf(m.text) || workroom.parseWhatIf('try ' + m.text); idea = { id: id('idea'), msgId, noticeId: m.notice.id, title: clip(m.notice.title, 80), text: clip(m.text, 1500), changes: changes && Object.keys(changes).length ? changes : null, design: false, iteration: false, by: actor.name, byId: actor.id, at: iso() }; }
  idea[use] = true; await ad(orgId).put(orgId, COL, idea.id, idea);
  m.notice.responses = m.notice.responses || {}; if (!m.notice.responses[actor.id]) { m.notice.responses[actor.id] = 'helpful'; await ad(orgId).put(orgId, 'wr_msgs', m.id, m); }
  await audit.log(orgId, actor, 'idea.add', { ideaId: idea.id, use }); return idea;
}
async function remove(orgId, actor, role, ideaId, use) { if (!orgs.can(role, 'iterate')) throw err(403, 'Your role cannot change this.'); const x = await ad(orgId).get(orgId, COL, ideaId); if (!x) throw err(404, 'That idea is not here.'); if (use === 'design' || use === 'iteration') x[use] = false; else { x.design = false; x.iteration = false; } if (!x.design && !x.iteration) await ad(orgId).del(orgId, COL, ideaId); else await ad(orgId).put(orgId, COL, ideaId, x); return { ok: true }; }
module.exports = { list, add, remove };
