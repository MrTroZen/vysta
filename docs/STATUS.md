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

- 100 tests pass across 7 test files.
- `npm run verify` runs typecheck, unit tests, and the production build.
- `npm run verify:full` adds isolated self-hosted and hosted local smoke suites.

## Accuracy

- P0.1 reporting-time and P0.2 DST corrections are committed and verified on staging.
- P0.3 duplicate initialization and site-scoped browser event idempotency are complete and verified on staging.
- P0.4 explicit UTM/ref precedence over HTTP referrers is complete and verified on staging.
- P0.5 server-goal session, property, recency, and idempotency contract is complete and verified on staging.
- Staging Worker version: `32295438-2e81-4b24-8bc0-e999a0575332`.
- P0.1-P0.5 are not deployed to production.
- All planned P0 accuracy work is complete; the final accuracy review is active.
- Reporting boundaries, browser event delivery, custom-source attribution, and keyed server confirmations are protected; P1 findings remain.

## Git

- `796a6dc` - fix: correct analytics reporting time boundaries
- `5196930` - test: establish analytics accuracy characterization baseline

Production changes still require explicit instruction and staging verification.
