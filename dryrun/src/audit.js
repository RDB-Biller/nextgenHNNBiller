'use strict';
const store = require('./store');
const orgs = require('./orgs');
const { iso, id } = require('./util');
const adapter = (orgId) => store.build(orgs.raw(orgId).storage);
async function log(orgId, actor, action, detail) {
  const entry = { id: `${Date.now().toString().padStart(14, '0')}_${id('a')}`, at: iso(), by: actor ? { id: actor.id, name: actor.name, role: actor.role } : { name: 'platform owner', role: 'platform' }, action, detail: detail || {} };
  await adapter(orgId).put(orgId, 'audit', entry.id, entry); return entry;
}
async function list(orgId, limit = 200) { return (await adapter(orgId).list(orgId, 'audit')).sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit); }
module.exports = { log, list, adapter };
