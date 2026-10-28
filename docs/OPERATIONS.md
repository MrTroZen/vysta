# Vysta Operations & Production Runbook

This runbook documents operational procedures, environment separation, database migration workflows, disaster recovery, and deployment protocols for Vysta.

---

## 1. Environment Architecture

Vysta operates three strictly isolated environments. Databases, Worker instances, secrets, and assets are never shared across environments.

| Environment | Purpose | Worker Name | D1 Database | Deployment Route |
| :--- | :--- | :--- | :--- | :--- |
| **Local** | Feature development & characterization | `minilytics` | `minilytics` (local SQLite in `.wrangler/state`) | `http://localhost:8787` (Vite on `5173`) |
| **Staging** | Pre-production validation & smoke testing | `vysta-staging` | `vysta-staging` (Cloudflare D1 APAC) | `https://vysta-staging.vysta.workers.dev` |
| **Production**| Live analytics & customer revenue data | `vysta-production` | `vysta-production` (Cloudflare D1 WEUR) | `https://vysta-production.vysta.workers.dev` |

> [!IMPORTANT]
> **Staging-Before-Production Rule:** Every change, migration, or dependency update must be verified on Staging and pass both unit and smoke test suites before deploying to Production. Never deploy directly to Production.

---

## 2. Secrets Management

Worker secrets are managed through Cloudflare's encrypted secret store and injected as environment variables at runtime.

### Secret Inventory
- `ADMIN_PASSWORD`: Master password for single-administrator dashboard authentication.
- `SESSION_SECRET`: Cryptographic key used to sign and verify 30-day session cookies (`ml_auth`).
- `GSC_GOOGLE_CLIENT_ID` / `GSC_GOOGLE_CLIENT_SECRET`: Credentials for the dedicated Search Console OAuth client. They are independent of hosted-login `GOOGLE_*` values.
- `GSC_OAUTH_REDIRECT_URI`: Exact environment-specific callback URI registered with Google.
- `GSC_TOKEN_ENCRYPTION_KEY`: Base64-encoded 32-byte AES-256-GCM key used to encrypt Google access and refresh tokens in D1.

### Secret Rotation Procedure
1. **Rotate Administrator Password:**
   ```powershell
   npx wrangler secret put ADMIN_PASSWORD --env production
   ```
   *Note:* Existing logged-in sessions remain active until their 30-day cookie expires or `SESSION_SECRET` is rotated.

2. **Immediate Session Invalidation:**
   To instantly revoke all active dashboard sessions across all devices:
   ```powershell
   npx wrangler secret put SESSION_SECRET --env production
   ```
   Enter a new high-entropy random string. All current sessions will immediately become invalid.

3. **Search Console token-encryption key:**
   Do not rotate `GSC_TOKEN_ENCRYPTION_KEY` in place. Existing rows can only be decrypted with the old key. Before production use, implement a versioned dual-key/re-encryption procedure; until then, disconnect every Search Console connection (deleting its encrypted tokens), set the new key, and reconnect each site. Never reuse this key across local, staging, and production.

### Search Console staging configuration

Create an OAuth client in Google Cloud with the Search Console API enabled, External/Testing consent, the read-only Search Console scope, and explicit test users. Register the exact staging callback:

```text
https://vysta-staging.vysta.workers.dev/api/integrations/search-console/oauth/callback
```

Set all four bindings on staging; named-environment secrets are not inherited:

```powershell
npx wrangler secret put GSC_GOOGLE_CLIENT_ID --env staging
npx wrangler secret put GSC_GOOGLE_CLIENT_SECRET --env staging
npx wrangler secret put GSC_OAUTH_REDIRECT_URI --env staging
npx wrangler secret put GSC_TOKEN_ENCRYPTION_KEY --env staging
```

Use `openssl rand -base64 32` for the encryption key. Apply `0009_search_console.sql` to staging before deploying the Worker. Testing-mode refresh tokens for an External Google OAuth app expire after seven days, so internal validation should expect weekly re-consent. Do not set these values or apply the migration to production without a separately approved production rollout.

---

## 3. Database Migrations

All schema changes use forward-only SQL migration files in `migrations/` following the naming convention `000X_description.sql`.

### Inspect Migration State
To check whether any migrations are pending on production without modifying data:
```powershell
npx wrangler d1 migrations list vysta-production --remote --env production
```

### Apply Migrations
```powershell
# Local
npm run db:migrate:local

# Staging
npm run db:migrate:staging

# Production
npm run db:migrate:production
```

Wrangler automatically captures an internal backup snapshot prior to executing migrations. If an error occurs during execution, the failing migration rolls back automatically.

---

## 4. Backup & Disaster Recovery

### Manual Export / Backup
Export a complete SQL dump of the production database (schema and data):
```powershell
npx wrangler d1 export vysta-production --remote --env production --output ./backups/vysta-prod-backup-$(Get-Date -Format "yyyyMMdd-HHmmss").sql
```
> [!CAUTION]
> D1 database exports contain plaintext tracking identifiers, visitor attributes, and payment transaction metadata. Store database backups in encrypted, access-restricted storage. Never commit backup files to source control.

### D1 Time Travel Recovery
Cloudflare D1 provides automated continuous point-in-time recovery (Time Travel) allowing restoration to any minute within the retention window (up to 30 days).

1. **Inspect Time Travel bookmarks:**
   ```powershell
   npx wrangler d1 time-travel info vysta-production --env production
   ```

2. **Restore to a specific timestamp:**
   ```powershell
   npx wrangler d1 time-travel restore vysta-production --timestamp="2026-10-26T14:30:00Z" --env production
   ```

---

## 5. Deployment Procedures

### Pre-Deployment Checklist
Before deploying to production, execute the verification suite:
```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
```

### Deploying to Production
```powershell
npm run deploy:production
```
This executes:
1. Production dashboard static assets build (`vite build` into `dist/`)
2. Production database forward migrations (`wrangler d1 migrations apply vysta-production --remote --env production`)
3. Atomic Worker deployment (`wrangler deploy --env production`)

---

## 6. Rollback Procedures

### Roll Back Worker Code (Instant)
If an application regression is identified post-deploy, roll back immediately to a previous stable Cloudflare deployment:
```powershell
# List recent versions
npx wrangler deployments list --env production

# Roll back to the previous deployment
npx wrangler rollback --env production
```

### Roll Back Database Changes
Because D1 migrations are forward-only, database rollbacks must be performed using:
1. **D1 Time Travel restore** (restoring database state to the point in time immediately prior to deployment), or
2. Writing a forward-compensating migration file.

---

## 7. Tracking Health Retention

Tracking Health request outcomes are aggregated into UTC hourly rows in `tracking_health_hourly`. The Worker cron runs at minute 17 of every hour and removes rows older than the 720-bucket window: the current hour plus the previous 719 hours (30 days). The small `site_tracking_health` last-seen summary remains until its site is deleted.

The retention handler is exported as the Worker's `scheduled` handler and configured in every Wrangler environment. Test it locally after applying migrations:

```powershell
curl http://127.0.0.1:8787/cdn-cgi/local/scheduled
```

Deleting a site also deletes its browser/server idempotency receipts, hourly health rows, last-seen health summary, and encrypted Search Console tokens. Health rows never contain rejected request bodies, URLs, visitor IDs, session IDs, API keys, or webhook secrets.
