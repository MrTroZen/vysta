# Security and production configuration

This document is the Phase 1.5 security inventory plus the Phase 1.6 dependency-remediation record for Vysta. It describes the current codebase; it does not mean the optional hosted/SaaS mode is production-hardened.

Never commit real credentials. Cloudflare recommends keeping local values in ignored `.dev.vars*` or `.env*` files and deployed values in encrypted Worker secrets, not plaintext Wrangler `vars`: [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## Deployment status

The production-runtime dependency blocker identified in Phase 1.5 has been remediated: MapLibre is on 6.16.0 and Live View passed a real-Chrome regression check. Before the first private deployment:

1. Create a production D1 database and replace the all-zero placeholder `database_id` in `wrangler.jsonc`.
2. Confirm the production Worker name and whether the top-level Wrangler configuration represents production or an explicit `production` environment.
3. Configure `ADMIN_PASSWORD` and `SESSION_SECRET` as Worker secrets.
4. Apply the existing migrations to the intended remote database only after confirming its name and ID.
5. Decide whether the deployment will remain publicly reachable on `workers.dev`, use a custom domain, or be protected with Cloudflare Access.
6. Confirm that no demo site or smoke-test data exists in the production database.

Do not run `npm run deploy` until these decisions are complete. That script builds, applies migrations to the configured **remote** D1 database, and deploys the Worker.

## Current Wrangler configuration

| Setting | Current value/state | Production action |
| --- | --- | --- |
| Worker name | `minilytics` | Confirm that this is the intended production Worker name and available account-wide. The name also determines the default `workers.dev` hostname. |
| Entry point | `src/worker/index.ts` | No change required. |
| Compatibility date | `2025-09-01` | It is deliberately pinned. Test before advancing it; do not change it during an unrelated deploy. |
| Static assets | `dist`, SPA fallback, Worker-first `/api/*` | Run the production build before deployment. |
| D1 binding | `DB`, database name `minilytics` | The binding matches the Worker code. |
| D1 database ID | All-zero placeholder | Hard blocker: create the production database and insert its real ID before any remote migration/deploy. |
| Observability | Enabled | Review Cloudflare log access and retention because request/error logs can contain operational metadata. Do not log secrets or full webhook bodies. |
| Routes/custom domain | Not configured | The first deploy will normally use a public `workers.dev` route. Add a Custom Domain explicitly if required. |
| Environments | No named environments | Local D1 is separate through `--local`, but persistent staging/production Workers and secrets are not separated in configuration. Add an explicit environment or use a dedicated production config before operating multiple persistent environments. |

Cloudflare creates separate Workers and non-inherited secrets for named Wrangler environments: [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/). Custom Domains receive managed DNS and certificates: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Cloudflare recommends a route or Custom Domain rather than `workers.dev` for business-critical production use: [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

## Secret inventory

### Worker-level secrets

| Name | Required | Storage | Rotation |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | Self-hosted mode | Cloudflare Worker secret. Local development only: ignored `.dev.vars`. Never store in `wrangler.jsonc`, source, CI YAML, screenshots, or logs. | Set a new strong value with `wrangler secret put ADMIN_PASSWORD`. Because existing sessions do not depend on the password after login, rotate `SESSION_SECRET` at the same time when immediate session invalidation is required. |
| `SESSION_SECRET` | All modes | Cloudflare Worker secret. Use a high-entropy random value unique to the environment. | Set a new value with `wrangler secret put SESSION_SECRET`. Rotation invalidates all existing 30-day dashboard sessions. |
| `GOOGLE_CLIENT_SECRET` | Hosted mode only | Cloudflare Worker secret; source value belongs in the Google Cloud credential store. | Create/rotate in Google Cloud, update the Worker secret, verify OAuth, then revoke the old credential. |
| `BILLING_WEBHOOK_SECRET` | Hosted billing only | Cloudflare Worker secret; source value belongs in Dodo's webhook configuration. | Coordinate replacement in Dodo and Cloudflare, verify signatures with the new value, then remove the old webhook/secret. Current code accepts one value, so there is no dual-secret overlap window. |

Commands above target the top-level Worker. If a named production environment is added, use the matching Wrangler `--env production` flag. Secrets are scoped to a Worker/environment and are not inherited.

### Configuration values that are not passwords

These values are not cryptographic secrets, but they are production configuration and should be environment-specific:

- `GOOGLE_CLIENT_ID`
- `ADMIN_EMAILS`
- `PLAN_CHECKOUT_URL`
- `PLAN_PRODUCT_ID`
- `PLAN_PRICE`
- `PLAN_INTERVAL`
- `PLAN_SPOTS`
- `SUPPORT_EMAIL`

Do not put personal email addresses or private checkout URLs in a public repository. They may be configured as Worker variables or secrets according to the deployment's privacy requirements.

### Deployment credentials

Interactive Wrangler login credentials and automation values such as `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are deployment credentials, not application bindings. Keep them in the operator's credential store or GitHub Actions encrypted secrets. Never place them in the repository, `.dev.vars.example`, workflow YAML, build output, or logs. Use a least-privilege API token and rotate/revoke it in Cloudflare.

### Per-site secrets stored in D1

| Database field | Purpose | Rotation/handling |
| --- | --- | --- |
| `sites.api_key` | Bearer credential for server-side goals and generic payment ingestion | Plaintext in D1 and returned to an authenticated dashboard. Rotate from Site Settings; the old key stops working immediately. Update every caller. |
| `sites.dodo_webhook_secret` | Verifies per-site Dodo webhooks | Plaintext in D1, masked in normal API responses. Replace it in Dodo and Site Settings as one coordinated change. There is no dual-secret overlap. |

D1 access, exports, backups, dashboard sessions, and support logs must therefore be treated as sensitive. Restrict Cloudflare account access and do not share raw database exports through public issue trackers or CI artifacts.

## Sensitive data stored in D1

The database also contains confidential or personal data even when a field is not an authentication secret:

- `visitors`: application user IDs, names, email addresses, and stable visitor IDs.
- `sessions`: acquisition data, URLs/paths, referrers, campaign values, approximate country/region/city and rounded coordinates, browser/OS/device, and stable visitor/session IDs.
- `events`: paths, event/goal names, outbound destinations, and arbitrary JSON properties that may accidentally contain sensitive data.
- `payments`: transaction, customer, subscription, visitor and session identifiers; email/name; amount/currency; and attribution metadata.
- `payment_claims`: payment/subscription identifiers mapped to visitor IDs.
- `login_failures`: source IP addresses and timestamps.
- `users` in hosted mode: Google subject, email/name/avatar, Dodo customer/subscription/payment identifiers, and plan state.
- `funnels` and `sites`: business configuration, domains, tracking IDs, and ownership.

Current retention is indefinite. There is no built-in export, erasure/anonymization, configurable retention, or privacy-request workflow.

## Dependency remediation and residual audit risk

Audit performed against the installed lockfile on 2026-10-26 after Phase 1.6. Current result: **0 critical, 1 high, 5 moderate**. No forced fix, transitive override, or unsupported downgrade was used.

| Package | Before / current | Dependency role | Deployed reachability and disposition | Breaking upgrade? |
| --- | --- | --- | --- | --- |
| `maplibre-gl` | `5.24.0` → `6.16.0`; advisory affected `<=6.4.0` | Direct production dashboard dependency | **Fixed.** The vulnerable browser code was reachable in Live View. Vysta now uses v6 named ESM imports, the explicit Vite worker URL, and `setWorkerUrl()`. Live View passed desktop-Chrome tile/style/marker/zoom/pan/navigation testing. | **Yes, completed.** No analytics behavior changed. |
| `tinypool` | `1.1.1` → absent | Former transitive dev dependency of Vitest | **Fixed/removed.** It is not in the deployed Worker/dashboard and is no longer present in the installed dependency tree. | Removed by the Vitest 3→4 upgrade. |
| `vitest` / `@vitest/mocker` | `3.2.7` → `4.1.12` | Direct dev dependency / transitive dev dependency | **Fixed.** Test tooling is not deployed. All 18 existing tests pass unchanged under Vitest 4.1.12. | **Yes, completed.** Vysta did not use affected removed APIs, so no test/config edits were required. |
| `undici` | `7.29.1`; affected aggregate range `7.0.0–7.30.0` (high excessive-content-encoding DoS: `>=7.18.0 <7.30.1`) | Transitive dev dependency, exact-pinned by Miniflare under Wrangler | **Residual high, development-only.** It is reachable in local/CI Wrangler and Miniflare HTTP operations but is not bundled into the deployed Worker/dashboard. The latest registry Wrangler remains `4.152.0` and pins `miniflare@5.20261019.2-beta`, which pins this Undici version. Wait for a supported Wrangler/Miniflare release using `undici >=7.30.1`; do not override the exact pin. | No Undici major is required. npm suggests an out-of-range Wrangler downgrade, which is not a safe remediation. |
| `tailwindcss` / `postcss-nested` / `postcss-selector-parser` | `tailwindcss@3.4.19`; selector parser affected `<7.1.6` | Direct and transitive build/dev dependencies | **Residual moderate, build-only.** Vysta processes repository-owned CSS/configuration at build time; these packages are not in the deployed Worker/dashboard JavaScript. npm's remediation is a Tailwind 4 major migration, outside this security-only phase. Keep untrusted CSS/configuration out of CI builds and plan the major separately. | **Yes.** Tailwind 3→4 is a breaking migration. |

Primary advisories: [MapLibre XSS](https://github.com/advisories/GHSA-jrc7-96c5-q579), [Tinypool worker-options RCE](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [Tinypool `run()`-options RCE](https://github.com/advisories/GHSA-85c8-ppgw-ccpr), [Undici excessive content-encoding DoS](https://github.com/advisories/GHSA-xjj6-f33q-929c), and [PostCSS selector-parser CPU exhaustion](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).

## Remediated and residual security inventory (Phase 1.7)

The Phase 1 audit identified several architectural and security limitations. The following have now been remediated:

- **Complete site deletion**: `DELETE /api/sites/:id` and demo seed scripts now delete associated `payment_claims` alongside events, sessions, visitors, payments, and funnels.
- **Defensive security headers**: All responses set `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and restrictive `Permissions-Policy`.
- **CSRF and Origin protection**: State-changing dashboard mutations (`POST`, `PATCH`, `DELETE`) validate `sec-fetch-site` (blocking cross-site requests) and origin headers, while preserving compatibility with local Vite dev proxying and non-browser tooling.
- **Session binding and duration bounds**: Event collection now binds existing sessions to their initial `visitor_id`, preventing session hijacking or cross-visitor contamination. Engaged duration updates via pings require `visitor_id` ownership and are bounded at a maximum of 24 hours per session.
- **Health diagnostics**: Added `/api/health` providing automated runtime readiness and D1 database connectivity checks.

### Remaining production security limitations

The following limitations remain for subsequent phases:

1. Public event ingestion is spoofable with a known site ID and allowed hostname; there is no replay defense, per-site quota, or platform rate limit.
2. Client-generated identify PII and arbitrary goal properties are accepted without strict schema validation.
3. Site API keys and Dodo webhook secrets are plaintext D1 fields; only API keys have a dedicated rotation action.
4. Sessions are stateless for 30 days with no revocation/version field.
5. Hosted Google OAuth lacks nonce/PKCE and does not independently verify the ID-token signature, expiry, or issued-at time. Hosted mode is not approved for production SaaS use.
6. Personal data and detailed journeys are retained indefinitely; arbitrary goal properties can contain sensitive data, and dashboard assets make third-party requests.
7. Schema integrity relies on application code rather than foreign keys, cascades, ownership constraints, or event-type checks.
8. Hosted plan enforcement is inconsistent across browser collection, API-key endpoints, and site webhooks.
9. Password brute-force protection is D1-based and basic; it has no platform rate limit and an `unknown` IP fallback bucket.

For a private self-hosted deployment, reduce exposure with a custom domain plus Cloudflare Access where practical, a strong unique password, a unique session secret, least-privilege Cloudflare account access, D1 backups, and monitoring.

## Repository and data safety

The repository ignores local dotenv/dev-var variants, `.wrangler` local D1 state, dependencies, build output and caches, coverage, logs, common private-key files, and JSON secret bundles. Example files may be committed only when they contain placeholders.

The demo seed command is local-only: it generates `.wrangler/seed.sql` and executes it with `--local`. Keep `--local` intact. Smoke tests must target localhost and must never be run against production. Before and after the first deployment, query the production database for unexpected `demo0001` or `smoke-test.com` rows.
