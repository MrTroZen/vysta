# Active Work Queue

## Current objective

Make Vysta analytics trustworthy enough for internal business decisions.

## Completed

- Core infrastructure and security baseline
- Staging and production environments
- Real Qavyo integration
- Phase 5 accuracy characterization
- P0.1/P0.2 reporting-time and DST corrections
- P0.3 duplicate tracker initialization and site-scoped browser event idempotency
- P0.4 explicit attribution precedence
- P0.5 server-goal contract
- Final P0 analytics accuracy review: all five runtime fixes pass together in the current workspace and staging
- P0 release blocker: site deletion removes browser and server idempotency receipts with the rest of the site's data

## Active task

### Production release preparation

- P0.1-P0.5 and the site-deletion receipt cleanup form one complete source-controlled release candidate.
- Verify and deploy the exact candidate on staging before any production deployment.

## Next

- Tracking Health
- GSC
- GA4
