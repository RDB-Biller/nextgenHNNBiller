'use strict';

/**
 * Async repository. Two interchangeable backends behind one API:
 *   - Postgres (when DATABASE_URL is set) — survives restarts, scales to many instances.
 *   - In-memory (otherwise) — zero-infra local/demo, used by the test harness.
 *
 * Domain objects keep their exact shape; queryable fields are mirrored into
 * columns, the whole object lives in a JSONB `data` column. Money-moving paths
 * use tx() with row locks (FOR UPDATE) in Postgres to stay correct across instances.
 */
const seed = require('./seed');

const usePg = !!process.env.DATABASE_URL;
let pool = null;

// ----------------------------------------------------------------------------
// Postgres backend
// ----------------------------------------------------------------------------
function pgInit() {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (id text PRIMARY KEY, api_key text UNIQUE, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS payers (id text PRIMARY KEY, api_key text UNIQUE, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS financiers (id text PRIMARY KEY, api_key text, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS bills (id text PRIMARY KEY, tenant_id text, status text, created_at timestamptz DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS claims (id text PRIMARY KEY, tenant_id text, payer_id text, status text, token text UNIQUE, created_at timestamptz DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS payments (id text PRIMARY KEY, bill_id text, status text, created_at timestamptz DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS financings (id text PRIMARY KEY, tenant_id text, bill_id text, status text, created_at timestamptz DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id text PRIMARY KEY, tenant_id text, bill_id text, share_token text UNIQUE, created_at timestamptz DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (id text PRIMARY KEY, bill_id text, created_at timestamptz DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS ledger (id text PRIMARY KEY, tenant_id text, bill_id text, type text, amount numeric, currency text, cash_movement boolean, created_at timestamptz DEFAULT now(), data jsonb NOT NULL);
ALTER TABLE IF EXISTS payers ADD COLUMN IF NOT EXISTS tenant_id text;
CREATE INDEX IF NOT EXISTS idx_payers_tenant ON payers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_type, org_id);
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS edition text;
CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, api_key text UNIQUE, role text, org_type text, org_id text, status text, created_at timestamptz DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS licenses (key text PRIMARY KEY, edition text, status text, org_id text, created_at timestamptz DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS emr_partners (id text PRIMARY KEY, api_key text UNIQUE, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS networks (id text PRIMARY KEY, payer_id text, tenant_id text, status text, updated_at timestamptz DEFAULT now(), data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS idx_networks_payer ON networks(payer_id);
CREATE INDEX IF NOT EXISTS idx_networks_tenant ON networks(tenant_id);
CREATE TABLE IF NOT EXISTS pricing_rules (id text PRIMARY KEY, tenant_id text, type text, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS claimit (id text PRIMARY KEY, tenant_id text, bill_id text, status text, created_at timestamptz DEFAULT now(), data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency_keys (scope text, key text, request_hash text, status text, response_status int, response_body jsonb, created_at timestamptz DEFAULT now(), PRIMARY KEY (scope, key));
CREATE INDEX IF NOT EXISTS idx_bills_tenant ON bills(tenant_id);
CREATE INDEX IF NOT EXISTS idx_claims_tenant ON claims(tenant_id);
CREATE INDEX IF NOT EXISTS idx_claims_payer ON claims(payer_id);
CREATE INDEX IF NOT EXISTS idx_notifications_bill ON notifications(bill_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON ledger(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_bill ON ledger(bill_id);
CREATE INDEX IF NOT EXISTS idx_pricing_tenant ON pricing_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_claimit_tenant ON claimit(tenant_id);
`;

// Build a repo whose queries run through `exec` (the pool, or a tx client).
function pgRepo(exec) {
  const one = async (text, params) => (await exec(text, params)).rows[0]?.data || null;
  const many = async (text, params) => (await exec(text, params)).rows.map((r) => r.data);
  const upsert = (table, cols) => {
    const names = ['id', ...cols, 'data'];
    const ph = names.map((_, i) => `$${i + 1}`).join(', ');
    const set = [...cols, 'data'].map((c) => `${c}=EXCLUDED.${c}`).join(', ');
    return `INSERT INTO ${table} (${names.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO UPDATE SET ${set}`;
  };

  return {
    tenants: {
      byApiKey: (k) => one('SELECT data FROM tenants WHERE api_key=$1', [k]),
      get: (id) => one('SELECT data FROM tenants WHERE id=$1', [id]),
      all: () => many('SELECT data FROM tenants', []),
      save: (o) => exec(upsert('tenants', ['api_key', 'edition']), [o.id, o.apiKey, o.edition || null, o]),
    },
    payers: {
      byApiKey: (k) => one('SELECT data FROM payers WHERE api_key=$1', [k]),
      get: (id) => one('SELECT data FROM payers WHERE id=$1', [id]),
      all: () => many('SELECT data FROM payers', []),
      // Global payers (tenant_id NULL) plus this facility's own programmed slots.
      listForTenant: (t) => many('SELECT data FROM payers WHERE tenant_id IS NULL OR tenant_id=$1', [t]),
      listSlots: (t) => many('SELECT data FROM payers WHERE tenant_id=$1', [t]),
      save: (o) => exec(upsert('payers', ['api_key', 'tenant_id']), [o.id, o.apiKey, o.tenantId || null, o]),
    },
    financiers: {
      byApiKey: (k) => one('SELECT data FROM financiers WHERE api_key=$1', [k]),
      get: (id) => one('SELECT data FROM financiers WHERE id=$1', [id]),
      save: (o) => exec(upsert('financiers', ['api_key']), [o.id, o.apiKey || null, o]),
    },
    bills: {
      get: (id, o = {}) => one(`SELECT data FROM bills WHERE id=$1${o.forUpdate ? ' FOR UPDATE' : ''}`, [id]),
      insert: (b) => exec(upsert('bills', ['tenant_id', 'status']), [b.id, b.tenantId, b.status, b]),
      update: (b) => exec(upsert('bills', ['tenant_id', 'status']), [b.id, b.tenantId, b.status, b]),
      listByTenant: (t) => many('SELECT data FROM bills WHERE tenant_id=$1 ORDER BY created_at', [t]),
    },
    claims: {
      get: (id, o = {}) => one(`SELECT data FROM claims WHERE id=$1${o.forUpdate ? ' FOR UPDATE' : ''}`, [id]),
      byToken: (t) => one('SELECT data FROM claims WHERE token=$1', [t]),
      insert: (c) => exec(upsert('claims', ['tenant_id', 'payer_id', 'status', 'token']), [c.id, c.tenantId, c.payerId, c.status, c.token, c]),
      update: (c) => exec(upsert('claims', ['tenant_id', 'payer_id', 'status', 'token']), [c.id, c.tenantId, c.payerId, c.status, c.token, c]),
      listByTenant: (t) => many('SELECT data FROM claims WHERE tenant_id=$1 ORDER BY created_at', [t]),
      listByPayer: (p) => many('SELECT data FROM claims WHERE payer_id=$1 ORDER BY created_at', [p]),
      all: (limit = 500) => many('SELECT data FROM claims ORDER BY created_at DESC LIMIT $1', [limit]),
      byStatus: (st, limit = 500) => many('SELECT data FROM claims WHERE status=$1 ORDER BY created_at DESC LIMIT $2', [st, limit]),
    },
    payments: {
      get: (id) => one('SELECT data FROM payments WHERE id=$1', [id]),
      insert: (p) => exec(upsert('payments', ['bill_id', 'status']), [p.id, p.billId, p.status, p]),
      update: (p) => exec(upsert('payments', ['bill_id', 'status']), [p.id, p.billId, p.status, p]),
    },
    financings: {
      get: (id) => one('SELECT data FROM financings WHERE id=$1', [id]),
      insert: (f) => exec(upsert('financings', ['tenant_id', 'bill_id', 'status']), [f.id, f.tenantId, f.billId, f.status, f]),
      update: (f) => exec(upsert('financings', ['tenant_id', 'bill_id', 'status']), [f.id, f.tenantId, f.billId, f.status, f]),
    },
    reports: {
      get: (id) => one('SELECT data FROM reports WHERE id=$1', [id]),
      byToken: (t) => one('SELECT data FROM reports WHERE share_token=$1', [t]),
      insert: (r) => exec(upsert('reports', ['tenant_id', 'bill_id', 'share_token']), [r.id, r.tenantId, r.billId, r.shareToken, r]),
    },
    notifications: {
      insert: (n) => exec(upsert('notifications', ['bill_id']), [n.id, n.billId, n]),
      listByTenant: (t) => many(
        'SELECT n.data FROM notifications n JOIN bills b ON b.id = n.bill_id WHERE b.tenant_id=$1 ORDER BY n.created_at', [t]),
    },
    settings: {
      get: (k) => one('SELECT data FROM settings WHERE key=$1', [k]),
      set: (k, v) => exec('INSERT INTO settings (key,data) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()', [k, v]),
    },
    networks: {
      get: (payerId, tenantId) => one('SELECT data FROM networks WHERE id=$1', [`${payerId}:${tenantId}`]),
      listByPayer: (p) => many('SELECT data FROM networks WHERE payer_id=$1 ORDER BY updated_at DESC', [p]),
      listByTenant: (t) => many('SELECT data FROM networks WHERE tenant_id=$1', [t]),
      save: (n) => exec(
        `INSERT INTO networks (id,payer_id,tenant_id,status,data) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, data=EXCLUDED.data, updated_at=now()`,
        [`${n.payerId}:${n.tenantId}`, n.payerId, n.tenantId, n.status, n]),
    },
    users: {
      byApiKey: (k) => one('SELECT data FROM users WHERE api_key=$1', [k]),
      get: (id) => one('SELECT data FROM users WHERE id=$1', [id]),
      all: () => many('SELECT data FROM users ORDER BY created_at DESC', []),
      listByOrg: (t, o) => many('SELECT data FROM users WHERE org_type=$1 AND org_id=$2', [t, o]),
      save: (u) => exec(
        `INSERT INTO users (id,api_key,role,org_type,org_id,status,data) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET api_key=EXCLUDED.api_key, role=EXCLUDED.role,
           org_type=EXCLUDED.org_type, org_id=EXCLUDED.org_id, status=EXCLUDED.status, data=EXCLUDED.data`,
        [u.id, u.apiKey, u.role, u.orgType, u.orgId, u.status, u]),
    },
    licenses: {
      get: (k) => one('SELECT data FROM licenses WHERE key=$1', [k]),
      all: () => many('SELECT data FROM licenses ORDER BY created_at DESC', []),
      save: (l) => exec(
        `INSERT INTO licenses (key,edition,status,org_id,data) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET edition=EXCLUDED.edition, status=EXCLUDED.status,
           org_id=EXCLUDED.org_id, data=EXCLUDED.data`,
        [l.key, l.edition, l.status, l.orgId || null, l]),
    },
    emrPartners: {
      byApiKey: (k) => one('SELECT data FROM emr_partners WHERE api_key=$1', [k]),
      get: (id) => one('SELECT data FROM emr_partners WHERE id=$1', [id]),
      all: () => many('SELECT data FROM emr_partners', []),
      save: (p) => exec(
        `INSERT INTO emr_partners (id,api_key,data) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET api_key=EXCLUDED.api_key, data=EXCLUDED.data`,
        [p.id, p.apiKey, p]),
    },
    pricing: {
      get: (tenantId, type) => one('SELECT data FROM pricing_rules WHERE id=$1', [`${tenantId}:${type}`]),
      listByTenant: (t) => many('SELECT data FROM pricing_rules WHERE tenant_id=$1 ORDER BY type', [t]),
      save: (r) => exec(
        `INSERT INTO pricing_rules (id,tenant_id,type,data) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, type=EXCLUDED.type, data=EXCLUDED.data`,
        [`${r.tenantId}:${r.type}`, r.tenantId, r.type, r]),
    },
    claimit: {
      get: (id) => one('SELECT data FROM claimit WHERE id=$1', [id]),
      insert: (c) => exec(
        `INSERT INTO claimit (id,tenant_id,bill_id,status,data) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, data=EXCLUDED.data`,
        [c.id, c.tenantId, c.billId, c.status, c]),
      update: (c) => exec(
        `INSERT INTO claimit (id,tenant_id,bill_id,status,data) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, data=EXCLUDED.data`,
        [c.id, c.tenantId, c.billId, c.status, c]),
      listByTenant: (t) => many('SELECT data FROM claimit WHERE tenant_id=$1 ORDER BY created_at DESC', [t]),
      byClaimNumber: (t, num) => one("SELECT data FROM claimit WHERE tenant_id=$1 AND data->>'nhisClaimNumber'=$2", [t, num]),
    },
    // Append-only money ledger (no UPDATE/DELETE — corrections are new entries).
    ledger: {
      insert: (e) => exec(
        'INSERT INTO ledger (id,tenant_id,bill_id,type,amount,currency,cash_movement,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [e.id, e.tenantId, e.billId, e.type, e.amount, e.currency, e.cashMovement, e]),
      listByTenant: (t, limit = 100) => many('SELECT data FROM ledger WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2', [t, limit]),
      listByBill: (b) => many('SELECT data FROM ledger WHERE bill_id=$1 ORDER BY created_at', [b]),
      all: (limit = 5000) => many('SELECT data FROM ledger ORDER BY created_at DESC LIMIT $1', [limit]),
      revenueAll: async () => (await exec(
        `SELECT tenant_id, type, count(*)::int AS n, COALESCE(SUM(amount),0) AS total
         FROM ledger WHERE type LIKE 'platform_fee_%' GROUP BY tenant_id, type`, [])).rows,
      summary: async (t) => (await exec(
        'SELECT type, count(*)::int AS n, COALESCE(SUM(amount) FILTER (WHERE cash_movement),0) AS cash, COALESCE(SUM(amount),0) AS total FROM ledger WHERE tenant_id=$1 GROUP BY type', [t])).rows,
    },
    idempotency: {
      begin: async (scope, key, hash) => {
        const ins = await exec(
          "INSERT INTO idempotency_keys (scope,key,request_hash,status) VALUES ($1,$2,$3,'in_progress') ON CONFLICT (scope,key) DO NOTHING", [scope, key, hash]);
        if (ins.rowCount > 0) return { claimed: true };
        const ex = await exec('SELECT request_hash,status,response_status,response_body FROM idempotency_keys WHERE scope=$1 AND key=$2', [scope, key]);
        return { claimed: false, existing: ex.rows[0] };
      },
      complete: (scope, key, status, body) => exec(
        "UPDATE idempotency_keys SET status='completed', response_status=$3, response_body=$4 WHERE scope=$1 AND key=$2", [scope, key, status, body]),
      release: (scope, key) => exec('DELETE FROM idempotency_keys WHERE scope=$1 AND key=$2', [scope, key]),
    },
  };
}

async function pgTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(pgRepo((t, p) => client.query(t, p)));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------------
// In-memory backend (single process)
// ----------------------------------------------------------------------------
function memRepo(M) {
  const list = (map, pred) => [...map.values()].filter(pred);
  return {
    tenants: {
      byApiKey: async (k) => list(M.tenants, (t) => t.apiKey === k)[0] || null,
      get: async (id) => M.tenants.get(id) || null,
      all: async () => [...M.tenants.values()],
      save: async (o) => M.tenants.set(o.id, o),
    },
    payers: {
      byApiKey: async (k) => list(M.payers, (p) => p.apiKey === k)[0] || null,
      get: async (id) => M.payers.get(id) || null,
      all: async () => [...M.payers.values()],
      listForTenant: async (t) => list(M.payers, (p) => !p.tenantId || p.tenantId === t),
      listSlots: async (t) => list(M.payers, (p) => p.tenantId === t),
      save: async (o) => M.payers.set(o.id, o),
    },
    financiers: {
      byApiKey: async (k) => list(M.financiers, (f) => f.apiKey === k)[0] || null,
      get: async (id) => M.financiers.get(id) || null,
      save: async (o) => M.financiers.set(o.id, o),
    },
    bills: {
      get: async (id) => M.bills.get(id) || null,
      insert: async (b) => M.bills.set(b.id, b),
      update: async (b) => M.bills.set(b.id, b),
      listByTenant: async (t) => list(M.bills, (b) => b.tenantId === t),
    },
    claims: {
      get: async (id) => M.claims.get(id) || null,
      byToken: async (t) => M.claims.get(M.claimTokens.get(t)) || null,
      insert: async (c) => { M.claims.set(c.id, c); if (c.token) M.claimTokens.set(c.token, c.id); },
      update: async (c) => M.claims.set(c.id, c),
      listByTenant: async (t) => list(M.claims, (c) => c.tenantId === t),
      listByPayer: async (p) => list(M.claims, (c) => c.payerId === p),
      all: async (limit = 500) => [...M.claims.values()].reverse().slice(0, limit),
      byStatus: async (st, limit = 500) => [...M.claims.values()].reverse().filter((c) => c.status === st).slice(0, limit),
    },
    payments: {
      get: async (id) => M.payments.get(id) || null,
      insert: async (p) => M.payments.set(p.id, p),
      update: async (p) => M.payments.set(p.id, p),
    },
    financings: {
      get: async (id) => M.financings.get(id) || null,
      insert: async (f) => M.financings.set(f.id, f),
      update: async (f) => M.financings.set(f.id, f),
    },
    reports: {
      get: async (id) => M.reports.get(id) || null,
      byToken: async (t) => M.reports.get(M.reportTokens.get(t)) || null,
      insert: async (r) => { M.reports.set(r.id, r); if (r.shareToken) M.reportTokens.set(r.shareToken, r.id); },
    },
    notifications: {
      insert: async (n) => { M.notifications.push(n); },
      listByTenant: async (t) => {
        const ids = new Set(list(M.bills, (b) => b.tenantId === t).map((b) => b.id));
        return M.notifications.filter((n) => ids.has(n.billId));
      },
    },
    settings: {
      get: async (k) => M.settings.get(k) || null,
      set: async (k, v) => M.settings.set(k, v),
    },
    networks: {
      get: async (payerId, tenantId) => M.networks.get(`${payerId}:${tenantId}`) || null,
      listByPayer: async (p) => [...M.networks.values()].filter((n) => n.payerId === p),
      listByTenant: async (t) => [...M.networks.values()].filter((n) => n.tenantId === t),
      save: async (n) => M.networks.set(`${n.payerId}:${n.tenantId}`, n),
    },
    users: {
      byApiKey: async (k) => list(M.users, (u) => u.apiKey === k)[0] || null,
      get: async (id) => M.users.get(id) || null,
      all: async () => [...M.users.values()].reverse(),
      listByOrg: async (t, o) => list(M.users, (u) => u.orgType === t && u.orgId === o),
      save: async (u) => M.users.set(u.id, u),
    },
    licenses: {
      get: async (k) => M.licenses.get(k) || null,
      all: async () => [...M.licenses.values()].reverse(),
      save: async (l) => M.licenses.set(l.key, l),
    },
    emrPartners: {
      byApiKey: async (k) => list(M.emrPartners, (p) => p.apiKey === k)[0] || null,
      get: async (id) => M.emrPartners.get(id) || null,
      all: async () => [...M.emrPartners.values()],
      save: async (p) => M.emrPartners.set(p.id, p),
    },
    pricing: {
      get: async (tenantId, type) => M.pricing.get(`${tenantId}:${type}`) || null,
      listByTenant: async (t) => [...M.pricing.values()].filter((r) => r.tenantId === t),
      save: async (r) => M.pricing.set(`${r.tenantId}:${r.type}`, r),
    },
    claimit: {
      get: async (id) => M.claimit.get(id) || null,
      insert: async (c) => M.claimit.set(c.id, c),
      update: async (c) => M.claimit.set(c.id, c),
      listByTenant: async (t) => [...M.claimit.values()].filter((c) => c.tenantId === t).reverse(),
      byClaimNumber: async (t, num) =>
        [...M.claimit.values()].find((c) => c.tenantId === t && c.nhisClaimNumber && c.nhisClaimNumber === num) || null,
    },
    ledger: {
      insert: async (e) => { M.ledger.push(e); },
      listByTenant: async (t, limit = 100) => M.ledger.filter((e) => e.tenantId === t).slice(-limit).reverse(),
      listByBill: async (b) => M.ledger.filter((e) => e.billId === b),
      all: async (limit = 5000) => [...M.ledger].reverse().slice(0, limit),
      revenueAll: async () => {
        const out = {};
        for (const e of M.ledger) {
          if (!String(e.type).startsWith('platform_fee_')) continue;
          const k = `${e.tenantId}|${e.type}`;
          (out[k] = out[k] || { tenant_id: e.tenantId, type: e.type, n: 0, total: 0 });
          out[k].n++; out[k].total += Number(e.amount);
        }
        return Object.values(out);
      },
      summary: async (t) => {
        const by = {};
        for (const e of M.ledger.filter((x) => x.tenantId === t)) {
          const g = by[e.type] || (by[e.type] = { type: e.type, n: 0, cash: 0, total: 0 });
          g.n++; g.total += e.amount; if (e.cashMovement) g.cash += e.amount;
        }
        return Object.values(by);
      },
    },
    idempotency: {
      begin: async (scope, key, hash) => {
        const k = `${scope}\u0000${key}`;
        if (M.idem.has(k)) return { claimed: false, existing: M.idem.get(k) };
        M.idem.set(k, { request_hash: hash, status: 'in_progress', response_status: null, response_body: null });
        return { claimed: true };
      },
      complete: async (scope, key, status, body) => {
        const r = M.idem.get(`${scope}\u0000${key}`);
        if (r) { r.status = 'completed'; r.response_status = status; r.response_body = body; }
      },
      release: async (scope, key) => { M.idem.delete(`${scope}\u0000${key}`); },
    },
  };
}

// A trivial async mutex so tx() bodies don't interleave in the single-process
// memory backend (Postgres uses real row locks instead).
function makeMutex() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(() => fn());
    chain = run.catch(() => {});
    return run;
  };
}

// ----------------------------------------------------------------------------
// Wire up the chosen backend
// ----------------------------------------------------------------------------
let repo, tx, init;

if (usePg) {
  pgInit();
  repo = pgRepo((t, p) => pool.query(t, p));
  tx = pgTx;
  init = async () => {
    await pool.query(SCHEMA);
    await seedInto(repo);
    console.log('Store: PostgreSQL (persistent)');
  };
} else {
  const M = {
    tenants: new Map(), payers: new Map(), financiers: new Map(),
    bills: new Map(), claims: new Map(), claimTokens: new Map(),
    payments: new Map(), financings: new Map(),
    reports: new Map(), reportTokens: new Map(), notifications: [],
    ledger: [], idem: new Map(), pricing: new Map(), claimit: new Map(),
    users: new Map(), licenses: new Map(), emrPartners: new Map(), networks: new Map(), settings: new Map(),
  };
  repo = memRepo(M);
  const mutex = makeMutex();
  tx = (fn) => mutex(() => fn(repo)); // same repo, serialized
  init = async () => { await seedInto(repo); console.log('Store: in-memory (non-persistent)'); };
}

async function seedInto(r) {
  for (const t of seed.tenants) if (!(await r.tenants.get(t.id))) await r.tenants.save(t);
  for (const p of seed.payers) if (!(await r.payers.get(p.id))) await r.payers.save(p);
  for (const f of seed.financiers) if (!(await r.financiers.get(f.id))) await r.financiers.save(f);
}

module.exports = {
  ...repo, tx, init,
  get pool() { return pool; },
};
