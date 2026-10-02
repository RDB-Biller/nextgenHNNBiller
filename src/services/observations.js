'use strict';

const crypto = require('crypto');
const store = require('../store');

/**
 * Clinical observations — the data Value-Based-Care metrics are computed
 * from (services/metricsLibrary.js). Three ways a row gets created, all
 * landing in the same table with the same shape, distinguished only by
 * `source`:
 *   - 'emr'            — an EMR/EHR partner's own feed, POST /api/v1/emr/
 *                         observations (routes/emr.js, authEmrPartner).
 *   - 'manual_hospital' — a clinic keys one in by hand, tenant-authenticated,
 *                         POST /api/v1/clinical-observations (routes/clinical.js)
 *                         — for a clinic with no EMR integration.
 *   - 'manual_patient' / 'patient_sms' — the patient's own self-report, via
 *                         the web portal or a text reply, once their phone is
 *                         linked to a payer+member (services/clinicalLinks.js,
 *                         routes/clinicalPortal.js, routes/webhooks.js).
 *
 * This app has no clinical data model of its own (it bills procedures/
 * medicines, not diagnoses or vitals) — these rows are the one deliberate
 * exception. Kept deliberately thin: a type, a value, who it's about, and
 * who sent it. metricsLibrary.js is where the clinical meaning of each
 * `type` is defined (what counts as "at target", etc).
 */

const TYPES = [
  'blood_pressure',       // value: systolic (or set systolic/diastolic directly)
  'hba1c',                // value: % (e.g. 6.8)
  'ldl',                  // value: mg/dL
  'complication',         // one row per complication event
  'followup_visit',       // one row per completed follow-up
  'screening_completed',  // campaign target-action completion (e.g. breast screening)
  'wellness_visit',       // loyalty qualifying action (e.g. a spa/wellness visit)
];

const SOURCES = ['emr', 'manual_hospital', 'manual_patient', 'patient_sms'];

function err(status, message, detail) {
  const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e;
}

/** Shared validation + shaping for every source. Never touches the store. */
function buildObservation(input = {}, meta = {}) {
  const { payerId, memberId, type } = input;
  if (!payerId) throw err(422, 'payerId_required');
  if (!memberId) throw err(422, 'memberId_required');
  if (!TYPES.includes(type)) throw err(422, 'invalid_type', `must be one of ${TYPES.join(', ')}`);

  return {
    id: `obs_${crypto.randomBytes(8).toString('hex')}`,
    payerId,
    memberId: String(memberId),
    tenantId: input.tenantId || null,
    emrPartnerId: meta.emrPartnerId || null,
    emrPartnerName: meta.emrPartnerName || null,
    source: SOURCES.includes(meta.source) ? meta.source : 'emr',
    recordedBy: meta.recordedBy || null,
    condition: input.condition || null,
    type,
    value: input.value != null ? Number(input.value) : null,
    systolic: input.systolic != null ? Number(input.systolic) : null,
    diastolic: input.diastolic != null ? Number(input.diastolic) : null,
    unit: input.unit || null,
    note: input.note ? String(input.note).slice(0, 300) : null,
    recordedAt: input.recordedAt || new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

async function record(emrPartner, input = {}) {
  const o = buildObservation(input, { source: 'emr', emrPartnerId: emrPartner.id, emrPartnerName: emrPartner.name });
  const payer = await store.payers.get(o.payerId);
  if (!payer) throw err(404, 'unknown_payer');
  await store.observations.insert(o);
  return o;
}

/** Accepts either one observation or {observations:[...]} for batch sync. */
async function recordBatch(emrPartner, body = {}) {
  const rows = Array.isArray(body.observations) ? body.observations : [body];
  if (!rows.length) throw err(422, 'no_observations');
  const saved = [];
  for (const row of rows) saved.push(await record(emrPartner, row));
  return saved;
}

/**
 * Manual entry — a hospital keying in a reading by hand (source:
 * 'manual_hospital', routes/clinical.js) or a patient submitting their own,
 * once their phone is verified against a payer+member (source:
 * 'manual_patient' from the web portal, 'patient_sms' from a text reply —
 * both via services/clinicalLinks.js). Same validation, same table, same
 * shape as the EMR feed; only `source`/`recordedBy` and the lack of an
 * emrPartner differ. `meta` is never user-supplied — callers set it, not
 * req.body, so a caller can't forge a different source or actor.
 */
async function recordManual(input = {}, meta = {}) {
  const o = buildObservation(input, meta);
  const payer = await store.payers.get(o.payerId);
  if (!payer) throw err(404, 'unknown_payer');
  await store.observations.insert(o);
  return o;
}

module.exports = { TYPES, SOURCES, record, recordBatch, recordManual };
