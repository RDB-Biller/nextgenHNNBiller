'use strict';
const express = require('express');
const accounts = require('../services/patientAccounts');
const r = express.Router();
r.use(express.json({ limit: '5kb' }));
r.get('/', async (_q, res, next) => { try { res.json(await accounts.authConfig()); } catch (e) { next(e); } });
r.put('/', async (req, res, next) => { try { res.json(await accounts.setAuthConfig(req.body || {})); } catch (e) { next(e); } });
module.exports = r;
