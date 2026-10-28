import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserHealthState, serverGoalHealthState } from '../src/dashboard/lib/trackingHealth';
import { handleEvent, ingest } from '../src/worker/collect';
import type { AppEnv, Site } from '../src/worker/env';
import { deleteSiteData } from '../src/worker/index';
import {
  getTrackingHealth,
  pruneTrackingHealth,
  recordServerGoal,
  recordTrackingHealth,
  trackingHealthCutoff,
} from '../src/worker/trackingHealth';

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

const now = Date.UTC(2026, 9, 28, 12, 34);
const hour = 60 * 60_000;
const site: Site = {
  id: 'health-site-0001',
  name: 'Health fixture',
  domain: 'example.com',
  timezone: 'UTC',
  currency: 'USD',
  api_key: 'ml_health',
  dodo_webhook_secret: null,
  created_at: Date.UTC(2026, 0, 1),
};

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
  for (const migration of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  sqlite
    .prepare('INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, site.created_at);
  return { sqlite, db: d1(sqlite) };
}

const geo = { country: null, region: null, city: null, lat: null, lon: null };
const payload = (overrides: Record<string, unknown> = {}) => ({
  w: site.id,
  t: 'pageview',
  u: 'https://example.com/pricing',
  vid: 'visitor-health-01',
  sid: 'session-health-01',
  eid: 'event-health-0001',
  tv: '1',
  ...overrides,
});

describe('Tracking Health v1', () => {
  beforeEach(() => vi.setSystemTime(now));
  afterEach(() => vi.useRealTimers());

  it('separates tracker requests from meaningful analytics events and counts safe duplicates', async () => {
    const { sqlite, db } = fixture();
    try {
      await ingest(db, site, payload(), new URL('https://example.com/pricing'), 'Mozilla/5.0 Chrome/129', geo, now - 2_000);
      await ingest(db, site, payload(), new URL('https://example.com/pricing'), 'Mozilla/5.0 Chrome/129', geo, now - 1_000);
      await ingest(
        db,
        site,
        payload({ t: 'ping', d: 5_000, eid: undefined }),
        new URL('https://example.com/pricing'),
        'Mozilla/5.0 Chrome/129',
        geo,
        now,
      );

      const health = await getTrackingHealth(db, site.id, now);
      expect(health.browser).toMatchObject({
        requests24h: 3,
        analyticsEvents24h: 1,
        pageviews24h: 1,
        pings24h: 1,
        duplicates24h: 1,
        warnings24h: 0,
        lastEventType: 'pageview',
        lastHostname: 'example.com',
        lastTrackerVersion: '1',
      });
      expect(browserHealthState(health.browser)).toMatchObject({ label: 'Working', tone: 'good' });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'pageview'").get()).toEqual({ n: 1 });
    } finally {
      sqlite.close();
    }
  });

  it('keeps an unused server-goal integration neutral and distinguishes requests-only browser activity', async () => {
    const { sqlite, db } = fixture();
    try {
      await ingest(
        db,
        site,
        payload({ t: 'identify', p: { user_id: 'customer-1' }, eid: undefined }),
        new URL('https://example.com/account'),
        'Mozilla/5.0 Chrome/129',
        geo,
        now,
      );
      const health = await getTrackingHealth(db, site.id, now);
      expect(browserHealthState(health.browser)).toMatchObject({ label: 'Requests only', tone: 'neutral' });
      expect(serverGoalHealthState(health.serverGoals)).toEqual({
        label: 'Not used',
        message: 'No server-side goal requests have been sent for this site.',
        tone: 'neutral',
      });
    } finally {
      sqlite.close();
    }
  });

  it('reports owner-facing server-goal states without treating retries as new events', async () => {
    const { sqlite, db } = fixture();
    try {
      await recordServerGoal(db, site.id, now - 2_000, 'accepted', 'order_confirmed');
      await recordServerGoal(db, site.id, now - 1_000, 'duplicate', 'order_confirmed');
      await recordServerGoal(db, site.id, now, 'warning', 'signup', 'session_not_found');
      const health = await getTrackingHealth(db, site.id, now);
      expect(health.serverGoals).toMatchObject({ requests24h: 3, recorded24h: 1, duplicates24h: 1, warnings24h: 1 });
      expect(serverGoalHealthState(health.serverGoals)).toMatchObject({ label: 'Working with warnings', tone: 'warning' });
      expect(health.serverGoals.warningReasons).toEqual([{ code: 'session_not_found', count: 1, lastAt: now }]);
    } finally {
      sqlite.close();
    }
  });

  it('surfaces a site-scoped collector warning without storing the rejected payload', async () => {
    const { sqlite, db } = fixture();
    try {
      const app = new Hono<AppEnv>();
      app.post('/api/event', handleEvent);
      const response = await app.request(
        '/api/event',
        {
          method: 'POST',
          headers: { 'content-type': 'text/plain', 'user-agent': 'Mozilla/5.0 Chrome/129 Safari/537.36' },
          body: JSON.stringify(payload({ u: 'https://not-example.test/pricing' })),
        },
        { DB: db } as never,
      );
      expect(response.status).toBe(403);
      const health = await getTrackingHealth(db, site.id, now);
      expect(health.browser).toMatchObject({ requests24h: 1, analyticsEvents24h: 0, warnings24h: 1 });
      expect(health.browser.warningReasons).toEqual([{ code: 'invalid_domain', count: 1, lastAt: now }]);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });

  it('prunes hourly data to exactly 720 current-and-prior hourly buckets', async () => {
    const { sqlite, db } = fixture();
    try {
      const cutoff = trackingHealthCutoff(now);
      for (const at of [cutoff - hour, cutoff, now]) {
        await recordTrackingHealth(db, { siteId: site.id, at, source: 'browser', outcome: 'accepted', eventType: 'pageview' });
      }
      await pruneTrackingHealth(db, now);
      expect(sqlite.prepare('SELECT hour FROM tracking_health_hourly ORDER BY hour').all()).toEqual([{ hour: cutoff }, { hour: now - (now % hour) }]);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM site_tracking_health WHERE site_id = ?').get(site.id)).toEqual({ n: 1 });
    } finally {
      sqlite.close();
    }
  });

  it('deletes tracking health and idempotency receipts with the site', async () => {
    const { sqlite, db } = fixture();
    try {
      await ingest(db, site, payload(), new URL('https://example.com/'), 'Mozilla/5.0 Chrome/129', geo, now);
      sqlite
        .prepare(
          `INSERT INTO server_goal_receipts
           (site_id, idempotency_key, request_hash, processing_token, session_id, visitor_id, goal_name, first_received_at, last_received_at)
           VALUES (?, 'key-1', 'hash', 'token', ?, ?, 'signup', ?, ?)`,
        )
        .run(site.id, payload().sid, payload().vid, now, now);

      await deleteSiteData(db, site.id);
      for (const table of ['sites', 'events', 'sessions', 'visitors', 'ingestion_receipts', 'server_goal_receipts', 'tracking_health_hourly', 'site_tracking_health']) {
        const column = table === 'sites' ? 'id' : 'site_id';
        expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(site.id), table).toEqual({ n: 0 });
      }
    } finally {
      sqlite.close();
    }
  });
});
