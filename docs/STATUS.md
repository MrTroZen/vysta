# Vysta Status

Current snapshot as of 2026-10-28.

## Recorded production state

- The prior local status records P0 Critical Accuracy as live in production at commit `0b18a0ec1f58b3e5b2f97254445205f59ccd7d36` and Worker version `c4b9cd5d-a074-4086-ad18-18eb03fb7ff6`.
- It also records healthy Worker/D1 connectivity and migrations `0006_event_idempotency.sql` and `0007_server_goal_idempotency.sql` as applied.
- This audit did not query or change production.
- The recorded production commit is present in the integrated Git history used for Tracking Health reconciliation.

## Verification

- The P0 release passed 101 tests across 8 test files, typecheck, production build, and both smoke suites.
- Production canaries passed for legacy and current tracking, duplicate suppression, attribution, goals, reporting, and cleanup.
- Tracking Health v1 passed `verify:full`: 106 tests across 8 test files, typecheck, production build, and both self-hosted and hosted smoke suites.
- Staging canaries passed for Worker/D1 health, static tracker delivery, authentication boundaries, browser page-view health, server-goal health, hourly aggregates, last-seen summary fields, and isolated canary cleanup.
- The final scheduler export compatibility fix passed 17 focused tests across 4 files, including the existing route-level site-deletion test, plus typecheck and production build.
- Staging was redeployed after that fix. Health/D1 and tracker delivery return `200`, unauthenticated site access returns `401`, and both Tracking Health tables are present in staging D1.

## Current development

- Active phase: Real Product Validation — Qavyo.
- The prior P1 Reliability & Trust sequence is deferred, not removed.
- Tracking Health v1 implementation, migration, Settings UI, and tests are reconciled on top of the production P0 history in `3d188c8` (`feat: add tracking health v1`), with the scheduler/Hono export compatibility fix in `8b66842`.
- Migration `0008_tracking_health.sql` is applied on staging. The hourly retention cron is deployed at `17 * * * *`.
- Production remains on the P0 release; Tracking Health has not been deployed or migrated there.

## Qavyo validation baseline

- The live Vysta-connected source is the separate Next.js repository at `E:\Qavyo\Pricing`, whose GitHub `main` is `0796e27` (`feat: add Vysta analytics`, 2026-10-27).
- That committed root layout loads `https://vysta-production.vysta.workers.dev/js/script.js` with public site ID `4g360v0d0i6n153r` across the `/` and `/pricing` routes.
- The only explicit Vysta goal in committed or local Qavyo Pricing source is `view_pricing`, attached to the hero's See Pricing link. No identify call, server-side goal, `start_free_intent`, or `talk_to_sales_intent` is configured.
- Standard tracker measurement available for consented/loaded visits includes page views and SPA route changes, acquisition/referrer/campaign fields, device data, outbound clicks, engagement pings, and `view_pricing`.
- The local Qavyo Pricing worktree is dirty: it replaces the committed always-on loader with an uncommitted consent-gated component and has untracked analytics support files and `docs/TRACKING.md`. A local Next.js build from 2026-10-27 contains that consent-gated version, but there is no `.vercel` metadata or deployment workflow proving which variant is live.
- The untracked tracking document records timezone `Europe/London`, currency `GBP`, and host `qavyo-pricing.vercel.app`; these values were not verified against Vysta production.
- `Qavyo-website` at `84a4039` is a separate static redesign repository. Its 120-route inventory and lack of Vysta code were correctly observed, but it was incorrectly treated as the source of the already-live pricing property.
- Vysta's accuracy audit was correct that Qavyo already had `view_pricing`; the prior status statement calling that goal unsupported was wrong.
- No GA4/GTM or Search Console verification is visible in the inspected Qavyo Pricing or static redesign source. Qavyo Pricing also has no committed robots/sitemap route or canonical production-domain metadata.

## Git state

- GitHub `main` was safely fast-forwarded from `0b18a0e` through the four reviewed Tracking Health commits and now points to `f62dd55`.
- The original Vysta worktree remains on `ff17b5a` because its `.git` ACL is read-only; documentation reconciliation continues through the isolated writable clone.
- The validation-sprint roadmap and this status snapshot are committed separately from the implementation.

## Environments

| Environment | Worker | D1 | Endpoint |
| --- | --- | --- | --- |
| Local | `minilytics` | local `minilytics` | `http://localhost:8787` |
| Staging | `vysta-staging` | `vysta-staging` | `https://vysta-staging.vysta.workers.dev` |
| Production | `vysta-production` | `vysta-production` | `https://vysta-production.vysta.workers.dev` |

Staging Worker version: `b4f5f77f-a830-4ca4-b1c0-ae6cc2bd2f35`.
