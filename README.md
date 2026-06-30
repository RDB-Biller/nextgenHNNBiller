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
