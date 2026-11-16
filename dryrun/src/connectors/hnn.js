'use strict';
/**
 * The only door between Dry Run and HNN Biller. It reads price books through HNN's platform API and nothing else.
 * Remove this file (and its two routes) and Dry Run stands alone.
 */
const { err } = require('../util');
const base = () => (process.env.HNN_BASE_URL || '').replace(/\/$/, '');
const configured = () => !!base();
async function call(path) {
  if (!configured()) throw err(503, 'HNN is not connected. Set HNN_BASE_URL (and HNN_PLATFORM_KEY) for this service.');
  let r; try { r = await fetch(base() + path, { headers: { 'x-platform-key': process.env.HNN_PLATFORM_KEY || '' } }); } catch (e) { throw err(502, `Could not reach HNN Biller: ${e.message}`); }
  if (!r.ok) throw err(r.status === 401 ? 502 : r.status, `HNN Biller answered ${r.status}.`);
  return r.json();
}
const listPriceBooks = async () => { const j = await call('/api/platform/price-books'); return Array.isArray(j) ? j : (j.books || j.priceBooks || []); };
const readPriceBook = (id) => call(`/api/platform/price-books/${encodeURIComponent(id)}`);
module.exports = { configured, listPriceBooks, readPriceBook };
