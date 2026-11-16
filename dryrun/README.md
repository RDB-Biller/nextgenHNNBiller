# Dry Run

A private workspace where an organisation rehearses a change (a rule, a price, a payment plan, a campaign) on its own data before it goes live. Built as a semi-separate service: it lives in the HNN Biller repository, has its own front end, storage and deploy, and talks to HNN Biller through one thin connector. Delete `src/connectors/hnn.js` and its two routes and it stands alone.

## Run it
    cd dryrun && npm start         # http://localhost:4100
    npm run smoke                  # 52 end-to-end checks, in memory
No packages are required. (`pg` is optional, only for Postgres storage.)

## Environment
| Variable | Purpose |
|---|---|
| `PLATFORM_ADMIN_KEY` | Platform owner key. **Default is a demo key. Change it.** |
| `DRYRUN_SECRET_KEY` | Encrypts client Postgres connection strings. **Default is a dev key. Change it.** |
| `DRYRUN_DATA_DIR` | Where the registry and default storage live (default `./data`; use a Railway volume). |
| `PLATFORM_DATABASE_URL` | Optional. Store default org data in Postgres instead of files. |
| `HNN_BASE_URL`, `HNN_PLATFORM_KEY` | Optional. Lets members import price books from HNN Biller. |
| `DRYRUN_MEMORY=1` | Tests only. |

## How it fits together
- **Accounts**: the platform owner creates an organisation and its first admin (key shown once). Admins add builders, approvers and viewers.
- **Plans**: free trial, extended trial, paid. Limits (members, assets, runs a month, dataset rows) are settings with per-organisation overrides. Trial ends, then a grace period, then read-only. The platform caps how many free organisations exist at once.
- **Storage**: working data (assets, runs, audit) lives on our system by default, or in a client folder or client Postgres. Changed any time from Settings: copy, verify counts, switch, remove the old copy. Accounts, team and plan always stay with us.
- **Library**: every change is a new version. Gates: draft, dry run, shadow, approved, one step at a time. Only an approver or admin approves. Only approved versions export.
- **Privacy**: uploads drop names, phones, emails and ID numbers; member ids become salted codes.
- **Scenarios** (insurer pack): AI adjudication ladder; expedited settlement. Runs are seeded, so the same inputs and seed give the same answer.
- **Coach**: a deterministic search inside the client's own guardrails. It only drafts a new version; a person moves it through the gates.
- **Packs**: a sector is an entry in `src/packs/index.js`. Bank, fintech, MFI, telco, hospital, pharmacy and school exist as shells (vocabulary and asset types, no scenarios yet).
- **Pace**: days, weeks or months changes only the checklist. The platform is ready on day one.

## Known limits
- Synthetic data and the expedited-settlement provider costs of funds are illustrative assumptions.
- Postgres storage is written but not tested against a live database.
- The Coach does not use an LLM yet; it explains itself in fixed wording.
- Keys are per member; there is no email invite or password flow yet.
