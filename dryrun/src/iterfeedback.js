'use strict';
/**
 * Putting iterations in front of customers, and bringing the answers back into the design.
 *  - A survey can show several iterations (the Team's, individual members', or a mix) as "Option A, B, C". People open each one live
 *    (a Dry Run Iteration link, watermarked) and rate it, say which they prefer, and say whether they are a customer.
 *    Respondents never see who made an option or which was the Team's. The team sees that in the results.
 *  - A share kit gives a tracked link for each social channel, so the results show which channel brought which answers.
 *  - Results appear only once there are enough answers (MIN_SHOWN), and each audience group is shown only once it is big enough.
 *  - "Use in design" saves a short summary as an insight. The Coach posts it in the General room and the test bench can include it,
 *    next to regulator rules, best practice, market factors and the web.
 */
const orgs = require('./orgs');
const plans = require('./plans');
const audit = require('./audit');
const surveys = require('./surveys');
const connect = require('./connect');
const workroom = require('./workroom');
const { err, iso, round } = require('./util');
const ad = (orgId) => audit.adapter(orgId);
const clip = (s, n) => String(s || '').trim().slice(0, n);
const LETTERS = 'ABCDEF';
const AUDIENCE = { customer: 'I am a customer', prospect: 'I am not a customer yet', other: 'Something else' };
const kinds = (patches) => { const c = {}; for (const p of patches) c[p.type] = (c[p.type] || 0) + 1; const names = { text: 'text', style: 'style', hide: 'hidden element', attr: 'attribute', setting: 'setting' }; return Object.entries(c).map(([k, n]) => `${n} ${names[k] || k} change${n === 1 ? '' : 's'}`).join(', '); };

async function create(orgId, actor, role, { title, purpose, picks, days, questions, askAudience } = {}) {
  const o = orgs.raw(orgId); plans.assertWritable(o); plans.assertNotDemo(o, 'Sending surveys'); if (!orgs.can(role, 'iterate')) throw err(403, 'Viewers can read surveys but not start them.');
  if (!Array.isArray(picks) || !picks.length) throw err(422, 'Choose at least one iteration to ask about.'); if (picks.length > 6) throw err(422, 'A survey can show up to 6 iterations.');
  const seen = new Set(); const chosen = [];
  for (const [i, p] of picks.entries()) { const key = `${p.siteId}/${p.iid}`; if (seen.has(key)) throw err(422, 'An iteration can only be in the survey once.'); seen.add(key); const s = await connect.find(orgId, String(p.siteId)); const it = (s.iterations || []).find((x) => x.id === p.iid); if (!it) throw err(404, `Iteration ${i + 1} is no longer there.`);
    if (s.level !== 'signed' || !s.manifest.permissions.iterate) throw err(422, `${s.name} does not allow live iterations right now.`); chosen.push({ s, it }); }
  const d = Math.min(30, Math.max(3, Math.round(Number(days) || 14))); const options = [];
  for (const [i, { s, it }] of chosen.entries()) { const sh = await connect.shareIteration(orgId, actor, role, s.id, it.id, { days: d }); options.push({ key: LETTERS[i], label: `Option ${LETTERS[i]}`, siteId: s.id, siteName: s.name, iid: it.id, title: it.title, scope: it.scope || 'member', by: it.by, summary: kinds(it.patches) || 'A change', link: sh.link, expiresAt: sh.expiresAt }); }
  const qs = [...options.map((x) => ({ id: 'rate_' + x.key, type: 'rating', prompt: `How much do you like ${x.label}? (1 is not at all, 5 is very much)` }))];
  if (options.length > 1) qs.push({ id: 'prefer', type: 'choice', prompt: 'Which one would you choose?', options: [...options.map((x) => x.label), 'None of these'] });
  if (askAudience !== false) qs.push({ id: 'who', type: 'choice', prompt: 'Which describes you?', options: Object.values(AUDIENCE) });
  qs.push({ id: 'change', type: 'text', prompt: 'What would you change? (please leave out names and phone numbers)' });
  for (const q of (Array.isArray(questions) ? questions : []).slice(0, 5)) qs.push({ ...q, id: undefined });
  qs.forEach((q, i) => { if (!q.id) q.id = 'x' + (i + 1); });
  const sv = await surveys.create(orgId, actor, { title: clip(title, 120) || (options.length > 1 ? 'Which do you prefer?' : 'What do you think?'), purpose: clip(purpose, 400) || 'Open each option, then tell us what you think. It takes about two minutes.', questions: qs }, { kind: 'iteration', options, linkDays: d, askAudience: askAudience !== false });
  await audit.log(orgId, actor, 'survey.iterations', { surveyId: sv.id, options: options.length }); return { survey: sv, options: options.map(privateOption) };
}
const privateOption = (x) => ({ key: x.key, label: x.label, siteId: x.siteId, siteName: x.siteName, iid: x.iid, title: x.title, scope: x.scope, by: x.by, summary: x.summary, expiresAt: x.expiresAt });

/** Per option: rating, preference, and the same split by audience. Small groups are not shown. */
function analyse(s, rs) {
  const M = surveys.MIN_SHOWN; const total = rs.length; const aud = (r) => { const v = (r.answers || {}).who; return v === AUDIENCE.customer ? 'customer' : v === AUDIENCE.prospect ? 'prospect' : v ? 'other' : 'unknown'; };
  const calc = (rows) => { const prefAns = rows.filter((r) => r.answers.prefer !== undefined); return Object.fromEntries(s.options.map((o) => { const rt = rows.map((r) => r.answers['rate_' + o.key]).filter((v) => v !== undefined); const pc = prefAns.filter((r) => r.answers.prefer === o.label).length; return [o.key, { ratings: rt.length, average: rt.length ? round(rt.reduce((a, b) => a + b, 0) / rt.length, 2) : null, prefer: pc, preferPct: prefAns.length ? round(100 * pc / prefAns.length, 1) : null }]; }).concat([['_none', { prefer: prefAns.filter((r) => r.answers.prefer === 'None of these').length, answered: prefAns.length }]])); };
  const pick = (c) => { if (!c._none || c._none.answered < M) return null; const ranked = s.options.map((o) => ({ o, ...c[o.key] })).sort((a, b) => b.prefer - a.prefer || (b.average || 0) - (a.average || 0)); const top = ranked[0]; if (c._none.prefer > top.prefer) return { none: true }; return top.prefer ? { key: top.o.key, prefer: top.prefer, of: c._none.answered, pct: top.preferPct, average: top.average } : null; };
  const all = calc(rs); const groups = {}; for (const g of ['customer', 'prospect', 'other']) { const rows = rs.filter((r) => aud(r) === g); if (rows.length) groups[g] = rows.length >= M ? { n: rows.length, ...calc(rows) } : { n: rows.length, hidden: `Waiting for at least ${M} answers from this group.` }; }
  const enough = total >= M; const winner = enough ? pick(all) : null; const notes = [];
  if (!enough) notes.push(`Waiting for at least ${M} answers before showing results.`);
  else if (winner && winner.none) notes.push('Most people chose "None of these". Read their comments before choosing.');
  const gp = ['customer', 'prospect'].map((g) => groups[g] && !groups[g].hidden ? pick(groups[g]) : null); if (gp[0] && gp[1] && !gp[0].none && !gp[1].none && gp[0].key !== gp[1].key) notes.push(`Customers prefer Option ${gp[0].key} but people who are not customers yet prefer Option ${gp[1].key}. Decide which group you are designing for.`);
  const opts = s.options.map((o) => ({ ...privateOption(o), ...(enough ? { all: all[o.key], groups: Object.fromEntries(Object.entries(groups).map(([g, v]) => [g, v.hidden ? v : { n: v.n, ...v[o.key] }])) } : {}) }));
  return { enough, total, options: opts, winner: winner && !winner.none ? { ...winner, option: s.options.find((o) => o.key === winner.key).label, title: s.options.find((o) => o.key === winner.key).title, siteId: s.options.find((o) => o.key === winner.key).siteId, iid: s.options.find((o) => o.key === winner.key).iid } : winner && winner.none ? { none: true } : null, notes, expired: Date.parse(s.options[0].expiresAt) < Date.now(), linksUntil: s.options[0].expiresAt };
}

// ---- share kit -------------------------------------------------------------------------------------------------------------------
async function kit(orgId, surveyId, base) {
  const s = await ad(orgId).get(orgId, 'surveys', surveyId); if (!s) throw err(404, 'Unknown survey.'); const o = orgs.raw(orgId); const root = `${String(base).replace(/\/+$/, '')}/s.html?t=${encodeURIComponent(s.token)}`; const link = (src) => `${root}&src=${src}`; const text = `${o.name} would like your view: ${s.title} It takes about two minutes. No sign-in.`; const q = encodeURIComponent;
  const ch = (key, label, url, note) => ({ key, label, link: link(key), url, note });
  return { link: root, text, channels: [
    ch('facebook', 'Facebook', `https://www.facebook.com/sharer/sharer.php?u=${q(link('facebook'))}`),
    ch('x', 'X', `https://twitter.com/intent/tweet?text=${q(text)}&url=${q(link('x'))}`),
    ch('linkedin', 'LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${q(link('linkedin'))}`),
    ch('whatsapp', 'WhatsApp', `https://wa.me/?text=${q(text + ' ' + link('whatsapp'))}`),
    ch('telegram', 'Telegram', `https://t.me/share/url?url=${q(link('telegram'))}&text=${q(text)}`),
    ch('email', 'Email', `mailto:?subject=${q(s.title)}&body=${q(text + '\n\n' + link('email'))}`),
    ch('instagram', 'Instagram', null, 'Instagram has no share link. Put this link in your bio or a story link sticker.'),
    ch('tiktok', 'TikTok', null, 'TikTok has no share link. Put this link in your bio.')] };
}

// ---- insights: what the Coach and the bench can use ------------------------------------------------------------------------------
async function addInsight(orgId, actor, role, surveyId) {
  const o = orgs.raw(orgId); plans.assertWritable(o); if (!orgs.can(role, 'iterate')) throw err(403, 'Your role cannot add survey results to the design.');
  const r = await surveys.results(orgId, surveyId); const n = r.survey.responses; if (n < surveys.MIN_SHOWN) throw err(422, `Wait for at least ${surveys.MIN_SHOWN} answers first. There ${n === 1 ? 'is' : 'are'} ${n} so far.`);
  const lines = []; let winner = null;
  if (r.iterations) { const it = r.iterations; for (const x of it.options) { const a = x.all; lines.push(`${x.label} (${x.title}${x.scope === 'team' ? ', Team iteration' : ', by ' + x.by}): average rating ${a.average == null ? 'n/a' : a.average} of 5, preferred by ${a.prefer} of ${it.total} (${a.preferPct == null ? 0 : a.preferPct}%).`); }
    if (it.winner && !it.winner.none) { winner = { siteId: it.winner.siteId, iid: it.winner.iid, title: it.winner.title }; lines.unshift(`Most preferred: ${it.winner.option} "${it.winner.title}", ${it.winner.prefer} of ${it.winner.of} (${it.winner.pct}%).`); } else if (it.winner && it.winner.none) lines.unshift('Most people chose none of the options.'); lines.push(...it.notes); }
  else for (const q of r.questions) { if (q.hidden) continue; if (q.counts && q.type === 'choice') { const t = [...q.counts].sort((a, b) => b.count - a.count)[0]; lines.push(`${q.prompt} Most said "${t.option}" (${t.pct}% of ${q.answered}).`); } else if (q.average != null) lines.push(`${q.prompt} Average ${q.average}${q.median != null ? ', median ' + q.median : ''} (${q.answered} answers).`); }
  if (!lines.length) throw err(422, 'There is nothing to summarise yet.');
  const ins = { id: 'ins_' + surveyId, surveyId, title: r.survey.title, kind: r.survey.kind, at: iso(), by: actor.name, responses: n, lines, feeds: r.feeds || [], winner, bySource: r.bySource };
  await ad(orgId).put(orgId, 'wr_insights', ins.id, ins); await audit.log(orgId, actor, 'insight.add', { surveyId, responses: n });
  await workroom.coachNote(orgId, workroom.GENERAL, `Customer feedback added to the design considerations: "${ins.title}" (${n} answers).\n${lines.slice(0, 6).join('\n')}`); return ins;
}
const listInsights = async (orgId) => (await ad(orgId).list(orgId, 'wr_insights')).sort((a, b) => b.at.localeCompare(a.at));
async function removeInsight(orgId, role, id) { if (!orgs.can(role, 'iterate')) throw err(403, 'Your role cannot remove this.'); const x = await ad(orgId).get(orgId, 'wr_insights', id); if (!x) throw err(404, 'That is not here.'); await ad(orgId).del(orgId, 'wr_insights', id); return { ok: true }; }
module.exports = { create, analyse, kit, addInsight, listInsights, removeInsight, AUDIENCE };
