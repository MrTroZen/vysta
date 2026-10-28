import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import app from '../src/worker/index';
import { ingest, type Geo } from '../src/worker/collect';
import { OutcomeGoalValidationError, pathMatchesOutcome, validateOutcomeGoal } from '../src/worker/outcomeGoals';
import { breakdown, overview } from '../src/worker/stats';
import { signToken } from '../src/worker/lib/crypto';
import type { Site } from '../src/worker/env';

class Statement {
  private args: any[] = [];
  constructor(private db: DatabaseSync, readonly sql: string) {}
  bind(...args: any[]) { this.args = args; return this; }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.args) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
  execute() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}

function d1(sqlite: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new Statement(sqlite, sql),
    batch: async (statements: Statement[]) => statements.map((statement) => statement.execute()),
  } as unknown as D1Database;
}

const openDatabases: DatabaseSync[] = [];
afterEach(() => { while (openDatabases.length) openDatabases.pop()!.close(); });

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  openDatabases.push(sqlite);
  for (const migration of readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const now = Date.UTC(2026, 9, 28, 12);
  const site: Site = {
    id: 'site-outcome-0001', name: 'Outcome Site', domain: 'example.com', timezone: 'UTC', currency: 'USD',
    api_key: 'ml_outcome', dodo_webhook_secret: null, created_at: now - 86_400_000,
  };
  const other: Site = { ...site, id: 'site-outcome-0002', name: 'Other', domain: 'other.example.com' };
  const insert = sqlite.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, dodo_webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const value of [site, other]) insert.run(value.id, value.name, value.domain, value.timezone, value.currency, value.api_key, null, value.created_at);
  return { sqlite, db: d1(sqlite), site, other, now };
}

const geo: Geo = { country: null, region: null, city: null, lat: null, lon: null };
function page(site: Site, sid: string, vid: string, path: string, eid: string) {
  return { w: site.id, t: 'pageview', u: `https://${site.domain}${path}`, vid, sid, eid, tv: 'test' };
}

function addRule(sqlite: DatabaseSync, siteId: string, id: string, name: string, matchType: 'exact' | 'starts_with', path: string, enabled = 1) {
  sqlite.prepare(
    `INSERT INTO outcome_goal_rules (site_id, id, name, match_type, path, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
  ).run(siteId, id, name, matchType, path, enabled);
}

describe('outcome path rules', () => {
  it('matches exact paths and segment-aware starts-with paths', () => {
    expect(pathMatchesOutcome('/thank-you', { path: '/thank-you', matchType: 'exact' })).toBe(true);
    expect(pathMatchesOutcome('/thank-you/next', { path: '/thank-you', matchType: 'exact' })).toBe(false);
    expect(pathMatchesOutcome('/signup/success', { path: '/signup', matchType: 'starts_with' })).toBe(true);
    expect(pathMatchesOutcome('/signup', { path: '/signup', matchType: 'starts_with' })).toBe(true);
    expect(pathMatchesOutcome('/signup-old', { path: '/signup', matchType: 'starts_with' })).toBe(false);
  });

  it('normalizes safe values and rejects raw URLs, queries, fragments, invalid types, and overlong names', () => {
    expect(validateOutcomeGoal({ name: '  Lead   submitted ', matchType: 'exact', path: '/thank-you/' }))
      .toEqual({ name: 'Lead submitted', matchType: 'exact', path: '/thank-you', enabled: true });
    for (const path of ['https://example.com/thanks', '/thanks?email=x', '/thanks#done', '/%00', 'thanks']) {
      expect(() => validateOutcomeGoal({ name: 'Lead', matchType: 'exact', path })).toThrow(OutcomeGoalValidationError);
    }
    expect(() => validateOutcomeGoal({ name: 'x'.repeat(65), matchType: 'exact', path: '/thanks' })).toThrow(OutcomeGoalValidationError);
    expect(() => validateOutcomeGoal({ name: 'Lead', matchType: 'contains', path: '/thanks' })).toThrow(OutcomeGoalValidationError);
  });
});

describe('outcome ingestion and reporting', () => {
  it('fires enabled exact and starts-with rules once per visit across SPA navigation and repeated pageviews', async () => {
    const { sqlite, db, site, now } = fixture();
    addRule(sqlite, site.id, 'exact001', 'Lead submitted', 'exact', '/thank-you');
    addRule(sqlite, site.id, 'prefix01', 'Signup completed', 'starts_with', '/signup');
    addRule(sqlite, site.id, 'disabled', 'Disabled', 'starts_with', '/thank-you', 0);

    const sid = 'session-outcome-0001';
    const vid = 'visitor-outcome-0001';
    await ingest(db, site, page(site, sid, vid, '/home', 'event-page-0001'), new URL('https://example.com/home'), 'Mozilla/5.0', geo, now);
    await ingest(db, site, page(site, sid, vid, '/thank-you?source=private', 'event-page-0002'), new URL('https://example.com/thank-you?source=private'), 'Mozilla/5.0', geo, now + 1);
    await ingest(db, site, page(site, sid, vid, '/signup/success', 'event-page-0003'), new URL('https://example.com/signup/success'), 'Mozilla/5.0', geo, now + 2);
    await ingest(db, site, page(site, sid, vid, '/thank-you', 'event-page-0004'), new URL('https://example.com/thank-you'), 'Mozilla/5.0', geo, now + 3);

    expect(sqlite.prepare("SELECT name, path, props FROM events WHERE type = 'goal' ORDER BY name").all()).toEqual([
      { name: '__vysta_outcome_exact001', path: '/thank-you', props: null },
      { name: '__vysta_outcome_prefix01', path: '/signup/success', props: null },
    ]);
    expect(sqlite.prepare('SELECT goals FROM sessions WHERE site_id = ? AND id = ?').get(site.id, sid)).toEqual({ goals: 2 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM outcome_goal_receipts WHERE site_id = ?').get(site.id)).toEqual({ n: 2 });
  });

  it('isolates sites and preserves explicit and automatic goals while reporting outcomes separately', async () => {
    const { sqlite, db, site, other, now } = fixture();
    addRule(sqlite, other.id, 'other001', 'Other outcome', 'exact', '/thank-you');
    addRule(sqlite, site.id, 'target01', 'Lead submitted', 'exact', '/thank-you');
    const sid = 'session-outcome-0002';
    const vid = 'visitor-outcome-0002';
    await ingest(db, site, page(site, sid, vid, '/thank-you', 'event-page-0010'), new URL('https://example.com/thank-you'), 'Mozilla/5.0', geo, now);
    await ingest(db, site, { ...page(site, sid, vid, '/thank-you', 'event-goal-0011'), t: 'goal', n: 'newsletter_signup' }, new URL('https://example.com/thank-you'), 'Mozilla/5.0', geo, now + 1);
    await ingest(db, site, { ...page(site, sid, vid, '/thank-you', 'event-goal-0012'), t: 'goal', n: '__vysta_phone_intent', p: { phone: 'private' } }, new URL('https://example.com/thank-you'), 'Mozilla/5.0', geo, now + 2);
    await ingest(db, site, { ...page(site, sid, vid, '/thank-you', 'event-goal-0013'), t: 'goal', n: '__vysta_outcome_forged' }, new URL('https://example.com/thank-you'), 'Mozilla/5.0', geo, now + 3);

    const ctx = { db, site, range: { from: now - 1, to: now + 10, granularity: 'day' as const }, filters: {} };
    expect((await breakdown(ctx as never, 'goal')).map((row) => row.label).sort()).toEqual(['__vysta_phone_intent', 'newsletter_signup']);
    expect(await breakdown(ctx as never, 'outcome')).toEqual([
      { label: 'Lead submitted', visitors: 1, pageviews: 1, revenue: 0, customers: 0 },
    ]);
    expect(await breakdown(ctx as never, 'outcome_page')).toEqual([
      { label: 'Lead submitted', extra: '/thank-you', visitors: 1, pageviews: 1, revenue: 0, customers: 0 },
    ]);
    const result = await overview(ctx as never);
    expect(result.current).toMatchObject({ actions: 2, outcomes: 1 });
    expect(sqlite.prepare("SELECT props FROM events WHERE name = '__vysta_phone_intent'").get()).toEqual({ props: null });
  });
});

describe('outcome goal Settings API', () => {
  it('creates, edits, pauses, deletes, validates, and keeps one site from changing another', async () => {
    const { sqlite, db, site, other } = fixture();
    const secret = 'outcome-goals-session-secret';
    const token = await signToken(secret, `admin.${Date.now() + 60_000}`);
    const request = (path: string, method = 'GET', body?: unknown) => app.request(path, {
      method,
      headers: { cookie: `ml_auth=${encodeURIComponent(token)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, { DB: db, ADMIN_PASSWORD: 'unused', SESSION_SECRET: secret } as never);

    const created = await request(`/api/sites/${site.id}/outcome-goals`, 'POST', { name: 'Booking completed', matchType: 'exact', path: '/booking-confirmed?secret=x' });
    expect(created.status).toBe(400);
    const valid = await request(`/api/sites/${site.id}/outcome-goals`, 'POST', { name: 'Booking completed', matchType: 'exact', path: '/booking-confirmed' });
    expect(valid.status).toBe(201);
    const id = ((await valid.json()) as { goal: { id: string } }).goal.id;
    const updated = await request(`/api/sites/${site.id}/outcome-goals/${id}`, 'PUT', { name: 'Booking confirmed', enabled: false });
    expect(updated.status).toBe(200);
    expect((await updated.json()) as object).toMatchObject({ goal: { name: 'Booking confirmed', enabled: false } });

    expect((await request(`/api/sites/${other.id}/outcome-goals/${id}`, 'DELETE')).status).toBe(404);
    expect((await request(`/api/sites/${site.id}/outcome-goals/${id}`, 'DELETE')).status).toBe(200);
    expect(sqlite.prepare('SELECT enabled, deleted_at IS NOT NULL AS deleted FROM outcome_goal_rules WHERE site_id = ? AND id = ?').get(site.id, id))
      .toEqual({ enabled: 0, deleted: 1 });
    expect((await (await request(`/api/sites/${site.id}/outcome-goals`)).json()) as object).toEqual({ goals: [] });
  });
});
