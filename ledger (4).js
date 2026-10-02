'use strict';

const crypto = require('crypto');

/**
 * Build an append-only ledger entry for a money event. Entries are never updated
 * or deleted; corrections are new compensating entries. `cashMovement` marks a
 * real transfer of funds (for reconciliation against SBG history) vs an accounting
 * event like hospital credit (a receivable, no cash moved).
 *
 * Insert the returned object via `repo.ledger.insert(entry)` — ideally inside the
 * same transaction that records the settlement, so they commit atomically.
 */
function entry({ tenantId, billId, type, source, amount, currency = 'GHS', cashMovement = true, refs = {} }) {
  return {
    id: `led_${crypto.randomBytes(8).toString('hex')}`,
    tenantId, billId, type,
    source: source || null,        // { kind, id, name } of who paid
    destination: { kind: 'clinic', id: tenantId },
    amount: Number(amount),
    currency,
    cashMovement,
    refs,                          // { claimId, financingId, paymentId, serviceRequestId, reference, gatewayRef }
    createdAt: new Date().toISOString(),
  };
}

module.exports = { entry };
