# Composite Billing & Settlement Platform

**The platform never custodies funds — it orchestrates, routes, and reconciles.**

Bills patients at the point of care and settles the money two ways, always paid
**directly to the clinic** (the platform is never in the flow of funds):

1. **Patient self-pay** — Mobile Money, card, or cash.
2. **Payer A2A (the USP)** — the patient names their **payer** and the clinic taps it.
   The bill is routed for validation, and the payer **moves money from its own
   Stanbic account straight to the clinic** on the patient's behalf (account-to-account
   over the Stanbic SBG rail). All parties are then notified.

A **payer** is whoever covers the bill: an **insurer** (Acacia, GMTF (Mahama Cares), …) **or an
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
| **Patient** | — | `/pay/?intent=…` |

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
notification fan-out. `npm run smoke` runs it over HTTP.

## Clinic / EHR API (key `x-api-key: emr_demo_key_123`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/bills` | Create an itemised bill (patient, coverage, items, adjustments) |
| POST | `/api/v1/bills/:id/route` | **Tap a payer** → claim + secure link |
| POST | `/api/v1/payments/intents` | Patient self-pay (mtn-momo / card / cash) |
| GET | `/api/v1/bills` · `/bills/:id` · `/claims` · `/dashboard` | Read |
| GET | `/api/v1/institutions` · `/account-validation` | SBG proxies |

## Payer API (key `x-payer-key`, e.g. `payer_acacia_key`, `payer_acme_key`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/payer/me` · `/summary` | Identity + KPIs |
| GET | `/api/payer/claims?status=pending` | Claims addressed to this payer |
| GET | `/api/payer/claims/:id` | Claim detail (member, lines, amount) |
| POST | `/api/payer/claims/:id/authorize` | Authorise the A2A transfer to the clinic |
| POST | `/api/payer/claims/:id/reject` | Decline `{reason}` |

Secure link portal (token, no key): `GET /claim/api/:token`,
`POST /claim/api/:token/authorize|reject`. Full contract in `openapi.yaml`.

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
tab (alongside Acacia, GMTF, **GAB**). The claim is derived from that bill.

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
| `hnn-01-core-billing` | Bills, patient payments, routing, dashboard, edition check | `x-api-key` | all |
| `hnn-02-payer-claims` | Claims, authorise A2A, secure links | `x-payer-key` | all |
| `hnn-03-nhis-claimit` | NHIS tracking, refunds, cashback, bulk ingest | `x-api-key` | commercial |
| `hnn-04-financing-reports` | Loans, grants, hospital credit, medical reports | `x-api-key` | commercial |
| `hnn-05-ledger-reconciliation` | Append-only ledger | `x-api-key` | commercial |
| `hnn-06-it-lead-configuration` | Revenue rules, other charges, payer tabs, licence redemption | `x-console-key` | all |
| `hnn-07-master-control` | Clients, payers, EMR partners, IT leads, licences, **edition transitions** | `x-platform-key` | all |

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

Accrued platform fees aggregated across every client, by type and by client.
All figures are receivables (cashMovement:false) — the platform never holds funds.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/platform/revenue` | Totals by type and by client |
| GET | `/api/platform/revenue/recent` | Recent fee activity feed |

UI: `/app/revenue.html` (auth `x-platform-key`).

## Stanbic settlement (verified against the SBG Money Transfer API doc)

Settlement performs the bank's four-call sequence inside one authorize call:

1. `POST /v1/auth/login` → access token (~1h)
2. `GET /v1/account-validation` → **mints the serviceRequestId** (ticket) + beneficiaryName
3. `GET /v1/service-charge` → fee, keyed by the ticket
4. `POST /v1/disbursements` → status + reference

Success requires `responseHeader.statusCode === "000"` (not just HTTP 200); a failure
envelope raises `SbgError` with the bank's code. Configure with `SBG_BASE_URL`,
`SBG_PATH_PREFIX`, `SBG_USERNAME`, `SBG_PASSWORD`, `SBG_SANDBOX`. Two hosts supported:
the marketplace gateway (`/api/sbg-transfer` prefix) and the direct smartapp host
(empty prefix). Sandbox settles instantly with an `SBX-` reference.

## Running modes

Same codebase, three deployments: **cloud/web** (Railway + Postgres, multi-tenant),
**on-site** (hospital-local Node + local Postgres, LAN access, outbound HTTPS to Stanbic
for settlement), and **desktop / Microsoft Store** (packaged app, local DB, offline-capable).

## Before production

1. **Rotate the leaked Stanbic credential** from the "public" Postman collection
   (plaintext password for `sbg_transfer_api_tester`). Secrets come from env only here.
2. **Authenticate payer authorisation** — back the secure link / payer API with the
   payer's login + step-up (OTP / signed mandate) before any transfer.
3. **No PHI over email/WhatsApp** — notifications carry references and links only.
4. **Persistence** — the app uses **PostgreSQL when `DATABASE_URL` is set** (survives
   restarts, scales to many instances) and an in-memory store otherwise. Schema is
   auto-created and seeded on boot. Money paths use `SELECT … FOR UPDATE` transactions
   so claims can't be double-authorised across instances. See `DEPLOY.md`.

## Next steps

- FHIR adapter for EHRs that prefer `Invoice`/`ChargeItem`.
- Payer-specific validation / pre-authorisation rules before authorise.
- Real email + SMS providers with delivery status.
- Payer remittance statements and clinic payout reports.
