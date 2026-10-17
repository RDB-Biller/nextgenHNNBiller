'use strict';

/**
 * Ghana healthcare group: hospitals, clinics, pharmacy and pharmaceutical firms, plus the sector bodies that can introduce
 * them. Starter names only (well-known public institutions); NO contact details are included. Contacts are added from
 * their public pages, by the team or by community contributors through the verified-source form.
 *
 * line: type|Name|City
 */
const GROUP = 'ghana-healthcare';
const RAW = `
hospital|Korle Bu Teaching Hospital|Accra
hospital|Komfo Anokye Teaching Hospital|Kumasi
hospital|Tamale Teaching Hospital|Tamale
hospital|Cape Coast Teaching Hospital|Cape Coast
hospital|Ho Teaching Hospital|Ho
hospital|University of Ghana Medical Centre|Accra
hospital|37 Military Hospital|Accra
hospital|Greater Accra Regional Hospital (Ridge)|Accra
hospital|Ghana Police Hospital|Accra
hospital|Effia Nkwanta Regional Hospital|Sekondi-Takoradi
hospital|Sunyani Regional Hospital|Sunyani
hospital|Bolgatanga Regional Hospital|Bolgatanga
hospital|Upper West Regional Hospital|Wa
hospital|Eastern Regional Hospital|Koforidua
hospital|Tema General Hospital|Tema
hospital|Legon Hospital|Accra
hospital|KNUST Hospital|Kumasi
hospital|Pantang Hospital|Accra
hospital|Accra Psychiatric Hospital|Accra
hospital|Nyaho Medical Centre|Accra
hospital|Lister Hospital and Fertility Centre|Accra
hospital|Euracare Advanced Diagnostic and Heart Centre|Accra
hospital|Trust Hospital|Accra
hospital|Akai House Clinic|Accra
hospital|The Bank Hospital|Accra
hospital|Medifem Hospital|Accra
hospital|Narh-Bita Hospital|Tema
hospital|Cocoa Clinic|Accra
hospital|Adabraka Polyclinic|Accra
hospital|Mamprobi Polyclinic|Accra
pharmacy|Ernest Chemists|Accra
pharmacy|Kinapharma|Accra
pharmacy|Tobinco Pharmaceuticals|Accra
pharmacy|Danadams Pharmaceuticals|Accra
pharmacy|Ayrton Drug Manufacturing|Accra
pharmacy|Letap Pharmaceuticals|Accra
pharmacy|Entrance Pharmaceuticals|Accra
pharmacy|Starwin Products|Accra
other|Ghana Health Service|Accra
other|Ministry of Health Ghana|Accra
other|Christian Health Association of Ghana (CHAG)|Accra
other|Pharmacy Council Ghana|Accra
other|Pharmaceutical Society of Ghana|Accra
other|Ghana Medical Association|Accra
other|Private Hospitals and Maternity Homes Association of Ghana|Accra
other|Ghana Registered Nurses and Midwives Association|Accra
`;
const rows = RAW.trim().split('\n').map((l) => { const [type, name, city] = l.split('|'); return { type, name, city }; });
module.exports = { GROUP, rows };
