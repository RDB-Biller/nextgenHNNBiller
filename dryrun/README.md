# Dry Run

A private workspace where an organisation rehearses a change (a rule, a price, a payment plan, a campaign) on its own data before it goes live. Built as a semi-separate service: it lives in the HNN Biller repository, has its own front end, storage and deploy, and talks to HNN Biller through one thin connector. Delete `src/connectors/hnn.js` and its two routes and it stands alone.

## Run it
    cd dryrun && npm start         # http://localhost:4100
    npm run smoke                  # 100+ end-to-end checks, in memory
No packages are required. (`pg` is optional, only for Postgres storage.)

## Environment
| Variable | Purpose |
|---|---|
| `PLATFORM_ADMIN_KEY` | Platform owner key. **Default is a demo key. Change it.** |
| `DRYRUN_SECRET_KEY` | Encrypts client Postgres connection strings. **Default is a dev key. Change it.** |
| `DRYRUN_DATA_DIR` | Where the registry and default storage live (default `./data`; use a Railway volume). |
| `PLATFORM_DATABASE_URL` | Optional. Store default org data in Postgres instead of files. |
| `HNN_BASE_URL`, `HNN_PLATFORM_KEY` | Optional. Lets members import price books from HNN Biller. |
| `AT_API_KEY`, `AT_USERNAME` | Africa's Talking, for SMS sign-in details and survey links (`sandbox` to test). |
| `AT_WA_NUMBER` | Your WhatsApp-enabled Africa's Talking sender, for WhatsApp. |
| `AT_SENDER_ID` | Optional SMS sender name. |
| `DRYRUN_PUBLIC_URL` | Optional. The address put in sign-in messages (defaults to the address the request came to). |
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
- **Sign-in by SMS and WhatsApp**: the platform owner enters the admin's email and phone; sign-in details go out by SMS and/or WhatsApp. Admins adding teammates get both channels by default. If a send fails (or Africa's Talking is not set up) the key is shown on screen once. The log never stores message text or keys. WhatsApp may refuse a first message to someone who has not messaged you before; SMS is the dependable channel.
- **Directory**: the platform owner sees every organisation, who the admin appointed, who added whom, roles, masked phones, last seen, and can re-send sign-in details (this issues a fresh key).
- **Regulator rules**: every product version is compared with the approved one and each change is sorted into no approval / notify / needs regulator. Widening hospital access on the same cap, or a discount within the limit, needs no approval by default. These are starting assumptions for an insurer, editable in Settings, and must be confirmed by the client's compliance team. A version that needs the regulator cannot be approved until its reference is recorded.
- **More scenarios**: plan options and hospital tiers (who picks what, who reaches their cap sooner, loss ratio) and marketing campaigns (audience, channels, offer, cost, first-year margin). The Coach labels each suggestion with its regulator status.
- **Surveys**: public link, no sign-in, no names or numbers stored, free text scrubbed, results hidden until 5 answers. A result can fill a scenario setting (for example, the share who want higher-tier hospitals).
- **Dry Run Live**: an approved version (with its regulator reference where needed) becomes a capped beta, then live for the first year. Actual monthly figures are recorded and compared with the forecast; guardrails raise alerts; pausing needs a reason; decisions are logged. Dry Run does not move money or issue policies. The platform owner sees all programmes and sets managed-service terms.
- **Pace**: days, weeks or months changes only the checklist. The platform is ready on day one.

## Known limits
- Choice, risk, cost and response-rate behaviour in the new scenarios is assumed until real data and survey results replace it.
- No email sending yet (the admin email is kept on file).
- Synthetic data and the expedited-settlement provider costs of funds are illustrative assumptions.
- Postgres storage is written but not tested against a live database.
- The Coach does not use an LLM yet; it explains itself in fixed wording.
- Keys are per member; there is no email invite or password flow yet.
