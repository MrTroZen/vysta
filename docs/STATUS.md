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

- Qavyo is a separate nested Git repository. Its working tree is clean on `main` at `84a4039` (`fix: refine public website cleanup`, 2026-10-21).
- Its route inventory exactly matches the 120 top-level HTML files on disk: 2 Final, 36 Existing, 80 Scaffolded, and 2 marked Retire.
- Final routes: `index.html`, `pricing.html`.
- Existing routes include the 12 utility/system pages plus 24 product, restaurant, retail, intelligence, and marketing pages recorded in `Qavyo-website/docs/PAGE-INVENTORY.md`.
- Retire routes: `broiler-farming.html`, `farm.html`.
- No Vysta installation or goal instrumentation exists in the Qavyo working tree or local Qavyo Git history: no tracker script, site ID, collector override, `data-ml-goal`, `window.minilytics`, or `view_pricing` implementation was found.
- Vysta's accuracy audit mentions an existing Qavyo `view_pricing` goal, but the current Qavyo source and history do not support that claim.
- No GA4 measurement ID, Google tag, or GTM container is configured. A delivery-plan link to Google Analytics consent guidance is documentation only.
- No Search Console verification meta tag/file, `sitemap.xml`, or `robots.txt` exists. Search Console verification and sitemap/robots work are still future tasks in Qavyo's delivery plan.
- `start-free.html` and `talk-to-sales.html` use demo forms that validate locally and redirect to a success page without transmitting data. They are not real signup or lead completions.
- The two defensible near-term client goals are `start_free_intent` and `talk_to_sales_intent`, attached to navigation into those flows. Completed signup/lead goals should wait for real backend outcomes.

## Git state

- The original Vysta worktree remains on `ff17b5a` because its `.git` ACL is read-only. Tracking Health was reconciled through the isolated writable clone on the `tracking-health-v1` branch, based on GitHub `main` commit `0b18a0e`.
- The validation-sprint roadmap and this status snapshot are committed separately from the implementation.

## Environments

| Environment | Worker | D1 | Endpoint |
| --- | --- | --- | --- |
| Local | `minilytics` | local `minilytics` | `http://localhost:8787` |
| Staging | `vysta-staging` | `vysta-staging` | `https://vysta-staging.vysta.workers.dev` |
| Production | `vysta-production` | `vysta-production` | `https://vysta-production.vysta.workers.dev` |

Staging Worker version: `b4f5f77f-a830-4ca4-b1c0-ae6cc2bd2f35`.
