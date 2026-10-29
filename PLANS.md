# Vysta Roadmap

## Product goal

Help a small-business owner understand whether people are finding their website, where they come from, which pages and actions perform, what changed, and what Google Search is doing—without unnecessary analytics complexity.

## Completed foundation

- P0 accuracy and site isolation
- Tracking Health v1
- Search Console backend and disconnected/configuration states
- Performance v1 with previous-period comparisons
- Automatic phone, WhatsApp, email, and form intent
- Deterministic What Changed insights
- No-Code Outcome Goals v1
- Staging migrations through `0010_outcome_goals.sql`

## Current phase: onboarding and product polish

Improve the existing customer journey rather than adding a parallel wizard:

1. Create a website with the existing Sites form and API.
2. Install the generated site-specific tracker in Settings.
3. Confirm receipt through Tracking Health.
4. Understand automatic activity and optionally configure a confirmed outcome.
5. Review results in Performance; connect Search Console only when useful and configured.

Current polish focuses on core-first Settings order, clear empty/loading/error/retry states, responsive forms, keyboard semantics, and business-owner language.

## Next

- Complete rendered desktop/mobile QA when browser tooling is available.
- Run a focused marketing/hosted-journey positioning pass; the landing and billing copy still over-emphasize indie makers, Dodo, and revenue.
- Validate real Search Console OAuth on staging only after separate credentials and approval are available.

## Boundaries

- Preserve validated analytics, acquisition, goal, outcome, and site-isolation semantics.
- Reuse Sites, Settings, Tracking Health, Outcome Goals, Performance, and Search Console states.
- Do not add GA4, AI insights, exports, reports, funnels, billing/team onboarding, or another core analytics feature in this phase.
- Do not deploy or migrate production without explicit approval.
