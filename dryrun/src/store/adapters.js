'use strict';
/**
 * Storage adapters: where an organisation's working data (assets, runs, audit) lives.
 *   platform  - on our system (a folder on the Dry Run server, or Postgres when PLATFORM_DATABASE_URL is set)
 *   file      - a folder the customer controls (a mounted volume, for example)
 *   postgres  - a Postgres database the customer controls (connection string is stored encrypted)
 * All adapters offer the same small API, so moving an organisation between them is a copy and a check.
 */
const fs = require('fs');
const path = require('path');
const { err } = require('../util');

const safe = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');

class MemoryAdapter {
  constructor() { this.m = new Map(); this.kind = 'memory'; }
  _k(o, k) { const key = `${o}/${k}`; if (!this.m.has(key)) this.m.set(key, new Map()); return this.m.get(key); }
  async ping() { return true; }
  async list(o, k) { return [...this._k(o, k).values()]; }
  async get(o, k, i) { return this._k(o, k).get(i) || null; }
  async put(o, k, i, d) { this._k(o, k).set(i, d); return d; }
  async del(o, k, i) { this._k(o, k).delete(i); }
  async kinds(o) { return [...this.m.keys()].filter((x) => x.startsWith(`${o}/`)).map((x) => x.slice(o.length + 1)); }
  async purge(o) { for (const k of [...this.m.keys()]) if (k.startsWith(`${o}/`)) this.m.delete(k); }
}

class FileAdapter {
  constructor(dir) { this.dir = dir; this.kind = 'file'; }
  _d(o, k) { return path.join(this.dir, safe(o), safe(k)); }
  async ping() { fs.mkdirSync(this.dir, { recursive: true }); const t = path.join(this.dir, '.ping'); fs.writeFileSync(t, String(Date.now())); fs.unlinkSync(t); return true; }
  async list(o, k) { const d = this._d(o, k); if (!fs.existsSync(d)) return []; return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); }
  async get(o, k, i) { const f = path.join(this._d(o, k), `${safe(i)}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
  async put(o, k, i, doc) { const d = this._d(o, k); fs.mkdirSync(d, { recursive: true }); const f = path.join(d, `${safe(i)}.json`); const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(doc)); fs.renameSync(t, f); return doc; }
  async del(o, k, i) { const f = path.join(this._d(o, k), `${safe(i)}.json`); if (fs.existsSync(f)) fs.unlinkSync(f); }
  async kinds(o) { const d = path.join(this.dir, safe(o)); return fs.existsSync(d) ? fs.readdirSync(d).filter((x) => fs.statSync(path.join(d, x)).isDirectory()) : []; }
  async purge(o) { fs.rmSync(path.join(this.dir, safe(o)), { recursive: true, force: true }); }
}

const pools = new Map();
class PgAdapter {
  constructor(url, ssl) { this.url = url; this.kind = 'postgres'; this.ssl = !!ssl; this.ready = null; }
  _pool() {
    let pg; try { pg = require('pg'); } catch { throw err(501, 'Postgres support is not installed on this server (npm install pg).'); }
    const k = `${this.url}|${this.ssl}`;
    if (!pools.has(k)) pools.set(k, new pg.Pool({ connectionString: this.url, max: 4, ssl: this.ssl ? { rejectUnauthorized: false } : false }));
    return pools.get(k);
  }
  async _init() { if (!this.ready) this.ready = this._pool().query('CREATE TABLE IF NOT EXISTS dr_docs (org_id text, kind text, id text, data jsonb NOT NULL, PRIMARY KEY (org_id, kind, id))'); return this.ready; }
  async ping() { await this._init(); await this._pool().query('SELECT 1'); return true; }
  async list(o, k) { await this._init(); return (await this._pool().query('SELECT data FROM dr_docs WHERE org_id=$1 AND kind=$2', [o, k])).rows.map((r) => r.data); }
  async get(o, k, i) { await this._init(); const r = await this._pool().query('SELECT data FROM dr_docs WHERE org_id=$1 AND kind=$2 AND id=$3', [o, k, i]); return r.rows[0] ? r.rows[0].data : null; }
  async put(o, k, i, d) { await this._init(); await this._pool().query('INSERT INTO dr_docs(org_id,kind,id,data) VALUES($1,$2,$3,$4) ON CONFLICT (org_id,kind,id) DO UPDATE SET data=EXCLUDED.data', [o, k, i, JSON.stringify(d)]); return d; }
  async del(o, k, i) { await this._init(); await this._pool().query('DELETE FROM dr_docs WHERE org_id=$1 AND kind=$2 AND id=$3', [o, k, i]); }
  async kinds(o) { await this._init(); return (await this._pool().query('SELECT DISTINCT kind FROM dr_docs WHERE org_id=$1', [o])).rows.map((r) => r.kind); }
  async purge(o) { await this._init(); await this._pool().query('DELETE FROM dr_docs WHERE org_id=$1', [o]); }
}
module.exports = { MemoryAdapter, FileAdapter, PgAdapter };
