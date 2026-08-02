'use strict';

/**
 * Provision API access for a partner: generates a key and inserts the record into
 * the database, then prints the credentials to hand over.
 *
 * Run against your deployed DB (uses DATABASE_URL). On Railway:
 *   railway run node scripts/provision.js list
 *   railway run node scripts/provision.js tenant   --name "City Clinic" --account 300591:0123456789 --email billing@city.example
 *   railway run node scripts/provision.js payer     --name "NHIS" --kind insurer --source 1300100999 --email claims@nhis.gov.gh
 *   railway run node scripts/provision.js payer     --name "Acme Ltd" --kind employer --source 1300100500 --email hr@acme.example
 *   railway run node scripts/provision.js financier --name "QuickLoan" --product momo_loan --source 1400200999 --email loans@quick.example
 *
 * Locally you can point at any DB with:  DATABASE_URL=... node scripts/provision.js list
 */
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (run via `railway run` or set it locally).');
  process.exit(1);
}
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i++; }
    else out._.push(argv[i]);
  }
  return out;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24);
const rand = () => crypto.randomBytes(6).toString('hex');

async function upsert(table, row) {
  await pool.query(
    `INSERT INTO ${table} (id, api_key, data) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET api_key=EXCLUDED.api_key, data=EXCLUDED.data`,
    [row.id, row.apiKey, row]);
}

function banner(role, name, key, header, extra = '') {
  console.log('\n──────────── API ACCESS PROVISIONED ────────────');
  console.log(`Role     : ${role}`);
  console.log(`Name     : ${name}`);
  console.log(`Auth     : header  ${header}: ${key}`);
  if (extra) console.log(extra);
  console.log('Base URL : set to your Railway domain, e.g. https://<your-app>.up.railway.app');
  console.log('Hand the partner: their key + the Partner Integration Guide + openapi.yaml');
  console.log('────────────────────────────────────────────────\n');
}

(async () => {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];

  if (cmd === 'list') {
    for (const t of ['tenants', 'payers', 'financiers']) {
      const { rows } = await pool.query(`SELECT id, api_key, data->>'name' AS name FROM ${t} ORDER BY id`);
      console.log(`\n${t}:`);
      rows.forEach((r) => console.log(`  ${r.id.padEnd(24)} ${(r.name || '').padEnd(28)} ${r.api_key || ''}`));
    }
  } else if (cmd === 'tenant') {
    const id = a.id || `tenant_${slug(a.name)}`;
    const key = `emr_${slug(a.name)}_${rand()}`;
    const [src, acct] = String(a.account || ':').split(':');
    const row = { id, apiKey: key, name: a.name,
      receivingAccount: { serviceRoutingCode: src || null, beneficiaryAccount: acct || null },
      contact: { email: a.email || null, phone: a.phone || null } };
    await upsert('tenants', row);
    banner('Clinic / Hospital (Billing API)', a.name, key, 'x-api-key');
  } else if (cmd === 'payer') {
    const id = a.id || slug(a.name);
    const key = `payer_${slug(a.name)}_${rand()}`;
    const row = { id, apiKey: key, name: a.name, kind: a.kind || 'insurer',
      contact: { email: a.email || null }, sbg: { sourceAccount: a.source || null } };
    await upsert('payers', row);
    banner(`Payer (${row.kind}) — Payer API`, a.name, key, 'x-payer-key');
  } else if (cmd === 'financier') {
    const id = a.id || slug(a.name);
    const key = `fin_${slug(a.name)}_${rand()}`;
    const row = { id, apiKey: key, name: a.name, kind: a.kind || 'lender', product: a.product || 'momo_loan',
      integration: a.integration || 'a2a', reportKind: a['report-kind'] || (a.product === 'bank_loan' ? 'detailed' : 'micro'),
      url: a.url || null, terms: a.terms ? { note: a.terms } : null,
      contact: { email: a.email || null }, sbg: { sourceAccount: a.source || null } };
    await upsert('financiers', row);
    banner(`Financier (${row.product})`, a.name, key, '(internal financier id)', `Financier id: ${id}`);
  } else {
    console.log('Usage: node scripts/provision.js <list|tenant|payer|financier> [--name ...] [--account RC:ACCT] [--kind ...] [--source ...] [--product ...] [--email ...]');
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
