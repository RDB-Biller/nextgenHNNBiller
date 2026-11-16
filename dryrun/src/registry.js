'use strict';
/**
 * The registry holds the small, always-on-our-system records: organisations, their members, plan and storage choice, platform caps.
 * A client's working data (assets, runs, audit) is NOT here: it lives wherever the client's storage setting points.
 */
const fs = require('fs');
const path = require('path');
const FILE = () => path.join(process.env.DRYRUN_DATA_DIR || path.join(process.cwd(), 'data'), 'registry.json');
let mem = null;
const blank = () => ({ orgs: {}, config: { caps: { maxFreeOrgs: 25 }, defaults: { trialDays: 60, graceDays: 30 } } });
function load() {
  if (process.env.DRYRUN_MEMORY === '1') { if (!mem) mem = blank(); return mem; }
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { mem = blank(); }
  mem.config = { ...blank().config, ...mem.config, caps: { ...blank().config.caps, ...(mem.config || {}).caps }, defaults: { ...blank().config.defaults, ...(mem.config || {}).defaults } };
  return mem;
}
function save() { if (process.env.DRYRUN_MEMORY === '1') return; fs.mkdirSync(path.dirname(FILE()), { recursive: true }); const t = `${FILE()}.tmp`; fs.writeFileSync(t, JSON.stringify(mem)); fs.renameSync(t, FILE()); }
function reset() { mem = null; }
module.exports = { load, save, reset };
