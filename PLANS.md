# Vysta Roadmap

## Overall goal

Build Vysta into a trustworthy, privacy-focused analytics platform that gives small businesses and independent builders accurate traffic, acquisition, conversion, revenue, and search-performance insights without unnecessary complexity.

## Completed

- P0 — Critical Accuracy: completed, verified, and deployed to production.
- Tracking Health v1: reviewed, verified, staged, and reconciled into source control. It distinguishes tracking requests from recorded analytics events, keeps unused server goals neutral, retains 720 hourly buckets, and cleans up health data with site deletion.

## Current phase

Google Search Console v1 — Implementation complete; staging validation pending

## Recorded Qavyo validation objective

Use Qavyo as the first real product/property to validate Vysta's installation, collection, acquisition, goal, and owner-facing diagnostic behavior before adding more analytics depth or Google integrations.

## Recorded Qavyo starting point

- The live Vysta-connected property comes from the separate Next.js repository at `E:\Qavyo\Pricing` / `MrTroZen/Qavyo-pricing`, not the static `Qavyo-website` redesign repository.
- Qavyo Pricing `main` commit `0796e27` installs the production Vysta tracker in the root layout with public site ID `4g360v0d0i6n153r` and configures the `view_pricing` browser goal on the hero's See Pricing link.
- The committed root layout applies to the `/` and `/pricing` routes. Vysta can therefore collect its standard page views, route changes, acquisition fields, devices, outbound clicks, engagement pings, and the explicit `view_pricing` goal.
- GitHub records a successful Vercel deployment for commit `0796e27`. The public `/` and `/pricing` routes resolve without redirect at `https://qavyo-pricing.vercel.app/`, and their delivered HTML contains the direct Vysta loader with no consent key or consent UI. Production therefore uses the committed always-on tracker.
- The local Qavyo Pricing worktree's consent-gated replacement, analytics support files, and tracking document are uncommitted and are not the deployed production revision. Preserve them as a local experiment until their intent is decided; do not commit or deploy them implicitly.
- `qavyo-pricing.vercel.app` is the verified current production and validation host. The local tracking document records `Europe/London` and `GBP`, but those two Vysta settings were not verified against production.
- The static `Qavyo-website` repository remains a separate 120-route redesign source with no Vysta instrumentation. Its browser-only Start Free and Talk to Sales forms are not live conversion outcomes for the current pricing property.
- No GA4/GTM or Search Console verification is configured in either inspected Qavyo source. Qavyo Pricing also has no committed `robots`/`sitemap` route or canonical production-domain metadata.

## Recorded Qavyo validation sequence

1. Do not reinstall Vysta or create a duplicate property. Use the existing `qavyo-pricing.vercel.app` property and site ID as the current validation baseline.
2. Use the existing site ID and real Vysta reports to baseline `/`, `/pricing`, acquisition, device, outbound, engagement, and `view_pricing` behavior.
3. Keep the uncommitted consent-gated experiment separate from production work until it is explicitly accepted or discarded. Production is currently always-on.
4. Treat `view_pricing` as the only verified explicit Qavyo goal. Do not promote the static redesign's demo forms or proposed intent names into live goals without a real product outcome and a separate approval.
5. Observe genuine traffic and goal quality long enough to identify concrete defects or product decisions before expanding measurement.
6. Search Console may target the verified Vercel URL as a URL-prefix property. Decide whether to keep that host or wait for a custom long-term domain before treating it as Qavyo's final SEO canonical; robots, sitemap, and canonical metadata remain unimplemented. Keep GA4/GTM and Search Console implementation outside this sprint unless explicitly authorized.

## Objective and boundaries

Add the minimum generic, server-side Search Console integration needed to validate Google organic-search data inside Vysta and support a later combined Performance view.

- Customer websites are external black-box integrations. This work does not inspect or modify their hosting, repositories, DNS, tracker installation, or deployments.
- Use Google OAuth in Testing mode with explicitly listed test users.
- Request only `https://www.googleapis.com/auth/webmasters.readonly`.
- Support exactly one selected Search Console property per Vysta site in v1.
- Do not add GA4, public OAuth onboarding/verification, a full dashboard, scheduled synchronization, or production deployment in this phase.

## Proposed architecture

### Separation from dashboard login

Vysta's existing `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` enable hosted Google sign-in. Search Console must use a separate configuration namespace so enabling the integration does not change authentication mode, especially for self-hosted installations:

- `GSC_GOOGLE_CLIENT_ID`
- `GSC_GOOGLE_CLIENT_SECRET`
- `GSC_OAUTH_REDIRECT_URI`
- `GSC_TOKEN_ENCRYPTION_KEY`

The same Google Cloud project or OAuth client may be supplied during internal validation, but the Vysta code paths and environment variables remain independent.

### Server modules

Add `src/worker/searchConsole.ts` as the integration boundary. It will own:

- OAuth authorization URL creation and code exchange;
- AES-GCM token encryption/decryption and refresh;
- `sites.list` property discovery;
- selected-property validation;
- `searchAnalytics.query` requests;
- normalization of Google rows into a stable Vysta response;
- bounded retries and typed Google error mapping.

Keep routing and site-access enforcement in `src/worker/index.ts`. No Google token or raw OAuth response is returned to the dashboard.

### Site-scoped API

All routes require the existing authenticated user and `loadSite` ownership check.

- `GET /api/sites/:id/integrations/search-console/status`
- `GET /api/sites/:id/integrations/search-console/oauth/start`
- `GET /api/integrations/search-console/oauth/callback`
- `GET /api/sites/:id/integrations/search-console/properties`
- `PUT /api/sites/:id/integrations/search-console/property`
- `GET /api/sites/:id/integrations/search-console/performance`
- `DELETE /api/sites/:id/integrations/search-console`

The callback is outside the `:id` route group, so it must independently restore the authenticated user, validate signed OAuth state, and re-run the site ownership check before storing tokens.

## Schema and storage

Create forward-only migration `0009_search_console.sql` with one row per Vysta site:

```sql
CREATE TABLE search_console_connections (
  site_id TEXT PRIMARY KEY,
  property_uri TEXT,
  permission_level TEXT,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  access_token_expires_at INTEGER NOT NULL,
  granted_scope TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- `property_uri` stays nullable between OAuth completion and property selection.
- The primary key enforces one Search Console connection/property per Vysta site.
- OAuth client credentials and the encryption key remain Worker secrets/configuration, never D1 values.
- Encrypt access and refresh tokens independently with AES-256-GCM. Store a versioned envelope containing the IV and ciphertext. Bind ciphertext to the Vysta site and token type with authenticated additional data.
- Add `search_console_connections` to site deletion so deleting a Vysta site also removes its stored Google tokens.
- Do not persist Search Console metrics in v1. Query them on demand; add a cache/sync schema only after usage and quota evidence justify it.

## OAuth flow

1. An authenticated site owner starts consent for a specific Vysta site.
2. Vysta creates a short-lived random state value bound to the user ID, site ID, and expiry in a signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookie.
3. Redirect to Google's web-server OAuth endpoint using the configured exact redirect URI, the read-only Search Console scope, `response_type=code`, and `access_type=offline`. Use `prompt=consent` during internal validation so Google returns a refresh token.
4. The callback verifies the cookie/state, expiry, current Vysta session, and current ownership of the bound site before exchanging the code server-side.
5. Verify that the granted scope contains the read-only scope, encrypt the tokens, and upsert the site-scoped connection. Preserve an existing refresh token if a later token response omits it.
6. Redirect to a neutral integration result/status location. Do not expose tokens in query parameters.
7. On API use, refresh an expired access token server-side. Retry a Google request once after a successful refresh; convert `invalid_grant` into a reconnect-required status.

Google OAuth projects with an External audience in Testing mode issue refresh tokens that expire after seven days for this scope. Internal validation must expect weekly re-consent until the app is moved out of Testing.

## Search Console API flow

### Property discovery and selection

1. Refresh the access token when necessary.
2. Call `GET https://www.googleapis.com/webmasters/v3/sites`.
3. Return only normalized `{ propertyUri, permissionLevel }` entries.
4. When the owner selects a property, fetch the accessible list again and save it only if the exact URI is present. Accept both URL-prefix URIs and `sc-domain:` Domain properties without deriving either from the Vysta site's domain.

### Performance query

Call `POST https://www.googleapis.com/webmasters/v3/sites/{encodedPropertyUri}/searchAnalytics/query` with validated inclusive `startDate`/`endDate`, `type=web`, `dataState=final`, and an allowlisted subset of `date`, `query`, `page`, and `device` dimensions.

Return a stable server-side shape:

```ts
type SearchPerformanceResponse = {
  source: 'google-search-console';
  propertyUri: string;
  startDate: string;
  endDate: string;
  dimensions: Array<'date' | 'query' | 'page' | 'device'>;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  rows: Array<{
    dimensions: { date?: string; query?: string; page?: string; device?: string };
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  nextStartRow: number | null;
  incompleteFrom: string | null;
};
```

- Run a separate no-dimension query for totals; do not average row CTR or average-position values.
- Default to finalized data and a conservative row limit. Cap Google `rowLimit` at 25,000 and expose bounded pagination through `startRow`.
- Treat Google results as top-row data rather than a guaranteed exhaustive export. Query/page combinations can be privacy-filtered, and the API does not guarantee every row.
- Keep this response independent of dashboard presentation so a later Performance service can combine Vysta acquisition/session data with Search Console metrics without leaking Google-specific response shapes into UI components.

## Security requirements

- Least privilege: request only `webmasters.readonly`; never request the read/write scope.
- Keep login OAuth and Search Console OAuth logically separate.
- Store client secrets and the token-encryption key through Cloudflare secrets; never commit them.
- Encrypt tokens before D1 writes and never return or log tokens, authorization codes, query text, or raw Google error bodies.
- Validate exact redirect URI, signed state, expiry, Vysta session, and site ownership at callback time.
- Validate every selected property against a fresh `sites.list` response; a Vysta site ID is public and grants no Google access.
- Apply existing same-origin CSRF checks to property selection and disconnect mutations.
- Bound date ranges, dimensions, row counts, response sizes, refresh attempts, and upstream timeouts. Handle 401, 403, 429, and 5xx responses without token leakage.
- Delete encrypted tokens when the connection or site is deleted. Document encryption-key rotation before production use.
- Search queries and page performance are customer-confidential analytics data; expose them only through existing site-scoped authenticated routes.

## Implementation status

The generic backend is implemented in source-control scope: forward migration, independent `GSC_*` bindings, AES-256-GCM token envelopes, signed short-lived OAuth state, consent/callback and refresh handling, property discovery/selection, normalized Search Analytics totals and allowlisted dimensions, authenticated site-scoped routes, deletion cleanup, and mocked tests. The Performance dashboard, GA4, public OAuth onboarding, production migration, and production deployment remain out of scope.

Real staging validation remains pending Google Cloud configuration, staging secrets, explicit approval to apply the staging migration/deploy, and a consenting test account with Search Console property access.

## Exact implementation sequence (completed locally; staging steps pending approval)

1. Configure a Google Cloud project in OAuth Testing mode, enable the Search Console API, add test users, and register local/staging callback URIs.
2. Add the four Search Console environment bindings to `Env` and document their local/staging setup without committing values.
3. Add migration `0009_search_console.sql` and include the connection table in site deletion.
4. Add versioned AES-GCM helpers and focused round-trip, wrong-key, wrong-site-AAD, and malformed-envelope tests.
5. Implement signed OAuth state, authorization URL generation, callback exchange, encrypted token upsert, refresh, and reconnect-required handling.
6. Implement property listing and exact accessible-property selection.
7. Implement the typed Search Analytics client and normalized totals/rows response for `date`, `query`, `page`, and `device`.
8. Add site-scoped routes with authentication, ownership, CSRF, input bounds, and safe error mapping.
9. Add mocked route/service tests for successful consent, state rejection, cross-site access rejection, refresh, missing refresh token, invalid grant, property validation, pagination, normalization, and deletion cleanup.
10. Add only a minimal internal connection/status control if needed for validation; defer the combined Performance dashboard.
11. Run `npm run verify`, then validate against local D1. Staging OAuth validation requires separate approval and configuration; do not deploy production.

## Google-account blockers

- A Google Cloud project selected for Vysta internal validation.
- Search Console API enabled in that project.
- OAuth consent screen configured with an External audience and Testing publishing status, including the Vysta test account(s).
- A Web application OAuth client with the exact local and eventual staging callback URIs.
- Client ID and client secret supplied as environment secrets.
- A new 32-byte token-encryption key supplied as a Cloudflare secret.
- A consenting test Google account that already has read access to at least one Search Console property with usable data.
- Acceptance that Testing-mode refresh tokens expire after seven days and require re-consent.

## Deferred P1 — Remaining Reliability & Trust

The remaining P1 sequence stays planned but is paused during Search Console v1:

1. Multi-tab engagement accuracy.
2. Realtime consistency.
3. Data/property validation.
4. PII protection.
5. Broader real-world integration tests.

## Later roadmap

- Combined Vysta + Search Console Performance dashboard
- GA4 integration
- Public OAuth onboarding and Google verification
- P2 — Analytics Depth
- P3 — Integrations
- P4 — Productization
- P5 — Commercial Readiness
