'use strict';
/** A private demo workspace anyone can open from the home page. It comes with sample data and runs, has tight limits, cannot send messages, and is deleted after 48 hours. */
const reg = require('./registry');
const orgs = require('./orgs');
const assets = require('./assets');
const engine = require('./engine');
const surveys = require('./surveys');
const packs = require('./packs');
const planOpts = require('./scenarios/planOptions');
const campaign = require('./scenarios/campaign');
const synthetic = require('./scenarios/synthetic');
const plans = require('./plans');
const { err, id } = require('./util');
const MAX_DEMOS = 150; const hits = new Map(); const HOURS = 48;
const demos = () => Object.values(reg.load().orgs).filter((o) => o.plan === 'demo');

async function sweep() { const now = Date.now(); let n = 0; for (const o of demos()) if (Date.parse(o.trialEndsAt) < now) { await orgs.removeOrg(o.id); n++; } return n; }
async function create(ip) {
  const now = Date.now(); const h = (hits.get(ip) || []).filter((t) => now - t < 3600000); if (h.length >= 6) throw err(429, 'You have opened several demos already. Please try again in an hour, or request an account.'); h.push(now); hits.set(ip, h);
  await sweep(); if (demos().length >= MAX_DEMOS) throw err(503, 'The demo is busy right now. Please request an account or try again later.');
  const tag = id('d').slice(2, 6).toUpperCase();
  const c = orgs.create({ name: `Demo workspace ${tag}`, sector: 'insurer', adminName: 'Demo visitor', adminEmail: `demo-${tag.toLowerCase()}@example.invalid`, plan: 'demo', trialDays: HOURS / 24 }, packs);
  const orgId = c.org.id; const memberId = c.admin.id; const actor = { id: memberId, name: 'Demo visitor', role: 'admin' };
  try {
    const prod = planOpts.DEFAULT_PRODUCT();
    const a = await assets.create(orgId, actor, { kind: 'product', name: 'Outpatient cover (sample)', data: prod, description: 'A sample plan with three member choices.', note: 'Current product' });
    const next = JSON.parse(JSON.stringify(prod)); next.options.push({ name: 'Choice: three chosen Tier 2 hospitals', tiers: ['T1', 'T2'], premiumAdjPct: -2 }); next.options = next.options.slice(1);
    await assets.addVersion(orgId, actor, a.id, { data: next, note: 'Try a "Choice" option with higher-tier hospitals' });
    await assets.create(orgId, actor, { kind: 'rule_set', name: 'Outpatient auto-approve rules (sample)', data: synthetic.defaultRules(), note: 'Starter rules' });
    await assets.create(orgId, actor, { kind: 'payment_plan', name: 'Early-pay tiers (sample)', data: engine.DEFAULT_PLAN, note: 'Starter tiers' });
    await assets.create(orgId, actor, { kind: 'campaign', name: 'Win-back offer (sample)', data: campaign.DEFAULT_CAMPAIGN(), note: 'Starter campaign' });
    await engine.run(orgId, actor, 'admin', { scenario: 'plan_options', name: 'Plan choices: first look', inputs: { product: { assetId: a.id, version: 1 } }, seed: 4 });
    await engine.run(orgId, actor, 'admin', { scenario: 'plan_options', name: 'Plan choices: with the new Choice option', inputs: { product: { assetId: a.id, version: 2 } }, seed: 4 });
    await engine.run(orgId, actor, 'admin', { scenario: 'adjudication_ladder', name: 'Claims ladder on sample claims', seed: 7, synthetic: { claims: 1200 } });
    const tpl = packs.get('insurer').surveyTemplates[0]; const s = await surveys.create(orgId, actor, { title: tpl.title, purpose: tpl.purpose, questions: tpl.questions }); const q = s.questions;
    for (let i = 0; i < 8; i++) await surveys.submit(s.token, { [q[0].id]: ['Local clinic or health centre', 'District or general hospital', 'Private or teaching hospital'][i % 3], [q[1].id]: i < 3 ? 'Yes' : i < 6 ? 'No' : 'Not sure', [q[2].id]: 15 + i * 3, [q[3].id]: 3 + (i % 3) }, `demo-${tag}`);
  } catch (e) { await orgs.removeOrg(orgId); throw e; }
  orgs.memberRaw(orgId, memberId).mustChange = false; return { sessionKey: orgs.openSession(orgId, memberId), expiresInHours: HOURS };
}
module.exports = { create, sweep, demos, MAX_DEMOS, HOURS };
