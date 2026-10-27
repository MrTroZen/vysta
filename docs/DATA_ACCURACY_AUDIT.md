# Vysta data accuracy audit and test plan

Audit date: 2026-10-27. The Phase 5 audit was the baseline; this document now records the completed P0 accuracy corrections.

Read `ANALYTICS_SEMANTICS.md` first for the exact definitions and one-visitor lifecycle.

## Executive assessment

Vysta's basic first-party visitor continuity, normal 30-minute browser session rotation, domain validation, common source classification, page/goal storage, and bot denylist are understandable and now substantially better characterized by deterministic tests.

The planned P0 accuracy defects are corrected and protected by deterministic tests: reporting time bases, timezone boundaries, duplicate tracker initialization, browser replay, explicit-source attribution, and the server-goal contract.

Engaged time should be treated as a visible-tab estimate, not human attention, and it currently double-counts simultaneous visible tabs. Client goals remain interaction signals; authoritative backend goals require a durable idempotency key. Reporting clocks are explicit and consistent with each metric's documented basis.

## Accuracy test matrix

Status legend:

- **Automated**: deterministic Vitest coverage exists.
- **Smoke**: covered in `scripts/smoke.mjs` against a local Worker/D1.
- **Manual**: requires real-browser/platform or operational verification.
- **Gap**: a useful automated test is still missing.

### Visitor identity

| Scenario | Current expected behavior | Status |
| --- | --- | --- |
| First visit | Generate `ml_vid` and `ml_sid`; insert one visitor/session on pageview | Automated, Smoke |
| Returning visitor | Reuse `ml_vid`; reuse live SID or create a new SID after expiry | Automated |
| Cleared cookies | New visitor and session; no automatic identity merge | Automated by separate cookie jars; Manual for browser controls |
| Expired visitor cookie | New visitor after the one-year sliding expiry or earlier browser privacy expiry | Gap for one-year clock; Manual for privacy browsers |
| Multiple tabs | Share domain cookies; independent pageviews and engagement loops | Automated |
| Subdomain | Root-domain cookie normally shares visitor/session across subdomains | Automated, Smoke |
| Different browser/profile | Separate cookie jar means separate visitor | Automated by separate jars |
| `ml_ignore` | `?ml_ignore=true` persists local opt-out; tracker becomes a no-op until false | Automated |

### Sessions

| Scenario | Current expected behavior | Status |
| --- | --- | --- |
| Normal navigation | Same SID while cookie is live; pageviews increment one session | Automated, Smoke |
| Return under 30 minutes | Same SID and sliding refresh | Automated |
| Return over 30 minutes with no sends | Same VID, new SID | Automated |
| Midnight boundary | Session remains one session; pageviews/goals use event time while session-quality metrics use session start | Automated with SQLite/D1-compatible A-H boundary fixture |
| Site timezone boundary | Range resolves each local midnight with the offset in force at that instant | Automated |
| DST transition boundary | London spring/fall ranges and per-row buckets use the correct offset | Automated with event-total fixtures |
| Old SID replay | A new/distinct event ID can update an old matching session; replay of one ID cannot | Receipt behavior automated; server timeout remains absent |
| Visitor/session mismatch | Event is silently dropped; ping update is visitor-bound | Automated |

### Pageviews

| Scenario | Current expected behavior | Status |
| --- | --- | --- |
| Hard load | New tracker instance sends one pageview | Automated |
| Refresh | Another tracker instance sends another pageview with shared cookies | Automated through multi-instance/tab harness |
| Next.js/History push navigation | Patched push/replace schedules pageview when path/query changed | Automated generically; real Next.js fixture is a Gap |
| Browser back | `popstate` sends when the resulting path/query differs | Automated |
| Browser forward | Same `popstate` behavior | Covered by mechanism; dedicated case is a Gap |
| Hash change | No pageview because hash is outside the duplicate key | Automated |
| Query-string change | Sends a pageview, but ingestion stores the same path without query | Automated |
| Duplicate script inclusion | Later inclusion reuses the first singleton without sending or installing hooks again | Automated |
| Two tabs | Each tab's load/navigation counts, sharing visitor/session | Automated |
| Forced API pageview | Clears local key and counts again even at the same URL | Automated |
| Identical payload replay | Same `eid` is ignored within the site; a distinct `eid` counts as a distinct logical event | Automated with SQLite migration fixture |

### Attribution

| Scenario | Current expected behavior | Status |
| --- | --- | --- |
| Direct | `Direct/None` / Direct when no usable tag or referrer | Automated |
| Google organic | Google / Organic Search | Automated, Smoke |
| Bing organic | Bing / Organic Search | Automated |
| Facebook | Facebook / Organic Social, including mobile subdomain | Automated |
| Instagram | Instagram / Organic Social, including link shim | Automated |
| X/Twitter | X / Organic Social, including `t.co` and mobile Twitter | Automated, Smoke |
| Reddit | Reddit / Organic Social | Automated, Smoke |
| ChatGPT/AI | Canonical AI source/channel for ChatGPT, Claude, Perplexity, Gemini | Automated, Smoke for ChatGPT |
| Generic referral | Raw domain / Referral | Automated |
| UTM source | Raw/canonical session field and derived source | Automated |
| UTM medium | Paid, Email, then known-source, then social precedence | Automated |
| UTM campaign | Stored once on new session | Automated ingestion, Smoke reporting |
| UTM term | Stored once on new session | Automated ingestion |
| `?ref=` | Used only when UTM source absent; stored once | Automated |
| Direct return after attributed session | New traffic session is Direct; payment credit uses last non-Direct | Smoke; focused SQL fixture is a Gap |
| Self-referral | Apex/subdomain referrer is discarded | Automated |
| Unknown tag plus known referrer | Explicit raw tag wins; HTTP referrer is consulted only when no explicit source exists | Automated |
| Android app referrer | Package captured as generic referrer domain | Gap |

### Engagement

| Scenario | Current expected behavior | Status |
| --- | --- | --- |
| Active visible page | Minute pings add visible wall-clock time | Automated |
| Hidden tab | Visibility change flushes pending visible time and stops accrual | Automated |
| Minimized/occluded browser | Depends on browser `visibilityState` | Manual |
| Close/pagehide | Flush via beacon/fetch when at least one second accumulated | Mechanism covered; dedicated pagehide case is a Gap |
| Rapid exit below one second | No ping is sent at that moment | Gap |
| Multiple pings | Add to duration; automatic loop stops after 30 until navigation | Automated |
| Two visible tabs | Both add to the shared session duration | Automated; confirmed overcount risk |
| Malicious excessive pings | Each capped at 10 minutes; session capped at 24 hours | Automated SQL/binds |
| Lost ping | No retry/persistence | Automated transport behavior |

### Goals

| Scenario | Current expected behavior | Status |
| --- | --- | --- |
| Declarative click goal | Delegated click sends named goal and clipped data attributes | Automated |
| JavaScript API goal | `goal` or `track` command sends goal | Automated |
| Event queued before ready | Works only when a valid `minilytics.q` stub already exists | Automated tracker consumption; installation stub is a docs gap |
| Rapid duplicate click/API | Every call counts as a distinct logical event; replay of one `eid` does not | Automated |
| Server-side goal | Exact recent requested session, otherwise latest recent visitor session; keyed retries mutate once | Automated with SQLite migration fixture |
| Malformed empty goal | Dropped after session ownership lookup | Automated |
| Oversized browser properties/body | Collector rejects raw bodies over 8 KiB | Smoke/endpoint unit is a Gap |
| More than 1,000 serialized property chars | Stored value is sliced and may be invalid JSON | Gap; confirmed by code |
| Client plus server confirmation | Both count unless developer chooses distinct names or one source | Documentation below |

### Bots and bad traffic

| Scenario | Current expected behavior | Status |
| --- | --- | --- |
| Known crawler UA | HTTP 202 with no storage | `isBot` Automated; Smoke endpoint |
| Webdriver browser | Tracker does not start | Automated |
| Headless/Playwright/Selenium UA | Collector denylist classifies bot | Automated |
| Malformed unknown UA | Accepted unless it matches the regex | Gap |
| Missing UA | Rejected as bot with 202 | Automated classifier |
| Plausible UA scripted request | Accepted; indistinguishable with current signals | Automated characterization |
| Invalid domain | 403; subdomains accepted, suffix lookalikes rejected | Automated helper, Smoke endpoint |
| Invalid site ID | 400 shape or 404 unknown site | Smoke coverage partial; endpoint unit Gap |
| Visitor/session mismatch | Silently dropped | Automated |
| Public event spoofing | Possible with site ID, allowed URL, plausible UA | Design limitation |

### Failure modes

| Scenario | Current expected behavior | Status |
| --- | --- | --- |
| Worker unavailable / HTTP failure | Fetch rejection is swallowed; event is lost | Automated |
| Request timeout | Tracker sets no explicit timeout and has no durable queue | Gap |
| `sendBeacon` unavailable | Keepalive fetch is used | Automated |
| `sendBeacon` returns false/throws | Keepalive fetch is used | Automated for false |
| `sendBeacon` returns true | No fetch is attempted | Automated |
| Ad blocker | Script or collector request may be blocked; no client diagnostic reaches Vysta | Manual/design |
| Network offline | Fetch rejection swallowed; no retry | Automated |
| Browser/network replay | Same `eid` mutates analytics once; legacy payloads without `eid` remain replayable | Automated ingestion with SQLite migration fixture |
| Partial page unload delivery | Browser-dependent | Manual |

## Automated characterization added

The Phase 5 suite added characterization tests. The boundary fix adds real SQLite/D1-compatible reporting fixtures:

- `test/tracker.test.ts`: a dependency-free VM browser harness covering cookie identity, sliding session expiry, subdomains/tabs, SPA navigation, hash/query behavior, goals and pre-load queues, duplicate script inclusion, engaged time, beacon/fetch fallback, no retry, opt-out/webdriver/localhost suppression, and URL scrubbing.
- `test/analytics.test.ts`: D1 statement/result fakes covering session/visitor/event creation, attribution capture, self-referrals, session mismatch, ping limits, replay behavior, goals, KPI formulas, ordered funnels, realtime windows, and server-side goal selection/fields.
- `test/idempotency.test.ts`: the real migration schema in SQLite, covering every browser event type, concurrent replay, site scoping, duplicate diagnostics, event IDs, and legacy compatibility.
- `test/core.test.ts` now has fixture-based major source coverage, explicit precedence cases, privacy-browser/bot separation, generic referrals, and DST-boundary characterization.
- `test/reporting-time.test.ts`: fixed A-H cross-midnight/range-start/range-end/previous/daily/hourly assertions against the real migration schema.
- `test/timezone-reporting.test.ts`: Europe/London GMT-to-BST and BST-to-GMT event totals, repeated/missing hour buckets, previous local-day comparison, plus Asia/Dhaka regression coverage.
- `test/server-goals.test.ts`: real migration schema coverage for exact/fallback session selection, ownership and recency, documented/legacy properties, atomic concurrent retry, key conflicts, site scoping, and unkeyed compatibility.

The suite is deterministic: timestamps are fixed, network calls are captured locally, and no external site is needed.

## Confirmed accuracy defects

These are defects against Vysta's own comments, UI promises, or internally consistent range/idempotency expectations. Resolution notes distinguish the two boundary defects fixed after the Phase 5 baseline.

### P0.1: overview pageviews and related session counters use the wrong time basis

**RESOLVED:** Overview Visitors/Pageviews and traffic series now query pageview events by `events.ts`. Session count, bounce, and average duration remain session-start cohorts. Goal reports remain goal-event-time based and money remains payment-time based. Session dimensions join in-range pageview events to the stored session snapshot. The site-list 24-hour visitor count also uses pageview event time.

**EXPECTED:** A selected day/hour/custom range explains activity in that range, and the overview/chart agrees with the event-based page breakdown.

**ACTUAL:** Sessions are selected and chart-bucketed by `started_at`; their mutable lifetime `pageviews`, `duration`, `goals`, and bounce state are then read. Events before/after the range can be omitted/included, and every pageview is charted at session start.

**IMPACT:** Midnight, custom-range, and historical comparisons can be wrong or change later. Page breakdown and overview can disagree.

**FIX:** Deliberately define each KPI's time basis, then query pageviews and pageview series from `events.ts`. Keep Sessions session-start based if desired. Define/finalize bounce and duration ownership explicitly, and align goal/customer denominators. Add a real D1 boundary fixture before changing SQL.

### P0.2: site-time midnight is wrong on some DST transition days

**RESOLVED:** Local dates are converted to zoned midnights using the offset at the resolved instant. Calendar ranges step by local dates, SQL chart buckets use a generated per-timestamp timezone-offset expression across transitions, repeated fall-back hours are combined once, and full-local-day previous comparisons shift by local calendar days.

**EXPECTED:** `startOfDay` returns the UTC instant of local midnight for the site date.

**ACTUAL:** It calculates one timezone offset at the supplied instant and applies it to midnight. On Europe/London's 2026 spring transition day, noon produces 23:00Z on the prior date rather than the correct 00:00Z local midnight instant.

**IMPACT:** Today/yesterday/custom boundaries and buckets can shift an hour on DST transitions.

**FIX:** Resolve the local calendar date to an actual zoned midnight with iterative offset resolution or a proven timezone routine, then add spring/fall fixtures for multiple zones.

### P0.3: duplicate tracker initialization and browser event replay inflate collection

**RESOLVED:** A versioned singleton guard is installed before tracker side effects, and later script inclusions reuse the first public API without sending or installing hooks again. Tracker sends carry one `eid` per logical send plus `tv`; migration `0006_event_idempotency.sql` adds site-scoped ingestion receipts and nullable event IDs. One atomic D1 batch gates all visitor/session/event/payment-claim mutations on the winning receipt token. Legacy payloads without `eid` remain accepted and unprotected.

**EXPECTED:** Installing the tracker twice behaves as one tracker, and retrying or replaying one logical event does not change analytics twice.

**ACTUAL:** Duplicate instances each sent an initial view and installed another set of navigation, click, and engagement hooks. Payloads had no event ID, so repeated pageview/goal/outbound payloads appended and incremented again and repeated pings added duration again.

**IMPACT:** CMS/tag-manager duplication and network/application replay could inflate core metrics.

**FIX:** Guard initialization before side effects and gate every event mutation through a site-scoped event receipt while preserving legacy payload compatibility.

### P0.4: an explicit unknown UTM/ref tag can lose to the HTTP referrer

**RESOLVED:** Explicit `utm_source`/`ref` values are now canonicalized when known and otherwise preserved verbatim. HTTP referrer classification is consulted only when no explicit source tag exists; medium-based channel precedence and self-referral filtering are unchanged.

**EXPECTED:** The classifier comment says explicit `utm_source`/`ref` wins over referrer.

**ACTUAL:** Known-source lookup tries the explicit tag and then the referrer. If the tag is unknown but the referrer is known, the known referrer becomes Source. Example: `utm_source=partner-42` plus a Google referrer reports Google, while raw UTM remains `partner-42`.

**IMPACT:** Partner/custom campaign source totals are misattributed.

**FIX:** If an explicit tag exists, canonicalize it when known, otherwise use its raw value; consult referrer only when no explicit tag exists. Preserve channel medium precedence.

### P0.5: server-side goal contract is internally inconsistent and not idempotent

**RESOLVED:** The endpoint accepts the documented `properties` field while retaining `props`, honors an exact site-scoped `session_id` with visitor ownership validation, bounds exact and fallback session matching to 30 days, and atomically deduplicates a site-scoped body/header idempotency key. Unkeyed legacy requests remain accepted and replayable.

**EXPECTED:** A confirmation API should attach to the requested/appropriate session, store documented properties, and safely accept retries.

**ACTUAL:** The endpoint ignores `session_id`, always selects the visitor's latest session across all time, reads `props` while `docs/TRACKING.md` shows `properties`, and counts every retry.

**IMPACT:** Confirmed signups/orders can attach to the wrong visit, lose properties, or double count.

**FIX:** Version or compatibly extend the endpoint to accept validated `session_id`, accept `props` and `properties` during transition, require/recommend an idempotency key, and reject/define behavior when no recent matching session exists.

### P1-1: simultaneous visible tabs overcount engaged duration

**EXPECTED:** Session time should not exceed the visitor's wall-clock engaged interval merely because two tabs are visible.

**ACTUAL:** Each tab independently sends visible time into the same session.

**IMPACT:** Session time can be multiplied by the number of visible tabs.

**FIX:** Choose and document either tab-time or visitor-time. If visitor-time is intended, coordinate a leader tab with `BroadcastChannel`/Web Locks and retain a fallback.

### P1-2: realtime definitions disagree across screens

**EXPECTED:** "Online" should mean the same thing on Websites, Overview, and Live View.

**ACTUAL:** Detail views require a session start within 6 hours; Websites allows 24 hours. Both require last seen within 5 minutes.

**IMPACT:** Online counts can disagree and long-lived active visits disappear in detail view.

**FIX:** Share one query/helper and use recent `last_seen_at` plus an explicitly justified stale-session guard.

### P1-3: goal conversion numerator and denominator can select different populations

**TIME-BASE PORTION RESOLVED:** Goal visitors and overview visitors now both use event timestamps in the selected window. The numerator is goal-active visitors and the denominator is pageview-active visitors, which is the documented product ratio rather than a session-start cohort.

**EXPECTED:** A goal conversion percentage uses a coherent population/window.

**ACTUAL:** Goal visitors use goal `events.ts`; total visitors use pageview `events.ts`. A visitor can still complete a goal inside a narrow range without an in-range pageview, so the two event populations are not necessarily identical.

**IMPACT:** Conversion can be misleading or exceed 100% in narrow/custom ranges.

**FOLLOW-UP:** Decide whether the documented event-window ratio is sufficient or whether the UI should instead expose a stricter pageview-to-goal cohort. That is a product-semantic decision, not a timestamp-boundary defect.

### P1-4: truncated goal properties can cease to be valid JSON

**EXPECTED:** `events.props` is null or valid JSON.

**ACTUAL:** The serialized JSON string is blindly sliced to 1,000 characters.

**IMPACT:** Consumers cannot reliably parse properties and data can be partially retained without a validity signal.

**FIX:** Enforce a structured byte/field limit before serialization or reject oversize props; never truncate serialized JSON mid-token.

### P1-5: queued-event and API examples in tracking documentation are unsafe/inconsistent

**EXPECTED:** The documented client example calls the real API and the claimed pre-load queue works.

**ACTUAL:** One guide example calls `window.minilytics('lead_form_submit', props)` rather than `('goal', name, props)`. The standard script tag alone does not create a pre-load stub. The server example uses `properties` while code reads `props`.

**IMPACT:** Some documented goals silently do nothing or lose metadata.

**FIX:** Correct examples after approving the server compatibility decision; provide one safe queue-stub snippet. Do not change existing Qavyo `view_pricing` instrumentation as part of this audit.

## Potential but unconfirmed issues

- Initial pageview and an extremely early client goal/outbound request can race; whichever creates the session can determine entry/acquisition. A real Worker+D1 concurrency test is needed.
- Next.js versions/router modes may cause extra replaceState calls or non-History transitions. The generic History harness passes, but a minimal real Next.js fixture is still needed.
- Browser cookie partitioning/expiry differs by Safari/privacy settings and embedded contexts; real-device measurements are needed.
- Same-timestamp funnel events are ordered only by timestamp, so progression can be nondeterministic without `events.id` as a tie-breaker.
- Funnel's 100,000 matching-event cap can silently undercount large periods.
- Some legitimate user agents containing broad terms such as `monitor`, `preview`, or `vercel` may be filtered; corpus evidence is needed before narrowing.
- Unknown automation that sends a normal browser UA is accepted. Blocking it safely needs more than a broader regex.
- The tracker outbound self-domain suffix test is less strict than Worker `belongsTo`; a lookalike hostname ending in the root-domain text can be treated as internal and omit an outbound event.
- The URL denylist is necessarily incomplete. General query strings are not stored, but allowed UTM/ref values, referrer paths, and goal properties can still contain PII.

## Event deduplication review and design

### Implemented state

- Repeated delivery of the same `eid`: site-scoped receipt prevents repeated analytics mutations.
- Beacon-to-fetch fallback reuses the same serialized payload and `eid`.
- Duplicate goal listener calls remain distinct logical events with distinct IDs.
- Duplicate script tags reuse the first tracker singleton.
- Identical payloads with different IDs count separately by design.
- Legacy payloads without `eid` remain accepted and unprotected.
- Payments are different: provider/payment primary keys use `INSERT OR IGNORE`, so their core record path has idempotency protection.

### Implemented compatible design

1. Browser payloads include optional `eid` and tracker version `tv`. The tracker generates `eid` once per logical event before selecting beacon/fetch.
2. Legacy payloads without `eid` continue to be accepted and remain unprotected.
3. Forward-only migration `0006_event_idempotency.sql` adds the receipt table and a nullable `events.event_id` with a partial site/event unique index:

```sql
CREATE TABLE ingestion_receipts (
  site_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processing_token TEXT NOT NULL,
  first_received_at INTEGER NOT NULL,
  last_received_at INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  tracker_version TEXT,
  PRIMARY KEY (site_id, event_id)
);
CREATE INDEX ingestion_receipts_site_time
  ON ingestion_receipts (site_id, first_received_at);
```

4. For each request, generate a server processing token. In one atomic D1 batch, `INSERT OR IGNORE` the receipt, and condition every session/visitor/event mutation on the receipt holding that token. A replay's insert is ignored, so its different token cannot mutate analytics. Update duplicate diagnostics separately.
5. Receipts currently have no automatic retention deletion; deleting one would reopen that event ID to replay.
6. `events.event_id` provides diagnostics and a partial unique index for non-null IDs.
7. Server-side goals use the separate `server_goal_receipts` design from migration `0007_server_goal_idempotency.sql`; browser event IDs and server business keys remain separate namespaces.
8. Do not derive identity from payload equality or timestamp/name/path hashes. Two legitimate identical clicks can happen; deduplicate logical sends, not similar content.

### Compatibility and cost implications

- Old installed trackers remain accepted but remain replayable.
- Schema, Worker, and tracker assets must be deployed together with the migration applied before the new Worker serves traffic.
- A receipt write adds D1 writes/storage per event and must be capacity-tested.
- Pings and identifies need receipts too; event-table uniqueness alone cannot protect their session/visitor mutations.
- Deduplication does not replace a singleton tracker guard, goal debounce policy, rate limiting, or bot controls.

P0.5 adds the forward-only `0007_server_goal_idempotency.sql` receipt table without rewriting stored analytics data.

## Source/channel audit

The implemented precedence is:

1. choose tag value: `utm_source`, otherwise `ref`/`via`;
2. when a tag exists, canonicalize it if known and otherwise keep it raw; consult the referrer only when no tag exists;
3. without a tag, choose Source from the known canonical referrer, otherwise raw referrer, otherwise `Direct/None`;
4. choose Channel: paid medium, email medium, known source channel, social medium, generic Referral, otherwise Direct.

UTM source beats `ref`, and either explicit tag beats the HTTP referrer. Fixture coverage includes Google, Bing, DuckDuckGo, Yahoo, Facebook, Instagram, LinkedIn, X/Twitter, Reddit, YouTube, TikTok, ChatGPT, Perplexity, Claude, Gemini, Direct, and generic referral, including common mobile/link-shim subdomains, plus explicit custom-source and medium-precedence cases.

Self-referrals are correctly removed during new-session ingestion using an exact host-or-dot-subdomain test. Payment last-non-direct credit is separate and deliberate: direct traffic remains Direct, while revenue may be credited to an earlier non-Direct session.

## Bot filtering assessment

### Known crawler

`isBot` rejects empty UAs and a regex containing common bot/crawler/preview/SEO/AI crawler identifiers. The collector returns 202 to avoid revealing or triggering retries. This is useful baseline filtering, not authoritative bot detection.

### Automation/browser testing

The browser tracker stops when `navigator.webdriver` is true. Collector regexes also match Headless, Phantom, Puppeteer, Playwright, Selenium, Lighthouse, monitoring tools, curl/wget, and common programmatic clients.

### Legitimate privacy browsers

Normal Brave and DuckDuckGo browser UA examples are not classified as bots. Vysta does not block users simply for privacy signals, cookie limitations, or absent referrer. UA parsing can label a privacy browser as Chrome when its UA does not expose a brand, but it remains accepted.

### Unknown scripted requests

A script using a plausible browser UA, valid site ID/URL, and valid-looking IDs is accepted. Aggressively widening the regex would create false positives and still be bypassable. Evidence-based future controls should combine rate/shape anomalies, per-site quotas, verified proxy headers, optional first-party origin signals, and diagnostics. Do not treat Origin/CORS as authentication.

## Ad-block and collection-loss analysis

### What can be blocked

- the hosted tracker URL, especially if its hostname or a filter rule identifies it as analytics;
- the cross-origin `POST /api/event` collector request even if the script loads;
- a first-party path if a generic rule targets names such as `analytics`, `track`, `collect`, or `event`;
- browser APIs or cookies under privacy/consent policies even when neither request is network-blocked.

The current exact paths are `/js/script.js` and `/api/event` on the Vysta host unless `data-api` overrides collection. Whether common lists block them depends on deployment hostname, list version, browser, and user settings.

### What percentage is lost

It cannot be inferred from Vysta's accepted event data: blocked clients produce no event with which to count themselves. A percentage requires an independent denominator, such as privacy-reviewed first-party server access logs, CDN request counts, controlled split measurement, or reconciliation against backend business events. Any unsupported global percentage would be misleading.

### Optional Next.js first-party proxy design

Use explicit same-origin routes, for example:

```text
GET  /_vysta/s.js  -> fixed Vysta /js/script.js upstream
POST /_vysta/e     -> fixed Vysta /api/event upstream
```

Install with the first-party script URL and `data-api="/_vysta/e"`. Proxy both script and collector; proxying only the script still exposes the collector. Do not create a general URL proxy. Hardcode the upstream, accepted method, body limit, content types, timeouts, and response headers.

### Security and caching

- Strip client-supplied platform geo headers and set trusted geo values only from the hosting platform. The Worker currently trusts Vercel geo headers when present.
- Preserve/forward the real user agent required for bot and browser parsing. Decide how client IP/rate limiting works without storing it in analytics tables.
- Keep the script cacheable with deliberate versioning/revalidation. Never cache collector POSTs or their responses.
- Enforce the same 8 KiB body limit at the proxy, fixed destination, TLS, rate limits, and observability without logging raw PII-bearing bodies.
- Avoid silently enabling this architecture. It changes infrastructure, geo trust, CSP, failure ownership, and blocker behavior.

## Conversion reliability

### Client-side goals

Use for intent/interaction signals such as CTA clicks, pricing views, checkout starts, and form-submit UI events. They are vulnerable to blockers, offline loss, duplicate listeners, navigation races, and client manipulation. They should not be the authoritative record of money or backend completion.

### Server-side goals

Use for confirmed signup, accepted lead, created order, successful payment, or another backend state transition. Carry a Vysta visitor/session identity captured earlier and a durable business idempotency key. The requested session is used exactly when recent and valid; a same-request retry with the same key is safe.

### Avoiding double count

Choose one authoritative goal name per business outcome. A recommended naming split is:

- `checkout_click` or existing `view_pricing`: client interaction only;
- `order_confirmed` / `signup_confirmed`: server confirmation only.

Do not send the same semantic goal from both client and server: server-goal idempotency keys deduplicate server requests only and do not coalesce a separate browser goal. If both stages matter, keep distinct names and build the funnel between them. This audit makes no change to Qavyo's `view_pricing` goal.

## Future Tracking Health design

Keep the first UI small: one compact card or settings section per website, not a new analytics dashboard.

### Useful fields

- last accepted event time and type;
- accepted events in last 24 hours, split into pageviews/goals/pings/other;
- distinct sessions and visitors created in last 24 hours;
- rejected counts by stable reason: malformed/body-too-large, unknown site, invalid domain, inactive plan, bot, session mismatch, duplicate, rate-limited;
- tracker versions observed and percentage of legacy events without `eid`;
- last duplicate time/count;
- last valid pageview hostname;
- "script detected" as a carefully worded derived state: recent valid tracker event observed, not proof that every page is installed.

### Backend data needed first

1. `site_ingestion_health` for last-seen timestamps/version/host and small lifetime counters.
2. `site_ingestion_daily` keyed by `(site_id, local_or_utc_day, outcome, event_type)` for bounded trend counts.
3. `ingestion_receipts` for duplicate counts once idempotency exists.
4. A stable rejection enum in the collector rather than scattered early returns.
5. Retention/rollup policy so health accounting does not grow per request forever.

Rejected requests create an abuse-accounting problem: writing one D1 row per rejected request lets attackers amplify cost. Aggregate with platform-native rate/analytics facilities where possible, sample noisy reasons, and only site-scope a rejection after safely validating a real site. Do not retain raw rejected payloads by default.

## Areas already accurate or well protected

- Collector accepts only a finite event type set, valid-shaped IDs, an 8 KiB body, a known site, and exact domain/subdomain ownership.
- Session hijacking across visitor IDs is rejected, and pings require the matching visitor.
- Self-referrals across the configured domain and subdomains are removed.
- Known source fixtures now cover the major search/social/AI sources requested.
- Page path normalization and sensitive query-name removal reduce accidental URL leakage; general query strings are not persisted as paths.
- Ping contribution and total duration have explicit caps.
- Common bots, empty UA, and WebDriver traffic are filtered without classifying ordinary privacy browsers as bots.
- Funnel progression is visitor-based and ordered rather than counting unordered step presence.
- Payment records have provider-ID idempotency and deliberately conservative matching behavior.
- Test clocks are fixed, and no assertions were weakened to hide current behavior.

## Missing automated tests after the boundary fixes

- real Next.js router fixture and browser back/forward at three navigation styles;
- real concurrency race between initial pageview and goal/outbound;
- handler-level malformed/oversized collection matrix and response/counter verification;
- Android/iOS app referrer fixture corpus;
- Safari/privacy-browser cookie expiry and browser minimize behavior;
- same-timestamp and 100,000-row funnel boundaries;
- first-party proxy header/geo/cache integration tests;
- Tracking Health counters, which do not exist yet;
- high-volume/query-plan tests.

## Recommended implementation order

### Exact P0 sequence

1. **Complete:** define/test every KPI time basis and correct pageview totals, series, dimensions, and denominators.
2. **Complete:** fix zoned-day calculation and per-row bucketing with spring/fall/non-DST fixtures.
3. **Complete:** add site-scoped event-ID receipts with legacy compatibility and replay/concurrency tests.
4. **Complete:** add the tracker singleton guard and test CMS/tag-manager double inclusion.
5. **Complete:** correct explicit attribution precedence while preserving raw UTM/ref fields and channel-medium rules; validate against the fixture table.
6. **Complete:** extend server goals for requested session, property compatibility, recency, and idempotency; then correct integration docs.

### Exact P1 sequence

1. Decide visitor-time versus tab-time, then coordinate engagement if visitor-time is desired.
2. Unify Online query semantics and centralize the active-window constants.
3. Preserve valid structured goal properties and add schema/size validation.
4. Add a real Next.js/browser navigation fixture and app-referrer corpus.
5. Implement bounded Tracking Health aggregates and outcome enums before a UI.
6. Prototype the optional first-party proxy with strict headers/cache/security, then measure collection loss rather than estimating it.
7. Add rate/shape diagnostics for unknown scripted traffic without broadening the UA regex blindly.

## Trust decision

**Current answer: the planned P0 runtime work and source-control reconciliation are complete.** Reporting boundaries, local DST buckets, previous-period comparisons, duplicate tracker inclusion, site-scoped browser replay, explicit-source precedence, and keyed server confirmations have deterministic coverage with no cross-fix regression found. `origin/main` contains the complete P0.1-P0.5 source set. Verify the exact reconciled branch on staging before production. The whole product is still not audit-grade: engaged duration remains visible-tab time and the P1 gaps above still need product decisions or deeper fixtures.
