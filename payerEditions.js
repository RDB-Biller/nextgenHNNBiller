'use strict';

const store = require('../store');
const editions = require('./editions');

/**
 * Commercial edition for PAYERS (insurers / corporate payers), parallel to
 * editions.js's tenant (hospital) edition — same two-value model
 * (non_commercial/commercial), same licence-key machinery, stored on the
 * payer object instead of the tenant. Kept as a separate, small file rather
 * than generalising editions.js itself: editionOf()/licenceState() already
 * work unchanged on any object with `.edition`/`.licenseExpiresAt` fields, so
 * they're reused directly; only the three functions that look up and save a
 * specific org (redeem/renew/setEdition) need a payer-scoped version, since
 * editions.js's versions are hardcoded to store.tenants.
 *
 * Unlike a hospital, a payer's commercial edition doesn't gate feature access
 * (NNEST, price lists, targets, prior approvals all already work regardless)
 * — it gates the per-claim platform commission (see services/fees.js
 * onPayerCommission) and is otherwise informational, shown in Master Control.
 */

const { EDITIONS, DEFAULT_TERM_MONTHS, issueLicense, generateKey, revoke,
  editionOf, has, featureList, licenceState } = editions;

/** Redeem a licence key against a payer, setting its edition and licence window. */
async function redeem(key, payerId) {
  const lic = await store.licenses.get(String(key || '').trim().toUpperCase());
  if (!lic) { const e = new Error('invalid_license_key'); e.status = 404; throw e; }
  if (lic.status === 'revoked') { const e = new Error('license_revoked'); e.status = 409; throw e; }
  if (lic.status === 'redeemed' && lic.redeemedBy !== payerId) {
    const e = new Error('license_already_redeemed'); e.status = 409; throw e;
  }
  if (lic.expiresAt && new Date(lic.expiresAt).getTime() < Date.now()) {
    const e = new Error('license_expired'); e.status = 409; throw e;
  }
  if (lic.orgId && lic.orgId !== payerId) { const e = new Error('license_not_for_this_client'); e.status = 403; throw e; }

  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('payer_not_found'); e.status = 404; throw e; }

  const previous = editionOf(payer);
  payer.edition = lic.edition;
  payer.editionUpdatedAt = new Date().toISOString();
  payer.editionSource = `license:${lic.key}`;
  payer.licenseKey = lic.key;
  payer.licenseExpiresAt = lic.expiresAt;
  await store.payers.save(payer);

  lic.status = 'redeemed';
  lic.redeemedBy = payerId;
  lic.redeemedAt = payer.editionUpdatedAt;
  await store.licenses.save(lic);

  return { payerId: payer.id, name: payer.name, from: previous, to: lic.edition,
    key: lic.key, expiresAt: lic.expiresAt, feeAmount: lic.feeAmount };
}

/**
 * Renew a payer's licence for another term (default 6 months). Extends from
 * the later of now or the current expiry, so early renewal never loses time.
 */
async function renew(payerId, { termMonths = DEFAULT_TERM_MONTHS, feeAmount = 0, by = 'HNN' } = {}) {
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('payer_not_found'); e.status = 404; throw e; }

  const base = payer.licenseExpiresAt && new Date(payer.licenseExpiresAt).getTime() > Date.now()
    ? payer.licenseExpiresAt : new Date().toISOString();
  const newExpiry = new Date(base);
  newExpiry.setMonth(newExpiry.getMonth() + termMonths);
  const newExpiryIso = newExpiry.toISOString();

  payer.licenseExpiresAt = newExpiryIso;
  payer.editionUpdatedAt = new Date().toISOString();
  payer.lastRenewedBy = by;
  if (!EDITIONS.includes(payer.edition)) payer.edition = 'non_commercial';
  await store.payers.save(payer);

  const rec = await issueLicense({
    edition: payer.edition, orgId: payerId, termMonths,
    feeAmount, note: `renewal by ${by}`, issuedBy: by, expiresAt: newExpiryIso,
  });
  rec.status = 'renewed';
  rec.redeemedBy = payerId;
  rec.redeemedAt = payer.editionUpdatedAt;
  rec.renewedAt = payer.editionUpdatedAt;
  await store.licenses.save(rec);

  return { payerId: payer.id, name: payer.name, edition: payer.edition,
    expiresAt: newExpiryIso, termMonths, feeAmount: rec.feeAmount, key: rec.key };
}

/** Direct set by a platform admin (no key needed) — same flip, fully reversible. */
async function setEdition(payerId, edition, by = 'platform_admin') {
  if (!EDITIONS.includes(edition)) { const e = new Error('unknown_edition'); e.status = 422; throw e; }
  const payer = await store.payers.get(payerId);
  if (!payer) { const e = new Error('payer_not_found'); e.status = 404; throw e; }
  const previous = editionOf(payer);
  payer.edition = edition;
  payer.editionUpdatedAt = new Date().toISOString();
  payer.editionSource = by;
  await store.payers.save(payer);
  return { payerId: payer.id, name: payer.name, from: previous, to: edition };
}

module.exports = {
  redeem, renew, setEdition,
  // Re-exported as-is from editions.js — already generic over any org shape.
  editionOf, has, featureList, licenceState, issueLicense, generateKey, revoke, EDITIONS,
};
