'use strict';

/**
 * Country and index lists for the outreach engine: ORGANISATIONS ONLY (no people, no emails, no phone numbers).
 *
 * Names are typed from general knowledge as a STARTER and can be stale or incomplete: every pack names its public
 * source so the operator can check it and import the full list with "Import a list" in Master Control. Ranked lists
 * that are published only as images, PDFs or paid datasets (Ghana Club 100, the full Fortune 500, FTSE 350 ...) are
 * therefore registered as packs with an importer rather than guessed.
 *
 * Format:  @CC  starts a country;  type: Name [tag,tag]; Name; ...   (types: bank ins hosp ehr adj core org)
 *          tags join an organisation to a list pack (see PACKS).
 */
const TYPE = { bank: 'bank', ins: 'insurer', hosp: 'hospital', ehr: 'ehr', adj: 'adjudication', core: 'core_banking', org: 'other' };

const PACKS = [
  { id: 'core-banking-top15', name: 'Top 15 core banking software providers (with regional offices)', country: '', source: 'Core banking market reports; offices to be verified on each company contact page', note: 'Vendors plus their head and regional offices, so a held country (for example South Africa) can be bypassed through the USA, UK, India or Swiss office.', complete: false, campaign: true },
  { id: 'africa-report-2024', name: 'The Africa Report 2024: all rankings (banks and insurers)', country: '', source: 'The Africa Report, issue 129, Oct-Dec 2024', note: 'The lists HNN supplied: consolidated banking groups, the top banks and the top 100 insurers. Its own campaign group.', complete: false, campaign: true },
  { id: 'africa-report-2024-bank-groups', name: 'The Africa Report 2024: top consolidated banking groups', country: '', source: 'The Africa Report, issue 129, Oct-Dec 2024', note: 'Top 28 groups.', complete: false, campaign: true },
  { id: 'africa-report-2024-banks', name: 'The Africa Report 2024: ranked banks', country: '', source: 'The Africa Report, issue 129, Oct-Dec 2024', note: 'About 190 banks. Some scanned rows were unreadable and were completed by hand.', complete: false, campaign: true },
  { id: 'africa-report-2024-insurers', name: 'The Africa Report 2024: top 100 insurers and reinsurers', country: '', source: 'The Africa Report, issue 129, Oct-Dec 2024', note: 'Includes health, life, general and reinsurance. Pitch claims adjudication, not only health.', complete: false, campaign: true },
  { id: 'ghana-club-100', name: 'Ghana Club 100', country: 'GH', source: 'https://gipc.gov.gh/category/ghana-club-100/', note: 'Ranked by GIPC each year. The public article text shows only the top 10, so import the full ranking from the GIPC publication.', complete: false },
  { id: 'ghana-health-finance', name: 'Ghana banks, insurers, health insurers/TPAs, hospitals', country: 'GH', source: 'https://www.nic.gov.gh', note: 'Regulator registers: National Insurance Commission, Bank of Ghana, NHIA.', complete: false },
  { id: 'fortune500', name: 'Fortune 500 (USA)', country: 'US', source: 'https://fortune.com/ranking/fortune500/', note: 'The full table is not readable from the public page, so this holds the banks, insurers, health and health-IT members plus the top 15. Download the list and import the rest.', complete: false },
  { id: 'ftse100', name: 'FTSE 100 (UK) finance and health', country: 'GB', source: 'https://www.londonstockexchange.com', note: 'Financial, insurance and health members only.', complete: false },
  { id: 'cac40', name: 'CAC 40 / SBF 120 (France) finance and health', country: 'FR', source: 'https://www.euronext.com', note: 'Financial, insurance and health members plus mutuelles.', complete: false },
  { id: 'dax40', name: 'DAX 40 / MDAX (Germany) finance and health', country: 'DE', source: 'https://www.deutsche-boerse.com', note: 'Financial, insurance and health members.', complete: false },
  { id: 'ibex35', name: 'IBEX 35 (Spain) finance and health', country: 'ES', source: 'https://www.bolsasymercados.es', note: 'Financial, insurance and health members.', complete: false },
  { id: 'psi', name: 'PSI (Portugal) finance and health', country: 'PT', source: 'https://www.euronext.com', note: 'Financial, insurance and health members.', complete: false },
  { id: 'nse-ng', name: 'Nigeria banks, insurers, HMOs, hospitals', country: 'NG', source: 'https://ngxgroup.com', note: 'Listed on the Nigerian Exchange plus the larger HMOs.', complete: false },
  { id: 'commonwealth', name: 'Commonwealth countries: banks, insurers, hospitals', country: '', source: 'https://thecommonwealth.org/our-member-countries', note: 'The larger banks, insurers and hospital groups of each member country that appears in this seed.', complete: false },
  { id: 'francophone', name: 'Francophone Africa and Maghreb', country: '', source: '', note: 'Banks and insurers of the French-speaking markets not already in the ranked African lists.', complete: false },
  { id: 'lusophone', name: 'Portuguese-speaking markets', country: '', source: '', note: 'Portugal, Brazil, Angola, Mozambique, Cabo Verde.', complete: false },
  { id: 'hispanic', name: 'Spanish-speaking markets', country: '', source: '', note: 'Spain and Latin America.', complete: false },
  { id: 'arabic', name: 'Arabic-speaking markets', country: '', source: '', note: 'Gulf, Levant and North Africa.', complete: false },
  { id: 'asia', name: 'India, China and Asia-Pacific', country: '', source: '', note: 'Hindi, Chinese and English-speaking Asia.', complete: false },
];

const TEXT = `
@GH
bank: GCB Bank [ghana-club-100]; Ecobank Ghana [ghana-club-100]; Absa Bank Ghana; Stanbic Bank Ghana [ghana-club-100]; Standard Chartered Bank Ghana; CalBank; Fidelity Bank Ghana; Republic Bank Ghana; Zenith Bank Ghana; Access Bank Ghana; First National Bank Ghana; Agricultural Development Bank; Prudential Bank; Societe Generale Ghana; United Bank for Africa Ghana; Consolidated Bank Ghana; OmniBSIC Bank Ghana; Guaranty Trust Bank Ghana; First Atlantic Bank; Bank of Africa Ghana; National Investment Bank; FBNBank Ghana [ghana-club-100]; Universal Merchant Bank; Bank of Ghana; GhIPSS; Zeepay [ghana-club-100]; MTN Mobile Money Ghana; Telecel Cash; AT Money Ghana; ExpressPay Ghana; Hubtel; GhanaPay
ins: Enterprise Group [ghana-club-100]; SIC Insurance; Star Assurance; Vanguard Assurance; Hollard Insurance Ghana; Glico Group; Activa International Insurance; Donewell Insurance; Allianz Insurance Ghana; Prudential Life Insurance Ghana; Metropolitan Life Ghana; Phoenix Insurance Ghana; Ghana Union Assurance; Sunu Assurances Ghana; Quality Insurance Company; Provident Insurance; Imperial General Assurance; Best Assurance; NSIA Insurance Ghana; Loyalty Insurance; Acacia Health Insurance; Apex Health Insurance; Nationwide Medical Insurance; Premier Health Insurance; Cosmopolitan Health Insurance; Ghana Medical Trust Fund (Mahama Cares); MSH International; National Health Insurance Authority; National Insurance Commission
hosp: Korle Bu Teaching Hospital; Komfo Anokye Teaching Hospital; Tamale Teaching Hospital; Cape Coast Teaching Hospital; Ho Teaching Hospital; 37 Military Hospital; Greater Accra Regional Hospital (Ridge); Nyaho Medical Centre; Lister Hospital; Euracare Advanced Diagnostic and Heart Centre; Trust Hospital; Akai House Clinic; Cocoa Clinic; Bank Hospital; Medifem Hospital; Ghana Health Service
ehr: Lightwave Health Information Management System (LHIMS)
org: Newmont Ghana Gold [ghana-club-100]; Scancom PLC (MTN Ghana) [ghana-club-100]; Amanex Company [ghana-club-100]; Gold Fields Ghana [ghana-club-100]; AngloGold Ashanti Ghana [ghana-club-100]; Dansworld International Services [ghana-club-100]; Abosso Goldfields [ghana-club-100]; Benso Oil Palm Plantation [ghana-club-100]
@NG
bank: Access Bank [nse-ng]; Zenith Bank [nse-ng]; Guaranty Trust Bank [nse-ng]; United Bank for Africa [nse-ng]; First Bank of Nigeria [nse-ng]; Stanbic IBTC [nse-ng]; Fidelity Bank Nigeria [nse-ng]; FCMB [nse-ng]; Wema Bank [nse-ng]; Sterling Bank [nse-ng]; Ecobank Nigeria [nse-ng]; Union Bank of Nigeria [nse-ng]; Polaris Bank; Keystone Bank; Unity Bank; Jaiz Bank; Providus Bank; Kuda Bank; OPay; Moniepoint; PalmPay; Paystack; Flutterwave; Interswitch; NIBSS; Bank of Industry
ins: AXA Mansard [nse-ng]; Leadway Assurance [nse-ng]; AIICO Insurance [nse-ng]; NEM Insurance [nse-ng]; Custodian Investment [nse-ng]; Sovereign Trust Insurance; Cornerstone Insurance; Sunu Assurances Nigeria; Mutual Benefits Assurance; Hygeia HMO; Avon HMO; Reliance HMO; Clearline HMO; Leadway Health; Total Health Trust; Axa Mansard Health; AIICO Multishield; Police Health Maintenance; National Health Insurance Authority Nigeria; National Insurance Commission Nigeria
hosp: Lagoon Hospitals; Reddington Hospital; St. Nicholas Hospital; Evercare Hospital Lekki; Duchess International Hospital; Nisa Premier Hospital; Cedarcrest Hospitals; University College Hospital Ibadan; Lagos University Teaching Hospital; National Hospital Abuja; Aminu Kano Teaching Hospital; Ahmadu Bello University Teaching Hospital Zaria; Garki Hospital Abuja
ehr: Helium Health; MDaaS Global; Medsaf; Ilara Health
@KE
bank: KCB Group; Equity Group; Co-operative Bank of Kenya; NCBA Group; Absa Bank Kenya; Stanbic Bank Kenya; Standard Chartered Kenya; I&M Bank Kenya; DTB Kenya; Family Bank; Sidian Bank; Safaricom M-PESA; Central Bank of Kenya
ins: Jubilee Insurance; Britam; CIC Insurance Group; APA Insurance; AAR Insurance; Madison Insurance Kenya; Heritage Insurance; Old Mutual Kenya; Sanlam Kenya; Resolution Insurance; Minet Kenya; National Hospital Insurance Fund; Social Health Authority
hosp: Aga Khan University Hospital Nairobi; Nairobi Hospital; Kenyatta National Hospital; MP Shah Hospital; Mater Hospital; Gertrude's Children's Hospital; Karen Hospital; Avenue Healthcare; Coptic Hospital; Moi Teaching and Referral Hospital
ehr: Kenya EMR (KenyaEMR); Jacaranda Health; Avenue Health Systems
@TZ
bank: CRDB Bank; NMB Bank; National Bank of Commerce Tanzania; Stanbic Bank Tanzania; Exim Bank Tanzania; Equity Bank Tanzania; Azania Bank; Vodacom M-Pesa Tanzania; Bank of Tanzania
ins: National Insurance Corporation Tanzania; Jubilee Allianz Tanzania; Sanlam Tanzania; Britam Tanzania; Strategis Insurance; Tanzania Reinsurance Company; National Health Insurance Fund Tanzania; Tanzania Insurance Regulatory Authority
hosp: Muhimbili National Hospital; Aga Khan Hospital Dar es Salaam; Hindu Mandal Hospital; Benjamin Mkapa Hospital; Kilimanjaro Christian Medical Centre; Bugando Medical Centre
@UG
bank: Stanbic Bank Uganda; Centenary Bank; DFCU Bank; Absa Bank Uganda; Equity Bank Uganda; Standard Chartered Uganda; Bank of Uganda; MTN Mobile Money Uganda; Airtel Money Uganda
ins: Jubilee Insurance Uganda; UAP Old Mutual Uganda; Sanlam Uganda; Britam Uganda; National Insurance Corporation Uganda; AAR Uganda; Insurance Regulatory Authority of Uganda
hosp: Mulago National Referral Hospital; Nakasero Hospital; International Hospital Kampala; Kampala Hospital; Mengo Hospital; Nsambya Hospital
@RW
bank: Bank of Kigali; I&M Bank Rwanda; Equity Bank Rwanda; Access Bank Rwanda; National Bank of Rwanda; Rwanda Social Security Board; MTN MoMo Rwanda
ins: Sanlam Rwanda; Radiant Insurance; Prime Insurance Rwanda; Rwanda Social Security Board Medical Scheme; Mutuelle de Sante Rwanda
hosp: King Faisal Hospital Kigali; University Teaching Hospital of Kigali; Rwanda Military Hospital
@ZM
bank: Zanaco; Stanbic Bank Zambia; Absa Bank Zambia; First National Bank Zambia; Standard Chartered Zambia; Indo-Zambia Bank; MTN Zambia Mobile Money
ins: Madison Life Zambia; Hollard Zambia; Professional Insurance Corporation Zambia; ZSIC Life; NHIMA Zambia; Pensions and Insurance Authority Zambia
hosp: University Teaching Hospital Lusaka; Levy Mwanawasa Hospital; Cavendish University Hospital; Coptic Hospital Zambia; Konkola Hospital
@ZW
bank: CBZ Holdings; Stanbic Bank Zimbabwe; FBC Holdings; NMB Bank Zimbabwe; Steward Bank; Ecobank Zimbabwe; EcoCash
ins: First Mutual Holdings; Zimre Holdings; Old Mutual Zimbabwe; CIMAS Medical Aid; PSMAS; Premier Service Medical Aid Society; Liberty Life Zimbabwe
hosp: Parirenyatwa Group of Hospitals; Avenues Clinic; Wilkins Hospital; Mpilo Central Hospital
@MW
bank: National Bank of Malawi; Standard Bank Malawi; FDH Bank; NBS Bank; First Capital Bank Malawi; Airtel Money Malawi; TNM Mpamba
ins: NICO Holdings; Old Mutual Malawi; Sanlam Malawi; Hollard Malawi; Medical Aid Society of Malawi (MASM)
hosp: Kamuzu Central Hospital; Queen Elizabeth Central Hospital; Mwaiwathu Private Hospital
@BW
bank: First National Bank Botswana; Absa Bank Botswana; Stanbic Bank Botswana; Standard Chartered Botswana; Bank Gaborone
ins: Botswana Insurance Holdings; Botswana Life Insurance; Sanlam Botswana; Metropolitan Botswana; Bomaid Medical Aid; Botsogo Health Plan
hosp: Princess Marina Hospital; Bokamoso Private Hospital; Sidilega Private Hospital
@NA
bank: First National Bank Namibia; Standard Bank Namibia; Bank Windhoek; Nedbank Namibia; Bank of Namibia
ins: Sanlam Namibia; Old Mutual Namibia; Namibia Medical Care; Medical Aid Fund Namibia; Metropolitan Namibia
hosp: Windhoek Central Hospital; Mediclinic Windhoek; Roman Catholic Hospital Windhoek
@SL
bank: Rokel Commercial Bank; Sierra Leone Commercial Bank; Ecobank Sierra Leone; Guaranty Trust Bank Sierra Leone; Orange Money Sierra Leone
ins: Sierra Leone Insurance Company; WAICA Reinsurance Corporation; Sierra Leone National Insurance
hosp: Connaught Hospital; 34 Military Hospital Freetown
@GM
bank: Trust Bank Gambia; Guaranty Trust Bank Gambia; Ecobank Gambia; Zenith Bank Gambia; Access Bank Gambia
ins: Gambia National Insurance Company; Gambia Insurance Company
hosp: Edward Francis Small Teaching Hospital
@CM
bank: Afriland First Bank; Societe Generale Cameroun; Ecobank Cameroon; Commercial Bank of Cameroon; Union Bank of Cameroon; Orange Money Cameroun; MTN Mobile Money Cameroon
ins: Activa Assurances Cameroun; Saham Assurance Cameroun; Chanas Assurances; NSIA Assurances Cameroun
hosp: Hopital General de Yaounde; Hopital Laquintinie Douala; Hopital Central de Yaounde
@MU
bank: Mauritius Commercial Bank; State Bank of Mauritius; Bank One; SBM Holdings; Absa Mauritius; Standard Chartered Mauritius
ins: Swan Group; Mauritius Union Assurance; Sicom; Sun Insurance Mauritius; Island Life Assurance
hosp: Apollo Bramwell Hospital; Clinique Darne; Wellkin Hospital; Fortis Clinique Darne; Victoria Hospital Mauritius
@ZA
bank: Standard Bank Group; FirstRand; Absa Group; Nedbank; Capitec; Investec; African Bank; TymeBank; Discovery Bank; Old Mutual Bank
ins: Discovery Health; Sanlam; Old Mutual; Momentum Metropolitan; Liberty Holdings; Santam; Hollard; Bonitas Medical Fund; GEMS Government Employees Medical Scheme; Medscheme; Medihelp
hosp: Netcare; Mediclinic Southern Africa; Life Healthcare; Lenmed; Busamed; Chris Hani Baragwanath Hospital
ehr: Medikredit; Healthbridge; MediSwitch; Altron HealthTech; Dentally; Meditech South Africa
core: Sybrin; Capitec Technology; Temenos South Africa; Finastra South Africa
@MZ
bank: Millennium bim; Standard Bank Mozambique; BCI Moçambique; Absa Bank Moçambique; Moza Banco; Banco Nacional de Investimento; M-Pesa Mozambique; e-Mola
ins: Emose; Hollard Moçambique; Fidelidade Moçambique; Seguradora Internacional de Moçambique; Sanlam Moçambique
hosp: Hospital Central de Maputo; Clinica Sommerschield; Hospital Privado de Maputo
@AO
bank: Banco BAI; Banco de Fomento Angola; Banco Millennium Atlântico; Standard Bank Angola; Banco Angolano de Investimentos; Banco Económico; Unitel Money
ins: ENSA Seguros de Angola; Fidelidade Angola; Nossa Seguros; Global Seguros; Sanlam Angola
hosp: Clínica Girassol; Clínica Sagrada Esperança; Hospital Américo Boavida
@CV
bank: Banco Comercial do Atlântico; Caixa Económica de Cabo Verde; Banco Interatlântico; Banco Cabo-verdiano de Negócios; Ecobank Cabo Verde
ins: Garantia Seguros; Impar Seguros; Aliança Seguradora
hosp: Hospital Agostinho Neto; Hospital Baptista de Sousa
@SN
bank: Ecobank Senegal; CBAO Groupe Attijariwafa; Societe Generale Senegal; BICIS; Banque Atlantique Senegal; Orange Money Senegal; Wave Senegal
ins: Sunu Assurances Senegal; Allianz Senegal; AXA Assurances Senegal; Saham Assurance Senegal; NSIA Senegal; La Sunu Santé; Institution de Prevoyance Maladie
hosp: Hopital Principal de Dakar; Hopital Le Dantec; Hopital Fann; Clinique Cheikh Zaid
@CI
bank: Societe Generale Cote d'Ivoire; NSIA Banque; Ecobank Cote d'Ivoire; Bank of Africa Cote d'Ivoire; Banque Atlantique Cote d'Ivoire; Orange Money Cote d'Ivoire; Wave Cote d'Ivoire; BOA Group
ins: NSIA Assurances; Sunu Assurances Cote d'Ivoire; Allianz Cote d'Ivoire; Saham Assurance Cote d'Ivoire; Sanlam Cote d'Ivoire; Axa Cote d'Ivoire; Mutuelle Generale des Fonctionnaires de Cote d'Ivoire (MUGEFCI)
hosp: CHU de Cocody; CHU de Treichville; Polyclinique Internationale Sainte Anne-Marie; Pisam
@TG
bank: Ecobank Togo; Orabank Togo; Banque Atlantique Togo; BIA Togo; Banque Populaire pour l'Epargne et le Credit
ins: Sunu Assurances Togo; NSIA Togo; Allianz Togo; Saham Assurance Togo
hosp: CHU Sylvanus Olympio; CHU Campus Lome
@BJ
bank: Ecobank Benin; Societe Generale Benin; Banque Atlantique Benin; Bank of Africa Benin; Orabank Benin
ins: Sunu Assurances Benin; NSIA Benin; Saham Assurance Benin; Allianz Benin
hosp: CNHU-HKM Cotonou
@BF
bank: Coris Bank International; Ecobank Burkina Faso; Societe Generale Burkina Faso; Bank of Africa Burkina Faso; Orabank Burkina
ins: Sunu Assurances Burkina; NSIA Burkina; Saham Assurance Burkina; Allianz Burkina
hosp: CHU Yalgado Ouedraogo
@ML
bank: Banque Malienne de Solidarite; Ecobank Mali; Bank of Africa Mali; Societe Generale Mali; Orange Money Mali
ins: Sunu Assurances Mali; NSIA Mali; Saham Assurance Mali
hosp: Hopital du Mali
@NE
bank: Ecobank Niger; Bank of Africa Niger; Orabank Niger; Banque Atlantique Niger
ins: Sunu Assurances Niger; Saham Assurance Niger; NSIA Niger
hosp: Hopital National de Niamey
@GA
bank: BGFIBank; Union Gabonaise de Banque; Orabank Gabon; Ecobank Gabon; Societe Generale Gabon
ins: Ogar Assurances; Colina Gabon; Saham Assurance Gabon; Sanlam Gabon
hosp: Centre Hospitalier Universitaire de Libreville
@CD
bank: Rawbank; Equity BCDC; Trust Merchant Bank; Ecobank DR Congo; Access Bank DR Congo; Orange Money RDC; M-Pesa DRC
ins: Sonas; Activa Assurances RDC; Rawsur
hosp: Cliniques Universitaires de Kinshasa; Hopital du Cinquantenaire
@ET
bank: Commercial Bank of Ethiopia; Awash Bank; Dashen Bank; Bank of Abyssinia; Zemen Bank; Telebirr Ethiotelecom
ins: Ethiopian Insurance Corporation; Awash Insurance; Nyala Insurance; Abay Insurance; Africa Insurance Company Ethiopia
hosp: Tikur Anbessa Specialized Hospital; St. Paul's Hospital Millennium Medical College; Hallelujah Hospital
@DZ
bank: Banque Nationale d'Algerie; Banque Exterieure d'Algerie; Credit Populaire d'Algerie; Banque de l'Agriculture et du Developpement Rural; Societe Generale Algerie; BNP Paribas El Djazair
ins: Saa Societe Nationale d'Assurance; CAAR; CAAT; CIAR; Trust Algeria; Axa Algerie; Allianz Algerie; Cardif El Djazair; GAM Assurances
hosp: CHU Mustapha Alger; Clinique Chahrazed; Centre Pierre et Marie Curie
@MA
bank: Attijariwafa Bank; Banque Populaire du Maroc; Bank of Africa BMCE; Credit Agricole du Maroc; Societe Generale Maroc; CIH Bank; Credit du Maroc; BMCI; Al Barid Bank
ins: Wafa Assurance; RMA; AXA Assurance Maroc; Sanlam Maroc; Atlanta Sanad; Saham Assurance; Allianz Maroc; Mutuelle Agricole Marocaine d'Assurance (MAMDA); CNSS Maroc; CNOPS
hosp: CHU Ibn Rochd Casablanca; Clinique Internationale Marrakech; Hopital Cheikh Zaid Rabat; Akdital Group; Clinique Al Madina Casablanca
@TN
bank: Banque de Tunisie; BIAT; Attijari Bank Tunisie; Amen Bank; STB Societe Tunisienne de Banque; Banque Zitouna; UIB; Banque de l'Habitat; Orange Money Tunisie
ins: STAR Societe Tunisienne d'Assurances et de Reassurances; Comar; GAT Groupe des Assurances de Tunisie; Maghrebia; Lloyd Tunisien; Assurances BIAT; CNAM Tunisie
hosp: Hopital Charles Nicolle; Clinique Les Berges du Lac; Hopital La Rabta; Clinique El Manar
@EG
bank: National Bank of Egypt; Banque Misr; Commercial International Bank Egypt; QNB Alahli; Banque du Caire; Faisal Islamic Bank of Egypt; Fawry; Vodafone Cash Egypt
ins: Misr Insurance; Allianz Egypt; AXA Egypt; MetLife Egypt; GIG Egypt; Bupa Egypt; Egyptian Life Takaful; Orient Takaful Insurance; Medcare Egypt; Universal Health Insurance Authority
hosp: Dar Al Fouad Hospital; Cleopatra Hospitals Group; Saudi German Hospital Cairo; Ain Shams University Hospitals; Kasr Al Ainy Hospital; Andalusia Health Group; Al Ahly Hospital Cairo
ehr: Vezeeta; Chefaa; Cerner Egypt
@SA
bank: Al Rajhi Bank; Saudi National Bank; Riyad Bank; Banque Saudi Fransi; Saudi Awwal Bank; Arab National Bank; Bank AlBilad; Alinma Bank; STC Pay; Saudi Payments
ins: Bupa Arabia; Tawuniya; Medgulf; Malath Insurance; Al Rajhi Takaful; Walaa Insurance; Allianz Saudi Fransi; Council of Health Insurance Saudi Arabia
hosp: King Faisal Specialist Hospital; Dr. Sulaiman Al Habib Medical Group; Saudi German Health; Mouwasat Medical Services; Dallah Healthcare; Almoosa Health
ehr: Nupco; Lean Business Services; Altibbi
@AE
bank: First Abu Dhabi Bank; Emirates NBD; Abu Dhabi Commercial Bank; Dubai Islamic Bank; Mashreq Bank; RAKBANK; Emirates Islamic; Commercial Bank of Dubai; Mashreq Neo; Wio Bank
ins: Daman; Sukoon Insurance; Orient Insurance; Oman Insurance; AXA Gulf; GIG Gulf; Dubai Insurance; Bupa Global Middle East; MetLife Gulf; Neuron; Nextcare
hosp: Cleveland Clinic Abu Dhabi; PureHealth; M42; NMC Healthcare; Mediclinic Middle East; Aster DM Healthcare; American Hospital Dubai; Burjeel Holdings; Emirates Health Services
ehr: Malaffi Health Information Exchange; Riayati; Oracle Health Middle East
@QA
bank: Qatar National Bank; Commercial Bank of Qatar; Doha Bank; Qatar Islamic Bank; Masraf Al Rayan; Dukhan Bank; Ahli Bank Qatar
ins: Qatar Insurance Company; Doha Insurance; Qatar General Insurance and Reinsurance; Al Khaleej Takaful; Damaan Islamic Insurance
hosp: Hamad Medical Corporation; Sidra Medicine; Al Ahli Hospital Qatar; Aspetar; Primary Health Care Corporation Qatar
@JO
bank: Arab Bank; Housing Bank for Trade and Finance; Jordan Kuwait Bank; Capital Bank of Jordan; Bank al Etihad
ins: Jordan Insurance Company; Arab Orient Insurance; Middle East Insurance; Medgulf Jordan; Jordan French Insurance
hosp: Jordan Hospital; Specialty Hospital Amman; King Hussein Cancer Center; Istishari Hospital
@KW
bank: National Bank of Kuwait; Kuwait Finance House; Gulf Bank; Burgan Bank; Commercial Bank of Kuwait; Warba Bank
ins: Gulf Insurance Group; Kuwait Insurance Company; Warba Insurance and Reinsurance; Al Ahleia Insurance; Kuwait Reinsurance
hosp: Dar Al Shifa Hospital; Mubarak Al-Kabeer Hospital; Royale Hayat Hospital
@US
bank: JPMorgan Chase [fortune500]; Bank of America [fortune500]; Citigroup [fortune500]; Wells Fargo [fortune500]; Goldman Sachs [fortune500]; Morgan Stanley [fortune500]; U.S. Bancorp [fortune500]; PNC Financial Services [fortune500]; Truist Financial [fortune500]; Capital One [fortune500]; Charles Schwab [fortune500]; American Express [fortune500]; Fifth Third Bancorp; KeyCorp; Regions Financial; M&T Bank; Citizens Financial Group; Ally Financial; Discover Financial; Synchrony; PayPal; Block (Square, Cash App); Visa; Mastercard; Western Union; MoneyGram; Remitly; Chime; SoFi; LendingClub
ins: UnitedHealth Group [fortune500]; CVS Health (Aetna) [fortune500]; Elevance Health [fortune500]; Cigna [fortune500]; Centene [fortune500]; Humana [fortune500]; Molina Healthcare [fortune500]; State Farm [fortune500]; Allstate [fortune500]; Progressive [fortune500]; MetLife [fortune500]; Prudential Financial [fortune500]; American International Group (AIG) [fortune500]; Travelers [fortune500]; Liberty Mutual [fortune500]; Nationwide [fortune500]; USAA [fortune500]; New York Life [fortune500]; Massachusetts Mutual (MassMutual) [fortune500]; Northwestern Mutual [fortune500]; TIAA [fortune500]; Lincoln National [fortune500]; Principal Financial Group [fortune500]; Aflac [fortune500]; The Hartford [fortune500]; Unum Group; Blue Cross Blue Shield Association; Kaiser Permanente; Health Care Service Corporation; Oscar Health; Bright Health; Clover Health; Chubb; Berkshire Hathaway [fortune500]
hosp: HCA Healthcare [fortune500]; Tenet Healthcare [fortune500]; Community Health Systems [fortune500]; Universal Health Services [fortune500]; CommonSpirit Health; Ascension; Providence; Mayo Clinic; Cleveland Clinic; Johns Hopkins Medicine; Mass General Brigham; Trinity Health; Advocate Health; Sutter Health
ehr: Epic Systems; Oracle Health (Cerner); MEDITECH; athenahealth; eClinicalWorks; NextGen Healthcare; Veradigm; ModMed; Greenway Health; CureMD; Netsmart; PointClickCare
adj: Rx Info Systems; Optum (UnitedHealth); Change Healthcare; Cognizant TriZetto [fortune500]; Availity; Waystar; R1 RCM; HealthEdge; Zelis; Cotiviti; Conduent; Gainwell Technologies
core: Fiserv [fortune500]; Fidelity National Information Services (FIS) [fortune500]; Jack Henry & Associates; Oracle [fortune500]; Q2 Holdings; nCino; Alkami; Finastra USA; Temenos USA
org: Amazon [fortune500]; Walmart [fortune500]; Apple [fortune500]; Alphabet [fortune500]; McKesson [fortune500]; Cencora [fortune500]; Microsoft [fortune500]; Costco [fortune500]; Cardinal Health [fortune500]; Nvidia [fortune500]; ExxonMobil [fortune500]
@CA
bank: Royal Bank of Canada; Toronto-Dominion Bank; Scotiabank; Bank of Montreal; Canadian Imperial Bank of Commerce; National Bank of Canada; Desjardins Group
ins: Manulife; Sun Life Financial; Great-West Lifeco; Intact Financial; Canada Life; Co-operators; Blue Cross Canada; Ontario Health Insurance Plan
hosp: University Health Network; Sunnybrook Health Sciences Centre; Providence Health Care Vancouver; McGill University Health Centre
ehr: Telus Health; Cerner Canada; OSCAR EMR; Nuance Canada
@GB
bank: Barclays [ftse100]; HSBC [ftse100]; Lloyds Banking Group [ftse100]; NatWest Group [ftse100]; Standard Chartered [ftse100]; Santander UK; Nationwide Building Society; Monzo; Starling Bank; Wise; Metro Bank; Virgin Money
ins: Aviva [ftse100]; Legal & General [ftse100]; Prudential plc [ftse100]; Phoenix Group [ftse100]; M&G [ftse100]; Admiral Group [ftse100]; Direct Line Group [ftse100]; Hiscox [ftse100]; Beazley [ftse100]; Lloyd's of London; Bupa; AXA Health UK; Vitality; Aviva Health UK; WPA; Simplyhealth; Zurich UK
hosp: NHS England; Spire Healthcare; Circle Health Group; HCA Healthcare UK; Nuffield Health; BMI Healthcare; Ramsay Health Care UK
ehr: EMIS Health; TPP SystmOne; Cerner UK; System C; Oracle Health UK; InterSystems UK; Cegedim Healthcare Solutions UK
core: Temenos UK; Finastra UK; Mambu UK; Thought Machine; 10x Banking; Oracle Financial Services UK
@IE
bank: Bank of Ireland; Allied Irish Banks; Permanent TSB; Ulster Bank
ins: Irish Life; FBD Insurance; Laya Healthcare; VHI Healthcare; Irish Life Health; Zurich Ireland
hosp: Beaumont Hospital; St James's Hospital Dublin; Mater Misericordiae University Hospital
@CY
bank: Bank of Cyprus; Hellenic Bank; Eurobank Cyprus; Alpha Bank Cyprus
ins: Eurolife Cyprus; Universal Life
hosp: Aretaeio Hospital; American Medical Center Cyprus; Evangelismos Medical Centre
@MT
bank: Bank of Valletta; HSBC Malta; APS Bank; Lombard Bank
ins: Atlas Insurance; MAPFRE Middlesea; Gasan Zammit; Hospital Insurance Malta
hosp: Mater Dei Hospital; St James Hospital Malta
@FR
bank: BNP Paribas [cac40]; Société Générale [cac40]; Crédit Agricole [cac40]; Groupe BPCE; Crédit Mutuel; La Banque Postale; Natixis; Crédit Industriel et Commercial; Boursorama; Worldline [cac40]
ins: AXA [cac40]; CNP Assurances; Groupama; MAIF; MACIF; Covéa; Allianz France; Generali France; AG2R La Mondiale; Malakoff Humanis; Harmonie Mutuelle; MGEN; Klesia; Mutuelle Générale; Alan; Swisslife France; AXA Santé
hosp: Ramsay Santé; Elsan; Vivalto Santé; Unicancer; AP-HP Assistance Publique Hôpitaux de Paris; Hospices Civils de Lyon; Korian (Clariane); Orpea
ehr: Doctolib; Cegedim; Dedalus France; Maincare; Sopra Steria [cac40]; Capgemini [cac40]
core: Sopra Banking Software; Murex; Finastra France; Temenos France; Avaloq France
@BE
bank: KBC Group; BNP Paribas Fortis; Belfius; ING Belgium; Argenta
ins: Ageas; AG Insurance; Ethias; P&V; Partena; Christelijke Mutualiteiten; Solidaris
hosp: UZ Leuven; AZ Sint-Jan; Cliniques universitaires Saint-Luc
@CH
bank: UBS; Julius Baer; Zürcher Kantonalbank; PostFinance; Raiffeisen Switzerland
ins: Zurich Insurance Group; Swiss Re; Helvetia; Swiss Life; Baloise; Mobiliar; Helsana; CSS; Sanitas; Groupe Mutuel
hosp: Universitätsspital Zürich; Insel Gruppe; Hirslanden; Genolier; Lindenhofgruppe
ehr: Temenos; Avaloq; Abraxas; CGM Switzerland
core: Temenos; Avaloq; Crealogix; Finnova
@PT
bank: Caixa Geral de Depósitos [psi]; Millennium bcp [psi]; Novo Banco; Santander Totta; Banco BPI; Montepio; Banco CTT; ActivoBank
ins: Fidelidade [psi]; Tranquilidade; Ageas Portugal; Allianz Portugal; Médis; Multicare; AdvanceCare; Zurich Portugal; Generali Portugal
hosp: Luz Saúde; José de Mello Saúde (CUF); Lusíadas Saúde; Trofa Saúde; Hospital da Luz; SNS Serviço Nacional de Saúde
ehr: Glintt; Alert Life Sciences Computing; Siemens Healthineers Portugal; SPMS Serviços Partilhados do Ministério da Saúde; Medicineone
core: Sibs; Link Consulting; Critical Software
@ES
bank: Banco Santander [ibex35]; BBVA [ibex35]; CaixaBank [ibex35]; Banco Sabadell [ibex35]; Bankinter [ibex35]; Unicaja Banco [ibex35]; Abanca; Kutxabank; Ibercaja
ins: Mapfre [ibex35]; Mutua Madrileña; Sanitas; SegurCaixa Adeslas; Asisa; DKV Seguros; Occident; Allianz Spain; Mutualidad de la Abogacía; Caser
hosp: Quirónsalud; HM Hospitales; Vithas; Ribera Salud; HLA Grupo Hospitalario; Hospital Clinic Barcelona
ehr: Indra; Everis; Savia (Indra); Doctoralia; Cegedim Spain
core: Indra Banking; Isban (Santander Group Tech); Cecabank; Redsys
@DE
bank: Deutsche Bank [dax40]; Commerzbank [dax40]; DZ Bank; KfW; Landesbank Baden-Württemberg; Sparkassen-Finanzgruppe; Volksbanken Raiffeisenbanken; N26; ING Germany
ins: Allianz [dax40]; Munich Re [dax40]; Hannover Re [dax40]; Talanx; Generali Deutschland; Debeka; Barmenia; HUK-Coburg; ERGO; Techniker Krankenkasse; AOK; Barmer; DAK-Gesundheit; Signal Iduna; Gothaer
hosp: Helios Kliniken; Asklepios Kliniken; Sana Kliniken; Rhön-Klinikum; Charité Berlin; Fresenius [dax40]
ehr: SAP [dax40]; CompuGroup Medical; Siemens Healthineers [dax40]; Dedalus Germany; Meierhofer; Doctolib Germany
core: SAP Banking; Finanz Informatik; Atruvia; Wincor Nixdorf; Temenos Germany
@AT
bank: Erste Group; Raiffeisen Bank International; BAWAG Group; UniCredit Bank Austria; Oberbank
ins: Vienna Insurance Group; Uniqa; Generali Austria; Wiener Städtische; Allianz Austria; Österreichische Gesundheitskasse
hosp: AKH Wien; Vinzenz Gruppe; Barmherzige Brüder Österreich
@NL
bank: ING Group; ABN AMRO; Rabobank; Bunq; Triodos Bank
ins: Aegon; NN Group; Achmea; VGZ; CZ; Zilveren Kruis; Menzis; ASR Nederland; Allianz Benelux
hosp: Amsterdam UMC; Erasmus MC; Radboudumc
ehr: ChipSoft; Nedap Healthcare; Philips Healthcare; Topicus
core: Temenos Netherlands; Mambu Netherlands; Backbase
@IT
bank: UniCredit; Intesa Sanpaolo; Banco BPM; BPER Banca; Banca Monte dei Paschi di Siena; Mediobanca
ins: Generali; Unipol; Poste Vita; Allianz Italia; Reale Mutua; Cattolica
hosp: Gruppo San Donato; Humanitas; Policlinico Gemelli
@BR
bank: Itaú Unibanco; Bradesco; Banco do Brasil; Caixa Econômica Federal; Santander Brasil; BTG Pactual; Nubank; Banco Inter; PagBank
ins: Bradesco Seguros; SulAmérica; Porto Seguro; Amil; Unimed; Hapvida NotreDame Intermédica; Allianz Seguros Brasil; Tokio Marine Brasil; Mapfre Brasil
hosp: Rede D'Or São Luiz; Hospital Israelita Albert Einstein; Hospital Sírio-Libanês; Dasa; Fleury
ehr: Totvs; MV Sistemas; Philips Tasy; Pixeon; Conexa Saúde
core: Totvs Financial; Dock; Zoop
@MX
bank: BBVA México; Banorte; Banamex; Santander México; HSBC México; Scotiabank México; Inbursa; Nu México; Mercado Pago
ins: GNP Seguros; Axa México; Seguros Monterrey New York Life; MetLife México; Qualitas; Mapfre México; Seguros Atlas
hosp: Hospital Ángeles; Christus Muguerza; Hospital ABC; Médica Sur
@CO
bank: Bancolombia; Banco de Bogotá; Davivienda; Banco de Occidente; BBVA Colombia; Nequi; Daviplata
ins: Sura Colombia; Seguros Bolívar; Seguros Alfa; Allianz Colombia; Colsanitas; Sanitas EPS; Nueva EPS
hosp: Fundación Santa Fe de Bogotá; Clínica del Country; Hospital Pablo Tobón Uribe
@AR
bank: Banco de la Nación Argentina; Banco Galicia; Banco Santander Argentina; BBVA Argentina; Banco Macro; Mercado Pago Argentina; Ualá
ins: Swiss Medical; OSDE; Galeno; Sancor Seguros; La Caja; Federación Patronal; Provincia Seguros
hosp: Hospital Italiano de Buenos Aires; Hospital Alemán; Hospital Británico
@CL
bank: Banco de Chile; Banco Santander Chile; BCI; Banco Itaú Chile; BancoEstado; Scotiabank Chile
ins: Consorcio; Sura Chile; MetLife Chile; Chilena Consolidada; Isapre Colmena; Banmédica
hosp: Clínica Alemana; Clínica Las Condes; Hospital Clínico UC
@PE
bank: Banco de Crédito del Perú; BBVA Perú; Interbank; Scotiabank Perú; Banco de la Nación Perú; Yape
ins: Rímac Seguros; Pacífico Seguros; La Positiva; Mapfre Perú; EsSalud
hosp: Clínica Anglo Americana; Clínica Internacional; Hospital Nacional Cayetano Heredia
@IN
bank: State Bank of India; HDFC Bank; ICICI Bank; Axis Bank; Kotak Mahindra Bank; Punjab National Bank; Bank of Baroda; Canara Bank; IndusInd Bank; Yes Bank; Paytm Payments Bank; Airtel Payments Bank; NPCI; Razorpay; PhonePe
ins: Life Insurance Corporation of India; HDFC Life; SBI Life Insurance; ICICI Prudential Life; ICICI Lombard; Star Health and Allied Insurance; Niva Bupa; Bajaj Allianz; Care Health Insurance; New India Assurance; United India Insurance; National Insurance Company India; Ayushman Bharat PM-JAY National Health Authority; Medi Assist; Paramount Health Services; Health India TPA
hosp: Apollo Hospitals; Fortis Healthcare; Max Healthcare; Narayana Health; Manipal Hospitals; Medanta; Aster DM Healthcare India; AIIMS Delhi
ehr: Practo; eHealth Kerala; Eka Care; Tata 1mg; Healthplix
core: Infosys Finacle; TCS BaNCS; Oracle FLEXCUBE; Nucleus Software; EdgeVerve; Intellect Design Arena; Tech Mahindra; Wipro; HCLTech
@PK
bank: Habib Bank Limited; United Bank Limited; MCB Bank; Meezan Bank; Allied Bank; Bank Alfalah; Standard Chartered Pakistan; JazzCash; Easypaisa; NayaPay
ins: State Life Insurance Corporation; Jubilee Life Insurance; EFU Life; Adamjee Insurance; Pak-Qatar Family Takaful; IGI Life; TPL Insurance; Sehat Card Plus
hosp: Aga Khan University Hospital Karachi; Shaukat Khanum Memorial Cancer Hospital; Dow University Hospital; Shifa International Hospital
@BD
bank: Sonali Bank; Islami Bank Bangladesh; Dutch-Bangla Bank; BRAC Bank; City Bank; Eastern Bank; bKash; Nagad
ins: Jiban Bima Corporation; Delta Life Insurance; Pragati Life Insurance; MetLife Alico Bangladesh; Green Delta Insurance; Pioneer Insurance
hosp: Square Hospitals; United Hospital Dhaka; Evercare Hospital Dhaka; Dhaka Medical College Hospital
@LK
bank: Bank of Ceylon; People's Bank; Commercial Bank of Ceylon; Hatton National Bank; Sampath Bank; Seylan Bank
ins: Sri Lanka Insurance; Ceylinco Insurance; AIA Insurance Lanka; Softlogic Life; Allianz Lanka; Union Assurance
hosp: Nawaloka Hospitals; Asiri Health; Lanka Hospitals; Durdans Hospital
@SG
bank: DBS Group; OCBC; United Overseas Bank; Standard Chartered Singapore; GrabFin; Maybank Singapore
ins: Great Eastern; NTUC Income; Prudential Singapore; AIA Singapore; Manulife Singapore; Raffles Health Insurance; Singlife; Allianz Singapore
hosp: SingHealth; National University Health System; Raffles Medical Group; IHH Healthcare; Parkway Pantai
ehr: Synapxe; Integrated Health Information Systems
@MY
bank: Maybank; CIMB Group; Public Bank; RHB Bank; Hong Leong Bank; AmBank; Bank Islam; TNG Digital; Boost
ins: Great Eastern Malaysia; Etiqa; AIA Malaysia; Allianz Malaysia; Prudential Malaysia; Zurich Malaysia; Takaful Malaysia; Tune Protect
hosp: IHH Healthcare Malaysia; KPJ Healthcare; Sunway Medical Centre; Columbia Asia
@HK
bank: HSBC Hong Kong; Hang Seng Bank; Bank of China Hong Kong; Standard Chartered Hong Kong; ZA Bank; Airstar
ins: AIA Group; Prudential Hong Kong; Manulife Hong Kong; FWD; Bupa Hong Kong; Cigna Hong Kong; Sun Life Hong Kong; Zurich Hong Kong
hosp: Hospital Authority Hong Kong; Hong Kong Sanatorium; Gleneagles Hong Kong
@CN
bank: Industrial and Commercial Bank of China [asia]; China Construction Bank [asia]; Agricultural Bank of China [asia]; Bank of China [asia]; Bank of Communications; China Merchants Bank; Ping An Bank; WeBank; Ant Group; Tencent Wealth
ins: Ping An Insurance [asia]; China Life Insurance [asia]; People's Insurance Company of China (PICC); China Pacific Insurance (CPIC); New China Life; Sunshine Insurance; China Taiping; ZhongAn Online
hosp: Fosun Health; Peking Union Medical College Hospital; Huaxi Hospital Sichuan; Mindray; United Family Healthcare
ehr: Winning Health; Neusoft Medical; Yidu Cloud; Kingdee; Yonyou
core: Sunline Technology; Kingdee Financial; Hundsun; Yucheng Technologies
@AU
bank: Commonwealth Bank of Australia; Westpac; ANZ; National Australia Bank; Macquarie Group; Bendigo and Adelaide Bank; Bank of Queensland; Judo Bank
ins: Medibank; NIB Holdings; Bupa Australia; HCF; Suncorp; IAG Insurance Australia Group; QBE Insurance; AIA Australia; TAL; Allianz Australia; Australian Unity
hosp: Ramsay Health Care; Healthscope; Epworth HealthCare; St Vincent's Health Australia; Monash Health
ehr: Cerner Australia; Best Practice Software; Medical Director; Telstra Health; Genie Solutions
core: Temenos Australia; Mambu Australia; Data Action; Fiserv Australia
@NZ
bank: ANZ New Zealand; ASB Bank; BNZ; Westpac New Zealand; Kiwibank
ins: Southern Cross Health Society; Accuro; NIB New Zealand; AIA New Zealand; Fidelity Life; Partners Life; Tower Insurance; IAG New Zealand; ACC
hosp: Te Whatu Ora Health New Zealand; Southern Cross Hospitals; Ascot Hospital; Mercy Hospital Auckland
@JM
bank: National Commercial Bank Jamaica; Scotiabank Jamaica; JMMB Group; Sagicor Bank Jamaica; First Global Bank; JN Bank; Bank of Jamaica
ins: Sagicor Group Jamaica; Guardian Life Jamaica; Advantage General Insurance; Jamaica National Life; Canopius Jamaica; National Health Fund Jamaica
hosp: University Hospital of the West Indies; Medical Associates Hospital; Andrews Memorial Hospital; Spanish Town Hospital
@TT
bank: Republic Financial Holdings; First Citizens Bank Trinidad; Scotiabank Trinidad and Tobago; Royal Bank of Trinidad and Tobago; JMMB Trinidad; Bank of Trinidad and Tobago
ins: Guardian Holdings; Sagicor Life Trinidad; Assuria Trinidad; Clico Trinidad; Colonial Life Insurance Trinidad
hosp: Port of Spain General Hospital; Eric Williams Medical Sciences Complex; St. Clair Medical Centre; Mount Hope Women's Hospital
`;

function parse() {
  const out = []; let cc = '';
  for (const raw of TEXT.split('\n')) {
    const line = raw.trim(); if (!line) continue;
    if (line[0] === '@') { cc = line.slice(1).trim(); continue; }
    const m = line.match(/^(\w+):\s*(.*)$/); if (!m || !TYPE[m[1]]) continue;
    for (const piece of m[2].split(';')) {
      const t = piece.trim(); if (!t) continue;
      const g = t.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
      const name = (g ? g[1] : t).trim(); const tags = g ? g[2].split(',').map((x) => x.trim()).filter(Boolean) : [];
      out.push({ name, type: TYPE[m[1]], cc, tags });
    }
  }
  return out;
}
module.exports = { PACKS, orgs: parse() };
