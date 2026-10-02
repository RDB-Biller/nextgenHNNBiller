'use strict';

const crypto = require('crypto');
const store = require('../store');

/**
 * Idempotency for unsafe POSTs. If the client sends an `Idempotency-Key` header,
 * we dedupe retries: the first request executes and its response is stored; any
 * later request with the same key + scope replays the stored response instead of
 * re-running the handler. Concurrent retries while the first is in flight get 409.
 * A different body under the same key is rejected (422). 5xx responses release the
 * key so the client can genuinely retry.
 *
 * `scopeFn(req)` namespaces keys per principal (tenant/payer) or per claim link.
 */
function idempotency(scopeFn) {
  return async (req, res, next) => {
    const key = req.header('Idempotency-Key');
    if (!key) return next(); // optional — no key means no dedupe

    const scope = scopeFn(req);
    const hash = crypto.createHash('sha256')
      .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body || {})}`)
      .digest('hex');

    let begun;
    try { begun = await store.idempotency.begin(scope, key, hash); }
    catch (e) { return next(e); }

    if (!begun.claimed) {
      const ex = begun.existing;
      if (!ex || ex.status === 'in_progress') return res.status(409).json({ error: 'request_in_progress' });
      if (ex.request_hash !== hash) return res.status(422).json({ error: 'idempotency_key_reused' });
      return res.status(ex.response_status || 200).json(ex.response_body);
    }

    // We own the key: capture the response, then persist or release on finish.
    const origJson = res.json.bind(res);
    let captured;
    res.json = (body) => { captured = body; return origJson(body); };
    res.on('finish', () => {
      const st = res.statusCode;
      if (st >= 500) store.idempotency.release(scope, key).catch(() => {});
      else store.idempotency.complete(scope, key, st, captured ?? null).catch(() => {});
    });
    next();
  };
}

module.exports = { idempotency };
