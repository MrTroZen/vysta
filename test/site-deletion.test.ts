import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { signToken } from '../src/worker/lib/crypto';

class SqliteD1Statement {
  private args: any[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...args: any[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }

  async run() {
    this.db.prepare(this.sql).run(...this.args);
    return { success: true };
  }

  execute() {
    return { results: this.db.prepare(this.sql).all(...this.args) };
  }
}

function d1(db: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new SqliteD1Statement(db, sql),
    batch: async (statements: SqliteD1Statement[]) => statements.map((statement) => statement.execute()),
  } as unknown as D1Database;
}

const siteTables = [
  'events',
  'sessions',
  'visitors',
  'payments',
  'funnels',
  'payment_claims',
  'ingestion_receipts',
  'server_goal_receipts',
  'outcome_goal_receipts',
  'outcome_goal_rules',
] as const;

function seedSite(sqlite: DatabaseSync, siteId: string, suffix: string) {
  const now = Date.UTC(2026, 9, 28, 12);
  const visitorId = `visitor-${suffix}`;
  const sessionId = `session-${suffix}`;

  sqlite
    .prepare('INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(siteId, `Site ${suffix}`, `${suffix}.example.com`, 'UTC', 'USD', `ml_${suffix}`, now);
  sqlite.prepare('INSERT INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').run(siteId, visitorId, now);
  sqlite
    .prepare(
      `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel)
       VALUES (?, ?, ?, ?, ?, 'Direct/None', 'Direct')`,
    )
    .run(siteId, sessionId, visitorId, now, now);
  sqlite
    .prepare("INSERT INTO events (site_id, session_id, visitor_id, ts, type, path) VALUES (?, ?, ?, ?, 'pageview', '/')")
    .run(siteId, sessionId, visitorId, now);
  sqlite
    .prepare("INSERT INTO payments (id, site_id, provider, ts, amount, currency) VALUES (?, ?, 'api', ?, 100, 'USD')")
    .run(`payment-${suffix}`, siteId, now);
  sqlite
    .prepare("INSERT INTO funnels (id, site_id, name, steps, created_at) VALUES (?, ?, 'Test', '[]', ?)")
    .run(`funnel-${suffix}`, siteId, now);
  sqlite
    .prepare('INSERT INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, ?, ?, ?)')
    .run(siteId, `claim-${suffix}`, visitorId, now);
  sqlite
    .prepare(
      `INSERT INTO ingestion_receipts
       (site_id, event_id, event_type, processing_token, first_received_at, last_received_at)
       VALUES (?, ?, 'pageview', ?, ?, ?)`,
    )
    .run(siteId, `event-${suffix}`, `event-token-${suffix}`, now, now);
  sqlite
    .prepare(
      `INSERT INTO server_goal_receipts
       (site_id, idempotency_key, request_hash, processing_token, session_id, visitor_id, goal_name, first_received_at, last_received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'signup', ?, ?)`,
    )
    .run(siteId, `goal-${suffix}`, `hash-${suffix}`, `goal-token-${suffix}`, sessionId, visitorId, now, now);
  sqlite
    .prepare(
      `INSERT INTO outcome_goal_rules
       (site_id, id, name, match_type, path, enabled, created_at, updated_at)
       VALUES (?, ?, 'Lead submitted', 'exact', '/thank-you', 1, ?, ?)`,
    )
    .run(siteId, `outcome-${suffix}`, now, now);
  sqlite
    .prepare(
      `INSERT INTO outcome_goal_receipts
       (site_id, session_id, rule_id, processing_token, first_matched_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(siteId, sessionId, `outcome-${suffix}`, `outcome-token-${suffix}`, now);
}

describe('site deletion', () => {
  it('removes all site-owned data, including both idempotency receipt tables, without affecting another site', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
      for (const migration of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));

      const deletedSiteId = 'site-delete-0001';
      const retainedSiteId = 'site-retain-0002';
      seedSite(sqlite, deletedSiteId, 'deleted');
      seedSite(sqlite, retainedSiteId, 'retained');

      const sessionSecret = 'site-deletion-test-secret';
      const token = await signToken(sessionSecret, `admin.${Date.now() + 60_000}`);
      const response = await app.request(
        `/api/sites/${deletedSiteId}`,
        { method: 'DELETE', headers: { cookie: `ml_auth=${encodeURIComponent(token)}` } },
        { DB: d1(sqlite), ADMIN_PASSWORD: 'unused', SESSION_SECRET: sessionSecret } as never,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sites WHERE id = ?').get(deletedSiteId)).toEqual({ n: 0 });
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sites WHERE id = ?').get(retainedSiteId)).toEqual({ n: 1 });
      for (const table of siteTables) {
        expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ?`).get(deletedSiteId), table).toEqual({ n: 0 });
        expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ?`).get(retainedSiteId), table).toEqual({ n: 1 });
      }
    } finally {
      sqlite.close();
    }
  });
});
