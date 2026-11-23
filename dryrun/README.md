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

## Working model and the DRI signing kit

- Entering a site address and choosing "Read public pages and build a working model" reads only what any visitor can see (robots.txt is respected) and builds an editable working model: pages, menu, forms, assumed features. It is not a copy and holds none of the site's code or images.
- **Market research** the team is allowed to use (own studies, licensed reports, public statistics) can be pasted or loaded as text, Markdown or CSV. Email addresses and phone numbers are removed. It is added to the model.
- Any member who can iterate can save **iterations on the model** (add, change or remove something). Voting and customer surveys need live pages, so they need DRI signing.
- Under every working model there is a footnote: "Get more done with DRI signing. If you have genuine access to the web application, install the following and get better control of the iterative process." It lists a download link per stack and **Everything as one text file** (`dri-signing-kit.txt`): settings, setup for each stack, links, and the full source of every connector file. Save it, or upload it to your build assistant to integrate into your own products. It contains the site secret, so admins and builders only.

## Platform messages and the Platform assistant

- **Message a team** (platform owner, "Team messages"): send an announcement or a suggestion to one team, several or all. It appears in each team's General room from "Platform team". Members mark it Helpful or Not for us; the owner sees counts only. Optionally text each team's admins to look. The owner cannot read team rooms.
- **Ask the platform team** (Workroom, any member except viewers): a team asks for help and ticks exactly what it will share (product results, rules, customer feedback, recent chat). Nothing else is read. The reply lands in General.
- **Platform assistant**: drafts a reply for one open help request, from the question and the shared items only. It cannot be pointed at a team that has not asked, cannot draft twice for an answered request, and sends nothing: the owner reads, edits, checks the wording (emails, keys, promises, length) and sends. It is rule-based, so no data leaves the platform; a hosted model can replace `draft()` in `src/platformdesk.js` behind the same shape.

Every message the platform sends (announcements, suggestions and replies to help requests) is kept in full: text, which teams got it, whether admins were texted, and each team's answer (Helpful, Not for us, Mixed, or none). Under "Team messages" you can open any message, **send it to other teams** (for example after a team answered "Not for us"; you can reword it first, the original stays as sent; a team never receives the same message twice), and download the whole record as a spreadsheet (`/api/platform/notices.csv`). Each send is also written to the receiving team's audit log and to the platform log (`/api/platform/message-log`).

**What a team does with a platform suggestion.** Each suggestion in General has two choices, and nothing is applied for them: *Add to design considerations* (the test bench lists it as "Platform team suggestions", next to regulator rules, best practice, market and customer feedback, with a "Try it as a variation" button when it names a number such as "premium 2%"), and *Add to iteration ideas* (it appears on Connected sites with "Use as an iteration", which fills in the iteration form). Either choice also counts as Helpful. The platform sees that a team added it, not how it was used.

**Request to add DRI Chief.** In Team messages, the "Request to add DRI Chief" tab sends a suggestion whose card gives each team's admin *Approve* and *Decline*. Approving adds a limited seat named "DRI Chief" (role `contributor`: read, make iterations, vote, post; no settings, site connecting, approving, promoting or team management). It does not use up one of the team's places, has no password anyone knows, and the team can remove it under Team at any time, which ends its access at once. After approval the owner sees the team under "DRI Chief seats" and can open it as DRI Chief in a new tab. The request, each decision, and each time the seat is opened are written to the logs.

**Messages to people on several teams.** In the owner's people panel, "This message is about" lets you pick the team and project the text refers to. People are matched across teams by email or phone, so a person on several teams is offered all of them, each with its project names (names only, never content). The SMS starts "Re <team> / <project>:" so the person knows which you mean. Anyone not on the chosen team is skipped and told so in the result. The message log records the team and project but never the text. "Also show it in that team's General room" posts it there as a platform suggestion, with the usual log and Helpful / Not for us answers.

**Texts to the owner.** Under Team messages, "Text me when a team responds" sends you an SMS when a team answers Helpful or Not for us, adds your suggestion to its plan, asks for help, or decides on DRI Chief. You pick which kinds, and can send a test text. You get one text per team and message (not one per person), at most 20 a day. The text names the team, never the person, and never repeats what you wrote. Needs SMS set up on the service (`AT_API_KEY` and `AT_USERNAME`).

**Message history.** The platform owner's message history (Directory) keeps the full text of every message, sent or failed, with the team, person, purpose, what it was about, the channel and the reason for any failure. Passwords and keys inside a text are replaced with `[hidden]` before it is stored. It can be searched, filtered to Failed, and downloaded as a spreadsheet (`/api/platform/messages.csv`). Teams see only their own delivery results, never the text. The last 1,500 messages are kept; messages sent before this change show no text.

## Multilingual Workroom

Everyone chooses the language they read and write in, and the Workroom shows each message to each reader in their own language. You type in English, a teammate reads Portuguese; they reply in Portuguese, you read English.

- **Your language:** the "I read and write in" picker above the chat (13 languages: English, Portuguese, French, Spanish, Arabic, Chinese, Hindi, German, Swahili, Twi, Hausa, Yoruba, Ga). Everyone sets only their own. "Translate for me" and "Show originals" are per person. Each translated message says what language it came from and has "Show original".
- **The Interpreter bot:** type `/lang pt`, `/lang`, `/who`, `/original on|off`, `/translate on|off` or `/help` in the composer. It answers only you and is not posted to the room. Viewers can use it to set their language.
- **Writing in another language for one message** ("Writing in" in the composer) and **Preview what others will read** before you send.
- **How it works:** each message is stored once in the author's words with the language it was written in. Translations are made for the reader through your own LibreTranslate service (`LIBRETRANSLATE_URL`, optionally `LIBRETRANSLATE_API_KEY`), cached so each text and language pair is translated only once, and bounded by a daily character cap (`TRANSLATE_DAILY_CHARS`, default 300,000 overall and `TRANSLATE_DAILY_CHARS_PER_TEAM`, default 60,000). Code, links, file paths and @mentions are never translated. If the translator is off, down, over its cap, or lacks a language, people read the original words and are told so. Twi, Hausa, Yoruba and Ga are normally not in LibreTranslate, so readers of those see the original, flagged.
- **Where it applies:** team rooms (messages, Coach replies and platform messages). Guest rooms shared with clients are not translated. The platform owner sees the translator's status under Platform settings.
- **Privacy:** message text is sent to your translation service only, not to any outside company, as long as LibreTranslate is self-hosted.

## Pen Test as a service

An organisation proves it owns a web address, agrees the rules and dates, and an administrator authorises the test. It is then run by the organisation's own team, by the platform owner, or by a listed **security firm** (a new partner account type, `security_firm`). Open **Security tests** in the workspace; the platform owner has the same tab for oversight and for tests assigned to the platform team.

**What it does, and does not do.** The built-in checks are a posture review of a handful of read-only GET requests each: certificate and TLS version, HTTP-to-HTTPS redirect, security headers, cookie flags, version disclosure, cross-origin settings, five well-known files that should not be public, and `security.txt`. Nothing is exploited, guessed, fuzzed or brute-forced, and the contents of an exposed file are never stored (only that it matched a known signature). Deeper work comes from an outside scanner the organisation connects, or a human tester who records findings by hand or imports them as JSON.

**Guards that always apply**
- The address must be proven by a text file at `/.well-known/dryrun-pentest.txt` or a DNS TXT record at `_dryrun-pentest.<host>`; proof lasts 30 days.
- Private, loopback, link-local and cloud-metadata addresses are refused, the name is re-resolved and pinned on every request, ports are limited to 80, 443, 8080 and 8443, and redirects are never followed. Scanner addresses get the same treatment and must use https.
- Every run needs an engagement that an administrator signed (full name and a declaration), inside its dates (up to 30 days), using only the checks agreed, on addresses in scope. At most 40 requests per run, paced.
- A tester from outside the organisation must accept first. A firm sees only the engagements assigned to it.
- An administrator can stop an engagement at any time; the platform owner can pause all testing at once. Authorisations, runs and findings go to the audit log.
- Fees are a record only. Dry Run does not collect or pay money.

**Findings** have a severity and a status (open, accepted risk, fixed, verified fixed, still present after fix). Running the checks again after a fix marks what has gone as verified fixed and flags anything that returns. Reports download as Markdown or CSV and state the method and its limits.

Outside scanner contract: Dry Run `POST`s `{engagementId, target, scope[], window{startsAt,endsAt}, rules}` with `Authorization: Bearer <token>` and expects `{ "findings": [{ "id", "title", "severity", "description", "evidence", "remediation" }] }`. The token is encrypted at rest and never returned. Smoke: `npm run smoke:pentest`. `DRYRUN_PENTEST_ALLOW_PRIVATE=1` exists only so the automated tests can aim at a local server; never set it in production.

## My apps: open every app for iteration

The platform owner's **My apps** tab lists every app you run with its Railway address and its own subdomain (seeded with Dry Run, HNN Biller, the TrimesterSave app, ERHeat and the two SMS services). Choose a workspace and press **Open all my apps**, or open a few. Each address becomes a connected site: Dry Run reads its public pages and builds a working model the team can iterate on straight away, with nothing installed. An address it cannot read yet (a sign-in wall, a cold start) is still added and says why. Installing the Dry Run connector later upgrades a site to Dry Run signed.

Type only the extension: a Railway name such as `erheat-app-production` becomes `erheat-app-production.up.railway.app`, and subdomains such as `dryrun` and `biller` are joined to your domain. Workspaces get the same box under Workroom, Connected sites ("Add several sites at once"). A workspace can hold 20 sites; the same site reached by two addresses on one host counts once. Edit the list from the tab, or `PUT /api/platform/apps`. Smoke: `npm run smoke:apps`.

## Invite by email link

On the Team tab, **Invite by email link** takes one or more email addresses and a role, and makes a personal link for each. Opening the link shows who it is for; one click on **Sign in and continue** signs them in with no username or password. They are then asked for their mobile number (confirmed with one text) and to choose a password for next time, and a reminder stays on screen until the number is added. A link works once and expires after 7 days; an administrator can make a fresh one at any time, and the platform owner can invite into any workspace (`POST /api/platform/orgs/:id/email-invite`).

Links are shared by hand by default: each result has **Copy link** and **Email it** (opens your own mail app with the message ready). To have Dry Run send the email itself, set `RESEND_API_KEY` and `EMAIL_FROM` (a sender address verified with Resend). The message history records each email without the sign-in link. Smoke: `npm run smoke:invite`.

**My apps** now starts with TrimesterSave BirthPrep (`tmsapp.trimestersave.com/birthprep` and its Railway address), with an **Open BirthPrep first** button.

## One link for everyone (general join link)

In Team, **One link for everyone** makes a single link you can paste into any email or chat. Whoever opens it types their own email (and mobile number); Dry Run then sends them *their own* personal sign-in link by text, and by email too when email sending is set up. The personal link is never shown on the page. Options: role, allowed email domains, a cap on people, an expiry; you can replace or switch it off at any time.

Safeguards: existing members only ever receive the link at the email and phone already on file; requests are rate-limited per address and per IP; seat limits apply; personal links are hidden in the message log. Anyone holding the link can request to join, so use a domain list or cap for wider sharing.

### Free email sending
Set `EMAIL_FROM` (for example `Dry Run <hello@yourdomain.com>`) plus **`BREVO_API_KEY`** (Brevo free plan: 300 emails a day) or `RESEND_API_KEY` (Resend free plan: 100 a day, 3,000 a month). Verify your sending domain or address with the provider first. Without these, the link is sent by text only.

Smoke test: `npm run smoke:join`.
