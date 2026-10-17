'use strict';

/**
 * Core banking software providers as one campaign group, each with the offices worth trying when the head office's
 * country is held back (for example a South Africa office that needs a legal review) so the operator can reach the
 * same company through its USA, UK, India or Swiss office instead.
 *
 * Starter data: the vendor list follows the core banking market reports (Temenos, Oracle, Finastra, FIS, Fiserv,
 * Infosys Finacle, TCS BaNCS, Jack Henry, Mambu, Thought Machine, nCino and so on). Office cities are widely known
 * locations but MUST be verified on each company's public "contact us" page before use. Replace or extend freely.
 *
 * office line: CC:City:role   (role: hq | regional | africa | sales)
 */
const GROUP = 'core-banking-top15';
const VENDORS = [
  ['Temenos AG', 'CH', 'CH:Geneva:hq; GB:London:regional; US:Orlando:regional; ZA:Johannesburg:africa; IN:Chennai:regional; SG:Singapore:regional; AE:Dubai:regional'],
  ['Oracle Corporation (Financial Services)', 'US', 'US:Austin:hq; IN:Mumbai:regional; GB:London:regional; ZA:Johannesburg:africa; AE:Dubai:regional; SG:Singapore:regional'],
  ['Finastra', 'GB', 'GB:London:hq; US:Lake Mary:regional; CA:Toronto:regional; ZA:Johannesburg:africa; IN:Bengaluru:regional; SG:Singapore:regional'],
  ['FIS', 'US', 'US:Jacksonville:hq; GB:London:regional; IN:Pune:regional; SG:Singapore:regional'],
  ['Fiserv, Inc.', 'US', 'US:Milwaukee:hq; GB:London:regional; IN:Pune:regional; SG:Singapore:regional'],
  ['Infosys Limited (Finacle)', 'IN', 'IN:Bengaluru:hq; US:Plano:regional; GB:London:regional; ZA:Johannesburg:africa; AE:Dubai:regional; SG:Singapore:regional'],
  ['Tata Consultancy Services (BaNCS)', 'IN', 'IN:Mumbai:hq; US:New York:regional; GB:London:regional; ZA:Johannesburg:africa; AE:Dubai:regional; SG:Singapore:regional'],
  ['Jack Henry & Associates, Inc.', 'US', 'US:Monett:hq'],
  ['Mambu', 'DE', 'DE:Berlin:hq; NL:Amsterdam:regional; US:New York:regional; GB:London:regional; SG:Singapore:regional'],
  ['Thought Machine', 'GB', 'GB:London:hq; US:New York:regional; SG:Singapore:regional; AU:Sydney:regional'],
  ['nCino', 'US', 'US:Wilmington:hq; GB:London:regional; AU:Sydney:regional'],
  ['Sopra Banking Software', 'FR', 'FR:Paris:hq; GB:London:regional; US:New York:regional'],
  ['Avaloq', 'CH', 'CH:Zurich:hq; GB:London:regional; DE:Frankfurt:regional; SG:Singapore:regional; HK:Hong Kong:regional'],
  ['HCL Technologies Limited', 'IN', 'IN:Noida:hq; US:Sunnyvale:regional; GB:London:regional'],
  ['Unisys', 'US', 'US:Blue Bell:hq; GB:London:regional; IN:Bengaluru:regional'],
];
function parseOffices(s) {
  return String(s).split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [cc, city, role] = x.split(':').map((y) => y.trim()); return { cc, city, role: role || 'regional', verify: true }; });
}
module.exports = { GROUP, vendors: VENDORS.map(([name, cc, offices]) => ({ name, cc, offices: parseOffices(offices) })) };
