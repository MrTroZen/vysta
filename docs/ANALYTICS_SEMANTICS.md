# Vysta analytics semantics

Status: current behavior characterization, 2026-10-27. This document describes the code as it exists; it does not redefine the metrics. The source of truth is `public/js/script.js`, `src/worker/collect.ts`, `src/worker/stats.ts`, `src/shared/sources.ts`, the D1 migrations, and the dashboard code.

## Scope and invariants

- All stored timestamps and durations are integer milliseconds.
- Visitor and session IDs are generated in the browser and scoped by `site_id` in D1.
- Traffic acquisition is a session snapshot. It is set only when a session row is first inserted.
- Reporting deliberately uses different clocks by metric: pageview traffic uses `events.ts`, session quality uses `sessions.started_at`, goals use goal `events.ts`, and money uses `payments.ts`.
- The collector accepts `pageview`, `goal`, `outbound`, `ping`, and `identify`. Only the first three create `events` rows.
- Current browser events have no event ID or idempotency key. Replaying a valid payload repeats its effects.
- "Current tests" below means the deterministic Vitest suite after the Phase 5 characterization additions. `scripts/smoke.mjs` is a separate local end-to-end suite.

## Metric definitions

### 1. Visitor

**Tracker behavior.** A visitor is the value of the first-party `ml_vid` cookie. The tracker creates a UUID when the cookie is absent and rewrites it with a one-year `max-age` on every call to `ids()`. It attempts to set the cookie on the highest writable parent domain, so an apex domain and its subdomains normally share it. Clearing, blocking, or browser-expiring the cookie creates a different visitor. Different browser profiles do not share it. Vysta does not fingerprint.

**Ingestion behavior.** `visitors` has primary key `(site_id, id)`. A session-creating event performs `INSERT OR IGNORE`, preserving the first `first_seen`. `identify` can create the visitor before a session exists and can later fill or overwrite non-null identity fields.

**SQL/reporting behavior.** The overview's Visitors value is `COUNT(DISTINCT events.visitor_id)` among pageview events whose `ts` is in the selected range and whose session matches all filters. It is not a count of `visitors` rows created in the range. Page/goal breakdowns also count distinct `events.visitor_id` by event time. The Users list remains a session-start cohort grouped by visitor.

**Known edge cases.** Cookie clearing, privacy expiration, a different browser, an incorrectly scoped `data-domain`, or a public-suffix/cookie policy failure creates a new visitor. A forged plausible browser request can choose any valid visitor ID. Two tabs normally share the visitor. The stable ID lasts one year from its most recent tracker use, not one year from first visit.

**Test protection.** Browser tests cover first creation, under-30-minute return, next-day return, expiry behavior, subdomains, and shared tabs. Worker tests cover the visitor insert and session binding. Safari/privacy-policy expiry remains a manual/browser-matrix concern.

### 2. New visitor

**Tracker behavior.** Informally, a visitor is new when `ml_vid` is missing and the tracker generates it.

**Ingestion behavior.** The first accepted session event or `identify` creates the `visitors` row. `INSERT OR IGNORE` means subsequent events do not change `first_seen`.

**SQL/reporting behavior.** There is currently no New visitors KPI, breakdown, or new/returning classification query. `visitors.first_seen` is displayed indirectly in profiles and conversion timing.

**Known edge cases.** A cleared/expired cookie is indistinguishable from a genuinely new person. An `identify` call can create a visitor row without a session. The Journey badge "Returning" means a renewal/repeat payment, not a returning website visitor.

**Test protection.** Cookie creation and visitor insertion are covered. No reporting test exists because no new-visitor metric exists.

### 3. Returning visitor

**Tracker behavior.** Informally, a visitor is returning when a later load reuses an existing `ml_vid`, whether it reuses or rotates `ml_sid`.

**Ingestion behavior.** A new session can point to the existing visitor row; no explicit returning flag is stored.

**SQL/reporting behavior.** There is no returning-visitor KPI. A visitor may appear once in an overview range despite several sessions because Visitors is distinct by ID.

**Known edge cases.** Identity cannot be joined across cookie loss, browsers, or devices. `identify(user_id)` does not merge visitor IDs.

**Test protection.** Same-session, 31+ minute, next-day, and subdomain reuse are characterized in tracker tests.

### 4. Session

**Tracker behavior.** A session is the `ml_sid` first-party cookie. It is generated when absent. Every tracker `send()` and `minilytics.attribution()` call rewrites it with a 1,800-second `max-age`, making expiry sliding.

**Ingestion behavior.** A `sessions` row is created when the first accepted `pageview`, `goal`, or `outbound` arrives for an unknown `(site_id, sid)`. A `ping` never creates a session. `identify` never creates a session. The row is bound to its first `visitor_id`; later events with the same session ID and another visitor are silently dropped.

**SQL/reporting behavior.** Sessions is `COUNT(*)` over session rows whose `started_at` is in the report range. The dashboard API returns this field, although the current overview card does not display it.

**Known edge cases.** The server does not independently enforce a 30-minute gap. A valid old SID replay continues to update its original row. A goal/outbound arriving before the initial pageview can create a zero-pageview session and capture Direct attribution. Tabs share the session cookie. There is no database constraint connecting event visitor/session identity beyond application checks.

**Test protection.** Cookie reuse/rotation, first-session insert, session/visitor mismatch, and multiple-tab sharing are automated. Network-order races are not yet covered by a real D1 concurrency test.

### 5. Session timeout

**Tracker behavior.** Timeout is 30 minutes since the last `ids()` call, which occurs on sends and attribution reads. It is not strictly 30 minutes since the last pageview. A visible page emits at most 30 automatic minute pings; the last of those refreshes the session cookie, so an otherwise idle, continuously visible page can retain its SID for about 60 minutes after load. Navigation resets the 30-ping cap. Activity in any same-domain tab refreshes the shared cookie.

**Ingestion behavior.** No server-side timeout check exists. The supplied SID controls row selection.

**SQL/reporting behavior.** Session counts trust the client-created session rows; reporting does not re-sessionize events.

**Known edge cases.** Cookie deletion/expiry, background throttling, browser shutdown, multiple tabs, and old-payload replay can all change the practical boundary.

**Test protection.** Fixed-clock browser tests cover reuse at 29 minutes, rotation after more than 30 minutes without sends, next-day rotation, and the 30 automatic-ping cap.

### 6. Pageview

**Tracker behavior.** One pageview is attempted on tracker initialization. The tracker also wraps `history.pushState` and `history.replaceState`, listens for `popstate`, and supports a forced `minilytics('pageview')`. Its local duplicate key is `pathname + search`. A repeated identical path/query is suppressed; a query change is sent; a hash-only change is not sent. Hard reload creates a new tracker instance and sends again. The public API deliberately clears the duplicate key and can force a repeat.

**Ingestion behavior.** An accepted pageview increments `sessions.pageviews`, updates `exit_page` and `last_seen_at`, appends a `pageview` event, and may claim a Dodo payment ID from the URL. Stored event paths are decoded when possible, have one trailing slash removed except `/`, omit all query/hash data, and are clipped to 500 characters.

**SQL/reporting behavior.** Overview Pageviews and the traffic series use `COUNT(*)` over pageview events whose `events.ts` is in the selected range. Each pageview is assigned to the site-local hour/day/week/month containing its own event timestamp. Page breakdowns use the same pageview-event clock.

**Known edge cases.** Duplicate script tags each send and install their own hooks/listeners. Two tabs intentionally create separate pageviews but share session/visitor IDs. Query-only views are distinct at collection but collapse onto the same stored path. Framework router behavior not implemented through History API is not observed. There is no replay deduplication.

**Test protection.** Initial load, refresh-equivalent new instance, push/replace semantics, popstate, query/hash behavior, forced pageviews, duplicate inclusion, two tabs, path normalization, ingestion, and report formulas are automated. A real Next.js fixture is still missing.

### 7. Bounce

**Tracker behavior.** There is no client bounce event.

**Ingestion behavior.** Session pageview and goal counters supply the later classification.

**SQL/reporting behavior.** A bounce is a session where `pageviews <= 1 AND goals = 0`. Engaged time and outbound clicks do not prevent a bounce. A zero-pageview outbound-only session is a bounce. Any accepted goal makes the session non-bouncing, even with zero pageviews.

**Known edge cases.** The status is mutable for the lifetime of the session and can change after the report boundary. Duplicate goals suppress bounce; duplicate pageviews prevent bounce. A goal/server-goal attached to the session prevents bounce regardless of intent.

**Test protection.** The SQL formula and 50% smoke result are protected. Cross-boundary session/pageview ownership now has a real SQLite fixture using the D1 migration; later mutation and duplicate effects remain documented risks.

### 8. Bounce rate

**SQL/reporting behavior.** `bounces / sessions`, returning zero when the denominator is zero. Both values select session rows by `started_at` in the range. The UI displays a percentage and treats a reduction as favorable.

**Known edge cases.** It inherits every bounce/session boundary and duplicate issue above.

**Test protection.** Unit reporting characterization and self-hosted smoke tests cover the formula.

### 9. Engaged time

**Tracker behavior.** Engaged time is wall-clock time accumulated while `document.visibilityState === 'visible'`. It is flushed on hide, `pagehide`, SPA page change, and once per visible minute for at most 30 intervals per pageview. A flush below 1,000 ms is retained until a later flush. Sent milliseconds are rounded.

**Ingestion behavior.** A ping duration is coerced to a number, rounded, clamped to 0-600,000 ms per request, and added only when site/session/visitor match. Total session duration is capped at 86,400,000 ms. A ping updates `last_seen_at` but creates no event row.

**SQL/reporting behavior.** Users sum session durations. Overview averages `sessions.duration` across sessions started in the selected range.

**Known edge cases.** Two visible tabs add time independently to the same session and can exceed human wall-clock attention. Visibility is the only activity signal; a visible but idle page counts. Minimized/occluded behavior depends on the browser's visibility implementation. A malicious sender can submit many maximum pings until the 24-hour cap. A failed transport loses the time; there is no retry queue.

**Test protection.** Visible interval, hide flush, two-tab addition, per-ping cap, visitor binding, total cap SQL, and interval limit are automated. Actual browser minimize/throttling remains manual.

### 10. Session duration

**Tracker/ingestion behavior.** Session duration is the accumulated engaged-time ping total, not `last_seen_at - started_at` and not elapsed visit length.

**SQL/reporting behavior.** "Session time" is rounded `AVG(sessions.duration)` for sessions started in the range. Sessions with no successful ping contribute zero.

**Known edge cases.** It inherits visible-idle counting, multiple-tab double counting, transport loss, client inflation, and range-boundary mutation.

**Test protection.** Ping accumulation constraints and overview rounding are characterized; smoke expects 21 seconds from one 42-second session plus one zero-duration session.

### 11. Realtime / online visitor

**Tracker behavior.** Pageviews, goals, outbound events, and pings update `last_seen_at`; `identify` does not.

**SQL/reporting behavior.** The overview and Live View define online as a distinct visitor with a session `started_at > now - 6 hours` and `last_seen_at > now - 5 minutes`. Live View returns the most recently seen session per visitor after a query capped at 500 session rows. Its feed contains pageviews/goals/payments from the last 30 minutes, not pings or outbound events. The Websites list uses a different guard: sessions started in the last 24 hours and last seen in the last 5 minutes.

**Known edge cases.** A genuinely active session older than 6 hours is excluded from overview/live but can remain online on the Websites list until 24 hours. Strict `>` makes exact boundary timestamps inactive. Duplicate events refresh presence.

**Test protection.** The 5-minute/6-hour detail rule, distinct visitor collapse, and smoke output are covered. The 24-hour list/detail inconsistency lacks an API-level comparison test.

### 12. Entry page

**Tracker behavior.** The current URL accompanies every event.

**Ingestion behavior.** `entry_page` is the normalized path of whichever pageview, goal, or outbound event first creates the session. It is immutable afterward.

**SQL/reporting behavior.** Entry-page breakdown joins in-range pageview events to their sessions, groups by the session's entry-page snapshot, counts distinct event visitors, and counts pageview events. Its reporting clock is pageview `events.ts`.

**Known edge cases.** An early goal/outbound can become the entry before the first pageview. Query and hash are absent. The hostname is separately fixed from that same first event.

**Test protection.** First-event session binding and normalization are covered. Request-order races remain untested against real D1.

### 13. Exit page

**Ingestion behavior.** `exit_page` starts as the first event's normalized path and changes only on pageviews. It means "most recent pageview path known for the session," not a confirmed browser exit.

**SQL/reporting behavior.** `exit_page` can be filtered and queried as a session dimension, but the current main page panel exposes Exit link (outbound destination), not an Exit page tab.

**Known edge cases.** Goal/outbound activity does not change it. A lost final pageview leaves an older value. Query-only views share the same path.

**Test protection.** Pageview update SQL is characterized. There is no dedicated exit-page UI test.

### 14. Source

**Ingestion behavior.** Source is stored once on the session. The classifier computes `tag = utm_source || ref`. When a tag exists, it is canonicalized if it matches a known source and otherwise kept verbatim; the HTTP referrer is consulted only when no explicit tag exists. Without a tag, a known referrer uses its canonical source, an unknown referrer keeps its domain, and no referrer becomes `Direct/None`.

**Precedence.** `utm_source` is chosen ahead of `ref`, and either explicit value is chosen ahead of the HTTP referrer. Paid and email media still override the channel; a known explicit source supplies its normal channel; social medium follows; and any remaining explicit tag is Referral.

**SQL/reporting behavior.** Source breakdown joins in-range pageview events to the session acquisition snapshot, then counts distinct event visitors and pageview events. Its reporting clock is pageview `events.ts`; dashboard labels it "Referrer" in several places.

**Known edge cases.** Case is canonicalized only for known sources. Unknown source strings keep trimmed original case. A medium without a source can yield `source=Direct/None` with a non-Direct channel.

**Test protection.** Fixture tests cover major search, social, AI, email, paid, direct, and generic-referral sources; UTM-over-ref precedence; unknown explicit UTM/ref values against known referrers; and medium precedence.

### 15. Channel

**Ingestion behavior.** Channel precedence is: paid `utm_medium`; email `utm_medium`; known source; social `utm_medium`; any remaining tag/referrer as Referral; otherwise Direct. Allowed values are Direct, Organic Search, Organic Social, AI, Referral, Email, and Paid.

**SQL/reporting behavior.** Stored on the session. Traffic breakdowns group in-range pageview events by that session snapshot, so their reporting clock is pageview `events.ts`. Payment credit prefers a session where `channel != 'Direct'` and money remains selected by `payments.ts`.

**Known edge cases.** A known AI/search/social source with `utm_medium=cpc` becomes Paid. An unknown source with `utm_medium=email` becomes Email. Medium normalization recognizes a finite regex vocabulary only.

**Test protection.** Fixture and precedence tests cover all channel classes except every spelling variant.

### 16. Referrer

**Tracker behavior.** `document.referrer` is sent only on the tracker instance's first pageview. Later SPA pageviews send an empty string.

**Ingestion behavior.** For an external HTTP(S) referrer, Vysta stores lowercase-without-`www` hostname in `referrer_domain` and hostname plus normalized path, clipped to 500 characters, in `referrer`. Scheme, query, and fragment are not stored. Same-site apex/subdomain referrers are discarded. For `android-app://...`, only the package is stored as `referrer_domain`; `referrer` stays null.

**SQL/reporting behavior.** `referrer` is a breakdown dimension; source generally exposes the canonical source instead.

**Known edge cases.** Referrer policy, privacy browsers, apps, redirects, HTTPS-to-HTTP rules, and blockers can remove it. Referrer paths can themselves contain sensitive data and are not denylisted. Common Android package names are not mapped to friendly sources.

**Test protection.** External/self-referral and classifier fixtures are covered. Android-app parsing needs a direct ingestion fixture.

### 17-20. UTM source, medium, campaign, and term

**Tracker behavior.** The full current URL, after private-parameter removal, is sent on each event.

**Ingestion behavior.** On session creation only, the Worker reads query parameters from the event URL: source/medium are trimmed and capped at 100 characters; campaign/term at 200. `utm_content` is also stored at 200. Empty values become null. Later events do not update the session's UTMs.

**SQL/reporting behavior.** Values are exact-match filter/dimensions on sessions. Campaign maps to `utm_campaign`; Keyword maps to `utm_term`. UTM source and medium are filterable and available as API dimensions but are not primary dashboard tabs.

**Known edge cases.** There is no cross-session campaign persistence. A direct return creates a Direct session without prior UTMs. Duplicate query parameter behavior follows `URLSearchParams.get` (first value).

**Test protection.** Ingestion binds, precedence, paid/email/social medium behavior, and fixed source fixtures are automated.

### 21. `?ref=`

**Ingestion behavior.** On session creation, Vysta stores the first non-empty of `ref` then `via`, trimmed and capped at 100 characters. Source uses it only when `utm_source` is absent.

**SQL/reporting behavior.** It is a session dimension/filter and appears alongside campaign information in journeys.

**Known edge cases.** It has no persistence beyond the created session, can contain arbitrary user-entered text/PII, and loses to `utm_source`.

**Test protection.** Known/unknown ref behavior and UTM-over-ref precedence are automated.

### 22. Direct traffic

**Ingestion behavior.** A session is Direct when no classifier tag/referrer produces another channel. It stores `source='Direct/None'` and `channel='Direct'`.

**SQL/reporting behavior.** Direct sessions count normally. Payment attribution is different: `creditedSessionSql()` chooses the visitor's latest non-Direct session before the payment if one exists, otherwise the latest Direct session. Thus traffic remains Direct while revenue can be credited to an older non-Direct visit.

**Known edge cases.** Missing referrers become Direct even when a source existed in reality. A medium-only URL can have a non-Direct channel with `Direct/None` source. Direct-return attribution is implemented for payments only, not goal conversion.

**Test protection.** Direct classification and smoke payment attribution are covered. A focused last-non-direct SQL integration fixture is still missing.

### 23. Goal

**Tracker behavior.** A goal is a named client event from `[data-ml-goal]`, `minilytics('goal'|'track', name, props)`, or a pre-existing `minilytics.q` queue. Names are stringified and sliced to 64 characters in the tracker; data-attribute property values are sliced to 255. There is no debounce or duplicate suppression.

**Ingestion behavior.** Browser ingestion trims/clips the name to 64, increments `sessions.goals`, updates `last_seen_at`, and inserts a goal event with current normalized path. Object/array properties are JSON-stringified and then sliced to 1,000 characters; this can store invalid truncated JSON. A goal can create a session.

**Server-side behavior.** `POST /api/v1/goals` authenticates by site API key, requires `visitor_id` and `name`, chooses that visitor's latest session across all time, increments it, and inserts the goal on its current `exit_page`. The endpoint ignores a supplied `session_id`. It reads `props`, while `docs/TRACKING.md` currently shows `properties`, so properties from that example are discarded. There is no idempotency key.

**SQL/reporting behavior.** Goal rows show distinct visitors and total completions (the generic `pageviews` field in the breakdown response) by goal `events.ts`, plus revenue from visitors who completed the goal. The UI percentage is `distinct goal visitors / overview visitors`; both visitor populations are event-window populations, although the numerator requires a goal and the denominator requires a pageview.

**Known edge cases.** Rapid/double listeners and replays count repeatedly. A duplicated tracker doubles click goals. A goal before the first pageview can create Direct attribution. Goal-active visitors and pageview-active visitors can still be different event populations inside a narrow range. Client calls made before load are safe only when the embedding site installed a valid queue stub; the standard script tag alone does not create that stub before execution.

**Test protection.** Declarative/API/queued goals, rapid duplicates, duplicate inclusion, ingestion, malformed empty names, properties, and smoke dashboard/funnel behavior are covered. The server-side handler needs focused unit coverage for latest-session selection and documented field compatibility.

### 24. Funnel progression

**Tracker behavior.** Funnels consume existing pageview/goal events; no special funnel event is sent.

**Ingestion/storage behavior.** Funnel definitions contain 2-10 ordered steps of exact goal name or page path with `*` wildcard.

**SQL/reporting behavior.** For events in the selected `events.ts` range, up to 100,000 matching rows are ordered by `e.ts`. Progress is tracked per visitor across sessions. An event advances only the visitor's next expected step, by one. Counts for each step include every visitor who reached at least that step. Dashboard percentages use step 1 as the overall denominator; drop-off uses the immediately preceding step.

**Known edge cases.** There is no maximum time between steps. Same-timestamp ordering has no secondary `events.id` tie-breaker. The 100,000-row cap can undercount. Replayed events can advance repeated steps or inflate the available sequence. Visitors, not sessions, are the unit.

**Test protection.** Ordered progression, out-of-order handling, wildcard matching, cross-session visitor identity, and smoke end-to-end behavior are covered. Same-timestamp and 100,000-cap behavior remain untested.

### 25. Conversion rate

Vysta currently uses more than one conversion rate:

1. **Overview conversion rate:** distinct non-renewal paying customers divided by overview Visitors. Customers are distinct by `COALESCE(payment.visitor_id, payment.id)` for `kind='payment' AND renewal=0`; payments are selected by payment timestamp while visitors are pageview-active visitors selected by pageview event timestamp in the same range.
2. **Goal conversion:** distinct visitors with a named goal event in the event-time range divided by pageview-active overview Visitors in the same event-time range.
3. **Funnel conversion:** visitors reaching a step divided by visitors reaching step 1; drop-off compares with the prior step.

**Known edge cases.** The first two compare different event populations in one range and can exceed intuitive bounds when a payment or goal occurs without an in-range pageview. Unattributed payments count as customers using payment ID. Renewals do not add customers. Filters require attributed payments joined to a matching session.

**Test protection.** Overview formula, goal smoke behavior, funnel progression/drop-off inputs, and cross-boundary event-time denominators are protected.

## One visitor, end to end

Assume a normal browser, accepted transports, no competing tab, and these symbolic IDs:

- site `W1`
- visitor `V1`
- first session `S1`
- later sessions `S2`, `S3`

### First page load

1. The tracker sees no cookies and generates `ml_vid=V1`, `ml_sid=S1`.
2. It writes `V1` for one year and `S1` for 30 minutes.
3. It sends `{w:W1,t:'pageview',u,vid:V1,sid:S1,r:document.referrer,sw}`.
4. The Worker validates body size/JSON/IDs/type, bot UA, site status, URL, and domain.
5. D1 ends with:
   - one `visitors` row `(W1,V1,first_seen=T1)`;
   - one `sessions` row `(W1,S1,V1,started_at=T1,last_seen_at=T1,pageviews=1,goals=0,duration=0,entry_page=P1,exit_page=P1)` plus acquisition/UA/geo snapshot;
   - one `events` row `(session=S1,visitor=V1,ts=T1,type=pageview,path=P1)`.
6. Overview includes the visitor/pageview if `T1` is inside the event-time range and includes the Session if the session's `started_at` is inside the session-start range. Page breakdown uses the same event-time test as overview traffic.

### Internal navigation and second pageview

1. A hard navigation runs a new tracker instance; an SPA History transition uses the existing one. Both reuse `V1/S1` if the session cookie is live.
2. The browser refreshes both cookie expiries and sends the second pageview. An SPA pageview sends an empty referrer.
3. D1 still has one visitor and one session. The session becomes `pageviews=2`, `exit_page=P2`, `last_seen_at=T2`. A second pageview event is appended. Acquisition, entry page, hostname, UA, and geo do not change.

### Goal event

1. The tracker sends `{t:'goal',n:G1,p:...,u,vid:V1,sid:S1}`.
2. The session becomes `goals=1`, `last_seen_at=T3`.
3. A goal event is appended with path `P2` and clipped serialized properties.
4. The session can no longer meet the current bounce definition.

### Engaged-time ping

1. The tracker sends visible elapsed milliseconds `D1`.
2. No event row is created.
3. The matching session becomes `duration=min(old+D1,24h)` and `last_seen_at=T4`; an individual request contributes at most 10 minutes.

### Return after 31+ minutes without any intervening `ids()` call

1. `ml_vid=V1` is still valid; `ml_sid=S1` has expired.
2. The tracker creates `S2` and sends a pageview.
3. The visitor table remains one row. A second session row is created, normally with its own acquisition snapshot (often Direct after a self-referral is discarded). A new pageview event points to `S2/V1`.
4. If a visible tab or another tab refreshed `S1` inside the 30-minute window, this step instead remains in `S1`; the timeout is sliding.

### Next-day return

1. With `ml_vid` still present, the browser remains `V1`.
2. With the prior session cookie expired, a new `S3` is created.
3. D1 now has one visitor, three sessions, and at least four pageview events in this example. If the visitor cookie was cleared/expired, the browser instead creates `V2`, which Vysta cannot automatically merge with `V1`.

## Important range semantics

All ranges are half-open: `timestamp >= range.from AND timestamp < range.to`. Custom dates are inclusive local calendar dates in the configured IANA timezone. Local midnights are resolved with the offset in force at that midnight, and chart bucketing uses the offset in force at each row timestamp. A spring-forward day therefore has 23 elapsed hours; a fall-back day has 25 elapsed hours, with both occurrences of the repeated local hour combined under one label.

The reporting query audit assigns these clocks deliberately:

| Surface / metric | Period timestamp | Reason |
| --- | --- | --- |
| Overview Visitors, Pageviews, traffic chart | pageview `events.ts` | Measures pageview activity that occurred inside the range |
| Page and session-dimension traffic breakdowns | pageview `events.ts`; joined session supplies dimensions | Keeps totals/buckets aligned while retaining acquisition and device snapshots |
| Sessions, Bounce rate, Average session duration | `sessions.started_at` | These are properties of the session-start cohort |
| Users list | `sessions.started_at` | The list describes visitors with a session beginning in the range |
| Goals, goal/outbound breakdowns, funnels | relevant `events.ts` | Measures completion/activity when the event occurred |
| Revenue, Payments, Customers, revenue chart | `payments.ts` | Measures money when the payment/refund record occurred |
| Site-list Visitors (last 24 hours) | pageview `events.ts` | Measures pageview-active visitors in the rolling window |
| Online / Live presence | `sessions.last_seen_at`, with the existing stale-session `started_at` guard | Presence is based on recent activity, not a reporting-period cohort |
| Visitor profile/history | no report range; ordered by each row's own timestamp | It is a history view |

Session-cohort metrics use:

```sql
sessions.started_at >= range.from AND sessions.started_at < range.to
```

Pageview and goal/outbound activity use:

```sql
events.ts >= range.from AND events.ts < range.to
```

Payments use the equivalent predicate on `payments.ts`.

Consequences and deliberate differences:

- A session started at 23:59 and a pageview at 00:01 contributes one Session to the first day and that pageview/visitor to the second day.
- A session started before a custom range but active inside it contributes in-range pageviews/visitor activity, but not a new Session, bounce, or average-duration sample.
- Bounce and average duration can still change later because they deliberately describe mutable session rows in the session-start cohort. Pageview totals do not move with them.
- Overview customer conversion compares payment-time customers with pageview-active visitors in the same range. It is a cross-event business ratio, not a session conversion cohort.
- A full-local-day previous comparison shifts by the same number of local calendar days. Other rolling/partial ranges compare the immediately preceding equal elapsed duration.

These are current semantics after the reporting boundary correction.

## Data retained and data not retained

Stored: stable IDs, session acquisition fields, normalized paths, pageview/goal/outbound events, clipped goal properties, approximate geo, UA-derived device fields, engaged duration, identities supplied through `identify`, and payment data.

Not stored: page titles, DOM content, full general query strings, URL fragments, raw IP addresses in analytics tables, raw user-agent strings, ping events, hash navigation, or a durable event idempotency key.
