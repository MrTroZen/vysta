import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Site } from '../src/worker/env';
import { breakdown, overview } from '../src/worker/stats';

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
  id: 'time000000000001',
  name: 'Time Test',
  domain: 'example.com',
  timezone: 'Europe/London',
  currency: 'GBP',
  api_key: 'ml_time',
  dodo_webhook_secret: null,
  created_at: Date.UTC(2026, 0, 1),
};

const jan14 = Date.UTC(2026, 0, 14);
const jan15 = Date.UTC(2026, 0, 15);
const jan16 = Date.UTC(2026, 0, 16);

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  sqlite.exec(`
    INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at)
      VALUES ('${site.id}', 'Time Test', 'example.com', 'Europe/London', 'GBP', 'ml_time', ${site.created_at});
    INSERT INTO visitors (site_id, id, first_seen) VALUES
      ('${site.id}', 'visitor-before', ${jan14 + 23 * 3_600_000 + 55 * 60_000}),
      ('${site.id}', 'visitor-ending', ${jan15 + 23 * 3_600_000 + 50 * 60_000});
    INSERT INTO sessions
      (site_id, id, visitor_id, started_at, last_seen_at, duration, pageviews, goals, entry_page, exit_page, source, channel)
      VALUES
      ('${site.id}', 'session-before', 'visitor-before', ${jan14 + 23 * 3_600_000 + 55 * 60_000}, ${jan15 + 10 * 60_000}, 900000, 2, 1, '/before', '/after', 'Google', 'Organic Search'),
      ('${site.id}', 'session-ending', 'visitor-ending', ${jan15 + 23 * 3_600_000 + 50 * 60_000}, ${jan16 + 10 * 60_000}, 1200000, 2, 0, '/late', '/next', 'Direct/None', 'Direct');
    INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path) VALUES
      ('${site.id}', 'session-before', 'visitor-before', ${jan14 + 23 * 3_600_000 + 55 * 60_000}, 'pageview', NULL, '/before'),
      ('${site.id}', 'session-before', 'visitor-before', ${jan15 + 5 * 60_000}, 'goal', 'signup', '/before'),
      ('${site.id}', 'session-before', 'visitor-before', ${jan15 + 10 * 60_000}, 'pageview', NULL, '/after'),
      ('${site.id}', 'session-ending', 'visitor-ending', ${jan15 + 23 * 3_600_000 + 50 * 60_000}, 'pageview', NULL, '/late'),
      ('${site.id}', 'session-ending', 'visitor-ending', ${jan16 + 10 * 60_000}, 'pageview', NULL, '/next');
  `);
  return { sqlite, db: d1(sqlite) };
}

function ctx(db: D1Database, from: number, to: number, granularity: 'hour' | 'day') {
  return { db, site, range: { from, to, granularity }, filters: {}, offset: 0 } as never;
}

describe('reporting time-base boundaries', () => {
  it('A: counts a pageview after midnight by event time, not by the session start day', async () => {
    const { sqlite, db } = fixture();
    try {
      const result = await overview(ctx(db, jan15, jan15 + 60 * 60_000, 'hour'));
      expect(result.current).toMatchObject({ visitors: 1, sessions: 0, pageviews: 1 });
    } finally {
      sqlite.close();
    }
  });

  it('B: counts a goal after midnight in the new day by goal event time', async () => {
    const { sqlite, db } = fixture();
    try {
      const goals = await breakdown(ctx(db, jan15, jan15 + 60 * 60_000, 'hour'), 'goal');
      expect(goals).toMatchObject([{ label: 'signup', visitors: 1, pageviews: 1 }]);
    } finally {
      sqlite.close();
    }
  });

  it('C: splits a session spanning two report days while counting the session on its start day only', async () => {
    const { sqlite, db } = fixture();
    try {
      const result = await overview(ctx(db, jan15, jan16, 'day'));
      expect(result.current).toMatchObject({ visitors: 2, sessions: 1, pageviews: 2 });
      const sources = await breakdown(ctx(db, jan15, jan16, 'day'), 'source');
      expect(sources.map((row) => [row.label, row.visitors, row.pageviews])).toEqual([
        ['Google', 1, 1],
        ['Direct/None', 1, 1],
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('D: includes in-range activity when the date range starts during an existing session', async () => {
    const { sqlite, db } = fixture();
    try {
      const result = await overview(ctx(db, jan15, jan15 + 60 * 60_000, 'hour'));
      expect(result.current.visitors).toBe(1);
      expect(result.current.pageviews).toBe(1);
      expect(result.current.sessions).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('E: excludes activity after the date range ends during an existing session', async () => {
    const { sqlite, db } = fixture();
    try {
      const result = await overview(ctx(db, jan15 + 23 * 3_600_000, jan16, 'hour'));
      expect(result.current).toMatchObject({ visitors: 1, sessions: 1, pageviews: 1 });
    } finally {
      sqlite.close();
    }
  });

  it('F: previous-period comparison assigns cross-boundary pageviews to their own event periods', async () => {
    const { sqlite, db } = fixture();
    try {
      const result = await overview(ctx(db, jan15, jan16, 'day'));
      expect(result.previous).toMatchObject({ visitors: 1, sessions: 1, pageviews: 1 });
      expect(result.current).toMatchObject({ visitors: 2, sessions: 1, pageviews: 2 });
    } finally {
      sqlite.close();
    }
  });

  it('G: daily granularity emits the event-time pageview total for the local day', async () => {
    const { sqlite, db } = fixture();
    try {
      const result = await overview(ctx(db, jan15, jan16, 'day'));
      expect(result.series).toHaveLength(1);
      expect(result.series[0]).toMatchObject({ bucket: '2026-01-15', visitors: 2, pageviews: 2 });
    } finally {
      sqlite.close();
    }
  });

  it('H: hourly granularity puts each pageview in its event hour, not the session start hour', async () => {
    const { sqlite, db } = fixture();
    try {
      const result = await overview(ctx(db, jan15, jan16, 'hour'));
      expect(result.series.find((row) => row.bucket === '2026-01-15T00:00')).toMatchObject({ visitors: 1, pageviews: 1 });
      expect(result.series.find((row) => row.bucket === '2026-01-15T23:00')).toMatchObject({ visitors: 1, pageviews: 1 });
      expect(result.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});
