'use strict';

/**
 * Multinational groups whose home country is held for legal review (South Africa, EU/EEA, Switzerland ...) and the
 * offices in other countries through which the campaign can lawfully introduce itself. Matching is by organisation name
 * (normalised, "starts with"). Starter data from the groups' public footprints: VERIFY each office on the company's own
 * contact page before adding contacts.
 *
 * line: name prefix | CC:City:role; CC:City:role ...
 */
const RAW = `
standard bank|GH:Accra:africa; NG:Lagos:africa; KE:Nairobi:africa; UG:Kampala:africa; GB:London:regional; AE:Dubai:regional
absa|GH:Accra:africa; KE:Nairobi:africa; UG:Kampala:africa; TZ:Dar es Salaam:africa; ZM:Lusaka:africa; GB:London:regional
firstrand|GB:London:regional; IN:Mumbai:regional; NG:Lagos:africa
nedbank|GB:London:regional; ZW:Harare:africa; MW:Blantyre:africa
old mutual|KE:Nairobi:africa; GH:Accra:africa; NG:Lagos:africa; ZW:Harare:africa; GB:London:regional
sanlam|KE:Nairobi:africa; NG:Lagos:africa; GH:Accra:africa; UG:Kampala:africa; GB:London:regional; IN:Mumbai:regional
liberty|KE:Nairobi:africa; UG:Kampala:africa; GB:London:regional
momentum|GB:London:regional; IN:Mumbai:regional
discovery|GB:London:regional; SG:Singapore:regional; US:New York:regional
santam|KE:Nairobi:africa; GB:London:regional
hollard|GB:London:regional; IN:Mumbai:regional
munich re|US:Princeton:regional; GB:London:regional; IN:Mumbai:regional; SG:Singapore:regional
hannover re|US:Orlando:regional; GB:London:regional; IN:Mumbai:regional; SG:Singapore:regional
general reinsurance|US:Stamford:regional; GB:London:regional
swiss re|US:Armonk:regional; GB:London:regional; IN:Mumbai:regional; SG:Singapore:regional; KE:Nairobi:africa
allianz|GB:London:regional; US:Minneapolis:regional; NG:Lagos:africa; KE:Nairobi:africa; IN:Pune:regional
axa|GB:London:regional; US:New York:regional; NG:Lagos:africa; GH:Accra:africa
sunu|GH:Accra:africa; NG:Lagos:africa
bnp paribas|GB:London:regional; US:New York:regional; IN:Mumbai:regional
societe generale|GB:London:regional; US:New York:regional; GH:Accra:africa; NG:Lagos:africa
credit agricole|GB:London:regional; US:New York:regional
deutsche bank|GB:London:regional; US:New York:regional; IN:Mumbai:regional; SG:Singapore:regional
santander|GB:London:regional; US:Boston:regional
bbva|US:Houston:regional; GB:London:regional
ubs|US:New York:regional; GB:London:regional; SG:Singapore:regional
zurich|US:Schaumburg:regional; GB:London:regional; IN:Mumbai:regional
credit suisse|US:New York:regional; GB:London:regional
`;
module.exports = RAW.trim().split('\n').map((l) => {
  const [prefix, offs] = l.split('|');
  return { prefix: prefix.trim(), offices: offs.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [cc, city, role] = x.split(':'); return { cc, city, role }; }) };
});
