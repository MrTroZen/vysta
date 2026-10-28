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

- The live Vysta-connected property comes from the separate Next.js repository at `E:\Qavyo\Pricing` / `MrTroZen/Qavyo-pricing`, not the static `Qavyo-website` redesign repository.
- Qavyo Pricing `main` commit `0796e27` installs the production Vysta tracker in the root layout with public site ID `4g360v0d0i6n153r` and configures the `view_pricing` browser goal on the hero's See Pricing link.
- The committed root layout applies to the `/` and `/pricing` routes. Vysta can therefore collect its standard page views, route changes, acquisition fields, devices, outbound clicks, engagement pings, and the explicit `view_pricing` goal.
- The local Qavyo Pricing worktree contains an uncommitted consent-gated replacement plus local tracking documentation. Its build artifacts contain that version, but no Vercel project metadata or deployment workflow is present, so repository evidence alone cannot establish whether the live deployment uses the committed always-on loader or the local consent-gated loader.
- The local tracking document records `Europe/London`, `GBP`, and `qavyo-pricing.vercel.app`, but those values are uncommitted and were not verified against Vysta production.
- The static `Qavyo-website` repository remains a separate 120-route redesign source with no Vysta instrumentation. Its browser-only Start Free and Talk to Sales forms are not live conversion outcomes for the current pricing property.
- No GA4/GTM or Search Console verification is configured in either inspected Qavyo source. Qavyo Pricing also has no committed `robots`/`sitemap` route or canonical production-domain metadata.

## Validation sequence

1. Do not reinstall Vysta or create a duplicate property. Confirm the live Qavyo Pricing deployment source and reconcile the committed loader with the uncommitted consent-gated variant first.
2. Use the existing site ID and real Vysta reports to baseline `/`, `/pricing`, acquisition, device, outbound, engagement, and `view_pricing` behavior.
3. Verify Tracking Health and consent behavior against the deployment variant that is actually live before changing measurement.
4. Treat `view_pricing` as the only verified explicit Qavyo goal. Do not promote the static redesign's demo forms or proposed intent names into live goals without a real product outcome and a separate approval.
5. Observe genuine traffic and goal quality long enough to identify concrete defects or product decisions before expanding measurement.
6. Resolve the production domain, deployment source, indexability, canonical, robots, and sitemap decisions before Search Console. Keep GA4/GTM and Search Console implementation outside this sprint unless explicitly authorized.

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
