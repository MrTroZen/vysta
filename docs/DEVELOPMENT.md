# Development

This guide covers local development and the checks enforced by CI. It uses a local Wrangler Worker and local D1 database; none of these commands touch the remote Cloudflare database unless `--remote` is explicitly added.

## Prerequisites

- Node.js 20 or newer (CI uses Node.js 22)
- npm, included with Node.js
- Git

Install the exact dependency versions recorded in `package-lock.json`:

```bash
npm ci
```

On Windows PowerShell, an execution policy may block `npm.ps1`. Use `npm.cmd` in the commands below (for example, `npm.cmd ci`) instead of changing the machine execution policy.

## Local configuration

Copy the example development variables:

```bash
# macOS/Linux
cp .dev.vars.example .dev.vars

# Windows PowerShell
Copy-Item .dev.vars.example .dev.vars
```

The defaults are for local development only:

```dotenv
ADMIN_PASSWORD=change-me
SESSION_SECRET=any-long-random-string
```

Do not commit `.dev.vars`; it is ignored by Git. Use strong, unique values through `wrangler secret put` for deployed environments.

## Local D1

Create or update the local database by applying every forward migration:

```bash
npm run db:migrate:local
```

Wrangler stores the local database under `.wrangler/state`. The placeholder `database_id` in `wrangler.jsonc` is sufficient for local development; replace it only when configuring a remote D1 database.

To populate the local database with deterministic demo traffic after migrating it:

```bash
npm run seed
```

The seed is optional and replaces only the demo site with ID `demo0001`. Delete `.wrangler/state` only when you intentionally want to discard all local D1 data and start over.

## Run the application

For the production-like local path, build the dashboard and run it with the Worker at <http://localhost:8787>:

```bash
npm run build
npm run dev:api
```

For dashboard hot reload, keep the API Worker running in one terminal and start Vite in another:

```bash
npm run dev:web
```

Vite serves the dashboard at <http://localhost:5173> and proxies `/api` requests to the Worker on port 8787. `npm run dev` starts both processes together.

After startup, verify the basics:

1. Open <http://localhost:8787> (or port 5173 when using Vite).
2. Sign in with the local `ADMIN_PASSWORD`.
3. Confirm the websites screen renders and the **Add website** control opens its form.
4. Check that `GET /api/auth/me` returns HTTP 200.

The browser tracker intentionally ignores localhost unless its script tag includes `data-allow-localhost`. Do not commit that attribute to a production installation.

## Verification commands

Run the fast checks before starting smoke tests:

```bash
npm run typecheck
npm test
npm run build
```

The unit suite currently characterizes source classification, bot and user-agent handling, URL normalization, time ranges and buckets, and webhook signatures.

### Self-hosted smoke suite

Start a migrated Worker with the default values from `.dev.vars`, then run in a second terminal:

```bash
npm run smoke
```

Override the target or password when necessary:

```bash
BASE=http://localhost:8787 ADMIN_PASSWORD=change-me npm run smoke
```

In PowerShell:

```powershell
$env:BASE = 'http://localhost:8787'
$env:ADMIN_PASSWORD = 'change-me'
npm.cmd run smoke
```

The suite creates a temporary `smoke-test.com` site, exercises ingestion, reporting, funnels, journeys, and payment attribution, and deletes the site when it finishes.

### Hosted-mode smoke suite

Hosted mode is optional. For its local smoke suite, start a second Worker with test-only values:

```bash
npx wrangler dev --local --port 8788 \
  --var ADMIN_PASSWORD:change-me \
  --var SESSION_SECRET:any-long-random-string \
  --var GOOGLE_CLIENT_ID:test \
  --var GOOGLE_CLIENT_SECRET:test \
  --var ADMIN_EMAILS:owner@example.com \
  --var PLAN_PRODUCT_ID:pdt_plan \
  --var PLAN_SPOTS:50 \
  --var 'PLAN_CHECKOUT_URL:https://checkout.dodopayments.com/buy/pdt_plan?quantity=1' \
  --var BILLING_WEBHOOK_SECRET:whsec_dGVzdC1iaWxsaW5nLXNlY3JldA==
```

Then run:

```bash
BASE=http://localhost:8788 SESSION_SECRET=any-long-random-string node scripts/smoke-hosted.mjs
```

The hosted suite uses fake OAuth and billing configuration. It writes temporary local users/sites, checks plan enforcement and owner isolation, and cleans them up. It never contacts Google or Dodo.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests, and manual dispatch. It performs, in order:

1. `npm ci`
2. TypeScript typecheck
3. Unit tests
4. Production build
5. Local D1 migrations
6. Self-hosted smoke tests
7. Hosted-mode smoke tests

The CI smoke servers bind only to `127.0.0.1` and use test-only secrets. When a server fails to become ready, its Wrangler log is printed in the job output.

## Change safety

Phase 1 treats the existing analytics kernel as stable. Changes should preserve:

- tracker cookie names, payload fields, public API, SPA hooks, and Dodo metadata
- event/session definitions and acquisition captured at session creation
- payment matching order and last-non-direct attribution
- KPI, report, filter, and funnel semantics
- existing migration history; use new forward-only migrations
- public endpoints, webhook paths, site IDs, API-key formats, and self-hosted authentication behavior

Add characterization tests before intentionally changing any of these contracts.

## Troubleshooting

- **`npm.ps1` cannot be loaded on Windows:** run `npm.cmd`/`npx.cmd` rather than changing PowerShell execution policy.
- **Port 8787 is already in use:** stop the previous Wrangler process or choose another port and set `BASE` for smoke tests.
- **`Set ADMIN_PASSWORD and SESSION_SECRET`:** create `.dev.vars` from the example or pass both values with Wrangler `--var` flags.
- **D1 table errors:** run `npm run db:migrate:local` and confirm `npx wrangler d1 migrations list minilytics --local` reports no pending migrations.
- **Remote database confusion:** local commands must include `--local`; deployment and production migration commands intentionally use `--remote`.
- **Stale generated state:** stop Wrangler before deliberately removing `.wrangler/state`, then reapply migrations. This destroys only the local D1 database.
