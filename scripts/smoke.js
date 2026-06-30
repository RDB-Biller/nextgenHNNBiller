'use strict';

/** E2E smoke over HTTP. Start `npm start`, then `npm run smoke`. */
const BASE = process.env.BASE || 'http://localhost:4000';
const KEY = process.env.API_KEY || 'emr_demo_key_123';
const h = { 'Content-Type': 'application/json', 'x-api-key': KEY };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

(async () => {
  // 1. Bill with coverage (20% copay, 10% discount), sponsored by an employer.
  let r = await fetch(`${BASE}/api/v1/bills`, { method: 'POST', headers: h, body: JSON.stringify({
    provider: 'Euracare Hospital', patient: { name: 'Ama Mensah', phone: '0241234567' },
    items: [{ code: 'GP-CONSULT' }, { code: 'FBC' }, { name: 'Dressing', cost: 40 }],
    adjustments: { copayPercent: 20, discountCode: 'WELCOME10' },
    insurance: { memberId: 'ACA-00123', employer: { name: 'Acme Ltd', email: 'hr@acme.example' } },
  }) });
  const bill = await j(r);
  console.log('BILL', bill.id, '| patient', bill.totals.patientPayable, '| payerShare', bill.totals.payerShare);

  // 2. Tap the insurer -> claim + secure link.
  r = await fetch(`${BASE}/api/v1/bills/${bill.id}/route`, { method: 'POST', headers: h, body: JSON.stringify({ payerId: 'acacia' }) });
  const routed = await j(r);
  console.log('ROUTED', routed.claim.id, '| link', routed.claim.link);

  // 3. Insurer authorises via the PAYER API (their own system, no front end).
  r = await fetch(`${BASE}/api/payer/claims/${routed.claim.id}/authorize`, { method: 'POST', headers: { 'x-payer-key': 'payer_acacia_key' } });
  console.log('AUTHORISED (payer API) ->', (await j(r)).status);

  // 4. Employer-as-payer: route a second bill to an SME employer and authorise.
  r = await fetch(`${BASE}/api/v1/bills`, { method: 'POST', headers: h, body: JSON.stringify({
    provider: 'Nyaho Medical Centre', patient: { name: 'Yaw', phone: '0205556666' },
    items: [{ code: 'GP-CONSULT' }], adjustments: { copayPercent: 0 }, insurance: { memberId: 'SAV-EMP-009' } }) });
  const bill2 = await j(r);
  r = await fetch(`${BASE}/api/v1/bills/${bill2.id}/route`, { method: 'POST', headers: h, body: JSON.stringify({ payerId: 'savanna' }) });
  const routed2 = await j(r);
  r = await fetch(`${BASE}/api/payer/claims/${routed2.claim.id}/authorize`, { method: 'POST', headers: { 'x-payer-key': 'payer_savanna_key' } });
  console.log('EMPLOYER pays ->', (await j(r)).status);

  // 5. Optional financing: micro report + MoMo loan for a self-pay patient share.
  r = await fetch(`${BASE}/api/v1/bills`, { method: 'POST', headers: h, body: JSON.stringify({
    provider: 'Euracare Hospital', patient: { name: 'Esi', phone: '0244000000' },
    items: [{ code: 'GP-CONSULT' }, { code: 'Coartem' }], adjustments: { copayPercent: 100 } }) });
  const bill3 = await j(r);
  r = await fetch(`${BASE}/api/v1/financing/reports`, { method: 'POST', headers: h, body: JSON.stringify({
    billId: bill3.id, diagnosis: 'Uncomplicated malaria', loanType: 'momo_loan',
    qa: [{ id: 'complaint', a: 'Fever 3 days' }, { id: 'urgency', a: 'Urgent' }] }) });
  const rep = await j(r);
  console.log('REPORT', rep.kind, '| share', `/report/?token=${rep.shareToken}`);
  r = await fetch(`${BASE}/api/v1/financing`, { method: 'POST', headers: h, body: JSON.stringify({
    billId: bill3.id, type: 'momo_loan', reportId: rep.id }) });
  const fin = await j(r);
  console.log('MOMO LOAN ->', fin.status, '| ref', fin.transferReference);

  // 6. Dashboard.
  r = await fetch(`${BASE}/api/v1/dashboard`, { headers: h });
  console.log('DASHBOARD', (await j(r)).totals);

  // 7. Reconciliation ledger.
  r = await fetch(`${BASE}/api/v1/ledger/summary`, { headers: h });
  console.log('LEDGER SUMMARY', await j(r));

  // 8. Idempotency: same key + body twice on a financing request -> one execution.
  const idemHeaders = { ...h, 'Idempotency-Key': `demo-${Date.now()}` };
  r = await fetch(`${BASE}/api/v1/bills`, { method: 'POST', headers: h, body: JSON.stringify({
    provider: 'Euracare Hospital', patient: { name: 'Idem', phone: '0240000001' }, items: [{ code: 'GP-CONSULT' }], adjustments: { copayPercent: 100 } }) });
  const bill4 = await j(r);
  const finBody = JSON.stringify({ billId: bill4.id, type: 'momo_loan' });
  const a1 = await j(await fetch(`${BASE}/api/v1/financing`, { method: 'POST', headers: idemHeaders, body: finBody }));
  const a2 = await j(await fetch(`${BASE}/api/v1/financing`, { method: 'POST', headers: idemHeaders, body: finBody }));
  console.log('IDEMPOTENCY first id', a1.id, '| retry returns same id?', a1.id === a2.id);
})().catch((e) => { console.error(e); process.exit(1); });
