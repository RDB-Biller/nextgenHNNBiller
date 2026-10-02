'use strict';

const crypto = require('crypto');
const store = require('../store');

/**
 * Editions — one deployment, many clients, each on its own edition.
 *
 *  non_commercial : the original build (billing, payer routing, patient payment).
 *  commercial     : everything above plus the revenue engine, financing, the NHIS
 *                   ClaimIt tracker, agnostic payer slots, and the audit ledger.
 *
 * Upgrading/downgrading is a per-client flag flip — no redeploy, no data migration,
 * and nothing is deleted on downgrade (features simply stop being served, and the
 * data reappears intact if the client upgrades again).
 */

const EDITIONS = ['non_commercial', 'commercial'];

// Feature -> minimum edition required.
const FEATURES = {
  billing: 'non_commercial',
  payer_routing: 'non_commercial',
  patient_payments: 'non_commercial',
  dashboard: 'non_commercial',
  notifications: 'non_commercial',
  medical_reports: 'non_commercial',
  // commercial-only
  revenue_rules: 'commercial',
  financing: 'commercial',
  claimit: 'commercial',
  payer_slots: 'commercial',
  ledger: 'commercial',
  report_fees: 'commercial',
};

const rank = (e) => (e === 'commercial' ? 1 : 0);

/**
 * The platform ships as NON-COMMERCIAL: every feature available, no fees.
 * A client is commercial only if it explicitly holds a commercial edition with a
 * live (unexpired) licence — see licenceState(). Anything else is non-commercial.
 */
function editionOf(tenant) {
  const e = tenant?.edition;
  if (e === 'commercial') {
    // A commercial edition only counts while its licence is live; lapsed -> non-commercial.
    if (tenant.licenseExpiresAt && new Date(tenant.licenseExpiresAt).getTime() < Date.now()) {
      return 'non_commercial';
    }
    return 'commercial';
  }
  return 'non_commercial';
}

function has(tenant, feature) {
  const need = FEATURES[feature];
  if (!need) return true;
  return rank(editionOf(tenant)) >= rank(need);
}

function featureList(tenant) {
  const ed = editionOf(tenant);
  return Object.fromEntries(Object.entries(FEATURES).map(([f, need]) => [f, rank(ed) >= rank(need)]));
}

// ---- licence keys ----------------------------------------------------------

function generateKey(edition = 'commercial') {
  const seg = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  const tag = edition === 'commercial' ? 'COMM' : 'NCOM';
  return `HNN-${tag}-${seg()}-${seg()}-${seg()}`;
}

// Default licence term. HNN renews non-commercial licences on this cadence.
const DEFAULT_TERM_MONTHS = 6;

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

/**
 * Issue a licence key.
 *  - edition       : 'non_commercial' (default, fee-free) or 'commercial'
 *  - termMonths    : licence validity window (default 6); expiresAt derived if not given
 *  - feeAmount     : the licensing fee for this term (0 = free, the current policy)
 *  - orgId         : bind to one client so the key can't be shared
 */
async function issueLicense({
  edition = 'non_commercial', orgId = null, note = null,
  expiresAt = null, termMonths = DEFAULT_TERM_MONTHS, feeAmount = 0, currency = 'GHS', issuedBy = null,
}) {
  if (!EDITIONS.includes(edition)) { const e = new Error('unknown_edition'); e.status = 422; throw e; }
  const issuedAt = new Date().toISOString();
  const lic = {
    key: generateKey(edition),
    edition, orgId, note,
    termMonths: termMonths || DEFAULT_TERM_MONTHS,
    expiresAt: expiresAt || addMonths(issuedAt, termMonths || DEFAULT_TERM_MONTHS),
    feeAmount: Math.max(0, Number(feeAmount) || 0),
    currency,
    status: 'issued', // issued -> redeemed | renewed | revoked
    issuedBy, issuedAt,
    redeemedBy: null, redeemedAt: null, renewedAt: null,
  };
  await store.licenses.save(lic);
  return lic;
}

/** Redeem a key against a client, setting their edition and licence window. */
async function redeem(key, tenantId) {
  const lic = await store.licenses.get(String(key || '').trim().toUpperCase());
  if (!lic) { const e = new Error('invalid_license_key'); e.status = 404; throw e; }
  if (lic.status === 'revoked') { const e = new Error('license_revoked'); e.status = 409; throw e; }
  if (lic.status === 'redeemed' && lic.redeemedBy !== tenantId) {
    const e = new Error('license_already_redeemed'); e.status = 409; throw e;
  }
  if (lic.expiresAt && new Date(lic.expiresAt).getTime() < Date.now()) {
    const e = new Error('license_expired'); e.status = 409; throw e;
  }
  if (lic.orgId && lic.orgId !== tenantId) { const e = new Error('license_not_for_this_client'); e.status = 403; throw e; }

  const tenant = await store.tenants.get(tenantId);
  if (!tenant) { const e = new Error('client_not_found'); e.status = 404; throw e; }

  const previous = editionOf(tenant);
  tenant.edition = lic.edition;
  tenant.editionUpdatedAt = new Date().toISOString();
  tenant.editionSource = `license:${lic.key}`;
  tenant.licenseKey = lic.key;
  tenant.licenseExpiresAt = lic.expiresAt;
  await store.tenants.save(tenant);

  lic.status = 'redeemed';
  lic.redeemedBy = tenantId;
  lic.redeemedAt = tenant.editionUpdatedAt;
  await store.licenses.save(lic);

  return { client: tenant.id, name: tenant.name, from: previous, to: lic.edition,
    key: lic.key, expiresAt: lic.expiresAt, feeAmount: lic.feeAmount };
}

/**
 * Renew a client's licence for another term (default 6 months). Extends from the
 * later of now or the current expiry, so early renewal never loses time.
 * feeAmount records what was charged (0 = free renewal, current policy).
 */
async function renew(tenantId, { termMonths = DEFAULT_TERM_MONTHS, feeAmount = 0, by = 'HNN' } = {}) {
  const tenant = await store.tenants.get(tenantId);
  if (!tenant) { const e = new Error('client_not_found'); e.status = 404; throw e; }

  const base = tenant.licenseExpiresAt && new Date(tenant.licenseExpiresAt).getTime() > Date.now()
    ? tenant.licenseExpiresAt : new Date().toISOString();
  const newExpiry = addMonths(base, termMonths);

  tenant.licenseExpiresAt = newExpiry;
  tenant.editionUpdatedAt = new Date().toISOString();
  tenant.lastRenewedBy = by;
  if (!EDITIONS.includes(tenant.edition)) tenant.edition = 'non_commercial';
  await store.tenants.save(tenant);

  const rec = await issueLicense({
    edition: tenant.edition, orgId: tenantId, termMonths,
    feeAmount, note: `renewal by ${by}`, issuedBy: by, expiresAt: newExpiry,
  });
  rec.status = 'renewed';
  rec.redeemedBy = tenantId;
  rec.redeemedAt = tenant.editionUpdatedAt;
  rec.renewedAt = tenant.editionUpdatedAt;
  await store.licenses.save(rec);

  return { client: tenant.id, name: tenant.name, edition: tenant.edition,
    expiresAt: newExpiry, termMonths, feeAmount: rec.feeAmount, key: rec.key };
}

/** Current licence state for a client — what the console/UI shows. */
function licenceState(tenant) {
  const now = Date.now();
  const exp = tenant.licenseExpiresAt ? new Date(tenant.licenseExpiresAt).getTime() : null;
  const active = !exp || exp >= now;
  const daysLeft = exp ? Math.ceil((exp - now) / 86400000) : null;
  return {
    edition: editionOf(tenant),
    declaredEdition: EDITIONS.includes(tenant.edition) ? tenant.edition : 'non_commercial',
    licenseKey: tenant.licenseKey || null,
    expiresAt: tenant.licenseExpiresAt || null,
    active, daysLeft,
    expired: exp ? exp < now : false,
    dueSoon: daysLeft != null && daysLeft <= 30 && daysLeft >= 0,
  };
}

async function revoke(key) {
  const lic = await store.licenses.get(key);
  if (!lic) { const e = new Error('invalid_license_key'); e.status = 404; throw e; }
  lic.status = 'revoked';
  lic.revokedAt = new Date().toISOString();
  await store.licenses.save(lic);
  return lic;
}

/** Direct set by a platform admin (no key needed) — same flip, fully reversible. */
async function setEdition(tenantId, edition, by = 'platform_admin') {
  if (!EDITIONS.includes(edition)) { const e = new Error('unknown_edition'); e.status = 422; throw e; }
  const tenant = await store.tenants.get(tenantId);
  if (!tenant) { const e = new Error('client_not_found'); e.status = 404; throw e; }
  const previous = editionOf(tenant);
  tenant.edition = edition;
  tenant.editionUpdatedAt = new Date().toISOString();
  tenant.editionSource = by;
  await store.tenants.save(tenant);
  return { client: tenant.id, name: tenant.name, from: previous, to: edition };
}

module.exports = { EDITIONS, FEATURES, DEFAULT_TERM_MONTHS, editionOf, has, featureList, licenceState, issueLicense, redeem, renew, revoke, setEdition, generateKey };
