'use strict';

/**
 * Countries the outreach engine knows: code, calling code, the languages we can write in (first = default for business
 * email), Commonwealth membership, and a conservative cold-contact level.
 *
 *   level 'open'   : B2B email with identity, source note and a one-click opt-out is generally acceptable.
 *   level 'review' : the country (or bloc) requires prior consent or has strict direct-marketing law (EU/EEA and
 *                    Switzerland, Canada CASL, Australia, New Zealand, South Africa POPIA, China, Brazil). Automated
 *                    email/SMS to these organisations is held back until the operator ticks the country as reviewed
 *                    by their lawyer in Master Control. Calls, referrals-by-hand and manual LinkedIn are unaffected.
 *   noColdSms      : cold SMS is not sent at all (US TCPA, Canada, India DLT/DND, China).
 *
 * This is a starting point for the operator and their lawyer, not legal advice.
 */
const RAW = `
GH|Ghana|233|en,tw,gaa|open|1|Africa
NG|Nigeria|234|en,ha,yo|open|1|Africa
KE|Kenya|254|en,sw|open|1|Africa
TZ|Tanzania|255|sw,en|open|1|Africa
UG|Uganda|256|en,sw|open|1|Africa
RW|Rwanda|250|en,fr|open|1|Africa
ZM|Zambia|260|en|open|1|Africa
ZW|Zimbabwe|263|en|open|0|Africa
MW|Malawi|265|en|open|1|Africa
BW|Botswana|267|en|open|1|Africa
NA|Namibia|264|en|open|1|Africa
LS|Lesotho|266|en|open|1|Africa
SZ|Eswatini|268|en|open|1|Africa
SL|Sierra Leone|232|en|open|1|Africa
GM|Gambia|220|en|open|1|Africa
LR|Liberia|231|en|open|0|Africa
CM|Cameroon|237|fr,en|open|1|Africa
MU|Mauritius|230|en,fr|open|1|Africa
SC|Seychelles|248|en,fr|open|1|Africa
ZA|South Africa|27|en|review|1|Africa
MZ|Mozambique|258|pt|open|1|Africa
AO|Angola|244|pt|open|0|Africa
CV|Cabo Verde|238|pt|open|0|Africa
ST|Sao Tome and Principe|239|pt|open|0|Africa
SN|Senegal|221|fr|open|0|Africa
CI|Cote d'Ivoire|225|fr|open|0|Africa
TG|Togo|228|fr|open|0|Africa
BJ|Benin|229|fr,yo|open|0|Africa
BF|Burkina Faso|226|fr|open|0|Africa
ML|Mali|223|fr|open|0|Africa
NE|Niger|227|fr,ha|open|0|Africa
GN|Guinea|224|fr|open|0|Africa
GA|Gabon|241|fr|open|0|Africa
CG|Congo|242|fr|open|0|Africa
CD|DR Congo|243|fr,sw|open|0|Africa
BI|Burundi|257|fr,sw|open|0|Africa
TD|Chad|235|fr,ar|open|0|Africa
GQ|Equatorial Guinea|240|es,fr,pt|open|0|Africa
GW|Guinea-Bissau|245|pt|open|0|Africa
ET|Ethiopia|251|en|open|0|Africa
SS|South Sudan|211|en,ar|open|0|Africa
DZ|Algeria|213|fr,ar|open|0|Africa
MA|Morocco|212|fr,ar|open|0|Africa
TN|Tunisia|216|fr,ar|open|0|Africa
EG|Egypt|20|ar,en|open|0|Africa
SA|Saudi Arabia|966|ar,en|open|0|Middle East
AE|United Arab Emirates|971|ar,en|open|0|Middle East
QA|Qatar|974|ar,en|open|0|Middle East
JO|Jordan|962|ar,en|open|0|Middle East
KW|Kuwait|965|ar,en|open|0|Middle East
US|United States|1|en|open|0|North America
CA|Canada|1|en,fr|review|1|North America
GB|United Kingdom|44|en|open|1|Europe
IE|Ireland|353|en|review|0|Europe
CY|Cyprus|357|en|review|1|Europe
MT|Malta|356|en|review|1|Europe
FR|France|33|fr|review|0|Europe
BE|Belgium|32|fr|review|0|Europe
CH|Switzerland|41|de,fr|review|0|Europe
PT|Portugal|351|pt|review|0|Europe
ES|Spain|34|es|review|0|Europe
DE|Germany|49|de|review|0|Europe
AT|Austria|43|de|review|0|Europe
NL|Netherlands|31|en|review|0|Europe
IT|Italy|39|en|review|0|Europe
BR|Brazil|55|pt|review|0|Latin America
MX|Mexico|52|es|open|0|Latin America
CO|Colombia|57|es|open|0|Latin America
AR|Argentina|54|es|open|0|Latin America
CL|Chile|56|es|open|0|Latin America
PE|Peru|51|es|open|0|Latin America
IN|India|91|hi,en|open|1|Asia
PK|Pakistan|92|en|open|1|Asia
BD|Bangladesh|880|en|open|1|Asia
LK|Sri Lanka|94|en|open|1|Asia
SG|Singapore|65|en|open|1|Asia
MY|Malaysia|60|en|open|1|Asia
HK|Hong Kong|852|zh,en|open|0|Asia
CN|China|86|zh|review|0|Asia
AU|Australia|61|en|review|1|Oceania
NZ|New Zealand|64|en|review|1|Oceania
JM|Jamaica|1876|en|open|1|Caribbean
TT|Trinidad and Tobago|1868|en|open|1|Caribbean
`;
const NO_COLD_SMS = new Set(['US', 'CA', 'IN', 'CN']);
const ALIASES = {
  usa: 'US', 'u.s.': 'US', 'united states of america': 'US', uk: 'GB', 'u.k.': 'GB', england: 'GB', 'great britain': 'GB', britain: 'GB',
  "côte d'ivoire": 'CI', "côte d’ivoire": 'CI', "cote d’ivoire": 'CI', 'ivory coast': 'CI', drc: 'CD', 'dr congo': 'CD', 'democratic republic of congo': 'CD',
  'rep. of congo': 'CG', 'republic of congo': 'CG', swaziland: 'SZ', 'st & principe': 'ST', 'sao tome & principe': 'ST', 'cape verde': 'CV', 'eq. guinea': 'GQ',
  uae: 'AE', 'the gambia': 'GM', 'south korea': 'KR',
};
const list = RAW.trim().split('\n').map((l) => {
  const [code, name, cc, langs, level, cw, region] = l.split('|');
  return { code, name, cc, langs: langs.split(','), level, commonwealth: cw === '1', region, noColdSms: NO_COLD_SMS.has(code) };
});
const byCode = new Map(list.map((c) => [c.code, c]));
const byName = new Map();
for (const c of list) byName.set(c.name.toLowerCase(), c.code);
for (const [k, v] of Object.entries(ALIASES)) byName.set(k, v);
const deacc = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
for (const c of list) byName.set(deacc(c.name), c.code);

/** Country object from a code (GH), a name (Ghana) or an alias (USA, Ivory Coast). */
function find(x) {
  if (!x) return null; const s = String(x).trim();
  if (byCode.has(s.toUpperCase())) return byCode.get(s.toUpperCase());
  const code = byName.get(s.toLowerCase()) || byName.get(deacc(s)); return code ? byCode.get(code) : null;
}
module.exports = { list, find, byCode };
