'use strict';

/**
 * Configuration data (clinics, payers, financiers) seeded on first boot.
 * In Postgres these are upserted with ON CONFLICT DO NOTHING, so once seeded you
 * can edit them in the DB (add clinics/payers) without a redeploy clobbering them.
 */
const tenants = [
  { id: 'tenant_euracare', apiKey: 'emr_demo_key_123', name: 'Euracare Hospital', edition: 'non_commercial',
    receivingAccount: { serviceRoutingCode: '300591', beneficiaryAccount: '0543880082' },
    contact: { email: 'billing@euracare.example', phone: '0302000000' } },
  { id: 'tenant_nyaho', apiKey: 'emr_demo_key_nyaho', name: 'Nyaho Medical Centre', edition: 'non_commercial',
    receivingAccount: { serviceRoutingCode: '300591', beneficiaryAccount: '0543880099' },
    contact: { email: 'billing@nyaho.example', phone: '0302111111' } },
];

const payers = [
  { id: 'acacia', apiKey: 'payer_acacia_key', name: 'Acacia Health Insurance', kind: 'insurer',
    contact: { email: 'claims@acacia.example' }, sbg: { sourceAccount: '1300100200' } },
  { id: 'gmtf', apiKey: 'payer_gmtf_key', name: 'GMTF (Mahama Cares)', kind: 'insurer',
    contact: { email: 'claims@gmtf.example' }, sbg: { sourceAccount: '1300100300' } },
  { id: 'international', apiKey: 'payer_intl_key', name: 'International Insurance', kind: 'insurer',
    contact: { email: 'claims@intl.example' }, sbg: { sourceAccount: '1300100400' } },
  { id: 'nhis-claimit', apiKey: 'payer_nhis_claimit_key', name: 'NHIS ClaimIt Tracker', kind: 'insurer',
    tracker: 'claimit', refundedBy: 'acacia',
    contact: { email: 'claims@nhis.example' }, sbg: { sourceAccount: '1300100700' } },
  { id: 'gab', apiKey: 'payer_gab_key', name: 'GAB', kind: 'insurer',
    contact: { email: 'claims@gab.example' }, sbg: { sourceAccount: '1300100800' } },
  { id: 'acme', apiKey: 'payer_acme_key', name: 'Acme Ltd', kind: 'employer',
    contact: { email: 'hr@acme.example' }, sbg: { sourceAccount: '1300100500' } },
  { id: 'savanna', apiKey: 'payer_savanna_key', name: 'Savanna Foods (SME)', kind: 'employer',
    contact: { email: 'admin@savanna.example' }, sbg: { sourceAccount: '1300100600' } },
];

const financiers = [
  { id: 'momo-quickcash', apiKey: 'fin_momo_key', name: 'MoMo QuickCash', kind: 'lender', product: 'momo_loan',
    integration: 'a2a', reportKind: 'micro', terms: { tenor: '30 days', rate: '4.5% flat' },
    sbg: { sourceAccount: '1400200100' }, contact: { email: 'loans@quickcash.example' } },
  { id: 'medfin-bank', apiKey: 'fin_medfin_key', name: 'MedFin Bank Loan', kind: 'lender', product: 'bank_loan',
    integration: 'a2a', reportKind: 'detailed', terms: { tenor: '6–24 months', rate: '2.1% monthly' },
    sbg: { sourceAccount: '1400200200' }, contact: { email: 'medical@medfin.example' } },
  { id: 'hope-grant', apiKey: 'fin_hope_key', name: 'Hope Medical Grant Fund', kind: 'grant', product: 'grant',
    integration: 'a2a', reportKind: 'detailed', terms: { repayment: 'none (grant)' },
    sbg: { sourceAccount: '1400200300' }, contact: { email: 'grants@hopefund.example' } },
  { id: 'partner-savings', name: 'TrimesterSave', kind: 'partner', product: 'savings',
    integration: 'referral', url: 'https://www.trimestersave.com' },
  { id: 'partner-loans', name: 'ConfirmU', kind: 'partner', product: 'momo_loan',
    integration: 'referral', reportKind: 'micro', url: 'https://confirmu.com' },
  { id: 'partner-remit', name: 'PayAngel', kind: 'partner', product: 'remittance',
    integration: 'referral', url: 'https://payangel.com' },
];

module.exports = { tenants, payers, financiers };
