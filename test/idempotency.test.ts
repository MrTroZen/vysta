import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Site } from '../src/worker/env';
import { ingest, type Geo } from '../src/worker/collect';

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
const geo: Geo = { country: null, region: null, city: null, lat: null, lon: null };
const ua = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/129 Safari/537.36';
const now = Date.UTC(2026, 9, 28, 12);

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
  for (const migration of migrations) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const insert = sqlite.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const item of [site, otherSite]) {
    insert.run(item.id, item.name, item.domain, item.timezone, item.currency, item.api_key, item.created_at);
  }
  return { sqlite, db: d1(sqlite) };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    w: site.id,
    t: 'pageview',
    u: 'https://example.com/',
    vid: 'visitor-0001',
    sid: 'session-0001',
    eid: 'event-page-0001',
    tv: '1',
    ...overrides,
  };
}

async function send(db: D1Database, targetSite: Site, body: ReturnType<typeof payload>, at = now) {
  await ingest(db, targetSite, body, new URL(body.u), ua, geo, at);
}

describe('site-scoped browser event idempotency', () => {
  it('applies pageview, goal, outbound, ping, and identify mutations once per event id', async () => {
    const { sqlite, db } = fixture();
    try {
      const page = payload();
      await send(db, site, page);
      await send(db, site, page, now + 1);

      const goal = payload({ t: 'goal', eid: 'event-goal-0001', n: 'signup', p: { plan: 'pro' } });
      await send(db, site, goal, now + 2);
      await send(db, site, goal, now + 3);

      const outbound = payload({ t: 'outbound', eid: 'event-link-0001', n: 'https://checkout.example/buy' });
      await send(db, site, outbound, now + 4);
      await send(db, site, outbound, now + 5);

      const ping = payload({ t: 'ping', eid: 'event-ping-0001', d: 5_000 });
      await send(db, site, ping, now + 6);
      await send(db, site, ping, now + 7);

      const identify = payload({ t: 'identify', eid: 'event-user-0001', p: { name: 'Alice' } });
      await send(db, site, identify, now + 8);
      await send(db, site, payload({ ...identify, p: { name: 'Mallory' } }), now + 9);

      expect(sqlite.prepare('SELECT pageviews, goals, duration FROM sessions WHERE site_id = ? AND id = ?').get(site.id, page.sid)).toEqual({
        pageviews: 1,
        goals: 1,
        duration: 5_000,
      });
      expect(sqlite.prepare('SELECT type, event_id FROM events WHERE site_id = ? ORDER BY id').all(site.id)).toEqual([
        { type: 'pageview', event_id: 'event-page-0001' },
        { type: 'goal', event_id: 'event-goal-0001' },
        { type: 'outbound', event_id: 'event-link-0001' },
      ]);
      expect(sqlite.prepare('SELECT name FROM visitors WHERE site_id = ? AND id = ?').get(site.id, page.vid)).toEqual({ name: 'Alice' });
      expect(sqlite.prepare('SELECT COUNT(*) AS n, SUM(duplicate_count) AS duplicates FROM ingestion_receipts WHERE site_id = ?').get(site.id)).toEqual({
        n: 5,
        duplicates: 5,
      });
    } finally {
      sqlite.close();
    }
  });

  it('accepts the same event id independently for two sites', async () => {
    const { sqlite, db } = fixture();
    try {
      const first = payload({ eid: 'shared-event-0001' });
      const second = payload({ w: otherSite.id, eid: 'shared-event-0001' });
      await send(db, site, first);
      await send(db, otherSite, second);

      expect(sqlite.prepare('SELECT site_id, event_id FROM events ORDER BY site_id').all()).toEqual([
        { site_id: site.id, event_id: 'shared-event-0001' },
        { site_id: otherSite.id, event_id: 'shared-event-0001' },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('applies concurrent delivery of one event id only once', async () => {
    const { sqlite, db } = fixture();
    try {
      const page = payload({ eid: 'concurrent-event-0001' });
      await Promise.all([send(db, site, page), send(db, site, page, now + 1)]);

      expect(sqlite.prepare('SELECT pageviews FROM sessions WHERE site_id = ? AND id = ?').get(site.id, page.sid)).toEqual({ pageviews: 1 });
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND event_id = ?').get(site.id, page.eid)).toEqual({ n: 1 });
      expect(sqlite.prepare('SELECT duplicate_count FROM ingestion_receipts WHERE site_id = ? AND event_id = ?').get(site.id, page.eid)).toEqual({
        duplicate_count: 1,
      });
    } finally {
      sqlite.close();
    }
  });

  it('continues accepting legacy payloads without event ids without deduplicating them', async () => {
    const { sqlite, db } = fixture();
    try {
      const legacy = payload({ eid: undefined, tv: undefined });
      await send(db, site, legacy);
      await send(db, site, legacy, now + 1);

      expect(sqlite.prepare('SELECT pageviews FROM sessions WHERE site_id = ? AND id = ?').get(site.id, legacy.sid)).toEqual({ pageviews: 2 });
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE site_id = ?').get(site.id)).toEqual({ n: 2 });
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM ingestion_receipts WHERE site_id = ?').get(site.id)).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });
});
