# Vysta / Minilytics Project Audit

Audit baseline: upstream `surendrapandar/minilytics`, branch `main`, commit `348cf74a441c7c101940d77529e5d9cc1282bf21` (2026-10-26). This audit is based on the complete cloned repository. No application code was changed.

## Executive summary

Minilytics is a compact Cloudflare-native analytics application with a sound core worth preserving. A browser tracker sends pageviews, goals, outbound clicks, identity updates, and engaged-time pings to a Hono Worker. The Worker enriches and stores them in D1, attributes payments, and serves an authenticated React dashboard. The current self-hosted mode already supports multiple websites behind one administrator password.

For Vysta Phase 1, keep the tracker payload, event/session semantics, attribution code, and reporting queries stable. First harden deployment, abuse controls, privacy/retention, backups, and regression coverage. Google Search Console and GA4 are not present. The optional hosted mode has Google sign-in, per-user site ownership, and Dodo plan billing, but it is an early account model—not workspaces or production-grade multi-tenancy.

## Architecture overview

| Layer | Implementation | Responsibility |
| --- | --- | --- |
| Tracker | `public/js/script.js` (plain browser JavaScript) | First-party IDs, SPA pageviews, engaged time, goals, outbound links, identify calls, Dodo link metadata |
| API/edge | Cloudflare Worker + Hono in `src/worker/` | Authentication, ingestion, site management, stats, funnels, payments, webhooks, hosted billing |
| Storage | Cloudflare D1 (SQLite), migrations `0001`–`0005` | Sites, visitors, sessions, events, payments, funnels, auth throttling, payment claims, users |
| Dashboard | React 18 + Vite + Tailwind + Recharts | Site list/settings, KPI dashboard, breakdown filters, funnels, journeys, visitor profiles, live map |
| Static delivery | Cloudflare Workers Static Assets from `dist/` | Dashboard SPA and tracker; only `/api/*` runs the Worker first |
| Integrations | Dodo Payments; optional Google OAuth; OpenFreeMap | Revenue ingestion/plan billing, hosted login, live map tiles |

There is no separate backend service, queue, cron job, ORM, or cache service. SQL is issued directly through the D1 binding. A per-Worker-isolate, 60-second in-memory cache is used for site configuration during ingestion.

## Directory structure

```text
.
├── migrations/               # Five ordered D1 schema migrations
├── public/
│   ├── js/script.js          # Embeddable analytics tracker
│   ├── landing/              # Marketing screenshots
│   └── _headers              # Tracker CORS/cache headers only
├── scripts/
│   ├── seed-demo.mjs         # Generates local demo SQL
│   ├── smoke.mjs             # Self-hosted end-to-end smoke suite
│   └── smoke-hosted.mjs      # Hosted/auth/billing isolation smoke suite
├── src/
│   ├── dashboard/            # React SPA: pages, panels, live map, journeys
│   ├── shared/               # Source classification and anonymous names
│   └── worker/               # Hono routes, auth, collection, stats, payments
├── test/core.test.ts         # Vitest unit tests
├── README.md                 # Deployment, tracking, and payment documentation
├── package.json              # Node 20+ scripts and dependencies
├── vite.config.ts            # Dashboard build and local API proxy
├── vitest.config.ts          # Unit-test discovery
└── wrangler.jsonc            # Worker, static assets, and D1 binding
```

## Database schema

All timestamps are integer milliseconds. Monetary amounts are integer minor units. Most tenant-scoped entities use `site_id`, but the schema defines no foreign keys or cascading deletes.

| Table | Purpose and important fields |
| --- | --- |
| `sites` | Tracking site: `id`, name/domain, timezone/currency, plaintext API key, Dodo webhook secret/product allowlist, optional `owner_id` |
| `visitors` | Site-scoped browser identity: ID, first seen, optional application user ID/name/email; composite primary key `(site_id,id)` |
| `sessions` | Client-ID session and acquisition snapshot: times/duration, counts, host/pages, referrer/UTMs/ref, geo, UA/device, rounded lat/lon; composite primary key `(site_id,id)` |
| `events` | Append-only pageview/goal/outbound rows: session/visitor IDs, timestamp, name/path, JSON props |
| `payments` | Payments/refunds: provider ID, amount/currency, visitor/session/customer identity, renewal, match method, subscription ID |
| `funnels` | Site-scoped named JSON step definitions (page or goal) |
| `login_failures` | IP and timestamp for self-hosted password throttling |
| `payment_claims` | Return-page payment/subscription ID mapped to a visitor |
| `users` | Optional hosted-mode Google identity and Dodo plan state |

Indexes cover common session/event/payment time and identity queries plus site ownership and login failures. There are no uniqueness rules for site domains, schema-level event-type checks, referential integrity, retention partitions, or aggregate tables.

## Request and data flow

### Website creation and tracking IDs

1. An authenticated user submits domain, optional name, timezone, and currency to `POST /api/sites`.
2. The Worker normalizes and validates the domain, generates a random 16-character site ID and an `ml_` API key, then inserts the site. In hosted mode it assigns `owner_id`; in self-hosted mode ownership is `NULL` and the single admin can see all sites.
3. The site ID is embedded as `data-website-id` in the script tag. It is a public routing identifier, not a secret. The API key is separate and authorizes server-side goals/payments.

### Browser collection

1. `script.js` reads or creates `ml_vid` (one year) and `ml_sid` (sliding 30 minutes) first-party cookies. It attempts a root-domain cookie so subdomains share identity. IDs are UUIDs and are entirely client-generated.
2. It skips localhost by default, opted-out browsers (`ml_ignore` in local storage), and `navigator.webdriver`.
3. It sends JSON as `text/plain` to `POST /api/event` using `sendBeacon` or keepalive `fetch`. Payload types are `pageview`, `goal`, `outbound`, `ping`, and `identify`.
4. History API changes and popstate generate SPA pageviews. Visible time is flushed as pings. Elements with `data-ml-goal` and the public `minilytics()` API generate goals. Cross-domain link clicks generate outbound events.
5. The URL scrubber removes query parameters whose names match a sensitive denylist. The Worker retains the normalized path and selected attribution/payment parameters, not the general query string.
6. Dodo links are decorated with visitor/session metadata; Dodo return-page `payment_id` or `subscription_id` parameters create payment claims.

### Worker ingestion

1. The Worker limits the raw body to 8 KiB, checks payload type/ID shape, rejects known bot user agents, loads the site, and verifies the payload URL hostname equals the configured domain or a subdomain.
2. Cloudflare request metadata supplies location; coordinates are rounded to two decimals. Vercel geo headers are trusted when present for proxied collection. User agent parsing supplies browser/OS/device.
3. A new client session captures its acquisition values once. Pageviews update counters/exit page, goals update goal counts, outbound events are appended, identifies update visitor PII, and pings add engaged duration.
4. Source/channel classification prefers `ref`/UTM data and otherwise maps referrer domains; absent attribution becomes Direct.

### Reporting, goals, funnels, and journeys

- Dashboard calls require a signed login cookie and pass through a site-access query. Stats are calculated directly from D1 for the selected/current and preceding ranges.
- Filters are exact-match AND conditions over acquisition, geo, device, host, page, or goal. Breakdowns include traffic, revenue, and customer counts.
- “Goals” are named events rather than separately configured goal definitions. They can come from HTML attributes, browser API calls, or the API-key-protected server endpoint.
- Funnels store 2–10 ordered page/goal steps. They count visitors progressing in order within the chosen report period, across sessions; page steps allow `*` wildcards. Evaluation reads at most 100,000 matching events.
- Visitor journeys combine visitor identity, up to 100 sessions, 1,000 events, and all attributed payments. List endpoints cap visitors/customers at 200.

### Payment attribution

- Dodo webhook signatures use Standard Webhooks HMAC with a five-minute timestamp window. Generic providers use the site bearer API key.
- Matching priority is explicit visitor metadata, return-page claim, previous customer/email, identified visitor email, then conservative checkout timing. Revenue credit goes to the visitor's most recent non-direct session before payment (or latest direct session if none exists).
- Refunds are negative payment rows. Renewals are recognized from prior customer/payment data. A manual rematch endpoint retries up to 500 unattributed payments.

## Authentication and tenancy

- **Self-hosted default:** one shared `ADMIN_PASSWORD`; a 30-day HMAC-signed, HTTP-only, SameSite=Lax cookie represents the synthetic `admin` user. All sites are visible.
- **Hosted optional mode:** enabled when both Google OAuth secrets exist. Google users are stored in `users`; signed cookies contain the user ID. `ADMIN_EMAILS` receive free/admin access and claim pre-account sites. Other users must have an active Dodo-backed plan to create sites.
- Hosted site reads and dashboard mutations are scoped by `owner_id`. This is basic per-owner isolation, not workspace tenancy: there are no organizations, memberships, roles, invitations, service accounts, or per-site sharing.

## Current features

- Multiple sites under one self-hosted login
- Pageviews, visitors, sessions, bounce rate, engaged time, live users, prior-period comparisons
- Acquisition channels, referrers, UTMs, `ref`, geography, browser/OS/device, entry/exit/page/host breakdowns
- Exact-match dashboard filters and custom date/granularity controls
- Browser and server-side goals; ordered funnels
- Anonymous friendly visitor names, identify calls, visitor profiles, and timelines
- Dodo and generic payment ingestion, refunds, last-non-direct attribution, journey/rematch UI
- Live 2D/3D map and recent event/payment feed
- SPA tracking, subdomain cookies, browser opt-out, bot filtering, ad-blocker proxy guidance
- Optional Google-login hosted landing/billing flow with basic per-user ownership

## Missing or immature features

- No Google Search Console or GA4 integration, import, reconciliation, or OAuth/token storage for either.
- No workspaces, membership/roles, invitations, shared sites, organization billing, or strong tenant administration.
- No configurable goal definitions, conversion windows, funnel time limits, cohorting, retention, paths, annotations, saved segments, or flexible boolean/range filters.
- No first-/multi-touch model selection, configurable attribution window, campaign cost/ROAS, LTV cohorts, recurring-revenue metrics, or broad payment-provider adapters.
- No data export/import, backup/restore workflow, retention policy, deletion/anonymization workflow, consent-mode API, or privacy-request tooling.
- No aggregate/rollup strategy for large datasets; report queries scan raw D1 rows and several endpoints have hard caps.
- No operational admin UI, audit log, alerting, health endpoint, ingestion diagnostics, per-site quotas, usage metering, or migration rollback guidance.
- Hosted billing/legal pages are a starting point only; SaaS readiness needs entitlement reconciliation, support/admin tooling, abuse controls, and reviewed legal/privacy material.

## Security and privacy concerns

Priority findings for Phase 1:

1. **Public ingestion is spoofable.** A site ID and allowed hostname in the client-supplied URL are sufficient to submit events. CORS and hostname checking prevent accidental cross-site data but not scripted pollution. There is no rate limit, replay/deduplication key, origin policy, or per-site abuse quota.
2. **Client identity and counters are trusted.** Visitor/session IDs, identify PII, goal props, and ping duration are client-controlled. Repeated pings can inflate duration; a known visitor ID can have identity fields overwritten; a reused session ID can create inconsistent visitor/event ownership.
3. **Site deletion is incomplete.** It deletes events, sessions, visitors, payments, funnels, and the site, but not `payment_claims`, leaving site-linked data behind.
4. **Secrets are stored directly.** Site API keys and Dodo webhook secrets are plaintext database fields; the API key is returned to authenticated dashboard clients. Rotation exists only for the API key. Treat D1 access, dashboard sessions, logs, and backups accordingly.
5. **Session and CSRF hardening is limited.** Sessions are stateless and valid for 30 days with no revocation/versioning. SameSite=Lax helps, but state-changing dashboard routes have no explicit CSRF token or Origin check. Static responses define no CSP, HSTS, frame, MIME-sniffing, or referrer security headers.
6. **OAuth validation should be strengthened before SaaS.** State and issuer/audience/email checks exist, but there is no nonce/PKCE and the ID token signature, expiry, and issued-at claims are not independently verified.
7. **PII/privacy controls are incomplete.** Identify and payment flows store email/name/user ID; approximate location and detailed journeys are retained indefinitely. Query sanitization is denylist-based, and arbitrary goal properties may contain sensitive data. Google Fonts, Google favicon lookup, Google avatars, and OpenFreeMap create third-party requests from the dashboard.
8. **Schema integrity is application-only.** There are no foreign keys/cascades, ownership constraints, event-type checks, or domain uniqueness. Several JSON/webhook paths rely on provider-valid payloads and do not consistently catch malformed JSON or constrain amounts/currencies/timestamps.
9. **Hosted plan enforcement is inconsistent.** Browser event collection stops for expired owners, but API-key goals/payments and site webhooks do not apply the same owner-active check.
10. **Brute-force control is basic.** Password login uses constant-time comparison and a 10-attempt/15-minute D1 throttle, but the fallback `unknown` IP bucket can affect unrelated clients and there is no platform-level rate limit.

The code does have useful safeguards: parameterized SQL for user values, site-scoped dashboard queries, domain-bound ingestion, payload/field clipping, bot filtering, signed HTTP-only cookies, OAuth state, webhook HMAC/timestamp validation, payment idempotency through primary keys, and masked webhook secrets in dashboard responses.

## Existing tests and verification status

| Suite | Coverage | Audit result |
| --- | --- | --- |
| `test/core.test.ts` | Source classification, bots/UA, domain/path normalization, timezone/ranges/buckets, webhook signatures | Inspected; not executed |
| `scripts/smoke.mjs` | Login, CRUD, ingestion, bot/domain rejection, KPIs, filters, goals/funnels, journeys, attribution fallbacks, live view, deletion | Inspected; not executed |
| `scripts/smoke-hosted.mjs` | Google-mode routing, billing, account/site isolation, plan expiry/refunds, webhook signatures | Inspected; not executed |
| `npm run typecheck` / `npm run build` | TypeScript and production dashboard build | Not executed |

Execution was not possible in the audit environment because no Node.js runtime or package manager is installed (`node`, `npm`, `npx`, `pnpm`, `yarn`, and `bun` were all unavailable). No test is reported as passing. There is also no checked-in CI workflow. Test gaps include direct authorization matrix tests for every route, ingestion abuse/race cases, deletion completeness, CSRF/security headers, malformed payload fuzzing, migration tests, high-volume query behavior, and browser tracker tests.

## Areas to avoid changing initially

- `public/js/script.js` cookie names, payload fields, public API, SPA hooks, and Dodo metadata contract
- Event/session definitions and acquisition captured at session creation
- Existing migrations; add forward-only migrations rather than rewriting history
- Payment matching priority and `creditedSessionSql()` last-non-direct behavior
- Stats KPI formulas and report/filter semantics until protected by characterization tests
- Public endpoints, webhook URLs, site IDs, and API-key formats used by installed sites
- Self-hosted authentication behavior while Phase 1 is being stabilized
- Source classification and UA parsing without fixture-based regression coverage

## Recommended development roadmap

### Phase 1 — safe multi-site self-hosting

1. Pin a Vysta upstream baseline and add CI for install, typecheck, unit tests, build, migrations, both smoke suites, and tracker browser tests.
2. Document environment separation, Cloudflare setup, secrets, custom domain/TLS, D1 backup/export/restore, deploy/rollback, and upgrade procedure. Add startup/config validation and health/diagnostic checks.
3. Add forward-only integrity migrations and complete deletion, including payment claims. Define retention, data export, visitor erasure/anonymization, consent/opt-out behavior, and a privacy inventory.
4. Add Cloudflare rate limiting/abuse controls for ingestion, login, generic APIs, and webhooks; validate Origin where useful, cap counter growth, bind events to session ownership, and add deduplication/replay defenses.
5. Add security headers, explicit CSRF/Origin protection, tighter input validation, secret-handling guidance, and dependency/security scanning. Keep the existing single-admin model for this phase.
6. Establish baseline load tests and D1 query plans at realistic event volumes before changing schema or analytics logic.

### Phase 2 — GSC and GA4

1. Design encrypted integration credentials/tokens separately from analytics identity and future tenant membership.
2. Add per-site Google OAuth connections, refresh/revocation handling, least-privilege scopes, sync cursors/jobs, backoff, and observable sync status.
3. Store imported GSC/GA4 facts in separate namespaced tables. Reconcile by site/date/dimension in the UI without modifying raw Minilytics events or KPI definitions initially.

### Phase 3 — analytics and revenue depth

1. Add configurable goal definitions and characterization tests around current raw goal events.
2. Introduce saved/compound filters, conversion/funnel windows, cohorts/retention, path analysis, and scalable aggregates.
3. Version attribution models; preserve current last-non-direct as the default. Add first/last/multi-touch views, attribution windows, product/order fields, LTV/MRR, and provider adapters.

### Phase 4 — accounts, workspaces, multi-tenancy

1. Introduce `workspaces`, `workspace_members`, roles, invitations, and workspace-owned sites through additive migrations.
2. Centralize authorization policy and test every resource/action across owner/admin/member/outsider states. Add audit logs and tenant-aware jobs, quotas, exports, integrations, and secret ownership.
3. Migrate existing self-hosted sites into a default workspace while preserving site IDs and installed trackers.

### Phase 5 — possible paid SaaS

1. Harden Google identity validation and session lifecycle; add verified email/account recovery, support/admin tools, incident controls, and deletion/export SLAs.
2. Build reliable entitlement reconciliation, metering/limits, webhook replay tracking, dunning, invoices/tax expectations, and workspace billing.
3. Complete security/privacy review, policies, subprocessor disclosures, monitoring/SLOs, backups/disaster recovery, and capacity/cost testing before public launch.

## Cloudflare and external dependencies

The current deployment is tightly coupled to Cloudflare Workers runtime APIs, D1 and its prepared/batch interface, Workers Static Assets (`ASSETS`), `request.cf` geolocation, Wrangler migrations/deploy, and Cloudflare platform limits. Rehosting would require adapters for all of these. Optional or secondary dependencies are Google OAuth/token endpoints, Dodo Payments checkout/webhooks, OpenFreeMap tiles, Google Fonts/favicon service, and optional Vercel geo headers when proxying collection.

The safest Vysta strategy is evolutionary: stabilize and characterize Minilytics as the analytics kernel, place new integrations and tenancy structures alongside it, and change core collection/attribution semantics only through explicit, tested versions.
