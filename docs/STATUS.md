# Vysta Status

Current snapshot as of 2026-10-28.

## Environments

| Environment | Worker | D1 | Endpoint |
| --- | --- | --- | --- |
| Local | `minilytics` | local `minilytics` | `http://localhost:8787` |
| Staging | `vysta-staging` | `vysta-staging` (`b11e3bf2-4e90-4b16-a58c-3ba99698aee3`) | `https://vysta-staging.vysta.workers.dev` |
| Production | `vysta-production` | `vysta-production` (`d628f0aa-abdb-4e0a-95b7-3e0a10269da5`) | `https://vysta-production.vysta.workers.dev` |

The first real tracked site is Qavyo Pricing.

## Verification

- 101 tests pass across 8 test files.
- `npm run verify` runs typecheck, unit tests, and the production build.
- `npm run verify:full` adds isolated self-hosted and hosted local smoke suites.
- Final P0 review on 2026-10-28: targeted checks and `npm run verify:full` passed, including both smoke suites.
- The site-deletion release-blocker fix has regression coverage for core analytics data and both idempotency receipt tables.

## Accuracy

- P0.1 reporting-time and P0.2 DST corrections are committed and verified on staging.
- P0.3 duplicate initialization and site-scoped browser event idempotency are committed and verified on staging.
- P0.4 explicit UTM/ref precedence over HTTP referrers is complete and verified on staging.
- P0.5 server-goal session, property, recency, and idempotency contract is complete and verified on staging.
- Site deletion removes `ingestion_receipts` and `server_goal_receipts` without changing their ingestion semantics.
- P0.1-P0.5 are not deployed to production.
- The final P0 review found no runtime regression or contradiction between the five fixes; all 101 targeted assertions pass together.
- The complete P0 release candidate requires staging verification before production.
- Reporting boundaries, browser event delivery, custom-source attribution, and keyed server confirmations are protected; P1 findings remain.

## Git

- `d01bd1e` - fix: harden server goal contract
- `09361e2` - fix: preserve explicit attribution precedence
- `796a6dc` - fix: correct analytics reporting time boundaries
- `5196930` - test: establish analytics accuracy characterization baseline

The original P0.3 commit `a7cd5cd76fa48d40468caa8e7442b464fa656a4d` was reconciled onto the current mainline without its unrelated temporary-clone harness parent.

Production changes still require explicit instruction and staging verification.
