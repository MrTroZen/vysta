# Vysta Status

Current snapshot as of 2026-10-28.

## Recorded production state

- The prior local status records P0 Critical Accuracy as live in production at commit `0b18a0ec1f58b3e5b2f97254445205f59ccd7d36` and Worker version `c4b9cd5d-a074-4086-ad18-18eb03fb7ff6`.
- It also records healthy Worker/D1 connectivity and migrations `0006_event_idempotency.sql` and `0007_server_goal_idempotency.sql` as applied.
- This audit did not query or change production.
- The recorded production commit is present in the integrated Git history used for Tracking Health reconciliation.

## Verification

- Search Console v1 passed `npm run verify`: 116 tests across 9 test files, typecheck, and the production dashboard build. Google/OAuth calls are fully mocked; no real credentials or external Google calls are used.
- The P0 release passed 101 tests across 8 test files, typecheck, production build, and both smoke suites.
- Production canaries passed for legacy and current tracking, duplicate suppression, attribution, goals, reporting, and cleanup.
- Tracking Health v1 passed `verify:full`: 106 tests across 8 test files, typecheck, production build, and both self-hosted and hosted smoke suites.
- Staging canaries passed for Worker/D1 health, static tracker delivery, authentication boundaries, browser page-view health, server-goal health, hourly aggregates, last-seen summary fields, and isolated canary cleanup.
- The final scheduler export compatibility fix passed 17 focused tests across 4 files, including the existing route-level site-deletion test, plus typecheck and production build.
- Staging was redeployed after that fix. Health/D1 and tracker delivery return `200`, unauthenticated site access returns `401`, and both Tracking Health tables are present in staging D1.

## Current development

- Active phase: Google Search Console v1 — backend implementation complete; real staging validation pending.
- The prior P1 Reliability & Trust sequence is deferred, not removed.
- Tracking Health v1 implementation, migration, Settings UI, and tests are reconciled on top of the production P0 history in `3d188c8` (`feat: add tracking health v1`), with the scheduler/Hono export compatibility fix in `8b66842`.
- Migration `0008_tracking_health.sql` is applied on staging. The hourly retention cron is deployed at `17 * * * *`.
- Production remains on the P0 release; Tracking Health has not been deployed or migrated there.

## Qavyo validation baseline

- The live Vysta-connected source is the separate Next.js repository at `E:\Qavyo\Pricing`, whose GitHub `main` is `0796e27` (`feat: add Vysta analytics`, 2026-10-27).
- That committed root layout loads `https://vysta-production.vysta.workers.dev/js/script.js` with public site ID `4g360v0d0i6n153r` across the `/` and `/pricing` routes.
- GitHub's Vercel status for `0796e27` is successful. Both public routes return `200` without redirect at `qavyo-pricing.vercel.app`; delivered HTML contains the production Vysta preload and serialized direct loader, with no consent key or consent UI. The live tracker is therefore the committed always-on variant.
- The only explicit Vysta goal in committed or local Qavyo Pricing source is `view_pricing`, attached to the hero's See Pricing link. No identify call, server-side goal, `start_free_intent`, or `talk_to_sales_intent` is configured.
- Standard tracker measurement available for loaded visits includes page views and SPA route changes, acquisition/referrer/campaign fields, device data, outbound clicks, engagement pings, and `view_pricing`.
- The local Qavyo Pricing worktree is dirty: it replaces the always-on loader with an uncommitted consent-gated component and has untracked analytics support files and `docs/TRACKING.md`. Its local Next.js build contains that experiment, but it is not the production revision and was not committed or deployed by this validation work.
- `qavyo-pricing.vercel.app` is the verified current production and validation property. The untracked tracking document records timezone `Europe/London` and currency `GBP`; those Vysta settings remain unverified because no production configuration query was authorized.
- `Qavyo-website` at `84a4039` is a separate static redesign repository. Its 120-route inventory and lack of Vysta code were correctly observed, but it was incorrectly treated as the source of the already-live pricing property.
- Vysta's accuracy audit was correct that Qavyo already had `view_pricing`; the prior status statement calling that goal unsupported was wrong.
- No GA4/GTM or Search Console verification is visible in the inspected Qavyo Pricing or static redesign source. Qavyo Pricing has no committed robots/sitemap route or canonical metadata, so the Vercel URL is operationally verified but not declared as a final SEO canonical.

## Search Console v1 implementation

- Customer websites are external black-box Vysta integrations. Search Console work does not depend on inspecting or changing customer hosting, source repositories, DNS, or tracker deployment.
- Vysta already has authenticated, owner-scoped site routes through Hono and D1. The existing `loadSite` middleware is the authorization boundary for integration status, property discovery/selection, and performance data.
- Existing Google OAuth handles hosted dashboard login only. Its `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` also enable hosted mode, so Search Console must use independent `GSC_*` configuration and a separate consent/callback path.
- The minimum scope is `https://www.googleapis.com/auth/webmasters.readonly`. No Search Console write scope is planned.
- Migration `0009_search_console.sql` adds one encrypted Search Console connection row per Vysta site, with a nullable selected property until discovery is complete. OAuth client credentials and the AES-GCM encryption key remain Cloudflare secrets.
- The backend lists properties with `sites.list`, validates a selected exact property URI, and queries `searchAnalytics.query` on demand. It normalizes clicks, impressions, CTR, average position, date, query, page, and device for a later combined Performance view.
- Search Console metrics will not be persisted or synchronized in v1. A separate aggregate query supplies totals so CTR and average position are not incorrectly averaged from dimension rows.
- Google External OAuth apps in Testing mode are limited to configured test users, and Search Console refresh tokens expire after seven days. Weekly re-consent is expected during internal validation.
- No GA4 integration, public OAuth onboarding/verification, full Search Console dashboard, production migration, or production deployment is part of this phase.
- The generic server integration, authenticated site-scoped routes, callback ownership recheck, token refresh/reconnect handling, deletion cleanup, configuration documentation, and mocked security/isolation/pagination tests are implemented. No real Google credentials are needed by automated tests.
- Real staging OAuth validation is not yet performed. It requires Google Cloud Testing-mode setup, four staging `GSC_*` bindings, migration/deploy approval, and a test account with access to a property containing data.

## Git state

- GitHub `main` contains the four reviewed Tracking Health commits through `f62dd55` and the corrected Qavyo repository baseline in `660ad2b`.
- The original Vysta worktree remains on `ff17b5a` because its `.git` ACL is read-only; documentation reconciliation continues through the isolated writable clone.
- Search Console v1 is reconciled on the isolated `search-console-v1` branch and is not merged to `main`.

## Environments

| Environment | Worker | D1 | Endpoint |
| --- | --- | --- | --- |
| Local | `minilytics` | local `minilytics` | `http://localhost:8787` |
| Staging | `vysta-staging` | `vysta-staging` | `https://vysta-staging.vysta.workers.dev` |
| Production | `vysta-production` | `vysta-production` | `https://vysta-production.vysta.workers.dev` |

Staging Worker version: `b4f5f77f-a830-4ca4-b1c0-ae6cc2bd2f35`.
