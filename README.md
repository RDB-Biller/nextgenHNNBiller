# Composite Billing & Settlement Platform

**The platform never custodies funds — it orchestrates, routes, and reconciles.**

Bills patients at the point of care and settles the money two ways, always paid
**directly to the clinic** (the platform is never in the flow of funds):

1. **Patient self-pay** — Mobile Money, card, or cash.
2. **Payer A2A (the USP)** — the patient names their **payer** and the clinic taps it.
   The bill is routed for validation, and the payer **moves money from its own
   Stanbic account straight to the clinic** on the patient's behalf (account-to-account
   over the Stanbic SBG rail). All parties are then notified.

A **payer** is whoever covers the bill: an **insurer** (Acacia, Cosmopolitan, GMTF (Mahama Cares), …) **or an
employer** that pays staff bills directly — the SME case where a company can't buy
insurance but still settles for its people. Same A2A mechanism for both.

```
 PATIENT ──(MoMo/card/cash)──────────▶ CLINIC account
 PAYER   ──(SBG A2A on tap/authorise)▶ CLINIC account   ◀── insurer OR employer
```

## Everyone connects by API or uses an optional front end

| Actor | Connect by API | Or use the hosted front end |
| --- | --- | --- |
| **Clinic / hospital** | `/api/v1/*` (their EHR/EMR) — key `x-api-key` | `/app/biller.html`, `/app/dashboard.html` |
| **Payer** (insurer RX / employer HR) | `/api/payer/*` — key `x-payer-key` | `/app/payers.html`, or the secure link `/claim/?token=…` |
| **Patient** | — | `/pay/?intent=…`, `/verify/?token=…` (confirm a bill), `/clinical/` (Value-Based-Care check-in — self-initiated, no link needed) |

Big institutions integrate API-to-API; small entities use the front ends. Same
backend, same actions, either way.

## Provisioning partner API keys

Issue a key for a clinic, payer (insurer/employer), or financier and hand it over:

```bash
# against your deployed DB (Railway):
railway run node scripts/provision.js list
railway run node scripts/provision.js tenant --name "City Clinic" --account 300591:0123456789 --email billing@city.example
railway run node scripts/provision.js payer  --name "NHIS" --kind insurer --source 1300100999 --email claims@nhis.gov.gh
railway run node scripts/provision.js financier --name "QuickLoan" --product momo_loan --source 1400200999
```

The command prints the key and the header to use. See the Partner Integration Guide.

## Run it

```bash
npm install
cp .env.example .env       # sandbox on — no bank creds needed
npm start
```

Demo path: open `http://localhost:4000/app/biller.html`, build a bill with a member
ID, tap a payer (insurer *or* employer), then open `/app/payers.html` (or the printed
secure link) and **Authorise** — watch it settle on `/app/dashboard.html` with the
notification fan-out. `npm run smoke` runs it over HTTP (needs `npm start` running
first). Six more smoke suites run in-process, no server/network needed: `npm run
smoke:verification` (patient verification, dashboard queue, reissue/override/prior
approvals, SMS/WhatsApp OTP + 2-way reply), `npm run smoke:messaging-live`
(credential encryption, the platform test account, and all three provider adapters,
against a mocked HTTP layer — see **SMS / WhatsApp verification** below), `npm run
smoke:operating-mode` (the sandbox/live confirmation gate, hybrid independence of
the two rails, and settlement credential resolution against a mocked Stanbic
transport — see **Operating mode** below), `npm run smoke:payer-commercial`
(payer edition/licence redemption and the per-claim commission's accrual + revenue
attribution — see **Payer commercial edition & commission** below), `npm run
smoke:pde` (observation ingestion, product validation, and all three product
types' scoring/reward math, including the null-vs-zero metric distinction and
period-window clipping — see **Product Development Environment** below), and `npm
run smoke:clinical-entry` (manual hospital entry, the OTP phone-link lifecycle,
every SMS/WhatsApp reading keyword and its condition auto-tagging, lockout/expiry,
STOP/HELP, and the lost-token re-request flow — see **Product Development
Environment** below).

## Clinic / EHR API (key `x-api-key: emr_demo_key_123`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/bills` | Create an itemised bill (patient, coverage, items, adjustments) — automatically sends the patient a verification link (`patientVerification` in the response) |
| POST | `/api/v1/bills/:id/route` | **Tap a payer** → claim + secure link |
| POST | `/api/v1/bills/:id/verification/reissue` | Resend the patient's verification link (`biller.html` shows it under the settle/route result, with a Resend link) |
| POST | `/api/v1/payments/intents` | Patient self-pay (mtn-momo / card / cash) |
| GET | `/api/v1/bills` · `/bills/:id` · `/claims` · `/dashboard` | Read |
| GET | `/api/v1/institutions` · `/account-validation` | SBG proxies |

## Payer API (key `x-payer-key`, e.g. `payer_acacia_key`, `payer_acme_key`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/payer/me` · `/summary` | Identity + KPIs |
| GET | `/api/payer/claims?status=pending` | Claims addressed to this payer |
| GET | `/api/payer/claims/:id` | Claim detail (member, lines, amount) |
| POST | `/api/payer/claims/:id/authorize` | Authorise the A2A transfer to the clinic — `409 patient_verification_pending` if this payer requires verification and the patient hasn't confirmed yet |
| POST | `/api/payer/claims/:id/reject` | Decline `{reason}` |
| POST | `/api/payer/claims/:id/verification/reissue` | Resend the patient's verification link |
| POST | `/api/payer/claims/:id/verification/override` | Mark verified without the patient's own confirmation — `{reason}` (reviewed directly, called the hospital, …) or `{priorApprovalId}` |
| GET, POST | `/api/payer/prior-approvals` | List / record a pre-authorization for a member (`{memberId, description, amountCap?, expiresAt?}`) |
| DELETE | `/api/payer/prior-approvals/:id` | Revoke one (only the payer who created it can) |

Secure link portal (token, no key): `GET /claim/api/:token`,
`POST /claim/api/:token/authorize|reject|verification/reissue|verification/override`.
Full contract in `openapi.yaml`.

## Patient bill verification

Every bill gets its own verification link the moment it's created — a courtesy step,
separate from claim routing, that never blocks billing. The patient opens
`/verify/?token=...` to confirm the charges or flag them as wrong (disputing notifies
the clinic). `biller.html` shows this link under the settle/route result (with a
**Resend** action) so hospital staff always have it to hand, since
`src/services/notifications.js` only logs a delivery record — there's no real SMS/email
gateway wired up yet.

A payer can opt into *requiring* verification before it will authorise —
`PUT /api/platform/payers/:id/require-verification {enabled}` (off by default, same
pattern as `reprice`). While a bill is unverified, the payer isn't stuck waiting on the
patient:

- **Reissue** — resend the same link (`POST .../verification/reissue`, from
  `payers.html`, `claim.html`, or the clinic side above). A disputed record resets to
  pending first.
- **Override** — mark it verified some other way (`POST .../verification/override`
  with a free-text `reason`): the payer looked at the claim directly, called the
  hospital, or is relying on a **prior approval** (below). Recorded as `verifiedBy:
  "payer_override"` or `"prior_approval"`, distinct from the patient's own
  `"patient"` confirmation.
- **Prior approval** — an insurer/employer can pre-authorise a member for a service
  ahead of time (`POST /api/payer/prior-approvals {memberId, description,
  amountCap?, expiresAt?}`). A later claim for that member surfaces any active,
  unexpired match as `matchingPriorApprovals` on the claim view, ready to reference
  by id in an override instead of typing a reason. Usage is tracked (`timesUsed`,
  `lastUsedClaimId`) but never hard-enforced — `amountCap`/`expiresAt` are
  informational, the payer's own judgement call. `src/services/priorApproval.js`.

Status is never duplicated onto the bill/claim; it's always read live from
`src/services/verification.js`. Portal: `GET /verify/api/:token`, `POST
/verify/api/:token/confirm|dispute` (patient-only — reissue/override are payer/clinic
actions, not exposed here).

**Known simplification:** verification is one record per *bill*, not per claim. On a
bill split across multiple payers, any one payer's override (or the patient's own
confirmation) satisfies the gate for all of them, since there's currently no way for
the patient to tell payers apart when confirming. Fine for the common case; a
per-payer verification record would be the next step if that turns out to matter.

The clinic dashboard (`dashboard.html`, `GET /api/v1/dashboard`) tracks whatever hasn't
been verified yet as a follow-up queue — `totals.pendingVerification` (count) and
`pendingVerifications[]` (oldest first, with patient/provider/amount/status/link).

### SMS / WhatsApp verification (optional)

Off for every channel, for every client, by default. A platform admin turns channels on
per client — `PUT /api/platform/clients/:id/verification-channels {sms?, whatsapp?,
includeTreatmentDetail?}` (`platform.html`, "Patient verification by SMS/WhatsApp" under
the **Messaging** tab). When a channel is on, the same verification message that carries the
link also goes out on SMS and/or WhatsApp, with a 6-digit one-time code the patient can
text back instead of opening the link. The code expires after
`VERIFICATION_OTP_TTL_MINUTES` (default 60 minutes) and locks after
`VERIFICATION_OTP_MAX_ATTEMPTS` (default 5) wrong guesses; once locked, only the web
link still works. Reissuing (above) always generates a fresh code, invalidating any
earlier one.

Replying **YES** (or `CONFIRM`/`OK`) confirms outright only when **exactly one**
verification is pending for that phone number. With two or more pending — e.g. the same
patient billed twice in one visit — a bare "yes" is ambiguous on purpose, so the patient
is asked for the specific code instead of risking the wrong bill getting confirmed. A
code is likewise only ever matched against that same phone's own pending verifications,
never across phone numbers, so a leaked or guessed code can't be replayed against
someone else's bill. Confirming this way is recorded as `verifiedVia: "sms"` or
`"whatsapp"` (vs `"web"` for the link), alongside the existing `verifiedBy: "patient"`.

Inbound replies land on `POST /api/v1/webhooks/messaging-inbound` — shared-secret
header (`x-webhook-secret`, checked against `MESSAGING_WEBHOOK_SECRET`, same pattern as
`/webhooks/collection`), provider-agnostic `{from, text, channel}` body with a couple of
common field-name aliases so a specific provider's webhook shape only needs a thin
translation layer in front, not a rewrite. Matching/lockout logic:
`src/services/verification.js#handleInboundReply`.

`includeTreatmentDetail` is a **separate** toggle, also off by default: leaving it off
keeps the SMS/WhatsApp text to just the amount and the link — the no-PHI rule below
stays true. Turning it on additionally lists the treatment/line items in the text
itself, which is the one deliberate, opt-in exception to that rule.

`src/services/messaging.js` wires in three real providers — **Twilio**, **Africa's
Talking**, and **Hubtel** — each a thin adapter over its own HTTP API. `send()` is
still the single seam every caller goes through; which credentials a given send
actually uses is resolved per-tenant by `resolveSender(tenant)`:

1. The client's **own** provider account, if it has turned on "bring your own
   credentials" and saved working credentials — always wins when configured
   (`PUT /api/platform/clients/:id/messaging-credentials`, the "Bring your own
   credentials" sub-section under each client's verification settings in
   `platform.html`'s **Messaging** tab).
2. Otherwise, the **platform-wide shared test account** — one set of real credentials
   HNN can activate for a live test and deactivate again when done, used by any client
   that hasn't set up its own (`PUT /api/platform/messaging/test-account`, the
   "Messaging test account" card in `platform.html`'s **Messaging** tab).
3. Otherwise, **sandbox** — logs the message instead of sending it.

All of that sits underneath the Messaging rail's sandbox/live switch — see
**Operating mode** below. While sandboxed, nothing above is ever actually sent, no
matter what's configured or activated; going live is a separate, one-click decision
from configuring either credential source, made from Master Control's Operating
Mode tab, not a redeploy. `GET /api/platform/messaging/providers` lists each
provider's required credential fields plus `encryptionConfigured`.

Provider credentials are the **one deliberate exception** to "secrets come from env
only" elsewhere in this app (see **Before production** below): a client's own account
can't be known at deploy time, so it has to be enterable at runtime. They're stored
**encrypted at rest** (AES-256-GCM, key derived from `CREDENTIAL_ENCRYPTION_KEY`; see
`src/services/credentials.js`) rather than in plaintext. Every API response shows only
`{provider, configured, hint, active|useOwnCredentials, updatedAt}` — a last-4-chars
hint, never the secret or the encrypted blob — and saving credentials fails with `422
credential_encryption_not_configured` rather than ever falling back to storing them
unencrypted if that env var isn't set.

In sandbox mode, `POST /api/v1/bills` and the reissue endpoint also echo the one-time
code back as `otpCodeSandbox`, and `biller.html`'s verification block adds a "simulate
patient reply" control, so the whole loop — dispatch, OTP, 2-way reply, ambiguity,
lockout — can still be demoed end-to-end without a real phone or provider. Configure
with `MESSAGING_SANDBOX`, `CREDENTIAL_ENCRYPTION_KEY`, `MESSAGING_WEBHOOK_SECRET`,
`PUBLIC_BASE_URL` (used to build the link inside the SMS/WhatsApp text),
`VERIFICATION_OTP_TTL_MINUTES`, `VERIFICATION_OTP_MAX_ATTEMPTS`.

**Honest per-provider confidence** — none of this could be exercised against a real
account from inside the environment this was built in (outbound network access there
is allowlisted to package registries and GitHub only; the adapters were instead tested
against a mocked HTTP layer, `_setRequestImplForTests` in `messaging.js`), so treat this
table as what to double-check first once it's live:

| Provider | SMS | WhatsApp |
| --- | --- | --- |
| **Twilio** | High confidence — the Messages resource is Twilio's oldest, most stable API | Supported — same endpoint, `whatsapp:` prefix on From/To |
| **Africa's Talking** | High confidence — confirmed against the official Python SDK's own source | Supported — confirmed against Africa's Talking's own WhatsApp API reference (`chat.africastalking.com`, supplied directly rather than guessed): text, image/video, template, and interactive buttons/list messages. Needs a separate `waNumber` (the account's WhatsApp-enabled sender) alongside the usual `apiKey`/`username` |
| **Hubtel** | Medium-high confidence — Basic Auth scheme and JSON request shape confirmed from Hubtel's own docs; the domain (`sms.hubtel.com`) is well triangulated but not independently confirmed from this environment | Not offered — Hubtel publishes no WhatsApp product; returns `provider_whatsapp_not_supported` |

Adding a fourth provider (e.g. Meta's WhatsApp Cloud API) means adding one function and
a line in `messaging.js`'s `ADAPTERS`/`PROVIDER_META`; nothing else in the flow changes.

## Money split

`subtotal − discount = net`. Patient pays `copay%` of net (minus cashback); the
**payer share** is the remainder and equals the claim amount. Example: 260 subtotal,
10% discount → 234 net, 20% copay → patient 46.80, payer 187.20.

## Source documents → code

| Source | Where |
| --- | --- |
| Item list (Coartem, FBC, GP Consultation) | `src/services/catalog.js` |
| Copay / cashback / discount math (TMS guide) | `src/services/billing.js` |
| Routing tabs → payers (insurers + employers) | `src/store.js`, `src/services/claims.js` |
| SBG login / validate / charge / disburse / status | `src/sbgClient.js` |
| Payer A2A transfer | `src/services/settlement.js` |
| Email/WhatsApp summaries (original page) | replaced by `src/services/notifications.js` |

## Architecture

```
src/
  server.js  config.js  sbgClient.js
  store.js   async repo: PostgreSQL pool OR in-memory (DATABASE_URL switches)
  seed.js    clinics / payers / financiers config
  services/  catalog billing claims settlement payments notifications
  routes/    bills payments claims dashboard institutions
             payerApi (x-payer-key)  claimPortal (token)  webhooks  checkout
public/      biller.html dashboard.html payers.html   (clinic + payer consoles)
             claim.html pay.html app.css              (secure link + patient)
```

## Optional: financing the patient's share

After a payer covers its part, the **patient's remaining share** can be financed instead
of paid out of pocket:

| Type | What happens |
| --- | --- |
| `momo_loan` / `bank_loan` | A lender disburses to the clinic over the A2A rail (micro / detailed report). |
| `employer_loan` | The employer lends the patient (A2A), repaid via payroll. |
| `grant` | A grant fund pays the clinic — no repayment. |
| `hospital_credit` | The hospital extends credit: **full**, or **part-payment now + remainder on credit**. |

Integrated financiers settle to the clinic the same way payers do (platform holds nothing);
referral partners (TrimesterSave, ConfirmU, PayAngel) hand off with the report attached.

### Medical report for due diligence

`POST /api/v1/financing/reports` builds a report from the bill — labs, medications, and
procedures are read straight off the line items and corroborated with the clinician's
diagnosis and a structured **Q&A** (`GET /api/v1/financing/questions?kind=micro|detailed`).
Small loans get a **micro** report; bigger ones a **detailed** one. A printable view is at
`/report/?token=…` (lender-shareable) or `/report/?id=…&key=…` (clinic). The report is
assembled from real inputs only and is flagged as requiring clinician sign-off.

**AI narrative:** the narrative is composed by `composeNarrative()` in
`src/services/medicalReport.js`. It's deterministic by default (runs offline); set
`composeNarrative.impl` to an LLM call (e.g. the Anthropic API) to generate richer prose
from the same structured facts.

### Financing endpoints (tenant key)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/financing/questions?kind=` | Clinical Q&A template |
| POST | `/api/v1/financing/reports` | Generate a micro/detailed medical report |
| GET | `/api/v1/financing/reports/:id` | Fetch a report |
| POST | `/api/v1/financing` | Create financing (loan / credit / grant) |
| GET | `/api/v1/financing/:id` | Financing status |

> Financing produces a **request and documentation**, not a credit decision; loan terms and
> approvals belong to the financier. Repayment mechanics are out of scope in this scaffold.

## Audit ledger & idempotency

**Append-only money ledger.** Every settlement writes an immutable `ledger` row in the
*same transaction* that updates the bill, so the books can't drift from the bill state.
Each entry records the type (`payer_settlement`, `financing_disbursement`,
`patient_payment`, `hospital_credit`), source, amount, currency, a `cashMovement` flag
(true for real transfers, false for credit/receivables), and references
(`serviceRequestId`, `reference`, `paymentId`, …) for reconciling against SBG history.
Entries are never updated or deleted — corrections are new compensating entries.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/ledger` | Recent ledger entries (`?limit=`) |
| GET | `/api/v1/ledger/summary` | Reconciliation totals by type (cash vs credit) |
| GET | `/api/v1/ledger/bill/:billId` | Entries for one bill |

**Idempotency keys.** Send an `Idempotency-Key` header on authorize/financing POSTs
(`/api/payer/claims/:id/authorize`, `/claim/api/:token/authorize`, `/api/v1/financing`).
The first request executes and its response is stored; a retry with the same key replays
the stored response instead of re-running (so a dropped connection won't double-charge).
A retry while the first is still running gets `409 request_in_progress`; the same key with
a different body gets `422 idempotency_key_reused`; a `5xx` releases the key for a genuine
retry. This complements the row-lock guard: locks stop double-execution inside the system,
idempotency keys dedupe client retries that arrive as separate HTTP requests.

## Revenue model (Admin / IT-lead console)

`/app/admin.html` (auth `x-admin-key`, env `ADMIN_API_KEY`) lets an IT lead program the
SaaS revenue model **per partner**. Rate caps are enforced server-side — the console
cannot exceed them.

| Rule | Basis | Cap | Charge to |
| --- | --- | --- | --- |
| `expedited_settlement` | payer share settled instantly | **15%** | insurer (reverse-bill), provider, or beneficiary entity (e.g. pharmacy) |
| `discount_fee` | value of the discount granted | **15%** | insurer, provider, or beneficiary |
| `claimit_margin` | NHIS/ClaimIt cashback refunded | 100% of cashback | member (netted from cashback), insurer, or provider |

Discounts are attributable by kind — `standard`, `referral` (patient referred another),
or `linked_payer` (a paying patient linked to an insured one) — set via
`adjustments.discountKind` on a bill, so referral programmes can be priced separately.

**Fees never touch the money flow.** Each fee is computed and **accrued to the
append-only ledger as a receivable** (`platform_fee_*`, `cashMovement: false`) owed by the
charged party, with the collection mode recorded (`reverse_bill`, `invoice`, or
`netted_from_cashback`). This preserves the guarantee that the platform never custodies funds.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/pricing/schema` | Rule types, caps, allowed charge targets |
| GET | `/api/admin/tenants` | Partners to configure |
| GET | `/api/admin/pricing/:tenantId` | Effective rules (saved or defaults) |
| PUT | `/api/admin/pricing/:tenantId/:type` | Program a rule (rate clamped to cap) |
| POST | `/api/admin/pricing/:tenantId/:type/preview` | Preview a fee, writes nothing |
| GET | `/api/admin/revenue/:tenantId` | Revenue by type from the ledger |

## NHIS ClaimIt tracker — two operating modes

The tracker follows an NHIS claim through to the refund a sponsoring insurer (e.g. Acacia)
pays back — up to **100%** of the NHIS amount. That refund becomes the member's **cashback**,
and the configured `claimit_margin` rule is accrued as revenue. Both modes are fully supported:

**A. Routed** — the bill is raised in HNN Biller and routed via the **NHIS ClaimIt Tracker**
tab (alongside Acacia, Cosmopolitan, GMTF, **GAB**). The claim is derived from that bill.

**B. External (the common case)** — the NHIS claim is submitted and settled elsewhere, in
your **EMR or the ClaimIt portal**. HNN Biller simply *receives the claim data* — how much
is being claimed, for whom — and tracks the refund and cashback. **No bill is required**
in this system; link a `billId` only if one happens to exist.

Intake is **idempotent on `nhisClaimNumber`**, so an EMR can safely re-push.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/claimit` · `/claimit/summary` | Tracked claims and totals (split routed vs external) |
| POST | `/api/v1/claimit` | Track one claim — pass `billId` (routed) **or** claim data (external) |
| POST | `/api/v1/claimit/ingest` | Bulk intake: `{ "claims": [ ... ] }` from an EMR export |
| POST | `/api/v1/claimit/:id/refund` | Record refund → cashback + margin |
| POST | `/api/v1/claimit/:id/status` | Update status |

External intake fields: `nhisClaimNumber`, `nhisAmount` (required), `provider`,
`patientName`, `memberId`, `refundPercent` (default 100), `refundedBy` (default `acacia`),
`refundDestination` (`provider` | `member`, default `provider`), `externalRef` (your EMR's
own id), `claimedAt`.

### Refund destination and cashback accounting

`refundDestination` records who actually receives the insurer's refund, and the accounting
follows:

| Destination | Member-charged margin | Provider owes member |
| --- | --- | --- |
| `provider` (default) — refund lands with the clinic | **netted from cashback** at source | net cashback |
| `member` — insurer pays the member directly | **invoiced** (we never touch that money) | nothing |

A margin charged to the insurer is always `reverse_bill`, and the member keeps the full
refund either way. The collection mode is written onto the ledger entry, and
`/api/v1/claimit/summary` reports `cashbackOwedToMembers` plus the split of refunds by
destination.

```bash
curl -X POST https://<app>/api/v1/claimit -H "x-api-key: <KEY>" -H "Content-Type: application/json" \
  -d '{"nhisClaimNumber":"CLM-2026-001","nhisAmount":340,"patientName":"Kofi Owusu","memberId":"NHIS-2211","externalRef":"EMR-98211"}'
```

UI: `/app/claimit.html` — shows a mode badge per row, a form for recording externally
settled claims, and a bulk JSON import.

## Agnostic payer tabs (facility self-service)

Each facility has **6 reserved payer slots — 3 insurer, 3 corporate** — that its own IT
lead programs from the Revenue Console. When a hospital lands a new scheme, they stand
the tab up themselves; no backend change or redeploy from the SaaS side.

- **Facility-scoped.** A slot programmed by Euracare never appears for Nyaho. Routing a
  bill to another facility's slot is rejected with `403 payer_not_available`.
- **Time-boxed (optional).** Set `expiresAt` for a pilot; expired slots disappear from the
  billing tabs and can't be routed to (`payer_slot_expired`).
- **Ready to integrate.** Each programmed slot gets its own `x-payer-key`, so the new payer
  can use the Payer API immediately, or just the secure claim link.
- **Reusable.** Releasing a slot frees it for a different payer; past claims are untouched.
- Corporate slots behave as **employer** payers on the settlement rail; insurer slots as insurers.

The billing terminal renders its payer tabs **dynamically** from
`GET /api/v1/bills/payers`, so a newly programmed tab appears without a code change.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/payer-slots/:tenantId` | All 6 slots, programmed or empty |
| PUT | `/api/admin/payer-slots/:tenantId/:kind/:index` | Program a slot (`kind` = `insurer`\|`corporate`, `index` 1-3) |
| DELETE | `/api/admin/payer-slots/:tenantId/:kind/:index` | Release a slot for reuse |
| GET | `/api/v1/bills/payers` | Payers this facility can route to (global + active slots) |

Body for PUT: `{ "name": "Nationwide Health", "sourceAccount": "1300109001", "contactEmail": "claims@…", "expiresAt": "2026-12-31", "enabled": true }`

## Composite APIs

Seven standalone OpenAPI 3.0 specifications, one per feature group, plus a combined
spec — downloadable in-app at `/app/apis.html` or from `public/apis/`.

| Spec | Covers | Auth | Edition |
| --- | --- | --- | --- |
| `hnn-01-core-billing` | Bills, patient payments, routing, dashboard, edition check, inbound SMS/WhatsApp replies, manual clinical-indicator entry + patient check-in enrollment | `x-api-key` | all |
| `hnn-02-payer-claims` | Claims, authorise A2A, secure links | `x-payer-key` | all |
| `hnn-03-nhis-claimit` | NHIS tracking, refunds, cashback, bulk ingest | `x-api-key` | commercial |
| `hnn-04-financing-reports` | Loans, grants, hospital credit, medical reports | `x-api-key` | commercial |
| `hnn-05-ledger-reconciliation` | Append-only ledger | `x-api-key` | commercial |
| `hnn-06-it-lead-configuration` | Revenue rules, other charges, payer tabs, licence redemption | `x-console-key` | all |
| `hnn-07-master-control` | Clients, payers, EMR partners, IT leads, licences, **edition transitions** (clients and payers), **payer commission**, **operating mode** (sandbox/live), SMS/WhatsApp verification channels, **Product Lab** (VBC/campaign/loyalty products, metric library, preview/accrue, and the four clinical-observation sources: EMR feed, manual hospital entry, patient web portal, patient SMS/WhatsApp) | `x-platform-key`; the one EMR-partner observation endpoint uses its own `x-api-key` instead | all |

Every documented endpoint is verified against the app's mounted routes.

## Editions, licensing and the master control board

One deployment serves many clients, each on its own edition. Switching is a per-client
flag flip — no redeploy, no data migration, **nothing deleted on downgrade**.

| Edition | Includes |
| --- | --- |
| `non_commercial` | Billing, payer routing, patient payments, dashboard, notifications, medical reports |
| `commercial` | Above **plus** revenue rules & other charges, financing, ClaimIt, payer tabs, ledger |

- **Master control board** — `/app/platform.html`, auth `x-platform-key` (env `PLATFORM_ADMIN_KEY`).
  Manage clients, payers, EMR/EHR partners, IT leads, and licences.
- **IT leads** get personal **org-scoped** console keys (`x-console-key`); they can only
  configure their own organisation (`403 out_of_scope` otherwise). Keys are rotatable and suspendable.
- **Licence keys** (`HNN-COMM-…`) can be bound to one client and given an expiry; the client's
  IT lead redeems one themselves at `POST /api/admin/edition/:tenantId/redeem`.
- Commercial-only endpoints return **402 `upgrade_required`**; clients self-check with
  `GET /api/v1/bills/edition`.

### Payer commercial edition & commission

**Payers** (insurers and corporate payers) carry the same two-value edition as a
hospital client — same licence-key machinery, same instant/reversible/non-destructive
flip — but it gates a **different** thing. A payer's edition never affects its own
feature access: NNEST, price lists, processing targets, and prior approvals all keep
working regardless of edition. The only thing it gates is a new **per-claim platform
commission**: `src/services/payerEditions.js`, `PUT /api/platform/payers/:id/edition`,
`PUT /api/platform/payers/:id/commission`, `POST /api/platform/payers/:id/renew`.

The commission is charged directly to a commercial payer on every claim it settles —
**separate from, and additional to**, whatever `expedited_settlement` fee a hospital's
own revenue rules may already charge that same payer above. Both can accrue on the
same settled claim; this one is the payer's own commercial relationship with the
platform, not something the hospital configures or that passes through it.

```
PUT /api/platform/payers/acacia/edition     { "edition": "commercial" }
PUT /api/platform/payers/acacia/commission  { "enabled": true, "rate": 5 }
```

`rate` accepts `0..1` or `0..100` and is clamped to **15%**
(`fees.MAX_PAYER_COMMISSION_RATE`), the same convention as every other percentage
rule in this app. Attempting to set or enable a commission on a non-commercial payer
returns **402 `upgrade_required`** — upgrade the edition first. Commission revenue is
fully reflected in **SaaS-wide revenue**'s `byPayer[]` breakdown below. Managed from
the "Commercial edition & commission" card under the **Payers** tab in
`/app/platform.html`, alongside the existing payer edition badge and upgrade/downgrade
button in the payers table.

### Other charges (report fees)

Alongside the percentage rules, the IT lead sets **flat** fees in the Other charges section:
`report_fee_mini` (Mini Medical Report) and `report_fee_standard` (Standard Medical Report),
chargeable to the patient, provider, insurer or financier. They accrue automatically when a
report is generated.

## NNEST — Narrow Network Expedited Settlement Terms

A feature of the instant-payment rail, **operationalised by the payer**. An insurer or
corporate payer designates a narrow network of providers and sets the terms on which each
is settled instantly.

Per provider: `settlement` (instant | standard), `feeRate` + `chargeTo` (capped at 15%),
optional `promptPaymentDiscountPercent` (the discount a provider grants for instant cash —
it reduces the transferred amount, max 15%), optional `maxClaimAmount`, and an effective window.
Per payer: `networkMode` (`open` | `narrow`) and `outOfNetworkPolicy` (`standard` | `block`).

- **NNEST terms take precedence** over the facility's default `expedited_settlement` rule.
- A claim that isn't expedited — out of network, over the ceiling, or terms suspended —
  attracts **no expedited fee**.
- Under narrow mode with `block`, authorisation is refused with **403 `out_of_network`**.
- Each claim records `nnest`: gross, prompt-payment discount, net settled, and the reason.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/payer/network` | Posture + all provider terms |
| PUT | `/api/payer/network/posture` | open vs narrow; out-of-network policy |
| PUT | `/api/payer/network/providers/:tenantId` | Set a provider's terms |
| DELETE | `/api/payer/network/providers/:tenantId` | Suspend terms |
| POST | `/api/payer/network/preview` | Dry-run a claim — writes nothing |
| GET | `/api/v1/bills/network-terms` | Provider's read-only view |

UI: the NNEST panel in `/app/payers.html`.

## Administrator submissions oversight

The SaaS administrator sees **every claim submission across all connected developers**
and can approve or decline centrally. **Approving triggers the Stanbic A2A transfer** to
the provider — the same guarded, idempotent path a payer uses, writing a ledger entry.
Funds never touch the platform. UI: `/app/submissions.html` (auth `x-platform-key`).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/platform/submissions` | All submissions (`?status=`, `?tenantId=`, `?limit=`) |
| GET | `/api/platform/submissions/summary` | Counts + value by status |
| GET | `/api/platform/submissions/:id` | One enriched submission |
| POST | `/api/platform/submissions/:id/approve` | Approve → run A2A transfer + settle |
| POST | `/api/platform/submissions/:id/decline` | Decline with a reason |

## Licensing model (non-commercial, fee-free by default)

This build ships **non-commercial**: every feature available, and **all pricing set to
zero**. The five per-transaction fee rules default to rate/amount `0` and stay that way
until deliberately set. Non-commercial is the default edition for every client, new or seeded.

HNN (the platform owner) controls a licensing **policy** from the master control board:

| Mode | Behaviour |
| --- | --- |
| `free_non_commercial` (default) | Fee-free. Licences issued/renewed at no charge on a 6-month term, purely to keep entitlement current. |
| `licensed` | A live licence is **required**. HNN sets a `licenseFee` per term. Switching on licensing starts a one-off **grace window** (default 30 days) so clients without a licence keep working while they pay; after grace, or once a held licence lapses, they are blocked (`402 license_required`) until they redeem/renew. |

Licences carry a **6-month term** (`termMonths`, configurable) and an `expiresAt`. A
commercial edition only counts while its licence is live — a lapsed licence falls back to
non-commercial automatically. Renewal extends from the later of now or current expiry, so
early renewal never loses time.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/platform/licensing` | Current policy |
| PUT | `/api/platform/licensing` | Set mode / term / fee (activate revenue) |
| GET | `/api/platform/licenses/state` | Every client's edition, expiry, days-left |
| POST | `/api/platform/clients/:id/renew` | Renew a licence for another term |
| POST | `/api/platform/licenses` | Issue a licence (term + fee) |

Clients self-check with `GET /api/v1/bills/edition`, which now returns a `licence` block
(`active`, `expiresAt`, `daysLeft`). Enforcement is a no-op while the policy is free — it
only blocks when HNN switches to `licensed`. UI: the **Licensing policy** tab in
`/app/platform.html`.

## Payer targets & price lists (master console)

**Volume targets.** Set a processing target for an insurer/employer over a window and
track settled value against it:
- `PUT /api/platform/payers/:id/target` { amount, period: monthly|sixmonth|yearly|custom }
- `GET /api/platform/payers/:id/target` → processed, remaining, percent, days left
- `GET /api/platform/targets` → all payers with a target

Progress is measured from the ledger's settled `payer_settlement` entries within the
current period, so it reflects real A2A money moved to clinics.

**Pre-approved price lists.** Upload an insurer's approved prices from CSV/Excel:
- `POST /api/platform/payers/:id/pricelist` { csv, replace? }
- Columns: `code, name, price` and optionally `unit, provider, category`.
- A `provider` (tenant id or facility name) gives that facility its own price;
  blank rows are the payer default — so prices can vary between hospitals/pharmacies.
- `GET /api/platform/payers/:id/pricelist?q=` to view/search; `DELETE` to clear.

**Repricing (opt-in, default off).** By default an uploaded price list is reference-only
and the billed price governs settlement. Turn on `PUT /api/platform/payers/:id/reprice`
{ enabled:true } to make a payer’s approved prices GOVERN its claims: each line is capped
at the approved price (facility-specific first, then payer default, else the billed price),
and the patient absorbs any gap between billed and approved. The claim carries `repriced:true`
and a breakdown of billedCover / approvedCover / patientAbsorbs. In a split, each payer
reprices independently.

Both are managed from the **Payers** tab on the master console (`/app/platform.html`).

## Multi-payer split

The covered (payer) portion of a bill can be divided between two or more payers
(insurer+insurer, or insurer+employer). Set it at bill creation or on the route call:

```json
{ "split": { "payers": [
  { "payerId":"acacia", "memberId":"ACA-1", "percent":60 },
  { "payerId":"gmtf",   "memberId":"GM-1",  "percent":40 }
] } }
```

Percentages (of the payer portion) or explicit amounts (must sum to it). A patient
copay, if any, is taken off the top first; the remainder is what gets split. Each payer
receives its **own itemised claim** and authorises independently — the claims always sum
exactly to the payer portion. The bill is marked settled only once **every** split claim
has settled. `POST /api/v1/bills/{id}/route` returns one claim + payer link per payer.

Who-pays is **explicit**: `adjustments.copayPercent` sets the patient share (0 = payers
cover all, no implicit default), and `split` sets how payers divide the rest.

## SaaS-wide revenue (platform owner)

Accrued platform fees aggregated across every client, by type, by client, and by
payer. All figures are receivables (cashMovement:false) — the platform never holds funds.

`byPayer[]` attributes the expedited-settlement fee and the per-claim commission
(see **Payer commercial edition & commission** below) to the payer that owes them —
read off the fee's own `refs.payerId`, not derived from the bill's coverage, which
can be imprecise on a split bill. A fee with no payer in its refs at all (e.g. a
report fee charged to the patient) is simply left out of `byPayer`, not dumped
under a meaningless "unknown" bucket; it still counts in `byType`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/platform/revenue` | Totals by type, by client, and by payer |
| GET | `/api/platform/revenue/recent` | Recent fee activity feed (now also names the payer, where one applies) |

UI: `/app/revenue.html` (auth `x-platform-key`) — "Revenue by payer" sits alongside
the existing by-type and by-client cards.

## Operating mode: sandbox, live, or hybrid (master control board)

Two rails, each independently switchable between sandbox and live, with **no
redeploy**: **Settlement** (Stanbic/SBG disbursements) and **Messaging**
(SMS/WhatsApp — see above). `src/services/operatingMode.js`, the **Operating
mode** tab in `/app/platform.html`, `GET`/`PUT /api/platform/operating-mode`.

This is what makes a genuine **hybrid** deployment possible — e.g. Messaging live
(real SMS/WhatsApp, real provider cost) while Settlement stays sandboxed (no real
bank transfers yet, further testing), or vice versa. Before this existed,
`MESSAGING_SANDBOX` was a deployment-wide kill switch nothing in the database could
override; it and `SBG_SANDBOX` now only **seed the starting default**, read once,
the first time `GET /api/platform/operating-mode` is called with nothing saved yet
(`seededFromEnv: true` in the response). The moment anything is saved via the `PUT`
below, that record governs **at runtime**, independent of either env var, until a
process restart finds an empty database (a fresh deploy).

Going live on **Settlement** moves real money through Stanbic for every payer that
has settlement credentials configured, so it's the one deliberately frictioned
transition: the request must include `confirm: "LIVE"` (exact, case-sensitive) or
it's rejected with `422 confirmation_required` and nothing changes. **Messaging**
going live has no such gate — a plain toggle, since the consequence is SMS/WhatsApp
send fees, not bank risk. Switching **either** rail back to sandbox never requires
confirmation. Both rails can be set in one call or separately, and each is
independent of the other:

```json
PUT /api/platform/operating-mode
{ "messaging": { "sandbox": false }, "settlement": { "sandbox": false }, "confirm": "LIVE" }
```

While Messaging is sandboxed, `biller.html`'s "simulate patient reply" control and
`otpCodeSandbox` in the bill-creation response keep working exactly as before — see
**SMS / WhatsApp verification** above — now driven by this live setting rather than
the static env var.

`biller.html` also shows a **"Master control"** link in its own nav, but only while
the whole deployment is fully sandboxed (both rails) — it checks the public,
key-less `GET /health` on load and hides itself the moment either rail goes live.
It's a convenience shortcut for whoever's demoing at the clinic terminal, not a
credential boundary: `platform.html` still requires its own platform key regardless
of whether the link is shown.

## Product Development Environment: VBC, campaigns, and loyalty programs

Master Control's **Product Lab** tab lets a payer's product team — no coding
required — build three kinds of product on top of the ecosystem of providers
(hospitals, pharmacies, physio practices…) already in this platform:

- **Value-Based-Care (VBC) programs** — pick a condition (hypertension,
  diabetes, or dyslipidemia), pick which pre-built clinical metrics matter
  (blood-pressure control, HbA1c control, LDL control, complication rate,
  follow-up adherence — each condition has its own set, `src/services/
  metricsLibrary.js`), and weight them into one blended 0–100 outcome score.
  Each participating provider is scored only on **its own** patients, then
  lands in a bonus or penalty tier purely from where that score falls — the
  tool for the perverse fee-for-service incentive you're guarding against
  (more complications/follow-ups silently paying a provider more). A patient
  can optionally earn their own cashback too, judged on their own reading of
  the program's primary metric, independent of their provider's score.
- **Promotional campaigns** (e.g. a breast-screening drive) — a target action,
  a time window, an optional flat reward for the patient and/or the provider
  per completion.
- **Loyalty / discount programs** (e.g. a spa/wellness cashback) — a
  qualifying action, a flat reward per occurrence, an optional cap per period.

All three share one engine (`src/services/products.js` builds and validates
the product; `src/services/incentives.js` scores it and writes the payout).
VBC prices off the blended formula above because that's what value-based
care actually is; campaigns and loyalty programs price off a flat amount per
completed action instead ("pay GHS 15 per completed screening"), because
forcing those through a weighted score would be false precision. Either way,
the result right now **only accrues as figures to review** — like the
Revenue page does for platform fees — nothing disburses automatically. A
product's `POST /api/platform/products/:id/accrue` is the one call that
writes; `/preview` runs the identical calculation without saving, so a
product manager can see what a draft would pay out before committing to it.

**Lifecycle**: every product starts in `draft`, moves to `sandbox` to test
against real observation data risk-free, then `live` once reviewed —
draft↔sandbox↔live, one step at a time (`POST /api/platform/products/:id/
status`). Every status computes/accrues identically today; the obvious seam
for later is gating real disbursement on `live`, the same way **Operating
mode** above gates real settlement on the live rail.

**Where the clinical data comes from**: this app bills procedures and
medicines, not diagnoses or vitals, everywhere else — clinical observations
are the one deliberate exception. Every row lands in the same table with the
same shape, distinguished only by `source`, and four things can write one:

| `source` | Who | How |
|---|---|---|
| `emr` | An EMR/EHR partner's own system | `POST /api/v1/emr/observations` (below) |
| `manual_hospital` | A clinic with no EMR integration | `POST /api/v1/clinical-observations`, tenant key |
| `manual_patient` | The patient themselves | The `/clinical/` web portal, once their phone is linked |
| `patient_sms` | The patient themselves | Texting a reading, once their phone is linked |

**The automated feed.** A partner pushes to `POST /api/v1/emr/observations`
(header `x-api-key`, the key issued when the partner was added under the
**EMR/EHR partners** tab — a different principal from a clinic/hospital
tenant's key of the same header name, see `src/middleware/
auth.js#authEmrPartner`). Body is one observation or `{ observations: [...]
}` for batch sync:

```json
{ "payerId": "pay_acacia", "memberId": "ACA-00123", "tenantId": "ten_euracare",
  "condition": "hypertension", "type": "blood_pressure",
  "systolic": 128, "diastolic": 80, "recordedAt": "2026-03-01T09:00:00Z" }
```

`type` is one of `blood_pressure | hba1c | ldl | complication |
followup_visit | screening_completed | wellness_visit`; the last two feed
campaigns and loyalty programs rather than a VBC score. A member's
attribution to a program is implicit — anyone with an observation tagged to
that payer + condition in the measurement period counts — so enrollment
needs no separate roster to maintain.

A metric nobody has reported data for yet is **excluded** from a VBC score,
never scored as 0 — `GET /api/platform/metrics-library` (optionally
`?domain=vbc&condition=diabetes`) lists what's available, and `src/services/
metricsLibrary.js`'s header explains that rule in full, since it's the one
easiest to get backwards when extending the library.

**Manual entry — a clinic keying in a reading by hand.**
`POST /api/v1/clinical-observations` (tenant key, `src/routes/clinical.js`)
takes the exact same body shape as the EMR feed above, minus `tenantId`
(taken from the key); `GET /api/v1/clinical-observations?payerId=&memberId=`
lists what that clinic itself has recorded for a member (not the EMR feed or
other clinics' entries — see the route's own comment for why it's scoped
that way). `biller.html`'s **VBC check-in** card is the front end for this.

**Manual entry — the patient's own self-report, web or SMS/WhatsApp.** This
is the one place in the app that accepts clinical data over text — in direct
tension with the "no PHI over SMS/WhatsApp" stance under **Before
production** below. The gate is `src/services/clinicalLinks.js`: a phone
number means nothing until its holder proves they hold it, via the exact
same OTP primitives (`services/messaging.js#genOtp`) and the exact same
lockout/expiry discipline `services/verification.js` already uses for bill
verification — this feature's version of the explicit, conscious opt-in
`includeTreatmentDetail` already is for treatment detail in a verification
text.

- A clinic can start this for a patient during a visit — `POST /api/v1/
  clinical-observations/link` (tenant key) — or a patient can start it
  themselves at the public **`/clinical/`** page. Either way, a code is
  texted to the phone and the **patient** has to confirm it (reply with it,
  or enter it on the page) before anything can be submitted from their side;
  a clinic starting it on someone's behalf doesn't skip that.
- Once confirmed, the patient can log a reading on the web page, or text one
  in using a short, fixed, number-only grammar designed to be easy to learn
  and unambiguous to parse: `BP 130/85`, `HBA1C 6.8`, `LDL 110`,
  `COMPLICATION`, `FOLLOWUP`, `SCREENING`, `WELLNESS`. `STOP` opts out
  immediately, from anyone, no confirmation needed; `HELP` repeats the list
  (but only to a phone already enrolled — it doesn't advertise the feature
  to one that isn't). `BP`/`HBA1C`/`LDL` always tag their own condition
  (hypertension/diabetes/dyslipidemia respectively) regardless of what the
  patient enrolled under; `COMPLICATION`/`FOLLOWUP` fall back to the
  condition chosen at enrollment, since those two are meaningful per-program
  rather than self-evident from the reading itself.
- Requesting a link is idempotent and always (re-)issues a fresh code rather
  than accumulating duplicate rows — the same one call covers first-time
  enrollment, a lost/forgotten session, and a new device. A successful
  confirmation mints a bearer token, returned exactly once (never echoed
  back by any later `GET`); it's required on every write and read of the
  patient's own data (`Authorization: Bearer …` or `x-clinical-token`), the
  link id alone is not enough.
- The inbound SMS/WhatsApp webhook (`POST /api/v1/webhooks/messaging-inbound`)
  tries a clinical interpretation **first** and falls straight through to
  the existing bill-verification handling, completely unchanged, for
  anything that isn't clearly clinical or doesn't match a pending clinical
  link — a phone that has never touched this feature sees no change in
  behaviour at all.

```bash
# Patient (or a clinic on their behalf) requests a code
curl -sX POST http://localhost:3000/clinical/api/link \
  -H 'Content-Type: application/json' \
  -d '{"payerId":"pay_acacia","memberId":"ACA-00123","phone":"0241234567","condition":"hypertension"}'
# -> { id, status:"pending", ... } — code is sent to the phone, never in this response

# Patient confirms (web page, or texting the same code back)
curl -sX POST http://localhost:3000/clinical/api/link/clk_xxx/confirm \
  -H 'Content-Type: application/json' -d '{"code":"123456"}'
# -> { ..., status:"active", token:"…" } — the ONLY time the bearer token is returned

# From then on, either the web page or a text message works:
curl -sX POST http://localhost:3000/clinical/api/link/clk_xxx/observations \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' \
  -d '{"type":"blood_pressure","systolic":130,"diastolic":85}'
```

Run `npm run smoke:clinical-entry` for the full suite against the in-memory
store: enrollment validation, OTP confirm/lockout/expiry (web and
SMS-bare-code paths), every reading keyword, condition auto-tagging,
STOP/HELP, hospital-initiated enrollment, and the "lost token" re-request
flow.

## Stanbic settlement (verified against the SBG Money Transfer API doc)

Settlement performs the bank's four-call sequence inside one authorize call:

1. `POST /v1/auth/login` → access token (~1h)
2. `GET /v1/account-validation` → **mints the serviceRequestId** (ticket) + beneficiaryName
3. `GET /v1/service-charge` → fee, keyed by the ticket
4. `POST /v1/disbursements` → status + reference

Success requires `responseHeader.statusCode === "000"` (not just HTTP 200); a failure
envelope raises `SbgError` with the bank's code. Two hosts supported: the
marketplace gateway (`/api/sbg-transfer` prefix) and the direct smartapp host (empty
prefix). Sandbox settles instantly with an `SBX-` reference; which mode applies is
the Settlement rail's own switch — see **Operating mode** above, not a static
per-process setting.

**Credentials resolve per payer**, in order, each one a fallback for the last:

1. **This payer's own encrypted credential** — `PUT`/`DELETE
   /api/platform/payers/:id/settlement-credentials` (Master Control, "Settlement
   credentials" under the Payers tab), stored encrypted the same way SMS/WhatsApp
   provider credentials are (AES-256-GCM, `CREDENTIAL_ENCRYPTION_KEY`; see
   `src/services/credentials.js`) and never echoed back — only `{configured, hint,
   updatedAt, updatedBy}`.
2. **A legacy plaintext credential already on the payer record** (`payer.sbg.
   {username, password}`) — pre-dates the encrypted path above; existing seed/demo
   payers keep working with no forced migration. `GET /api/platform/payers` reports
   `legacySettlementCredentialsConfigured` so Master Control can tell which one is
   actually in effect.
3. **`SBG_USERNAME`/`SBG_PASSWORD`** — a single deployment-wide fallback credential,
   same env-only convention every other secret in this app follows (see **Before
   production** below), used only if a payer has neither of the above.

Configure the host and the deployment-wide fallback with `SBG_BASE_URL`,
`SBG_PATH_PREFIX`, `SBG_USERNAME`, `SBG_PASSWORD`; `SBG_SANDBOX` is now only the
starting default for the Settlement rail — see **Operating mode** above.

## Running modes

Same codebase, three deployments: **cloud/web** (Railway + Postgres, multi-tenant),
**on-site** (hospital-local Node + local Postgres, LAN access, outbound HTTPS to Stanbic
for settlement), and **desktop / Microsoft Store** (packaged app, local DB, offline-capable).

## Before production

1. **Rotate the leaked Stanbic credential** from the "public" Postman collection
   (plaintext password for `sbg_transfer_api_tester`). Secrets come from env only here
   — the deliberate exceptions are third-party SMS/WhatsApp provider credentials
   (Twilio / Africa's Talking / Hubtel) and a payer's own Stanbic/SBG marketplace
   credentials, neither of which can be known at deploy time; both are instead entered
   via Master Control and stored encrypted at rest — see **SMS / WhatsApp
   verification** and **Stanbic settlement** above.
2. **Authenticate payer authorisation** — back the secure link / payer API with the
   payer's login + step-up (OTP / signed mandate) before any transfer.
3. **No PHI over email/WhatsApp** — notifications carry references and links only.
   There are two deliberate, consent-gated exceptions, both off unless someone
   explicitly turns them on: a client can turn on `includeTreatmentDetail`
   (`PUT /api/platform/clients/:id/verification-channels`, see **SMS / WhatsApp
   verification** below), which lists the treatment/line items in the SMS/WhatsApp
   text itself; and the Product Development Environment's clinical check-in (see
   **Product Development Environment** above) does accept a patient's own clinical
   readings by text, but only once that phone has proven it belongs to that patient
   via OTP, and `STOP` always, immediately, opts it back out. Leave both off/unused
   to keep the blanket rule strictly true; a production deployment turning either on
   should make sure the consent language shown at enrollment reflects that choice.
4. **Persistence** — the app uses **PostgreSQL when `DATABASE_URL` is set** (survives
   restarts, scales to many instances) and an in-memory store otherwise. Schema is
   auto-created and seeded on boot. Money paths use `SELECT … FOR UPDATE` transactions
   so claims can't be double-authorised across instances. See `DEPLOY.md`.

## Next steps

- FHIR adapter for EHRs that prefer `Invoice`/`ChargeItem`.
- Payer-specific validation / pre-authorisation rules before authorise.
- Exercise Africa's Talking WhatsApp and Hubtel's exact SMS domain against real,
  live accounts once deployed (see the confidence table under **SMS / WhatsApp
  verification** above). Africa's Talking WhatsApp is now built against its own
  confirmed API reference (text, media, template, interactive buttons/list), but
  like Hubtel, hasn't been exercised against a real account from this environment —
  this environment's egress is allowlisted to package registries and GitHub only.
  A fourth provider, e.g. Meta's WhatsApp Cloud API, is a one-function addition to
  `messaging.js` once needed. Email delivery status is still unbuilt.
- Payer remittance statements and clinic payout reports.

## InsureCredit (micro-loan offers) and messaging changes

**InsureCredit** is a Product Lab solution (module `insurecredit`). An insurer or hospital programs it; the
patient gets an SMS with a link (and a USSD code plus an 8-digit application number) to apply for a micro-loan
of up to GHS 2,000 towards their out-of-pocket share. The micro medical report is generated with the offer and
travels with the application to ConfirmU; the application number lets the backend verify need
(`GET /insurecredit-hooks/<secret>/applications/<no>`). Above the limit the patient is offered a
justification note instead: with their consent the report is emailed/texted to a funder (e.g. HR) through an
expiring, revocable link (max 3 recipients per application).

- **Design variations:** `design` = classic / stepper / compact / story, plus colour, brand, headline,
  button, SMS style/template and more. Product Lab shows a live preview; "Duplicate as variation" copies a
  product so several can run side by side.
- **Callbacks:** Master Control -> Product Lab -> InsureCredit panel shows the USSD and ConfirmU URLs
  (secret in the path; rotatable). A USSD short code must be provisioned with Africa's Talking.
- **ConfirmU contract:** the webhook (HMAC `x-hnn-signature`), decision callback and verification packet are
  HNN's own shapes - align them with ConfirmU before going live.
- **Sandbox:** a non-live product only previews. A live product creates real records; the global messaging
  sandbox still stops SMS/email leaving the building.

**Messaging changes shipped with it:** `notify()` now really dispatches (SMS/WhatsApp/email) instead of only
logging; local numbers (`024…`) are normalised to `+233…` at the send seam; a provider-agnostic email
transport (`EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`; Resend or SendGrid); outbound requests time out
after 12s; hospital-initiated clinical links use that hospital's sender. Smoke: `npm run smoke:insurecredit`.
