'use strict';

const express = require('express');
const trialRegistrations = require('../services/trialRegistrations');

const router = express.Router();

// Fully public, unauthenticated — this is the page a campaign "YES" reply
// links to. `hp` is a honeypot field: real browsers never fill a field
// that's hidden via CSS, so any request where it's non-empty is almost
// certainly a bot and is accepted-but-discarded (200 OK, nothing stored) —
// telling a scraper its submission failed just invites it to retry harder.
router.post('/submit', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.hp) return res.json({ ok: true });
    const reg = await trialRegistrations.submit(body);
    res.status(201).json({ ok: true, id: reg.id });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

module.exports = router;
