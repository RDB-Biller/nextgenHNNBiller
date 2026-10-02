'use strict';

const crypto = require('crypto');
const store = require('../store');

/**
 * Clinical observations — the data Value-Based-Care metrics are computed
 * from (services/metricsLibrary.js), pushed in by an EMR/EHR partner via
 * POST /api/v1/emr/observations (routes/webhooks.js, authEmrPartner).
 *
 * This app has no clinical data model of its own (it bills procedures/
 * medicines, not diagnoses or vitals) — these rows are the one deliberate
 * exception, and only ever arrive from an EMR partner's own feed, never
 * entered by hand here. Kept deliberately thin: a type, a value, who it's
 * about, and who sent it. metricsLibrary.js is where the clinical meaning of
 * each `type` is defined (what counts as "at target", etc).
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

function err(status, message, detail) {
  const e = new Error(message); e.status = status; if (detail) e.detail = detail; return e;
}

async function record(emrPartner, input = {}) {
  const { payerId, memberId, type } = input;
  if (!payerId) throw err(422, 'payerId_required');
  if (!memberId) throw err(422, 'memberId_required');
  if (!TYPES.includes(type)) throw err(422, 'invalid_type', `must be one of ${TYPES.join(', ')}`);

  const payer = await store.payers.get(payerId);
  if (!payer) throw err(404, 'unknown_payer');

  const o = {
    id: `obs_${crypto.randomBytes(8).toString('hex')}`,
    payerId,
    memberId: String(memberId),
    tenantId: input.tenantId || null,
    emrPartnerId: emrPartner.id,
    emrPartnerName: emrPartner.name,
    condition: input.condition || null,
    type,
    value: input.value != null ? Number(input.value) : null,
    systolic: input.systolic != null ? Number(input.systolic) : null,
    diastolic: input.diastolic != null ? Number(input.diastolic) : null,
    unit: input.unit || null,
    recordedAt: input.recordedAt || new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
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

module.exports = { TYPES, record, recordBatch };
