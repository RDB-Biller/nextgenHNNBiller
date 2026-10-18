'use strict';

/**
 * Value propositions for outreach segments, each in two sizes: a SUMMARY (what goes in the first email and on one screen)
 * and DETAILS (the full case: who we are, why them, what we offer, what we ask, how to try it, what we will not do).
 * Master Control > Outreach shows both. The association text is written for NABIP (the National Association of Benefits
 * and Insurance Professionals) and for any similar trade body.
 *
 * It sticks to what HNN Biller actually does. It does not claim ACA or US-market expertise, and it does not use the
 * recipient's role (for example Government Affairs) as a pretext: the first email asks to be pointed to the right person.
 */
const ASSOCIATION = {
  segment: 'association',
  title: 'Associations of insurance and benefits professionals (NABIP)',
  audience: 'Trade bodies whose members are licensed agents, brokers, general agents, consultants and benefits professionals.',
  subject: 'A short introduction for {org}: health billing and patient-finance tools, and who to speak to',
  summary: {
    headline: 'A free sandbox, a knowledge exchange and a referral route for your members, with nothing to buy.',
    points: [
      'HNN Biller bills patients at the point of care and settles insurer-, employer- and patient-paid claims account to account. We never hold the money.',
      'Your members run benefits administration and billing consolidation every day. We want their view on what our claims and settlement tools are missing.',
      'Members whose clients have family or health needs in Ghana and wider Africa get a route to hospitals, savings plans and small emergency loans paid straight to the provider.',
      'The ask is small: a 20-minute conversation, or a pointer to whoever handles partnerships and member programmes.',
    ],
  },
  details: [
    { heading: 'Who we are', items: [
      'HNN Biller is billing and settlement software for hospitals, insurers and employers. A bill is raised, routed to the person or company paying, authorised and settled account to account. The platform never holds funds; it bills, routes, authorises, reconciles and notifies.',
      'TrimesterSave and BirthPrep help families save for a delivery or a planned procedure. InsureCredit and ERHEAT Shield offer small loans for a medical bill or an emergency, paid by the lender straight to the hospital, landlord, school or vendor, never to the borrower.',
      'We work first in Ghana and are opening other African markets.'] },
    { heading: 'Why NABIP', items: [
      'NABIP represents more than 100,000 licensed health insurance agents, brokers, general agents, consultants and benefit professionals through more than 200 chapters. Your members handle plan selection, employee benefits, COBRA and HIPAA administration, and the "nagging billing reconciliations" that employers dread.',
      'That is the same problem our claims, billing-consolidation and settlement tools address in a different market. Practitioners like your members can tell us quickly where our approach is naive.'] },
    { heading: 'What we can offer your members', items: [
      'A free, no-commitment sandbox. Raise a bill, route it to a payer, see an authorised settlement and the audit trail. Two minutes, no sign-up.',
      'A knowledge exchange: a short webinar or chapter session on how health financing and claims settlement work in emerging markets, and a chance for members to critique our design.',
      'A referral route: members whose clients (or clients’ families) need care in Ghana or elsewhere in Africa can introduce them to participating hospitals, a savings plan for planned care, and small loans paid directly to the provider. Referral points are tracked and rewards are agreed in writing.',
      'Co-created content: plain-language guides on employer-paid claims, settlement cycles and reconciliation that your education team can adapt.'] },
    { heading: 'What we are asking', items: [
      'Not a sponsorship and not an endorsement. First, to be pointed to whoever leads partnerships, member programmes or education at NABIP.',
      'Second, if there is interest, a 20-minute call to hear what members find hard in billing and reconciliation, and to show the sandbox.',
      'Third, if it fits, a pilot: a small group of member agencies tries the sandbox and tells us what to change.'] },
    { heading: 'What we will not do', items: [
      'We will not market to your members through your lists without your agreement, and we will not describe NABIP as a partner or endorser unless you say so in writing.',
      'We do not offer insurance, give medical or legal advice, or claim expertise in ACA marketplace rules or other US regulation.',
      'We do not hold anyone’s money. Every message carries who we are and a one-click opt-out.'] },
    { heading: 'How to try it', items: [
      'Open the sandbox link in the email. Click New bill, fill it in, and open the payer routing and InsureCredit tabs.',
      'Tell us what is missing through the feedback link. Every answer is read by the founders.'] },
    { heading: 'Open questions for NABIP', items: [
      'Which member segments (small-group benefits, individual, Medicare, international) would care most?',
      'Is there a partnerships or member-benefits programme we should apply to?',
      'Would a chapter session or a webinar for members be welcome?'] },
  ],
};

const BANK = {
  segment: 'bank',
  title: 'Banks',
  audience: 'Retail and commercial banks, and bank groups, that want to offer savings and small loans through their own channels.',
  summary: {
    headline: 'Embedded savings and micro-credit your customers use from your app, USSD or mobile-money rails.',
    points: [
      'Goal-based savings plans and micro-loans, health first, then education, agriculture, transport, rent and energy (ERHEAT Shield).',
      'Credit demand is higher than savings demand, so we suggest credit first, with your credit-scoring partner.',
      'It plugs in by API, so you keep the customer and the balance-sheet decisions.'],
  },
  details: [
    { heading: 'What it is', items: ['A ready-to-embed finance layer for your app and USSD: goal-based savings plans and micro-loans triggered from verified bills and goals, delivered over REST APIs, webhooks, USSD and SMS/WhatsApp.'] },
    { heading: 'How it works', items: ['A third party who knows the need confirms it (landlord, clinician, bursar, vendor), the customer consents, and your bank receives a Verified-Need Packet. You decide credit and pay the payee, never the borrower. HNN never lends and never holds funds.'] },
    { heading: 'How to try it', items: ['The sandbox takes two minutes. Raise a bill, open the InsureCredit tab to see an offer, then register on the patient app and set up a savings plan.'] },
  ],
};

const VALUE = { association: ASSOCIATION, bank: BANK };
const get = (segment) => VALUE[segment] || null;
const list = () => Object.values(VALUE).map((v) => ({ segment: v.segment, title: v.title }));

/** The first email to an association: honest about the source, short, one clear ask. */
function associationEmail({ first, org, sandbox, feedback, sig }) {
  return {
    subject: ASSOCIATION.subject.replace('{org}', org),
    body: `Dear ${first},

I am writing because your address appears on a public NABIP post, and I would be grateful if you could point me to whoever leads partnerships or member programmes if that is not you.

I lead HNN Biller / TrimesterSave. We build billing and settlement software for hospitals, insurers and employers: bills are routed to whoever pays, authorised and settled account to account, and we never hold the money. We also offer patient savings plans and small loans paid straight to the provider.

Why ${org}: your members handle benefits administration and billing consolidation every day. We would value their view on what our claims and settlement tools are missing, and we would like to explore three things, none of which involves an endorsement:
1) a free sandbox your members can try in two minutes;
2) a short chapter session or webinar on how health financing and claims settlement work in emerging markets;
3) a referral route for members whose clients or their families need care in Ghana and wider Africa.

The sandbox: ${sandbox}
Tell us what is missing: ${feedback}

If a 20-minute call is easier, just reply with a time. If this is not for you, a forward to the right person would be very kind.

${sig}`,
  };
}

/** NABIP: the organisation and the public source for the contact. */
const NABIP = {
  org: { name: 'NABIP (National Association of Benefits and Insurance Professionals)', type: 'association', country: 'US', website: 'http://www.nabip.org', lists: ['nabip'],
    note: 'Trade body for more than 100,000 licensed health insurance agents, brokers, general agents, consultants and benefit professionals; 200+ chapters; Washington DC; non-profit; founded 1930. LinkedIn company page, About tab.' },
  contact: { name: 'Michael Andel', role: 'Senior Vice President of Government Affairs', email: 'mandel@nabip.org', persona: 'partnerships',
    source: 'NABIP LinkedIn post (about a week before 18 Oct 2026) naming Michael Andel, NABIP Senior Vice President of Government Affairs, at mandel@nabip.org as the contact for questionnaires' },
};

module.exports = { VALUE, get, list, associationEmail, NABIP };
