# Dry Run

A private workspace where an organisation rehearses a change (a rule, a price, a payment plan, a campaign) on its own data before it goes live. Built as a semi-separate service: it lives in the HNN Biller repository, has its own front end, storage and deploy, and talks to HNN Biller through one thin connector. Delete `src/connectors/hnn.js` and its two routes and it stands alone.

## Run it
    cd dryrun && npm start         # http://localhost:4100
    npm run smoke                  # 130+ end-to-end checks, in memory
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
- **Partner network**: two partner sector packs, `research_firm` and `operator` (white-label). The platform owner creates them and lists the ones it vouches for. A client admin engages a listed partner, chooses exactly which surveys or live programmes the partner can work on (never customer or claims data), and agrees fees (one-off, monthly, and for operators a commission on premium collected). The partner accepts, then works inside the client's workspace through scoped screens; the client's audit log names the partner. Operators can record figures and notes and pause a programme, but starting or going live stays the client's decision. Statements are calculated from recorded figures, with Dry Run's share (set by the platform owner, default 10% of the partner's fee) shown to the partner and the platform owner but not the client. Dry Run does not collect or pay money.
- **Pace**: days, weeks or months changes only the checklist. The platform is ready on day one.

## Known limits
- Choice, risk, cost and response-rate behaviour in the new scenarios is assumed until real data and survey results replace it.
- No email sending yet (the admin email is kept on file).
- Synthetic data and the expedited-settlement provider costs of funds are illustrative assumptions.
- Postgres storage is written but not tested against a live database.
- The Coach does not use an LLM yet; it explains itself in fixed wording.
- Keys are per member; there is no email invite or password flow yet.


## Sign-in, requests and demo

- **Pages**: `/` public landing, `/join` request an account or open a demo, `/app` the workspace (`/app?go=admin` opens the Team area for admins).
- **Sign-in**: username and password (texted to people when they are added). The first password is temporary and must be changed on first sign-in. Five wrong tries lock a username for 15 minutes. Access keys and the platform key still work from "Use an access key".
- **Messages** (SMS and WhatsApp via Africa's Talking): admin appointment and teammate invite both carry the interface link and an invite link (`/join?ref=...`). The admin message also carries the admin console link and, when the admin's email is on a company domain, an offer of `dryrun.<their domain>`. Previews are on the Create-organisation form and the Team form.
- **Account requests**: public form on `/join` (honeypot, 5 per hour per IP). The platform owner approves or declines from the Requests tab; approving creates the workspace and sends sign-in details.
- **Demo**: one click on `/join`, a private 48-hour workspace with sample data. No messaging, storage changes, partners or own address. Capped at 150 live demos and 6 per hour per IP. Expired demos are swept every 15 minutes.
- **Own address**: admins ask for `dryrun.theircompany.com` in Settings; the platform owner marks it connected after DNS is added on Railway.

## Two kinds of invite

- **General invite** (`/join?ref=<org>`): sent to other organisations. They ask for their own workspace and the platform owner decides. The inviting organisation is recorded as the introducer.
- **Team invite** (`/join?team=<token>`): for colleagues of one organisation. They ask to join that team, and that organisation's admin approves, picks the role and sends sign-in details. Seat limits apply. Admins can copy, replace or switch off the link in the Team tab. These requests never reach the platform owner's queue.
- Both appear in the credential SMS, team link first.

## Fintech pack and proposals

- **Fintech scenarios**: `premium_financing` (premium paid in instalments by auto-debit, with an overdraft raised automatically when the wallet is short, compared with and without it on the same customers) and `copay_cash` (short advances for co-payments and services the plan does not cover). The design is a `finance_offer` asset; the Coach searches fee, loading and limit within the customer-cost and credit-loss limits. Wallet and repayment behaviour are assumptions until pilot data replaces them. Output carries a consumer-credit caution.
- **Proposals** (`/api/org/proposals`): a fintech drafts a proposal from its design and runs (the system writes the first draft), addresses it with the other side's partner code (Settings/Proposals shows yours) or leaves it for the platform to introduce. The recipient sees a snapshot of the terms and evidence, never data. Accepting (approver or admin) copies the design into the recipient's Library as a draft. Insurers can also post a request.
- **Deals** (platform owner): introduce the parties, name a launch partner (none, the platform, or a partner organisation such as a research firm), and confirm the link fee and launch commission (defaults in Platform settings). Terms are recorded; nothing is collected automatically.
- No brand names appear in the product; a test enforces this.

## Product Lab

Pick a product type (outpatient, inpatient and surgical, maternity, chronic care, micro health, family plan, loyalty cashback; for fintechs, instalment premium with overdraft and cover cash), enter a few parameters and get a complete draft with a first run. Then: change the parameters as a new version, make variations (one change each) that are grouped with the original, compare them side by side with what each would need from the regulator, and use the ideas board (suggest, vote, build a draft from an idea). Everything lands in the Library as a draft and passes the same gates. Claims frequency and cost for each product type are typical assumptions stored on the product, not real data.

## Outcomes-based care

Scenario `outcomes_based_care` and Product Lab type "Outcomes-based care programme" (hypertension, diabetes, high cholesterol). Providers are scored only on their own patients across control, adherence, screening and complications, blended into one score that places them in a bonus or penalty band. Output: who lands where, complications avoided, bonuses and reductions, patient cashback, net to the insurer, and the fee-for-service trap (providers with more complications are paid more). The Coach searches better bands and keeps penalised providers under 30%. Provider response is an assumption. The Library tab is now "Product Lab Library".

### Platform owner: people and messages

On the Organisations tab, **People and messages** opens each organisation's members. For each person you can save a phone number, **Send sign-in details** (a new temporary password plus a sign-in link with the username filled in; they choose their own password on first sign-in) or send them a free-text **Message**. You can also message an organisation's admins, or everyone in it. Messages go by SMS (and WhatsApp if set up) and are logged without their text or passwords.

### Team request texts

All by SMS, each with a link onto the platform. A request to join → the team lead(s) get a "pending" text (saying who invited the person, if anyone). Added → the person gets their sign-in details, the team leads are told, and the colleague who invited them is told. Declined → the person and the team leads are told. Every team member, from admin to viewer, can Quick Invite colleagues (up to 25 invitations a day each); the link carries who invited, so they are told when the person is added.

### Workroom

A team working space inside the Product Lab Library, opened from the teal **Workroom** tab (or the "Open the Workroom" button at the top of the Product Lab Library, or "Room" beside any product). Left: rooms (General, one per product or programme, and guest rooms), plus **Needs me** and the **Decision log**. Middle: the thread. Right: the pinned product, its parameters and open tasks.

- **Comments on specifics:** tap a parameter on the right to comment on that number and version.
- **Approvals:** a builder asks for an approval in the room; an approver approves (the version really moves a gate) or sends it back with a reason, inside the thread. Both are logged as decisions and texted to the requester.
- **Decision log:** searchable record of what was decided and why. Add your own with "Log a decision".
- **Tasks, mentions and digest:** assign a task (with a due date), mention people with `@username` or `@firstname`, and each gets an SMS with a link to the room. Members can switch on a morning digest text (set `DRYRUN_DIGEST_HOUR`, UTC, default 7; needs `DRYRUN_PUBLIC_URL`).
- **Coach:** `@coach <question>` answers in the room. In a product room, `@coach what if the premium goes down 5%?` saves a draft variation, compares it with the current version and reports the difference. Nothing is approved. Finishing a run in a product's room is posted there too.
- **Guest rooms:** an admin opens a room for chosen partners (from active engagements). The partner sees only that room, under **Rooms** in their engagement, and none of the rest of the workspace.

### Test bench (Simulate and Constraints tabs in a product room)

Open a product's room in the Workroom and use **Simulate** and **Constraints**.

- **Constraints:** the company's own rules for the product: payback (ROI) within N months, customer mix (for example 75% women, 25% men), total addressable market and the share of it year 1 may take, allowed regions, a limit on any measure from the run, or a rule in words. Upload an **assumptions sheet** (.xlsx or .csv; what it is in column A, the value in column B, unit and note optional). Recognised names include `tam_members`, `expected_members_year1`, `acquisition_cost`, `fixed_cost_year`, `market_women_pct`, `uptake_women_vs_men`, `target_regions`, `avg_monthly_income`, `lapse_pct`, `claims_per_member_year`, `median_claim_cost`, `price_sensitivity`, `adverse_selection` and `target_loss_ratio_pct`.
- **Simulate:** the current product plus up to 5 variations (or a sweep of one setting across 2-5 steps) run side by side. Each variation is saved as a draft in the library (tagged `bench`, no separate room). Each is checked against the company's constraints, and the best choice is the one that meets every constraint with the highest margin. What cannot be tested is shown as "Not tested", never as a pass.
- **Coach, with the builder's consent:** the builder sees what the Coach would apply and ticks any of regulator rules, best practice, market factors and web lookup. Nothing unticked is applied. Market factors are assumptions and are listed in the results. The Coach posts the outcome in the room.
- **Web lookup:** off until `TAVILY_API_KEY` is set on the service. It searches once per run and lists every source so the builder can check it. It does not change the numbers.
- **Live test:** give the product's public https address. Dry Run POSTs 6 test customers (age, sex, region) plus the product settings, and compares the premium in the JSON answer (`premium`, `monthlyPremium`, `price` or `quote`) with the simulation, within a tolerance. Only public https addresses are called: private, loopback and metadata addresses are refused, and the check runs on the address actually connected to. Not available in demo workspaces.
- The customer-mix check is a model, not a measurement: women's share of buyers comes from `market_women_pct` and `uptake_women_vs_men` (a placeholder of 1, or 4 for maternity cover, if you give none), and the result says what ratio would reach the target. Payback uses `acquisition_cost` (placeholder 60 per member if you give none). Both placeholders are named in the result.

## Workroom: Enter URL and Upload product
Two tabs sit between the message box and the Send / Ask the Coach / Add a task / Log a decision buttons.
- **Enter URL** posts a live address (web app, endpoint, store listing, repository). Https links are checked once (status, speed, page title) through the same private-address guard as the test bench. Tick "Use it for live tests" in a product room to make it the bench's live address.
- **Upload product** takes an app (.apk, .aab, .ipa), a zipped project or IDE workspace, or a document, up to 100 MB each (`DRYRUN_UPLOAD_CAP_MB` caps the org total, default 1024). Dry Run reads the archive index only, says what it found, warns about secrets, signing keys and `.git` folders, and adds store-submission notes. It never runs the file and never publishes to Google Play or the App Store.
- Files download as attachments; the uploader or an admin can remove them. Demo workspaces cannot upload.

## Connected sites: Dry Run signed and inferred
Workroom, **Connected sites** (and the label on any web link posted in a room).
- **Dry Run signed.** The owner installs the Dry Run connector (`public/connector/`: Node, Python and PHP add-ons plus the `dryrun.js` page script, all dependency-free and read-only). Ownership is proved by publishing the issued token at `/.well-known/dryrun.json`. A site that also runs the server add-on answers HMAC-signed capture requests (routes, forms, API shapes, shared settings, sample data only if allowed). Values under secret-looking keys are replaced with `[hidden]`. The page script lets the Workroom preview iterations as overlays inside an iframe (only for origins the owner lists). Pages are framable by Dry Run only (`frame-ancestors`).
- **Iterations and packs.** Text, style, hide, attribute and setting changes are validated on the server and again in the page script (no links or braces in styles, no event attributes, safe links only). They are saved per site and exported as a **Dry Run pack** (`dryrun-pack.json` with a digest). The owner reviews it and, if they switch `applyPack` on, the connector serves it to the page script. Dry Run never changes a live site.
- **Inferred.** Any other public https site is read as a visitor would (robots.txt respected, up to 5 pages, private addresses refused). Features are guesses with a confidence level. No iterations or pack export.
- Owner controls: `permissions` (`structure`, `iterate`, `sampleData`) in the manifest, enforced by both sides. Disconnecting a site deletes everything captured.
- Config: `DRYRUN_PUBLIC_URL` is the origin shown in the install snippets.

## Dry Run Iteration (DRI), Quick Start and more connectors
- **DRI.** "Open live (DRI)" on a saved iteration makes a share link on the owner's own site (`https://site/?dri=...`, valid 1 to 30 days, revocable). The page script fetches the changes from `/api/public/dri/:token`, which answers only the site the link was made for (CORS and `Origin` checked). The real site then runs normally with the changes applied, a tiled "Dry Run Iteration (DRI)" watermark and a badge in a closed shadow root, and `[DRI]` in the tab title. The token is kept in `sessionStorage` so it follows the visitor across pages. What visitors do on the site is real, and the badge says so.
- **Quick Start.** Connected sites, pick a stack (Node, Django, Flask or other Python, Laravel, plain PHP, static), copy the three settings and the snippet, press Check. Dry Run re-checks every 8 seconds for two minutes and shows a three-line checklist: ownership proved, server add-on connected, page script found on the home page.
- **Connectors** in `public/connector/`: `dryrun-connector.js`, `dryrun_connector.py` (WSGI), `dryrun-connector.php`, `dryrun_django.py` and `DryRunMiddleware.php` (Laravel), plus `dryrun.js`. Django and Laravel could not be installed where they were built, so those two are tested against minimal stand-ins for the framework, not the real thing. Try them on a real project before relying on them.

## Hardware Developer pack and Design studio
- New sector pack `hardware` with two scenarios (`print_run`, `build_economics`) and a `hardware_design` asset kind (parts, bought parts, print settings, price). The Coach suggests cheaper print settings or a price for a target margin, as a draft.
- **Design studio** (own tab, landing page for this pack, API under `/api/org/studio/*`): 14 parametric parts in three groups, robot (mounting plate, arm link, gripper finger, enclosure and lid), machine (involute spur gear, V pulley, stepped shaft, pipe reducer, hex bolt, L bracket) and automobile (wheel or rim, brake disc, connecting rod). Each is checked for sensible values and builds a closed solid in millimetres (`src/cad.js`, no dependencies). A software 3D viewer turns and zooms. Export STL (binary) or OBJ for one part or a print plate. The print check reports fit to the printer, best way up, overhang, thin walls, weight, hours and material cost. The slicer writes G-code (perimeters, straight infill, solid top and bottom) with a layer preview.
- Limits: estimates use stated assumptions (material price, machine rate, moulding cost). Strength is not modelled. The slicer is for prototyping, so open the G-code in your printer's own slicer first. There is no printer connection: you download the file. Parts are built from the catalogue, not imported from other CAD files.

## Importing models, printing and robots (Hardware Developer pack)

**Import.** In the Design studio, "Your files" takes STL (binary or text) and OBJ models, and G-code. A model can be added to a design as an imported part with a scale (use 25.4 for inches). It is print-checked, shown in the viewer, sliced and exported like any other part. Wall thickness and strength are not checked for imported models.

**Sending G-code.** Every file is scanned before it leaves: hotend and bed over the printer's limit, moves outside the bed or above the printer, driving into the bed, and commands that change settings or firmware (M92, M500, M997, M30 and others) are refused, and unknown printer macros are refused. Sending is upload-only by default. Starting a print needs the run role, a confirmation, and a printer that was set to allow starts.

| Printer | How | Status |
|---|---|---|
| OctoPrint | HTTP API with an API key. Also the route for USB-only printers such as EasyThreed K-series or Ender, via a Raspberry Pi | Tested against a stand-in server |
| Klipper (Moonraker) | HTTP API | Tested against a stand-in server |
| PrusaLink | HTTP API with an API key | Tested against a stand-in server |
| Bambu Lab | LAN mode: FTPS upload on port 990 (bridge only). You start the print on the printer | Not tested on a real printer |
| EasyThreed and similar | No network interface of their own. Use OctoPrint on a Pi, or download the G-code and copy it to the printer's card | n/a |

**Reaching devices.** Dry Run runs in the cloud and cannot see your Wi-Fi.
- **Bridge** (`public/bridge/dryrun-bridge.js`, one file, Node 18+): runs on your network and connects out to Dry Run, so nothing is opened on your router. Printer keys stay in its config file. It enforces its own limits: it rescans the G-code, only starts prints when `allowStart` is true, and only runs robot programs when `allowRun` is true. Start it with `node dryrun-bridge.js --init`, edit the file, then `node dryrun-bridge.js`.
- **Direct**: for a printer with a public, secured address. Addresses inside a private network are refused. Keys are encrypted at rest and never shown again.
- Robots are bridge-only. Running code is never exposed to the public internet.

**Robot programs.** An arm (servos) or a two-wheel rover. Steps: move joints, reach a point (inverse kinematics, refused if out of reach or past a joint limit), gripper, wait, repeat. Played in a simulation first. Code is generated for Arduino and ESP32 (C++), Raspberry Pi Pico (MicroPython), Raspberry Pi (Python) and ROS 2 (a package, downloaded as a zip). Generated code clamps every angle to your limits, ramps moves, and halts on an optional stop button. The simulation uses your link lengths only: no weight, torque or collisions other than the table. Rover distances are timed, not measured.

## Iterations, team votes and customer surveys

- **Who can iterate.** Everyone on a team except viewers can make an iteration on a connected Dry Run signed site and view it live. Viewers can look but not create, vote or start surveys.
- **Team votes.** Anyone who can iterate can start a vote between two or more member iterations. One vote each, changeable until closed. The creator or an admin closes it. The winner is copied as a Team iteration; a tie goes to the iteration made first.
- **Surveys about iterations.** Under Workroom → Surveys, pick 2 to 6 iterations (Team, individual, or a mix). Respondents see blind Option A, B, C labels, open each live with a DRI label, rate them and say which they prefer. Each channel has its own link so results show where answers came from. Results show at 5 or more answers.
- **General surveys** can also be created from the Workroom, using the same templates and custom questions as the main Surveys tab.
- **Design considerations.** "Use in design considerations" saves the results as an insight, posts a Coach note in General, and adds a "Customer feedback" option in the test bench next to regulatory, best practice, market and web.
- The live DRI link opens the owner's real site, so respondents' actions there are real.
