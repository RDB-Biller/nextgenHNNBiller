'use strict';

const express = require('express');
const accounts = require('../services/patientAccounts');
const savings = require('../services/savingsPlans');

/**
 * The Afriyie / TrimesterSave app's account API, served by the Biller at /patient-api/v1 with the same
 * paths the app already used (patient/register, patient/login, budget/..., vital/...), so the app only
 * needs its base URL changed. Responses keep the app's { result } envelope and { error } messages.
 */
function limiter(limit, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(); const key = req.ip || 'unknown';
    const h = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (h.length >= limit) return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
    h.push(now); hits.set(key, h);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    next();
  };
}
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (!e.status) console.error('[patient-api]', e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Something went wrong. Please try again.' });
  }
};
const authed = (fn) => wrap(async (req, res) => fn(req, res, await accounts.authenticate(req.get('authorization'))));

const r = express.Router();
r.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
r.use(express.json({ limit: '2mb' }));
r.use(limiter(120, 60000));

r.post('/patient/register', limiter(10, 60000), wrap(async (req, res) => res.status(201).json({ result: await accounts.register(req.body || {}) })));
r.post('/patient/login', limiter(15, 60000), wrap(async (req, res) => res.json({ result: await accounts.login(req.body || {}) })));
r.get('/patient/me', authed(async (req, res, a) => res.json({ result: { user: accounts.publicUser(a) } })));
r.patch('/patient/update', authed(async (req, res, a) => res.json({ result: { user: await accounts.updateProfile(a, req.body || {}) } })));
r.patch('/patient/change_password', limiter(10, 60000), authed(async (req, res, a) => res.json({ result: await accounts.changePassword(a, req.body || {}) })));
r.patch('/patient/forgot_password', limiter(5, 60000), wrap(async (req, res) => res.json({ result: await accounts.forgotPassword(req.body || {}) })));
r.patch('/patient/reset_password', limiter(10, 60000), wrap(async (req, res) => res.json({ result: await accounts.resetPassword(req.query.code, req.body || {}) })));
r.patch('/patient/verify_phone', limiter(10, 60000), wrap(async (req, res) => res.json({ result: await accounts.verifyPhone(req.body || {}) })));
const sendCode = limiter(5, 60000);
r.post('/patient/send_verification_code', sendCode, wrap(async (req, res) => res.json(await savings.startVerification(req.body?.phone))));

r.post('/budget/add_budget', authed(async (req, res, a) => res.status(201).json({ result: await accounts.addBudget(a, req.body || {}) })));
r.get('/budget/patient_budgets', authed(async (req, res, a) => res.json({ result: accounts.listBudgets(a) })));
r.post('/vital/add_vital', authed(async (req, res, a) => res.status(201).json({ result: await accounts.addVital(a, req.body || {}) })));
r.get('/vital/patient_vitals', authed(async (req, res, a) => res.json({ result: accounts.listVitals(a) })));
r.get('/vital', authed(async (req, res, a) => res.json({ result: accounts.listVitals(a) })));

// appointments (specific paths first, then /:id)
r.post('/appointment/add_appointment', authed(async (req, res, a) => res.status(201).json({ result: await accounts.addAppointment(a, req.body || {}) })));
r.get('/appointment/patient_appointments', authed(async (req, res, a) => res.json({ result: accounts.listAppointments(a) })));
r.patch('/appointment/update/:id', authed(async (req, res, a) => res.json({ result: await accounts.updateAppointment(a, req.params.id, req.body || {}) })));
r.delete('/appointment/delete/:id', authed(async (req, res, a) => res.json({ result: await accounts.deleteAppointment(a, req.params.id) })));
r.get('/appointment/:id', authed(async (req, res, a) => res.json({ result: accounts.getAppointment(a, req.params.id) })));

// notifications for the signed-in patient (the :id the app sends is ignored: the token decides whose they are)
r.patch('/notification/read_notification/:id', authed(async (req, res, a) => res.json({ result: await accounts.readNotification(a, req.params.id) })));
r.get('/notification/:id', authed(async (req, res, a) => res.json({ result: await accounts.listNotifications(a), unread: (a.notifications || []).filter((n) => !n.read).length })));

// document vault
r.post('/vault/add_file', authed(async (req, res, a) => res.status(201).json({ result: await accounts.addFile(a, req.body || {}) })));
r.get('/vault/patient_files', authed(async (req, res, a) => res.json({ result: accounts.listFiles(a) })));
r.patch('/vault/update_file/:id', authed(async (req, res, a) => res.json({ result: await accounts.updateFile(a, req.params.id, req.body || {}) })));
r.delete('/vault/delete/:id', authed(async (req, res, a) => res.json({ result: await accounts.deleteFile(a, req.params.id) })));
r.get('/vault/:id', authed(async (req, res, a) => res.json({ result: await accounts.getFile(a, req.params.id) })));

module.exports = r;
