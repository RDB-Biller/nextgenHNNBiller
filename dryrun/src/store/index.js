'use strict';
const path = require('path');
const { MemoryAdapter, FileAdapter, PgAdapter } = require('./adapters');
const secret = require('../secret');
const { err } = require('../util');

const DATA_DIR = () => process.env.DRYRUN_DATA_DIR || path.join(process.cwd(), 'data');
let platformAdapter = null;
function platform() {
  if (platformAdapter) return platformAdapter;
  if (process.env.DRYRUN_MEMORY === '1') platformAdapter = new MemoryAdapter();
  else if (process.env.PLATFORM_DATABASE_URL) platformAdapter = new PgAdapter(process.env.PLATFORM_DATABASE_URL, process.env.PGSSL === 'true');
  else platformAdapter = new FileAdapter(path.join(DATA_DIR(), 'orgdata'));
  return platformAdapter;
}
function reset() { platformAdapter = null; }

/** Build the adapter for a storage config: {kind:'platform'} | {kind:'file', dir} | {kind:'postgres', sealed, ssl}. */
function build(cfg) {
  const c = cfg || { kind: 'platform' };
  if (c.kind === 'platform') return platform();
  if (c.kind === 'file') { if (!c.dir) throw err(422, 'A folder path is required.'); return new FileAdapter(c.dir); }
  if (c.kind === 'postgres') { if (!c.sealed) throw err(422, 'A connection string is required.'); return new PgAdapter(secret.open(c.sealed).url, c.ssl); }
  throw err(422, 'Unknown storage kind. Use platform, file or postgres.');
}
/** Turn what a client submits into a stored config (credentials are encrypted). */
function toConfig(input) {
  const k = input && input.kind;
  if (k === 'platform') return { kind: 'platform' };
  if (k === 'file') return { kind: 'file', dir: String(input.dir || '').trim() };
  if (k === 'postgres') { if (!input.url) throw err(422, 'A connection string is required.'); return { kind: 'postgres', sealed: secret.seal({ url: String(input.url) }), ssl: !!input.ssl }; }
  throw err(422, 'Unknown storage kind. Use platform, file or postgres.');
}
const describe = (cfg) => { const c = cfg || { kind: 'platform' }; return c.kind === 'file' ? { kind: 'file', dir: c.dir } : c.kind === 'postgres' ? { kind: 'postgres', ssl: !!c.ssl, connection: 'stored encrypted' } : { kind: 'platform' }; };

/** Copy every document from the current location to a new one, verify, and return a report. The caller then switches the org over. */
async function migrate(orgId, fromCfg, toCfg) {
  const from = build(fromCfg), to = build(toCfg);
  if (from === to) throw err(422, 'That is already where the data is stored.');
  await to.ping();
  const report = {};
  for (const kind of await from.kinds(orgId)) {
    const docs = await from.list(orgId, kind);
    for (const d of docs) await to.put(orgId, kind, d.id, d);
    const check = await to.list(orgId, kind);
    if (check.length < docs.length) throw err(500, `Copy check failed for ${kind}: ${check.length} of ${docs.length} arrived. Nothing was changed.`);
    report[kind] = docs.length;
  }
  return { report, done: async () => { await from.purge(orgId); } };
}
module.exports = { platform, build, toConfig, describe, migrate, reset };
