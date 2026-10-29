# Vysta Status

Current snapshot as of 2026-10-29.

## Recorded production state

- The prior local status records P0 Critical Accuracy as live in production at commit `0b18a0ec1f58b3e5b2f97254445205f59ccd7d36` and Worker version `c4b9cd5d-a074-4086-ad18-18eb03fb7ff6`.
- It also records healthy Worker/D1 connectivity and migrations `0006_event_idempotency.sql` and `0007_server_goal_idempotency.sql` as applied.
- This audit did not query or change production.
- The recorded production commit is present in the integrated Git history used for Tracking Health reconciliation.

## Verification

- The complete milestone chain through No-Code Outcome Goals v1 was deployed to staging at source commit `f441be93b0e9b16c7ee899a6440c678ca7b9ea6b`. Staging D1 has migrations `0001` through `0010` in order, runtime canaries passed, and temporary canary data was removed. Staging Worker version: `8c225489-2251-4e4b-a03c-99582e16989a`.
- Pre-merge polish updates Vysta product-facing branding and hardens obvious Settings, Performance, Tracking Health, and Outcome Goals loading/error/responsive states. Rendered browser QA remains pending because the Browser plugin and a project Playwright workflow are unavailable.
- No-Code Outcome Goals v1 passed `npm run verify`: 149 tests across 14 test files, typecheck, and the production dashboard build. Focused outcome/action/SPA/reporting verification covered 79 tests across ten files. Rendered browser QA remains pending because browser access was unavailable and this worktree has no Playwright installation.
- What Changed Insights v1 passed `npm run verify`: 143 tests across 13 test files, typecheck, and the production dashboard build. Focused insight/reporting verification covered 29 tests across four files without Google credentials or external calls. Rendered browser QA remains pending because this worktree has no Playwright setup and the Browser plugin was unavailable.
- The reconciled Performance v1 and Lead & Action Tracking v1 branch passed `npm run verify`: 130 tests across 12 test files, typecheck, and the production dashboard build. Tracker, ingestion, server-goal, reporting-time, Search Console composition, and stable action-model coverage use local mocks and fixtures; no customer site or external service is required.
- Performance v1 passed `npm run verify`: 120 tests across 10 test files, typecheck, and the production dashboard build. Performance/Search Console composition uses mocked API responses; no real Google credentials or calls are required.
- Search Console v1 passed `npm run verify`: 116 tests across 9 test files, typecheck, and the production dashboard build. Google/OAuth calls are fully mocked; no real credentials or external Google calls are used.
- The P0 release passed 101 tests across 8 test files, typecheck, production build, and both smoke suites.
- Production canaries passed for legacy and current tracking, duplicate suppression, attribution, goals, reporting, and cleanup.
- Tracking Health v1 passed `verify:full`: 106 tests across 8 test files, typecheck, production build, and both self-hosted and hosted smoke suites.
- Staging canaries passed for Worker/D1 health, static tracker delivery, authentication boundaries, browser page-view health, server-goal health, hourly aggregates, last-seen summary fields, and isolated canary cleanup.
- The final scheduler export compatibility fix passed 17 focused tests across 4 files, including the existing route-level site-deletion test, plus typecheck and production build.
- Staging was redeployed after that fix. Health/D1 and tracker delivery return `200`, unauthenticated site access returns `401`, and both Tracking Health tables are present in staging D1.

## Current development

- Active phase: Onboarding & product polish v1. The validated Search Console → Performance → automatic actions → Insights → Outcome Goals chain is complete and prepared for main.
- The prior P1 Reliability & Trust sequence is deferred, not removed.
- Tracking Health v1 implementation, migration, Settings UI, and tests are reconciled on top of the production P0 history in `3d188c8` (`feat: add tracking health v1`), with the scheduler/Hono export compatibility fix in `8b66842`.
- Migrations through `0010_outcome_goals.sql` are applied on staging. The hourly retention cron is deployed at `17 * * * *`.
- Production remains on the P0 release; Tracking Health has not been deployed or migrated there.

## Insights v1 implementation

- Performance now requests the same source, page, action, and action-page breakdowns for the automatic previous period through `compare=previous`.
- A standalone deterministic rule layer applies absolute, percentage, and minimum-volume thresholds; ranks candidates; caps category repetition; and returns at most four owner-facing observations.
- The compact What changed panel covers material traffic and action movement, contact intent, source/page movement, leading action pages, loading, and neutral no-insight states. Optional typed Search Console inputs require no live Google credentials.

## No-Code Outcome Goals v1 implementation

- Site Settings supports owner-named exact-path and segment-aware starts-with rules, including create, edit, pause/enable, and soft delete.
- Accepted page views match only normalized paths. Query strings and fragments are excluded, and a site/session/rule receipt limits each outcome to once per visit across SPA revisits and tracker reinitialization.
- Outcomes reuse goal events under server-reserved internal names, while browser and server goal APIs reject attempts to forge those names. Existing custom goals and automatic intent actions remain compatible.
- Performance reports confirmed-outcome totals with automatic previous-period comparison plus outcome-name and outcome-page breakdowns, separately from contact intent and other configured actions.
- Migration `0010_outcome_goals.sql` stores site-scoped rules and deduplication receipts; site deletion removes both tables' rows while soft-deleted rules retain historical report labels.

## Search Console v1 implementation

- Customer websites are external black-box Vysta integrations. Search Console work does not depend on inspecting or changing customer hosting, source repositories, DNS, or tracker deployment.
- Vysta already has authenticated, owner-scoped site routes through Hono and D1. The existing `loadSite` middleware is the authorization boundary for integration status, property discovery/selection, and performance data.
- Existing Google OAuth handles hosted dashboard login only. Its `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` also enable hosted mode, so Search Console must use independent `GSC_*` configuration and a separate consent/callback path.
- The minimum scope is `https://www.googleapis.com/auth/webmasters.readonly`. No Search Console write scope is planned.
- Migration `0009_search_console.sql` adds one encrypted Search Console connection row per Vysta site, with a nullable selected property until discovery is complete. OAuth client credentials and the AES-GCM encryption key remain Cloudflare secrets.
- The backend lists properties with `sites.list`, validates a selected exact property URI, and queries `searchAnalytics.query` on demand. It normalizes clicks, impressions, CTR, average position, date, query, page, and device for the site-level Performance view.
- Search Console metrics will not be persisted or synchronized in v1. A separate aggregate query supplies totals so CTR and average position are not incorrectly averaged from dimension rows.
- Google External OAuth apps in Testing mode are limited to configured test users, and Search Console refresh tokens expire after seven days. Weekly re-consent is expected during internal validation.
- Settings now presents not-connected, property-required, selected, reconnect/error, property selection, and disconnect states in owner language.
- Performance remains useful without Google: it combines Vysta visitors, pageviews, goals/actions, customers, sources, pages, and action breakdowns, with automatic previous-period comparison. When available, Search Console adds summary metrics, top queries, and top search pages; its loading, empty, upstream-error, and reconnect states are isolated from Vysta data.
- No GA4 integration, AI insights, public OAuth onboarding/verification, production migration, or production deployment is part of this phase.
- Lead & Action Tracking v1 uses the existing goal event model. The tracker recognizes phone, WhatsApp, email, and native form-submit intent under reserved generic names; destination/contact/form data is not transported, and ingestion discards properties for those names. Reporting includes action counts, distinct people, and action-by-page rows while keeping configured goals compatible.
- The generic server integration, authenticated site-scoped routes, callback ownership recheck, token refresh/reconnect handling, deletion cleanup, configuration documentation, and mocked security/isolation/pagination tests are implemented. No real Google credentials are needed by automated tests.
- Real staging OAuth validation is not yet performed. It requires Google Cloud Testing-mode setup, four staging `GSC_*` bindings, migration/deploy approval, and a test account with access to a property containing data.

## Git state

- The milestone history remains linear from Search Console v1 (`255091e`) through Outcome Goals v1 (`f441be9`), followed only by focused pre-merge polish.
- Staging is deployed and validated. Production has not been migrated or deployed.

## Remaining product gaps

- Performance v1 has no trend chart, saved report, export, or drill-down from its summary lists.
- Search Console data is fetched on demand and is limited to the top ten query/page rows in the owner view; there is no scheduled sync or historical cache.
- Real OAuth/property behavior still needs staging validation after the manual Google configuration and explicit staging migration/deploy approval.
- Search insight rules accept mocked current/previous values, but Performance does not yet request a previous Search Console period or show Google change insights.

## Environments

| Environment | Worker | D1 | Endpoint |
| --- | --- | --- | --- |
| Local | `minilytics` | local `minilytics` | `http://localhost:8787` |
| Staging | `vysta-staging` | `vysta-staging` | `https://vysta-staging.vysta.workers.dev` |
| Production | `vysta-production` | `vysta-production` | `https://vysta-production.vysta.workers.dev` |

Staging Worker version: `8c225489-2251-4e4b-a03c-99582e16989a`.
