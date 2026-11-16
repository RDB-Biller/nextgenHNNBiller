'use strict';
// Synthetic insurer claims for trying Dry Run with no real data. Prices and mixes are ILLUSTRATIVE, not official tariffs.
const { rng, round } = require('../util');
const DX = [
  { icd: 'B50.9', name: 'Uncomplicated malaria', w: 26, services: [['CONSULT-GP', 40], ['MALARIA-RDT', 25], ['ARTEMETHER-LUM', 45]] },
  { icd: 'J06.9', name: 'Upper respiratory infection', w: 20, services: [['CONSULT-GP', 40], ['AMOXICILLIN-5D', 35]] },
  { icd: 'A09', name: 'Gastroenteritis', w: 12, services: [['CONSULT-GP', 40], ['ORS-ZINC', 18], ['STOOL-R', 22]] },
  { icd: 'I10', name: 'Hypertension review', w: 10, services: [['CONSULT-GP', 40], ['AMLODIPINE-30D', 45], ['BLOOD-GLUC', 15]] },
  { icd: 'N39.0', name: 'Urinary tract infection', w: 9, services: [['CONSULT-GP', 40], ['URINE-R', 20], ['CIPRO-5D', 38]] },
  { icd: 'A01.0', name: 'Typhoid fever', w: 7, services: [['CONSULT-GP', 40], ['WIDAL', 30], ['CEFTRIAXONE-5D', 120]] },
  { icd: 'Z34.9', name: 'Antenatal supervision', w: 10, services: [['ANC-VISIT', 60], ['US-OBS', 90], ['FBC', 35]] },
  { icd: 'O80', name: 'Normal delivery', w: 3, services: [['DELIV-SVD', 900]] },
  { icd: 'K35.8', name: 'Appendicitis, surgical', w: 3, services: [['SURG-APPENDIX', 4800], ['ADMIT-3D', 1500]] },
];
function build(n, seed) {
  const r = rng(seed); const total = DX.reduce((a, d) => a + d.w, 0); const providers = Array.from({ length: 12 }, (_, i) => `PRV-${String(i + 1).padStart(2, '0')}`);
  const members = Array.from({ length: Math.max(40, Math.floor(n / 3)) }, (_, i) => `M${String(i + 1).padStart(5, '0')}`);
  const claims = []; const baseDate = Date.UTC(2026, 0, 1);
  const priceBook = {}; DX.forEach((d) => d.services.forEach(([c, p]) => { priceBook[c] = p; }));
  const pick = () => { let x = r() * total; for (const d of DX) { x -= d.w; if (x <= 0) return d; } return DX[0]; };
  for (let i = 0; i < n; i++) {
    const dx = pick(); const svc = dx.services[Math.floor(r() * dx.services.length)] ; const provider = providers[Math.floor(r() * providers.length)]; const member = members[Math.floor(r() * members.length)];
    const day = Math.floor(r() * 300); const date = new Date(baseDate + day * 86400000).toISOString().slice(0, 10);
    // total of a visit: all of the diagnosis's services, as one claim line per service
    const code = svc[0]; const base = svc[1]; let amount = base * (0.95 + r() * 0.1); let issue = 'none'; let eligible = true; let limit = dx.icd === 'K35.8' ? 8000 : dx.icd === 'O80' ? 2500 : 1500;
    const x = r();
    if (x < 0.05) { amount = base * (1.4 + r() * 1.2); issue = 'overpriced'; }
    else if (x < 0.075) { eligible = false; issue = 'ineligible'; }
    else if (x < 0.095) { amount = Math.max(amount, limit * (1.1 + r() * 0.4)); issue = 'over_limit'; }
    claims.push({ claim_id: `C${String(i + 1).padStart(6, '0')}`, member_id: member, provider, date, diagnosis: dx.icd, service_code: code, amount: round(amount), eligible, benefit_limit: limit, known_issue: issue });
    if (issue === 'none' && r() < 0.03) { const c = claims[claims.length - 1]; claims.push({ ...c, claim_id: `C${String(i + 1).padStart(6, '0')}D`, known_issue: 'duplicate' }); }
  }
  return { claims, priceBook: Object.entries(priceBook).map(([code, price]) => ({ code, name: code, price })), note: 'Synthetic claims with labelled issues (overpriced, ineligible, over limit, duplicate). Illustrative only.' };
}
const defaultRules = () => ({ rules: DX.filter((d) => ['B50.9', 'J06.9', 'A09', 'I10', 'N39.0'].includes(d.icd)).map((d) => ({ name: `${d.name}: routine outpatient`, icdPrefixes: [d.icd], maxAmount: 42 })), settings: { tariffTolerancePct: 20, outlierMultiple: 2.5, duplicateWindowDays: 7, autonomyTargetPct: 30, maxMissRatePct: 0.5 } });
module.exports = { build, defaultRules, DX };
