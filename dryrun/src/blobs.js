'use strict';
/** Uploaded files, kept on the server's data volume (in memory under tests). Never executed, never served inline. */
const fs = require('fs');
const path = require('path');
const mem = new Map();
const dir = (orgId) => path.join(process.env.DRYRUN_DATA_DIR || path.join(process.cwd(), 'data'), 'uploads', String(orgId).replace(/[^a-z0-9_]/gi, ''));
const safe = (id) => String(id).replace(/[^a-z0-9_]/gi, '');
function put(orgId, id, buf) { if (process.env.DRYRUN_MEMORY === '1') { mem.set(orgId + '/' + id, buf); return; } fs.mkdirSync(dir(orgId), { recursive: true }); fs.writeFileSync(path.join(dir(orgId), safe(id)), buf); }
function get(orgId, id) { if (process.env.DRYRUN_MEMORY === '1') return mem.get(orgId + '/' + id) || null; try { return fs.readFileSync(path.join(dir(orgId), safe(id))); } catch { return null; } }
function del(orgId, id) { if (process.env.DRYRUN_MEMORY === '1') { mem.delete(orgId + '/' + id); return; } try { fs.unlinkSync(path.join(dir(orgId), safe(id))); } catch { /* already gone */ } }
module.exports = { put, get, del };
