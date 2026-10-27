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

## Active task

### Production release gate

- Restore the completed P0.3 tracker singleton and browser event-idempotency changes to `origin/main`.
- Verify the exact branch release candidate on staging before any production deployment.
- Keep production unchanged until the branch contains the complete reviewed P0 set.

## Next

- Tracking Health
- GSC
- GA4
