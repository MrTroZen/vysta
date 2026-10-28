# Vysta Roadmap

## Overall goal

Build Vysta into a trustworthy, privacy-focused analytics platform that gives small businesses and independent builders accurate traffic, acquisition, conversion, and revenue insights without unnecessary complexity.

## Completed

- P0 — Critical Accuracy: completed, verified, and deployed to production.
- Tracking Health v1: reviewed, verified, staged, and reconciled into source control. It distinguishes tracking requests from recorded analytics events, keeps unused server goals neutral, retains 720 hourly buckets, and cleans up health data with site deletion.

## Current phase

Real Product Validation — Qavyo

## Validation objective

Use Qavyo as the first real product/property to validate Vysta's installation, collection, acquisition, goal, and owner-facing diagnostic behavior before adding more analytics depth or Google integrations.

## Verified starting point

- Qavyo is a separate, clean Git repository at local `main` commit `84a4039`.
- The Qavyo repository contains 120 top-level HTML routes: 2 Final, 36 Existing, 80 Scaffolded, and 2 marked Retire in its route inventory.
- No Vysta script tag, `data-website-id`, `data-ml-goal`, `window.minilytics` call, or `view_pricing` implementation exists in the current Qavyo tree or its local Git history.
- No GA4 measurement ID, Google tag, or GTM container is configured in Qavyo. The only Google Analytics reference is general consent guidance in the delivery plan.
- No Search Console verification meta tag/file is present. `robots.txt` and `sitemap.xml` are also absent; Search Console and sitemap work remain future delivery-plan tasks.
- Qavyo's Start Free and Talk to Sales forms are browser-only demonstrations and transmit nothing. They must not be counted as completed signups or leads.

## Validation sequence

1. Reconcile the intended Qavyo property/domain and install Vysta once with a dedicated Qavyo site ID; verify pageviews and Tracking Health before adding goals.
2. Validate representative Final, Existing, Scaffolded, utility, and Retire routes so route status is not confused with real public demand.
3. Add only high-intent client goals after the installation baseline is healthy:
   - `start_free_intent` for navigation into the 30-day access flow;
   - `talk_to_sales_intent` for navigation into the sales conversation flow.
4. Treat `view_pricing` as proposed/unverified until it exists in Qavyo source. Do not claim demo-form completion as a signup or lead.
5. Observe real traffic, acquisition, route demand, and goal quality long enough to identify concrete defects or product decisions before resuming feature expansion.
6. Keep GA4, GTM, and Search Console implementation outside this sprint unless a later task explicitly authorizes them.

## Deferred P1 — Remaining Reliability & Trust

The remaining P1 sequence stays planned but is paused during real-product validation:

1. Multi-tab engagement accuracy.
2. Realtime consistency.
3. Data/property validation.
4. PII protection.
5. Real-world integration tests beyond the focused Qavyo validation sprint.

## Later roadmap

- P2 — Analytics Depth
- P3 — Integrations
- P4 — Productization
- P5 — Commercial Readiness
