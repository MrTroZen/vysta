import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, Site } from '../src/worker/env';
import { handleGoalApi } from '../src/worker/payments';

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

const now = Date.UTC(2026, 9, 28, 12);
const day = 86_400_000;
const site: Site = {
  id: 'site000000000001',
  name: 'Primary',
  domain: 'example.com',
  timezone: 'UTC',
  currency: 'USD',
  api_key: 'ml_primary',
  dodo_webhook_secret: null,
  created_at: Date.UTC(2026, 0, 1),
};
const otherSite: Site = { ...site, id: 'site000000000002', name: 'Other', api_key: 'ml_other' };

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
  for (const migration of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));

  const insertSite = sqlite.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const item of [site, otherSite]) {
    insertSite.run(item.id, item.name, item.domain, item.timezone, item.currency, item.api_key, item.created_at);
  }

  const insertSession = sqlite.prepare(
    `INSERT INTO sessions
     (site_id, id, visitor_id, started_at, last_seen_at, goals, exit_page, source, channel)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'Direct/None', 'Direct')`,
  );
  insertSession.run(site.id, 'session-old', 'visitor-0001', now - 2 * day, now - 2 * day, '/old');
  insertSession.run(site.id, 'session-latest', 'visitor-0001', now - day, now - day, '/latest');
  insertSession.run(site.id, 'session-stale', 'visitor-stale', now - 40 * day, now - 40 * day, '/stale');
  insertSession.run(otherSite.id, 'session-other', 'visitor-other', now - day, now - day, '/other');
  return { sqlite, db: d1(sqlite) };
}

async function goal(db: D1Database, apiKey: string, body: Record<string, unknown>, key?: string) {
  const app = new Hono<AppEnv>();
  app.post('/api/v1/goals', handleGoalApi);
  return app.request(
    '/api/v1/goals',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify(body),
    },
    { DB: db } as never,
  );
}

describe('server-side goal contract', () => {
  beforeEach(() => vi.setSystemTime(now));
  afterEach(() => vi.useRealTimers());

  it('rejects internal confirmed-outcome names from the public goal API', async () => {
    const { sqlite, db } = fixture();
    try {
      const response = await goal(db, site.api_key, { session_id: 'session-old', name: '__vysta_outcome_forged' });
      expect(response.status).toBe(400);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE name LIKE '__vysta_outcome_%'").get()).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('never stores properties under reserved automatic action names', async () => {
    const { sqlite, db } = fixture();
    try {
      const response = await goal(db, site.api_key, {
        session_id: 'session-old',
        name: '__vysta_email_intent',
        properties: { email: 'private@example.com' },
      });
      expect(response.status).toBe(200);
      expect(sqlite.prepare('SELECT name, props FROM events WHERE site_id = ?').get(site.id)).toEqual({
        name: '__vysta_email_intent',
        props: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it('uses the requested session, documented properties, and an idempotency key exactly once', async () => {
    const { sqlite, db } = fixture();
    try {
      const body = {
        session_id: 'session-old',
        name: 'order_confirmed',
        properties: { amount: 45, plan: 'pro' },
        props: { ignored: true },
        idempotency_key: 'order-order_123',
      };
      const [first, second] = await Promise.all([goal(db, site.api_key, body), goal(db, site.api_key, body)]);

      expect([first.status, second.status]).toEqual([200, 200]);
      const firstBody = (await first.json()) as { duplicate: boolean };
      const secondBody = (await second.json()) as { duplicate: boolean };
      expect([firstBody.duplicate, secondBody.duplicate].sort()).toEqual([false, true]);
      expect(sqlite.prepare('SELECT goals FROM sessions WHERE site_id = ? AND id = ?').get(site.id, 'session-old')).toEqual({ goals: 1 });
      expect(sqlite.prepare('SELECT goals FROM sessions WHERE site_id = ? AND id = ?').get(site.id, 'session-latest')).toEqual({ goals: 0 });
      expect(sqlite.prepare('SELECT session_id, visitor_id, name, path, props FROM events WHERE site_id = ?').get(site.id)).toEqual({
        session_id: 'session-old',
        visitor_id: 'visitor-0001',
        name: 'order_confirmed',
        path: '/old',
        props: '{"amount":45,"plan":"pro"}',
      });
      expect(
        sqlite.prepare('SELECT duplicate_count FROM server_goal_receipts WHERE site_id = ? AND idempotency_key = ?').get(site.id, body.idempotency_key),
      ).toEqual({ duplicate_count: 1 });
      expect(
        sqlite
          .prepare("SELECT outcome, count FROM tracking_health_hourly WHERE site_id = ? AND source = 'server_goal' ORDER BY outcome")
          .all(site.id),
      ).toEqual([
        { outcome: 'accepted', count: 1 },
        { outcome: 'duplicate', count: 1 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('keeps legacy visitor_id and props requests working without deduplicating them', async () => {
    const { sqlite, db } = fixture();
    try {
      const body = { visitor_id: 'visitor-0001', name: 'legacy_goal', props: { legacy: true } };
      expect((await goal(db, site.api_key, body)).status).toBe(200);
      expect((await goal(db, site.api_key, body)).status).toBe(200);

      expect(sqlite.prepare('SELECT goals FROM sessions WHERE site_id = ? AND id = ?').get(site.id, 'session-latest')).toEqual({ goals: 2 });
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND name = ?').get(site.id, 'legacy_goal')).toEqual({ n: 2 });
      expect(sqlite.prepare('SELECT props FROM events WHERE site_id = ? AND name = ? LIMIT 1').get(site.id, 'legacy_goal')).toEqual({
        props: '{"legacy":true}',
      });
    } finally {
      sqlite.close();
    }
  });

  it('rejects mismatched and stale sessions', async () => {
    const { sqlite, db } = fixture();
    try {
      expect(
        (await goal(db, site.api_key, { session_id: 'session-old', visitor_id: 'someone-else', name: 'bad_owner' })).status,
      ).toBe(409);
      expect((await goal(db, site.api_key, { session_id: 'session-stale', name: 'too_late' })).status).toBe(404);
      expect((await goal(db, site.api_key, { visitor_id: 'visitor-stale', name: 'too_late' })).status).toBe(404);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'goal'").get()).toEqual({ n: 0 });
      expect(
        sqlite
          .prepare("SELECT reason, count FROM tracking_health_hourly WHERE site_id = ? AND source = 'server_goal' ORDER BY reason")
          .all(site.id),
      ).toEqual([
        { reason: 'session_mismatch', count: 1 },
        { reason: 'session_not_found', count: 2 },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('validates authentication, required identity, missing sessions, and conflicting keys', async () => {
    const { sqlite, db } = fixture();
    try {
      expect((await goal(db, 'wrong-key', { session_id: 'session-old', name: 'confirmed' })).status).toBe(401);
      expect((await goal(db, site.api_key, { name: 'confirmed' })).status).toBe(400);
      expect((await goal(db, site.api_key, { session_id: 'missing-session', name: 'confirmed' })).status).toBe(404);
      expect(
        (
          await goal(
            db,
            site.api_key,
            { session_id: 'session-old', name: 'confirmed', idempotency_key: 'body-key' },
            'header-key',
          )
        ).status,
      ).toBe(400);
    } finally {
      sqlite.close();
    }
  });

  it('rejects reuse of an idempotency key for a different goal', async () => {
    const { sqlite, db } = fixture();
    try {
      const key = 'business-key-123';
      expect((await goal(db, site.api_key, { session_id: 'session-old', name: 'first_goal' }, key)).status).toBe(200);
      expect((await goal(db, site.api_key, { session_id: 'session-old', name: 'other_goal' }, key)).status).toBe(409);
      expect(sqlite.prepare("SELECT name FROM events WHERE type = 'goal'").all()).toEqual([{ name: 'first_goal' }]);
    } finally {
      sqlite.close();
    }
  });

  it('scopes the same idempotency key independently per site', async () => {
    const { sqlite, db } = fixture();
    try {
      const key = 'shared-business-key';
      expect((await goal(db, site.api_key, { session_id: 'session-old', name: 'confirmed' }, key)).status).toBe(200);
      expect((await goal(db, otherSite.api_key, { session_id: 'session-other', name: 'confirmed' }, key)).status).toBe(200);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'goal'").get()).toEqual({ n: 2 });
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM server_goal_receipts WHERE idempotency_key = ?').get(key)).toEqual({ n: 2 });
    } finally {
      sqlite.close();
    }
  });
});
