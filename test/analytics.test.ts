import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { handleEvent, ingest, type Geo } from '../src/worker/collect';
import type { AppEnv, Env, Site } from '../src/worker/env';
import { handleGoalApi } from '../src/worker/payments';
import { funnel, overview, realtime } from '../src/worker/stats';

interface RecordedStatement {
  sql: string;
  args: unknown[];
}

interface FakeDbOptions {
  first?: (statement: RecordedStatement) => unknown;
  all?: (statement: RecordedStatement) => unknown[];
  batch?: (statements: RecordedStatement[]) => unknown[][];
}

function fakeDb(options: FakeDbOptions = {}) {
  const prepared: RecordedStatement[] = [];
  const batches: RecordedStatement[][] = [];
  const runs: RecordedStatement[] = [];

  class Statement {
    readonly recorded: RecordedStatement;

    constructor(sql: string) {
      this.recorded = { sql, args: [] };
      prepared.push(this.recorded);
    }

    bind(...args: unknown[]) {
      this.recorded.args = args;
      return this;
    }

    async first<T>() {
      return (options.first?.(this.recorded) ?? null) as T | null;
    }

    async all<T>() {
      return { results: (options.all?.(this.recorded) ?? []) as T[] };
    }

    async run() {
      runs.push(this.recorded);
      return { success: true };
    }
  }

  const db = {
    prepare(sql: string) {
      return new Statement(sql);
    },
    async batch(statements: Statement[]) {
      const recorded = statements.map((statement) => statement.recorded);
      batches.push(recorded);
      return (options.batch?.(recorded) ?? recorded.map(() => [] as unknown[])).map((results) => ({ results }));
    },
  } as unknown as D1Database;

  return { db, prepared, batches, runs };
}

const site: Site = {
  id: 'site000000000001',
  name: 'Example',
  domain: 'example.com',
  timezone: 'UTC',
  currency: 'USD',
  api_key: 'ml_test',
  dodo_webhook_secret: null,
  created_at: Date.UTC(2026, 0, 1),
};

const geo: Geo = { country: 'US', region: 'CA', city: 'Oakland', lat: 37.8, lon: -122.27 };
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129 Safari/537.36';
const now = Date.UTC(2026, 9, 23, 12, 0);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    w: site.id,
    t: 'pageview',
    u: 'https://example.com/landing',
    vid: 'visitor-0001',
    sid: 'session-0001',
    sw: 1440,
    ...overrides,
  };
}

describe('event ingestion characterization', () => {
  it('creates one visitor, session, pageview counter, and event for a first pageview', async () => {
    const f = fakeDb();
    await ingest(
      f.db,
      site,
      payload({
        u: 'https://www.example.com/pricing/?utm_source=google&utm_medium=cpc&utm_campaign=launch&utm_term=widgets&ref=ignored',
        r: 'https://m.facebook.com/post/1',
      }),
      new URL('https://www.example.com/pricing/?utm_source=google&utm_medium=cpc&utm_campaign=launch&utm_term=widgets&ref=ignored'),
      ua,
      geo,
      now,
    );

    expect(f.batches).toHaveLength(1);
    const statements = f.batches[0];
    expect(statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining('INSERT OR IGNORE INTO visitors'),
      expect.stringContaining('INSERT OR IGNORE INTO sessions'),
      expect.stringContaining('UPDATE sessions SET pageviews = pageviews + 1'),
      expect.stringContaining('INSERT INTO events'),
    ]);

    const session = statements[1].args;
    expect(session.slice(0, 9)).toEqual([
      site.id,
      'session-0001',
      'visitor-0001',
      now,
      now,
      'example.com',
      '/pricing',
      '/pricing',
      'm.facebook.com/post/1',
    ]);
    expect(session.slice(9, 18)).toEqual([
      'm.facebook.com',
      'Google',
      'Paid',
      'google',
      'cpc',
      'launch',
      'widgets',
      null,
      'ignored',
    ]);
    expect(statements[3].args).toEqual([site.id, 'session-0001', 'visitor-0001', now, 'pageview', null, '/pricing', null]);
  });

  it('captures attribution only while creating a session and ignores self-referrals', async () => {
    const f = fakeDb();
    await ingest(
      f.db,
      site,
      payload({ r: 'https://app.example.com/inside' }),
      new URL('https://example.com/landing'),
      ua,
      geo,
      now,
    );
    const session = f.batches[0][1].args;
    expect(session[8]).toBeNull();
    expect(session[9]).toBeNull();
    expect(session[10]).toBe('Direct/None');
    expect(session[11]).toBe('Direct');

    const existing = fakeDb({ first: () => ({ visitor_id: 'visitor-0001' }) });
    await ingest(
      existing.db,
      site,
      payload({ u: 'https://example.com/next?utm_source=reddit', r: 'https://reddit.com/r/test' }),
      new URL('https://example.com/next?utm_source=reddit'),
      ua,
      geo,
      now + 1_000,
    );
    expect(existing.batches[0].map((statement) => statement.sql)).toEqual([
      expect.stringContaining('UPDATE sessions SET pageviews = pageviews + 1'),
      expect.stringContaining('INSERT INTO events'),
    ]);
  });

  it('keeps explicit attribution while discarding a self-referrer', async () => {
    const f = fakeDb();
    const url = new URL('https://example.com/landing?utm_source=partner-42&utm_medium=social');
    await ingest(
      f.db,
      site,
      payload({ u: url.href, r: 'https://app.example.com/inside' }),
      url,
      ua,
      geo,
      now,
    );

    const session = f.batches[0][1].args;
    expect(session.slice(8, 14)).toEqual([null, null, 'partner-42', 'Organic Social', 'partner-42', 'social']);
  });

  it('drops an event when an existing session belongs to another visitor', async () => {
    const f = fakeDb({ first: () => ({ visitor_id: 'different-visitor' }) });
    await ingest(f.db, site, payload(), new URL('https://example.com/landing'), ua, geo, now);
    expect(f.batches).toHaveLength(0);
  });

  it('bounds each engaged-time ping and binds it to the session visitor', async () => {
    const f = fakeDb();
    await ingest(
      f.db,
      site,
      payload({ t: 'ping', d: 999_999_999 }),
      new URL('https://example.com/landing'),
      ua,
      geo,
      now,
    );
    expect(f.runs).toEqual([
      {
        sql: expect.stringContaining('duration = MIN(duration + ?, 86400000)'),
        args: [600_000, now, site.id, 'session-0001', 'visitor-0001'],
      },
    ]);
  });

  it('stores each replayed pageview and goal because events have no idempotency key', async () => {
    const f = fakeDb({ first: () => ({ visitor_id: 'visitor-0001' }) });
    const page = payload();
    await ingest(f.db, site, page, new URL(page.u), ua, geo, now);
    await ingest(f.db, site, page, new URL(page.u), ua, geo, now);
    const goal = payload({ t: 'goal', n: 'signup', p: { plan: 'pro' } });
    await ingest(f.db, site, goal, new URL(goal.u), ua, geo, now + 1_000);
    await ingest(f.db, site, goal, new URL(goal.u), ua, geo, now + 1_000);

    expect(f.batches).toHaveLength(4);
    expect(f.batches.filter((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO events')))).toHaveLength(4);
    expect(f.batches[2][0].args).toEqual([now + 1_000, site.id, 'session-0001']);
    expect(f.batches[2][1].args.at(-1)).toBe('{"plan":"pro"}');
  });

  it('ignores a malformed empty goal after validating session ownership', async () => {
    const f = fakeDb({ first: () => ({ visitor_id: 'visitor-0001' }) });
    const goal = payload({ t: 'goal', n: '   ' });
    await ingest(f.db, site, goal, new URL(goal.u), ua, geo, now);
    expect(f.batches).toHaveLength(0);
  });
});

describe('collector validation characterization', () => {
  function appFor(db: D1Database) {
    const app = new Hono<AppEnv>();
    app.post('/api/event', handleEvent);
    const env = { DB: db } as Env;
    return (body: string, userAgent?: string) =>
      app.request(
        '/api/event',
        { method: 'POST', headers: userAgent ? { 'user-agent': userAgent } : undefined, body },
        env,
      );
  }

  it('rejects malformed, oversized, and invalid-shape payloads before storage', async () => {
    const call = appFor(fakeDb().db);
    expect((await call('{', ua)).status).toBe(400);
    expect((await call('x'.repeat(8_193), ua)).status).toBe(413);
    expect((await call(JSON.stringify(payload({ w: 'short' })), ua)).status).toBe(400);
    expect((await call(JSON.stringify(payload({ eid: 'bad' })), ua)).status).toBe(400);
  });

  it('silently drops missing and known-bot user agents', async () => {
    const f = fakeDb();
    const call = appFor(f.db);
    expect((await call(JSON.stringify(payload()))).status).toBe(202);
    expect((await call(JSON.stringify(payload()), 'Googlebot/2.1')).status).toBe(202);
    expect(f.batches).toHaveLength(0);
  });

  it('rejects an event URL outside the configured domain', async () => {
    const f = fakeDb({
      first: (statement) => (statement.sql.includes('FROM sites s LEFT JOIN users') ? site : null),
    });
    const call = appFor(f.db);
    const response = await call(JSON.stringify(payload({ u: 'https://evil.example.net/' })), ua);
    expect(response.status).toBe(403);
    expect(f.batches).toHaveLength(0);
  });

  it('returns 404 for a well-shaped unknown site id', async () => {
    const call = appFor(fakeDb().db);
    const response = await call(JSON.stringify(payload({ w: 'site000000000002' })), ua);
    expect(response.status).toBe(404);
  });
});

describe('reporting semantics characterization', () => {
  it('derives traffic from pageview events and visit quality from session cohorts', async () => {
    let batchCall = 0;
    const f = fakeDb({
      batch: (statements) => {
        batchCall++;
        expect(statements[0].sql).toContain('s.started_at >= ?');
        expect(statements[0].sql).toContain('s.pageviews <= 1 AND s.goals = 0');
        expect(statements[2].sql).toContain("e.type = 'pageview'");
        expect(statements[2].sql).toContain('e.ts >= ?');
        return [
          [{ sessions: 3, bounces: 2, avg_duration: 10_000.4 }],
          [{ sessions: 1, bounces: 1, avg_duration: 0 }],
          [{ visitors: 2, pageviews: 7 }],
          [{ visitors: 1, pageviews: 1 }],
          [{ revenue: 12_500, customers: 1, payments: 2 }],
          [{ revenue: 0, customers: 0, payments: 0 }],
          [{ n: 2 }],
          [{ b: '2026-10-23T12:00', visitors: 2, pageviews: 7 }],
          [{ b: '2026-10-23T12:00', revenue: 12_500, payments: 2 }],
        ];
      },
    });
    const range = { from: now, to: now + 60 * 60_000, granularity: 'hour' as const };
    const result = await overview({ db: f.db, site, range, filters: {}, offset: 0 } as never);

    expect(batchCall).toBe(1);
    expect(result.current).toEqual({
      visitors: 2,
      sessions: 3,
      pageviews: 7,
      bounceRate: 2 / 3,
      avgDuration: 10_000,
      revenue: 12_500,
      payments: 2,
      customers: 1,
      conversionRate: 0.5,
      revenuePerVisitor: 6_250,
    });
    expect(result.online).toBe(2);
    expect(result.series[0]).toMatchObject({ visitors: 2, pageviews: 7, revenue: 12_500, payments: 2 });
  });

  it('advances funnel steps in event order per visitor, across sessions', async () => {
    const f = fakeDb({
      all: () => [
        { v: 'a', ts: 1, type: 'pageview', name: null, path: '/' },
        { v: 'b', ts: 2, type: 'goal', name: 'signup', path: '/' },
        { v: 'a', ts: 3, type: 'pageview', name: null, path: '/pricing' },
        { v: 'b', ts: 4, type: 'pageview', name: null, path: '/' },
        { v: 'a', ts: 5, type: 'goal', name: 'signup', path: '/pricing' },
      ],
    });
    const range = { from: 0, to: 10, granularity: 'day' as const };
    const result = await funnel(
      { db: f.db, site, range, filters: {}, offset: 0 } as never,
      [
        { type: 'page', value: '/' },
        { type: 'page', value: '/pric*' },
        { type: 'goal', value: 'signup' },
      ],
    );
    expect(result.map((step) => step.visitors)).toEqual([2, 1, 1]);
  });

  it('defines realtime as recent activity plus a six-hour session-start guard', async () => {
    const f = fakeDb({
      batch: (statements) => {
        expect(statements[0].args).toEqual([site.id, now - 6 * 3_600_000, now - 5 * 60_000]);
        expect(statements[1].args).toEqual([site.id, now - 30 * 60_000]);
        return [
          [
            { visitor_id: 'a', session_id: 'new', last_seen_at: now - 1_000 },
            { visitor_id: 'a', session_id: 'old', last_seen_at: now - 2_000 },
            { visitor_id: 'b', session_id: 'b', last_seen_at: now - 3_000 },
          ],
          [{ id: 1, ts: now - 1_000, type: 'pageview', path: '/', visitor_id: 'a' }],
          [],
        ];
      },
    });
    const result = await realtime(f.db, site, now);
    expect(result.visitors.map((visitor) => visitor.visitor_id)).toEqual(['a', 'b']);
    expect(result.feed).toHaveLength(1);
  });
});

describe('server-side goals characterization', () => {
  it('attaches a goal to the requested session and prefers documented properties', async () => {
    const f = fakeDb({
      first: (statement) => {
        if (statement.sql.includes('FROM sites WHERE api_key')) return site;
        if (statement.sql.includes('FROM sessions')) {
          return { id: 'requested-session', visitor_id: 'visitor-0001', exit_page: '/checkout', last_seen_at: now };
        }
        return null;
      },
    });
    const app = new Hono<AppEnv>();
    app.post('/api/v1/goals', handleGoalApi);
    const response = await app.request(
      '/api/v1/goals',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${site.api_key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          visitor_id: 'visitor-0001',
          session_id: 'requested-session',
          name: 'confirmed_signup',
          properties: { documented: true },
          props: { stored: true },
        }),
      },
      { DB: f.db } as Env,
    );

    expect(response.status).toBe(200);
    expect(f.prepared.find((statement) => statement.sql.includes('FROM sessions'))?.args).toEqual([
      site.id,
      'requested-session',
      expect.any(Number),
    ]);
    expect(f.batches[0][0].args).toEqual([site.id, 'requested-session']);
    expect(f.batches[0][1].args.slice(0, 7)).toEqual([
      site.id,
      'requested-session',
      'visitor-0001',
      expect.any(Number),
      'confirmed_signup',
      '/checkout',
      '{"documented":true}',
    ]);
  });
});
