'use strict';

const store = require('../store');

/**
 * Currencies for display. HNN Biller bills, lends and settles in cedis (GHS). A person can *view* amounts in another currency:
 * GHS and USD are the two main ones (each person ticks their default the first time they sign in and can flip between them),
 * and every other currency sits in the "Other" tab, with the Nigerian naira and the East African currencies first.
 * Converted amounts are approximate. The rates are set by Master Control (units of currency per 1 US dollar); the built-in
 * numbers are only a starting point and are labelled indicative until Master Control saves its own.
 */
const D = (code, name, symbol, decimals, region) => ({ code, name, symbol, decimals, region });
const CURRENCIES = [
  D('GHS', 'Ghanaian cedi', 'GH₵', 2, 'Ghana'), D('USD', 'US dollar', '$', 2, 'United States'),
  // Other tab, first: the naira, then East Africa
  D('NGN', 'Nigerian naira', '₦', 2, 'Nigeria'),
  D('KES', 'Kenyan shilling', 'KSh', 2, 'East Africa'), D('UGX', 'Ugandan shilling', 'USh', 0, 'East Africa'), D('TZS', 'Tanzanian shilling', 'TSh', 2, 'East Africa'),
  D('RWF', 'Rwandan franc', 'RF', 0, 'East Africa'), D('ETB', 'Ethiopian birr', 'Br', 2, 'East Africa'), D('BIF', 'Burundian franc', 'FBu', 0, 'East Africa'),
  D('SSP', 'South Sudanese pound', 'SSP', 2, 'East Africa'), D('SOS', 'Somali shilling', 'Sh', 2, 'East Africa'), D('DJF', 'Djiboutian franc', 'Fdj', 0, 'East Africa'), D('ERN', 'Eritrean nakfa', 'Nfk', 2, 'East Africa'),
  // West and Central Africa
  D('XOF', 'West African CFA franc', 'CFA', 0, 'West Africa'), D('GMD', 'Gambian dalasi', 'D', 2, 'West Africa'), D('SLE', 'Sierra Leonean leone', 'Le', 2, 'West Africa'), D('LRD', 'Liberian dollar', 'L$', 2, 'West Africa'),
  D('GNF', 'Guinean franc', 'FG', 0, 'West Africa'), D('CVE', 'Cape Verdean escudo', 'Esc', 2, 'West Africa'), D('MRU', 'Mauritanian ouguiya', 'UM', 2, 'West Africa'),
  D('XAF', 'Central African CFA franc', 'FCFA', 0, 'Central Africa'), D('CDF', 'Congolese franc', 'FC', 2, 'Central Africa'), D('AOA', 'Angolan kwanza', 'Kz', 2, 'Central Africa'), D('STN', 'São Tomé dobra', 'Db', 2, 'Central Africa'),
  // Southern Africa and islands
  D('ZAR', 'South African rand', 'R', 2, 'Southern Africa'), D('BWP', 'Botswana pula', 'P', 2, 'Southern Africa'), D('NAD', 'Namibian dollar', 'N$', 2, 'Southern Africa'), D('ZMW', 'Zambian kwacha', 'ZK', 2, 'Southern Africa'),
  D('MWK', 'Malawian kwacha', 'MK', 2, 'Southern Africa'), D('MZN', 'Mozambican metical', 'MT', 2, 'Southern Africa'), D('LSL', 'Lesotho loti', 'L', 2, 'Southern Africa'), D('SZL', 'Swazi lilangeni', 'E', 2, 'Southern Africa'),
  D('ZWG', 'Zimbabwe Gold', 'ZiG', 2, 'Southern Africa'), D('MGA', 'Malagasy ariary', 'Ar', 2, 'Southern Africa'), D('MUR', 'Mauritian rupee', '₨', 2, 'Southern Africa'), D('SCR', 'Seychellois rupee', 'SR', 2, 'Southern Africa'), D('KMF', 'Comorian franc', 'CF', 0, 'Southern Africa'),
  // North Africa
  D('EGP', 'Egyptian pound', 'E£', 2, 'North Africa'), D('MAD', 'Moroccan dirham', 'DH', 2, 'North Africa'), D('TND', 'Tunisian dinar', 'DT', 3, 'North Africa'), D('DZD', 'Algerian dinar', 'DA', 2, 'North Africa'), D('LYD', 'Libyan dinar', 'LD', 3, 'North Africa'), D('SDG', 'Sudanese pound', 'SDG', 2, 'North Africa'),
  // Rest of the world
  D('EUR', 'Euro', '€', 2, 'Europe'), D('GBP', 'Pound sterling', '£', 2, 'Europe'), D('CHF', 'Swiss franc', 'CHF', 2, 'Europe'), D('SEK', 'Swedish krona', 'kr', 2, 'Europe'), D('NOK', 'Norwegian krone', 'kr', 2, 'Europe'), D('DKK', 'Danish krone', 'kr', 2, 'Europe'),
  D('ISK', 'Icelandic króna', 'kr', 0, 'Europe'), D('PLN', 'Polish złoty', 'zł', 2, 'Europe'), D('CZK', 'Czech koruna', 'Kč', 2, 'Europe'), D('HUF', 'Hungarian forint', 'Ft', 2, 'Europe'), D('RON', 'Romanian leu', 'lei', 2, 'Europe'), D('TRY', 'Turkish lira', '₺', 2, 'Europe'), D('RUB', 'Russian rouble', '₽', 2, 'Europe'), D('UAH', 'Ukrainian hryvnia', '₴', 2, 'Europe'),
  D('CAD', 'Canadian dollar', 'C$', 2, 'Americas'), D('MXN', 'Mexican peso', 'Mex$', 2, 'Americas'), D('BRL', 'Brazilian real', 'R$', 2, 'Americas'), D('ARS', 'Argentine peso', 'AR$', 2, 'Americas'), D('CLP', 'Chilean peso', 'CL$', 0, 'Americas'), D('COP', 'Colombian peso', 'COL$', 2, 'Americas'), D('PEN', 'Peruvian sol', 'S/', 2, 'Americas'), D('UYU', 'Uruguayan peso', '$U', 2, 'Americas'), D('JMD', 'Jamaican dollar', 'J$', 2, 'Americas'), D('TTD', 'Trinidad and Tobago dollar', 'TT$', 2, 'Americas'),
  D('AED', 'UAE dirham', 'AED', 2, 'Middle East'), D('SAR', 'Saudi riyal', 'SAR', 2, 'Middle East'), D('QAR', 'Qatari riyal', 'QAR', 2, 'Middle East'), D('KWD', 'Kuwaiti dinar', 'KD', 3, 'Middle East'), D('BHD', 'Bahraini dinar', 'BD', 3, 'Middle East'), D('OMR', 'Omani rial', 'OMR', 3, 'Middle East'), D('JOD', 'Jordanian dinar', 'JD', 3, 'Middle East'), D('ILS', 'Israeli shekel', '₪', 2, 'Middle East'),
  D('INR', 'Indian rupee', '₹', 2, 'Asia'), D('PKR', 'Pakistani rupee', 'Rs', 2, 'Asia'), D('BDT', 'Bangladeshi taka', '৳', 2, 'Asia'), D('LKR', 'Sri Lankan rupee', 'Rs', 2, 'Asia'), D('NPR', 'Nepalese rupee', 'Rs', 2, 'Asia'),
  D('CNY', 'Chinese yuan', '¥', 2, 'Asia'), D('HKD', 'Hong Kong dollar', 'HK$', 2, 'Asia'), D('JPY', 'Japanese yen', '¥', 0, 'Asia'), D('KRW', 'South Korean won', '₩', 0, 'Asia'), D('TWD', 'New Taiwan dollar', 'NT$', 2, 'Asia'), D('SGD', 'Singapore dollar', 'S$', 2, 'Asia'),
  D('MYR', 'Malaysian ringgit', 'RM', 2, 'Asia'), D('THB', 'Thai baht', '฿', 2, 'Asia'), D('IDR', 'Indonesian rupiah', 'Rp', 2, 'Asia'), D('PHP', 'Philippine peso', '₱', 2, 'Asia'), D('VND', 'Vietnamese dong', '₫', 0, 'Asia'),
  D('AUD', 'Australian dollar', 'A$', 2, 'Oceania'), D('NZD', 'New Zealand dollar', 'NZ$', 2, 'Oceania'),
];
const BY = new Map(CURRENCIES.map((c) => [c.code, c]));
const MAIN = ['GHS', 'USD'];
// Units per 1 US dollar. A starting point only, labelled indicative until Master Control saves its own.
const SEED = { USD: 1, GHS: 11, NGN: 1550, KES: 129, UGX: 3600, TZS: 2600, RWF: 1440, ETB: 135, BIF: 2950, SSP: 4500, SOS: 571, DJF: 178, ERN: 15, XOF: 600, GMD: 71, SLE: 22.7, LRD: 195, GNF: 8650, CVE: 101, MRU: 40, XAF: 600, CDF: 2850, AOA: 912, STN: 22.8, ZAR: 18, BWP: 13.6, NAD: 18, ZMW: 26, MWK: 1750, MZN: 64, LSL: 18, SZL: 18, ZWG: 26.5, MGA: 4500, MUR: 45, SCR: 14, KMF: 450, EGP: 49, MAD: 9.4, TND: 3, DZD: 133, LYD: 4.9, SDG: 600, EUR: 0.92, GBP: 0.77, CHF: 0.86, SEK: 10.4, NOK: 10.6, DKK: 6.9, ISK: 138, PLN: 3.9, CZK: 22.5, HUF: 355, RON: 4.6, TRY: 38, RUB: 90, UAH: 41, CAD: 1.38, MXN: 19.5, BRL: 5.6, ARS: 1000, CLP: 950, COP: 4100, PEN: 3.7, UYU: 41, JMD: 158, TTD: 6.8, AED: 3.67, SAR: 3.75, QAR: 3.64, KWD: 0.31, BHD: 0.38, OMR: 0.385, JOD: 0.71, ILS: 3.7, INR: 84, PKR: 280, BDT: 120, LKR: 295, NPR: 134, CNY: 7.2, HKD: 7.8, JPY: 150, KRW: 1380, TWD: 32, SGD: 1.33, MYR: 4.4, THB: 34, IDR: 15800, PHP: 57, VND: 25000, AUD: 1.52, NZD: 1.65 };
const KEY = 'currency:cfg';
const err = (status, message) => { const e = new Error(message); e.status = status; return e; };
const now = () => new Date().toISOString();

async function config() {
  const c = (await store.settings.get(KEY)) || {};
  return { rates: { ...SEED, ...(c.rates || {}) }, saved: !!c.rates, asOf: c.asOf || null, platformDefault: BY.has(c.platformDefault) && MAIN.includes(c.platformDefault) ? c.platformDefault : 'GHS', disabled: Array.isArray(c.disabled) ? c.disabled : [], updatedAt: c.updatedAt || null, updatedBy: c.updatedBy || null };
}
async function setConfig(b = {}, by = 'master') {
  const cur = (await store.settings.get(KEY)) || {}; const next = { ...cur, updatedAt: now(), updatedBy: by };
  if (b.rates !== undefined) {
    next.rates = { ...(cur.rates || {}) };
    for (const [code, v] of Object.entries(b.rates || {})) { if (!BY.has(code)) throw err(422, `Unknown currency ${code}`); const n = Number(v); if (!(n > 0) || !isFinite(n)) throw err(422, `The rate for ${code} must be a number above zero.`); next.rates[code] = n; }
    next.rates.USD = 1; next.asOf = b.asOf ? String(b.asOf).slice(0, 10) : now().slice(0, 10);
  }
  if (b.platformDefault !== undefined) { if (!MAIN.includes(b.platformDefault)) throw err(422, 'The platform default must be GHS or USD.'); next.platformDefault = b.platformDefault; }
  if (b.disabled !== undefined) { next.disabled = (Array.isArray(b.disabled) ? b.disabled : []).filter((c) => BY.has(c) && !MAIN.includes(c)); }
  await store.settings.set(KEY, next); return config();
}
const isKnown = (code) => BY.has(String(code || '').toUpperCase());
const norm = (code) => String(code || '').toUpperCase();

/** What an app needs to build its currency picker and show approximate amounts. */
async function publicView() {
  const c = await config(); const on = (x) => !c.disabled.includes(x.code);
  const withRate = (x) => ({ ...x, rate: c.rates[x.code] || null });
  const other = CURRENCIES.filter((x) => !MAIN.includes(x.code) && on(x)).map(withRate);
  return { base: 'GHS', main: MAIN.map((m) => withRate(BY.get(m))), defaultCurrency: c.platformDefault, other, otherRegions: [...new Set(other.map((x) => x.region))], rates: { perUSD: c.rates, asOf: c.asOf, indicative: !c.saved, note: c.saved ? 'Rates set by HNN.' : 'Indicative rates. Amounts in other currencies are approximate.' }, note: 'Everything is billed, lent and repaid in GHS. Other currencies are shown for your convenience.' };
}
/** amount in `from` -> `to`, rounded to the target's decimals. Pivot is USD. */
async function convert(amount, from, to) {
  const f = norm(from); const t = norm(to); if (!BY.has(f) || !BY.has(t)) throw err(422, 'Unknown currency.');
  const n = Number(amount); if (!isFinite(n)) throw err(422, 'amount must be a number');
  const c = await config(); const rf = c.rates[f]; const rt = c.rates[t]; if (!rf || !rt) throw err(409, 'No rate is set for that currency yet.');
  const v = (n / rf) * rt; const d = BY.get(t).decimals; const m = 10 ** d;
  return { amount: Math.round(v * m) / m, from: f, to: t, rate: rt / rf, asOf: c.asOf, indicative: !c.saved };
}
module.exports = { CURRENCIES, MAIN, SEED, config, setConfig, publicView, convert, isKnown, norm, get: (code) => BY.get(norm(code)) || null };
