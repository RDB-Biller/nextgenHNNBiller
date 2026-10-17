'use strict';

/** Small in-process per-key sliding-window limiter (single-instance deployments). */
function limiter(limit, windowMs, keyFn) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(); const key = (keyFn ? keyFn(req) : req.ip) || 'unknown';
    const h = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (h.length >= limit) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    h.push(now); hits.set(key, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    next();
  };
}
module.exports = { limiter };
