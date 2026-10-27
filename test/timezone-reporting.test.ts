import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Site } from '../src/worker/env';
import { resolveRange } from '../src/worker/lib/time';
import { overview } from '../src/worker/stats';

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

interface TimedPageview {
  id: string;
  ts: number;
}

function fixture(timezone: string, pageviews: TimedPageview[]) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const site: Site = {
    id: 'timezone00000001',
    name: 'Timezone Test',
    domain: 'example.com',
    timezone,
    currency: 'USD',
    api_key: 'ml_timezone',
    dodo_webhook_secret: null,
    created_at: Date.UTC(2026, 0, 1),
  };
  sqlite
    .prepare('INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(site.id, site.name, site.domain, site.timezone, site.currency, site.api_key, site.created_at);
  const visitor = sqlite.prepare('INSERT INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)');
  const session = sqlite.prepare(
    `INSERT INTO sessions
      (site_id, id, visitor_id, started_at, last_seen_at, duration, pageviews, goals, entry_page, exit_page, source, channel)
     VALUES (?, ?, ?, ?, ?, 0, 1, 0, '/', '/', 'Direct/None', 'Direct')`,
  );
  const event = sqlite.prepare(
    `INSERT INTO events (site_id, session_id, visitor_id, ts, type, path)
     VALUES (?, ?, ?, ?, 'pageview', '/')`,
  );
  for (const pageview of pageviews) {
    const visitorId = `visitor-${pageview.id}`;
    const sessionId = `session-${pageview.id}`;
    visitor.run(site.id, visitorId, pageview.ts);
    session.run(site.id, sessionId, visitorId, pageview.ts, pageview.ts);
    event.run(site.id, sessionId, visitorId, pageview.ts);
  }
  return { sqlite, db: d1(sqlite), site };
}

async function dayOverview(timezone: string, day: string, now: number, pageviews: TimedPageview[]) {
  const built = fixture(timezone, pageviews);
  const range = resolveRange({ period: 'custom', from: day, to: day, granularity: 'hour' }, timezone, 0, now);
  const result = await overview({ db: built.db, site: built.site, range, filters: {} } as never);
  return { ...built, range, result };
}

describe('timezone-aware report boundaries', () => {
  it('counts every spring-forward event and compares with the complete prior local day', async () => {
    const { sqlite, result } = await dayOverview('Europe/London', '2026-03-29', Date.UTC(2026, 2, 30, 12), [
      { id: 'previous', ts: Date.UTC(2026, 2, 28, 0, 30) },
      { id: 'midnight', ts: Date.UTC(2026, 2, 29, 0, 30) },
      { id: 'after-jump', ts: Date.UTC(2026, 2, 29, 1, 30) },
      { id: 'last-hour', ts: Date.UTC(2026, 2, 29, 22, 30) },
      { id: 'next-day', ts: Date.UTC(2026, 2, 29, 23) },
    ]);
    try {
      expect(result.current).toMatchObject({ visitors: 3, pageviews: 3 });
      expect(result.previous).toMatchObject({ visitors: 1, pageviews: 1 });
      expect(result.series).toHaveLength(23);
      expect(result.series.find((row) => row.bucket === '2026-03-29T02:00')?.pageviews).toBe(1);
      expect(result.series.some((row) => row.bucket === '2026-03-29T01:00')).toBe(false);
      expect(result.series.reduce((total, row) => total + row.pageviews, 0)).toBe(3);
    } finally {
      sqlite.close();
    }
  });

  it('merges both fall-back instants into the repeated local hour without losing events', async () => {
    const { sqlite, result } = await dayOverview('Europe/London', '2026-10-25', Date.UTC(2026, 9, 26, 12), [
      { id: 'previous', ts: Date.UTC(2026, 9, 23, 23, 30) },
      { id: 'midnight', ts: Date.UTC(2026, 9, 24, 23, 30) },
      { id: 'first-01', ts: Date.UTC(2026, 9, 25, 0, 30) },
      { id: 'second-01', ts: Date.UTC(2026, 9, 25, 1, 30) },
      { id: 'last-hour', ts: Date.UTC(2026, 9, 25, 23, 30) },
      { id: 'next-day', ts: Date.UTC(2026, 9, 26) },
    ]);
    try {
      expect(result.current).toMatchObject({ visitors: 4, pageviews: 4 });
      expect(result.previous).toMatchObject({ visitors: 1, pageviews: 1 });
      expect(result.series).toHaveLength(24);
      expect(result.series.find((row) => row.bucket === '2026-10-25T01:00')?.pageviews).toBe(2);
      expect(result.series.reduce((total, row) => total + row.pageviews, 0)).toBe(4);
    } finally {
      sqlite.close();
    }
  });

  it('keeps non-DST Dhaka day totals and prior-period comparison stable', async () => {
    const start = Date.UTC(2026, 4, 31, 18);
    const { sqlite, range, result } = await dayOverview('Asia/Dhaka', '2026-06-01', Date.UTC(2026, 5, 2, 12), [
      { id: 'previous', ts: start - 24 * 3_600_000 + 30 * 60_000 },
      { id: 'first', ts: start + 30 * 60_000 },
      { id: 'last', ts: start + 23 * 3_600_000 + 30 * 60_000 },
      { id: 'next-day', ts: start + 24 * 3_600_000 },
    ]);
    try {
      expect(range.to - range.from).toBe(24 * 3_600_000);
      expect(result.current).toMatchObject({ visitors: 2, pageviews: 2 });
      expect(result.previous).toMatchObject({ visitors: 1, pageviews: 1 });
      expect(result.series).toHaveLength(24);
      expect(result.series.reduce((total, row) => total + row.pageviews, 0)).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});
