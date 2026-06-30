# Deploying HNN Biller to Railway

This is a single Node/Express service that serves both the APIs and the hosted
front ends, so **one Railway service** runs everything. No build step, no database
required for the demo (it uses an in-memory store — see the persistence note).

The repo already includes what Railway needs:
- `package.json` with `"start": "node src/server.js"` and `"engines": { "node": ">=18" }`
- `Procfile` (`web: npm start`), `.nvmrc` (Node 20), `railway.json`
- The server binds to `process.env.PORT`, which Railway injects automatically.

## Option A — Deploy from GitHub (recommended)

1. Put this folder in a GitHub repo:
   ```bash
   cd composite-billing-api
   git init && git add . && git commit -m "HNN Biller"
   git branch -M main
   git remote add origin https://github.com/<you>/hnn-biller.git
   git push -u origin main
   ```
2. In Railway: **New Project → Deploy from GitHub repo →** pick the repo.
3. Railway auto-detects Node (Nixpacks), runs `npm install`, then `npm start`.
4. **Variables** tab → add the env vars below (start with `SBG_SANDBOX=true`).
5. **Settings → Networking → Generate Domain** to get a public URL.
6. Open `https://<your-domain>/app/biller.html`.

## Option B — Deploy from your machine with the CLI

```bash
npm i -g @railway/cli
railway login
cd composite-billing-api
railway init            # create a new project
railway up              # build & deploy this folder
railway domain          # generate a public URL
railway variables --set SBG_SANDBOX=true
```

## Environment variables

| Variable | Value |
| --- | --- |
| `SBG_SANDBOX` | `true` to run with mock Stanbic (no creds). `false` for live. |
| `SBG_BASE_URL` | `https://api.marketplaceuat.stanbic.com.gh` (or prod URL) |
| `SBG_USERNAME` / `SBG_PASSWORD` | Stanbic creds — only when `SBG_SANDBOX=false`. Set in Railway Variables, never in code. |
| `COLLECTION_WEBHOOK_SECRET` | Shared secret for the collection webhook |

`PORT` is provided by Railway — do **not** set it yourself.

## After it's up

- Clinic terminal: `/app/biller.html`
- Clinic dashboard: `/app/dashboard.html`
- Payer console: `/app/payers.html`
- Patient checkout: `/pay/?intent=…`
- Insurer/payer claim link: `/claim/?token=…`
- Printable medical report: `/report/?token=…`
- Health check (point Railway's healthcheck here): `/health`

Optional: in Railway, **Settings → Deploy → Healthcheck Path** → `/health`.

## Persistence (PostgreSQL) — recommended for production

The app has two interchangeable storage backends, chosen at runtime:

- **`DATABASE_URL` set** → PostgreSQL. Data survives restarts and is shared across
  instances, so you can scale the service horizontally. The schema is created
  automatically on first boot and config rows (clinics, payers, financiers) are
  seeded with `ON CONFLICT DO NOTHING` (so later edits in the DB aren't clobbered).
- **`DATABASE_URL` unset** → in-memory (local/demo only; resets on restart).

To turn on Postgres in Railway:

1. In your project: **New → Database → Add PostgreSQL**.
2. Open your **app service → Variables → New Variable → Add Reference →**
   select the Postgres service's **`DATABASE_URL`**. (Using the reference wires the
   internal `*.railway.internal` host, which is fast and needs no SSL.)
3. Redeploy. The logs will print `Store: PostgreSQL (persistent)`.
4. If you instead use a **public** Postgres URL, also set `PGSSL=true`.
   Optional: `PG_POOL_MAX` (default 10) to size the connection pool.

Money-moving paths (claim authorisation, financing settlement, self-pay) use
`SELECT … FOR UPDATE` inside a transaction, so a claim can't be double-authorised
even with multiple instances running.

### Scaling to multiple instances

Once Postgres is on, raise replicas in **Settings → Deploy → Replicas**. All state
lives in the DB, so any instance can serve any request. (The only thing still
in-process is the notification log writer, which also persists to the DB.)

## Custom domain (optional)

Railway **Settings → Networking → Custom Domain** → add e.g. `biller.hnn.com` and set
the CNAME it shows at your DNS provider.

## Audit ledger & idempotency

Every settlement is recorded in an append-only `ledger` table in the same transaction
as the bill update (audit/reconciliation), and the authorize/financing endpoints accept
an `Idempotency-Key` header so client retries don't double-execute. Both are created
automatically as part of the schema — nothing extra to configure on Railway.
