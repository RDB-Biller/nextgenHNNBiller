'use strict';

/**
 * Default chargeable catalog, lifted from the HNN/TMS billing UI.
 * In production each tenant/provider would own its own price list; this is the
 * seed list so the demo works out of the box. Prices in GHS.
 */
const DEFAULT_CATALOG = [
  { code: 'Coartem', name: 'Coartem', category: 'drug', price: 200 },
  { code: 'FBC', name: 'Full Blood Count', category: 'lab', price: 120 },
  { code: 'GP-CONSULT', name: 'GP Consultation', category: 'service', price: 100 },
];

function findItem(key) {
  if (!key) return null;
  const k = String(key).toLowerCase();
  return DEFAULT_CATALOG.find((i) => i.code.toLowerCase() === k || i.name.toLowerCase() === k) || null;
}

module.exports = { DEFAULT_CATALOG, findItem };
