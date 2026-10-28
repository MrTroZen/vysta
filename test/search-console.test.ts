import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_COOKIE } from '../src/worker/auth';
import type { Env } from '../src/worker/env';
import { app } from '../src/worker/index';
import { signToken } from '../src/worker/lib/crypto';
import {
  createSearchConsoleState,
  decryptSearchConsoleToken,
  encryptSearchConsoleToken,
  getSearchConsolePerformance,
  GSC_SCOPE,
  listSearchConsoleProperties,
  SearchConsoleError,
  selectSearchConsoleProperty,
  verifySearchConsoleState,
} from '../src/worker/searchConsole';

class SqliteD1Statement {
  private args: any[] = [];
  constructor(private readonly db: DatabaseSync, private readonly sql: string) {}
  bind(...args: any[]) { this.args = args; return this; }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.args) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
  execute() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}

function d1(db: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new SqliteD1Statement(db, sql),
    batch: async (statements: SqliteD1Statement[]) => statements.map((statement) => statement.execute()),
  } as unknown as D1Database;
}

const key = randomBytes(32).toString('base64');
const baseEnv = {
  ADMIN_PASSWORD: 'password',
  SESSION_SECRET: 'session-secret-for-tests',
  GSC_GOOGLE_CLIENT_ID: 'gsc-client-id',
  GSC_GOOGLE_CLIENT_SECRET: 'gsc-client-secret',
  GSC_OAUTH_REDIRECT_URI: 'https://analytics.example/api/integrations/search-console/oauth/callback',
  GSC_TOKEN_ENCRYPTION_KEY: key,
} satisfies Partial<Env>;

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
  for (const migration of migrations) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  sqlite.prepare("INSERT INTO users (id, google_sub, email, created_at, plan_status) VALUES ('owner-a', 'sub-a', 'a@example.com', 1, 'active')").run();
  sqlite.prepare("INSERT INTO users (id, google_sub, email, created_at, plan_status) VALUES ('owner-b', 'sub-b', 'b@example.com', 1, 'active')").run();
  sqlite.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('site-a', 'A', 'a.example', 'UTC', 'USD', 'ml_a', 1, 'owner-a');
  sqlite.prepare(
    'INSERT INTO sites (id, name, domain, timezone, currency, api_key, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('site-b', 'B', 'b.example', 'UTC', 'USD', 'ml_b', 1, 'owner-b');
  return { sqlite, db: d1(sqlite) };
}

async function selfHostedCookie(expires = Date.now() + 60_000) {
  return `${AUTH_COOKIE}=${await signToken(baseEnv.SESSION_SECRET, `admin.${expires}`)}`;
}

async function hostedCookie(userId: string, expires = Date.now() + 60_000) {
  return `${AUTH_COOKIE}=${await signToken(baseEnv.SESSION_SECRET, `u:${userId}.${expires}`)}`;
}

async function addConnection(sqlite: DatabaseSync, overrides: { siteId?: string; expiresAt?: number; propertyUri?: string | null } = {}) {
  const siteId = overrides.siteId ?? 'site-a';
  const access = await encryptSearchConsoleToken(key, siteId, 'access', 'access-token');
  const refresh = await encryptSearchConsoleToken(key, siteId, 'refresh', 'refresh-token');
  sqlite.prepare(
    `INSERT INTO search_console_connections
      (site_id, property_uri, permission_level, access_token_encrypted, refresh_token_encrypted,
       access_token_expires_at, granted_scope, connected_at, updated_at)
     VALUES (?, ?, 'siteOwner', ?, ?, ?, ?, 1, 1)`,
  ).run(siteId, overrides.propertyUri === undefined ? 'sc-domain:example.com' : overrides.propertyUri, access, refresh, overrides.expiresAt ?? Date.now() + 3_600_000, GSC_SCOPE);
}

function env(db: D1Database, hosted = false): Env {
  return {
    ...baseEnv,
    ...(hosted ? { GOOGLE_CLIENT_ID: 'login-client', GOOGLE_CLIENT_SECRET: 'login-secret' } : {}),
    DB: db,
    ASSETS: { fetch: () => Promise.resolve(new Response('asset')) } as unknown as Fetcher,
  } as Env;
}

describe('Search Console token encryption and OAuth state', () => {
  it('round-trips AES-256-GCM tokens and binds ciphertext to site and token type', async () => {
    const encrypted = await encryptSearchConsoleToken(key, 'site-a', 'access', 'secret-token');
    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await decryptSearchConsoleToken(key, 'site-a', 'access', encrypted)).toBe('secret-token');
    await expect(decryptSearchConsoleToken(randomBytes(32).toString('base64'), 'site-a', 'access', encrypted)).rejects.toMatchObject({ code: 'search_console_token_unreadable' });
    await expect(decryptSearchConsoleToken(key, 'site-b', 'access', encrypted)).rejects.toMatchObject({ code: 'search_console_token_unreadable' });
    await expect(decryptSearchConsoleToken(key, 'site-a', 'refresh', encrypted)).rejects.toMatchObject({ code: 'search_console_token_unreadable' });
    await expect(decryptSearchConsoleToken(key, 'site-a', 'access', 'v1.bad')).rejects.toMatchObject({ code: 'search_console_token_unreadable' });
  });

  it('accepts only matching, unexpired, signed user-bound state', async () => {
    const state = await createSearchConsoleState('state-secret', 'owner-a', 'site-a', 1_000);
    expect(await verifySearchConsoleState('state-secret', state.cookie, state.state, 'owner-a', 1_001)).toMatchObject({ siteId: 'site-a' });
    expect(await verifySearchConsoleState('state-secret', state.cookie, 'wrong', 'owner-a', 1_001)).toBeNull();
    expect(await verifySearchConsoleState('state-secret', state.cookie, state.state, 'owner-b', 1_001)).toBeNull();
    expect(await verifySearchConsoleState('wrong-secret', state.cookie, state.state, 'owner-a', 1_001)).toBeNull();
    expect(await verifySearchConsoleState('state-secret', state.cookie, state.state, 'owner-a', state.expiresAt)).toBeNull();
  });
});
describe('Search Console Google client', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('refreshes expired access once, stores rotated tokens, and lists normalized properties', async () => {
    const { sqlite, db } = fixture();
    try {
      await addConnection(sqlite, { expiresAt: Date.now() - 1 });
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: GSC_SCOPE }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ siteEntry: [
          { siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' },
          { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteFullUser' },
          { siteUrl: 42, permissionLevel: 'bad' },
        ] }), { status: 200 }));
      await expect(listSearchConsoleProperties(env(db), 'site-a')).resolves.toEqual([
        { propertyUri: 'https://www.example.com/', permissionLevel: 'siteOwner' },
        { propertyUri: 'sc-domain:example.com', permissionLevel: 'siteFullUser' },
      ]);
      const tokenCall = vi.mocked(fetch).mock.calls[0];
      expect(String(tokenCall[1]?.body)).toContain('refresh_token=refresh-token');
      expect((vi.mocked(fetch).mock.calls[1][1]?.headers as Record<string, string>).authorization).toBe('Bearer new-access');
      const stored = sqlite.prepare('SELECT access_token_encrypted, refresh_token_encrypted FROM search_console_connections WHERE site_id = ?').get('site-a') as any;
      expect(await decryptSearchConsoleToken(key, 'site-a', 'access', stored.access_token_encrypted)).toBe('new-access');
      expect(await decryptSearchConsoleToken(key, 'site-a', 'refresh', stored.refresh_token_encrypted)).toBe('new-refresh');
    } finally { sqlite.close(); }
  });

  it('maps invalid_grant to reconnect-required without leaking the upstream response', async () => {
    const { sqlite, db } = fixture();
    try {
      await addConnection(sqlite, { expiresAt: 0 });
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'sensitive detail' }), { status: 400 }));
      await expect(listSearchConsoleProperties(env(db), 'site-a')).rejects.toMatchObject({
        code: 'search_console_reconnect_required', status: 401, message: 'Search Console must be reconnected.',
      });
    } finally { sqlite.close(); }
  });

  it('validates selected properties against a fresh exact sites.list response', async () => {
    const { sqlite, db } = fixture();
    try {
      await addConnection(sqlite, { propertyUri: null });
      vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] }), { status: 200 })));
      await expect(selectSearchConsoleProperty(env(db), 'site-a', 'sc-domain:example.com')).resolves.toEqual({ propertyUri: 'sc-domain:example.com', permissionLevel: 'siteOwner' });
      expect(sqlite.prepare('SELECT property_uri FROM search_console_connections WHERE site_id = ?').get('site-a')).toEqual({ property_uri: 'sc-domain:example.com' });
      await expect(selectSearchConsoleProperty(env(db), 'site-a', 'https://example.com/')).rejects.toMatchObject({ code: 'search_console_property_unavailable' });
    } finally { sqlite.close(); }
  });

  it('queries totals separately and normalizes allowlisted dimensions with bounded pagination', async () => {
    const { sqlite, db } = fixture();
    try {
      await addConnection(sqlite);
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [{ clicks: 10, impressions: 100, ctr: 0.1, position: 4.5 }] }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [
          { keys: ['2026-10-20', 'mobile'], clicks: 6, impressions: 60, ctr: 0.1, position: 3 },
          { keys: ['2026-10-21', 'desktop'], clicks: 4, impressions: 40, ctr: 0.1, position: 6.75 },
        ] }), { status: 200 }));
      const result = await getSearchConsolePerformance(env(db), 'site-a', {
        startDate: '2026-10-20', endDate: '2026-10-21', dimensions: ['date', 'device'], rowLimit: 2, startRow: 4,
      });
      expect(result).toMatchObject({
        source: 'google-search-console', propertyUri: 'sc-domain:example.com',
        totals: { clicks: 10, impressions: 100, ctr: 0.1, position: 4.5 },
        nextStartRow: 6, incompleteFrom: null,
      });
      expect(result.rows[0]).toMatchObject({ dimensions: { date: '2026-10-20', device: 'mobile' } });
      const calls = vi.mocked(fetch).mock.calls;
      expect(calls[0][0]).toContain('sc-domain%3Aexample.com');
      expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ startDate: '2026-10-20', endDate: '2026-10-21', type: 'web', dataState: 'final', rowLimit: 1 });
      expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({ dimensions: ['date', 'device'], rowLimit: 2, startRow: 4 });
      await expect(getSearchConsolePerformance(env(db), 'site-a', { startDate: '2026-10-20', endDate: '2026-10-21', dimensions: ['country'] })).rejects.toMatchObject({ code: 'search_console_dimensions_invalid' });
      await expect(getSearchConsolePerformance(env(db), 'site-a', { startDate: '2026-10-20', endDate: '2026-10-21', rowLimit: 25_001 })).rejects.toBeInstanceOf(SearchConsoleError);
    } finally { sqlite.close(); }
  });
});
describe('Search Console routes and isolation', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('starts consent with least privilege and completes callback with encrypted storage', async () => {
    const { sqlite, db } = fixture();
    try {
      const auth = await selfHostedCookie();
      const start = await app.request('https://analytics.example/api/sites/site-a/integrations/search-console/oauth/start', { headers: { cookie: auth } }, env(db));
      expect(start.status).toBe(302);
      const authorization = new URL(start.headers.get('location')!);
      expect(authorization.searchParams.get('scope')).toBe(GSC_SCOPE);
      expect(authorization.searchParams.get('access_type')).toBe('offline');
      expect(authorization.searchParams.get('prompt')).toBe('consent');
      const oauthCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
      expect(start.headers.get('set-cookie')).toContain('HttpOnly');
      expect(start.headers.get('set-cookie')).toContain('Secure');
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ access_token: 'callback-access', refresh_token: 'callback-refresh', expires_in: 3600, scope: GSC_SCOPE }), { status: 200 }));
      const callback = await app.request(
        `https://analytics.example/api/integrations/search-console/oauth/callback?code=code-1&state=${authorization.searchParams.get('state')}`,
        { headers: { cookie: `${auth}; ${oauthCookie}` } }, env(db),
      );
      expect(callback.headers.get('location')).toBe('/site/site-a/settings?integration=search-console&status=connected');
      const stored = sqlite.prepare('SELECT * FROM search_console_connections WHERE site_id = ?').get('site-a') as any;
      expect(stored.access_token_encrypted).not.toContain('callback-access');
      expect(await decryptSearchConsoleToken(key, 'site-a', 'refresh', stored.refresh_token_encrypted)).toBe('callback-refresh');
    } finally { sqlite.close(); }
  });

  it('rejects state reuse/tampering, missing refresh tokens, and callback ownership changes', async () => {
    const { sqlite, db } = fixture();
    try {
      const auth = await selfHostedCookie();
      const state = await createSearchConsoleState(baseEnv.SESSION_SECRET, 'admin', 'site-a');
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ access_token: 'access', expires_in: 3600, scope: GSC_SCOPE }), { status: 200 }));
      const missingRefresh = await app.request(
        `https://analytics.example/api/integrations/search-console/oauth/callback?code=code&state=${state.state}`,
        { headers: { cookie: `${auth}; vysta_gsc_oauth=${state.cookie}` } }, env(db),
      );
      expect(missingRefresh.headers.get('location')).toContain('status=failed');
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_console_connections').get()).toEqual({ n: 0 });

      const hostedState = await createSearchConsoleState(baseEnv.SESSION_SECRET, 'owner-a', 'site-b');
      const ownerAuth = await hostedCookie('owner-a');
      vi.mocked(fetch).mockClear();
      const changedOwner = await app.request(
        `https://analytics.example/api/integrations/search-console/oauth/callback?code=code&state=${hostedState.state}`,
        { headers: { cookie: `${ownerAuth}; vysta_gsc_oauth=${hostedState.cookie}` } }, env(db, true),
      );
      expect(changedOwner.headers.get('location')).toContain('status=failed');
      expect(fetch).not.toHaveBeenCalled();

      const tampered = await app.request(
        'https://analytics.example/api/integrations/search-console/oauth/callback?code=code&state=wrong',
        { headers: { cookie: `${auth}; vysta_gsc_oauth=${state.cookie}` } }, env(db),
      );
      expect(tampered.headers.get('location')).toContain('status=failed');
    } finally { sqlite.close(); }
  });

  it('enforces authenticated owner scope and same-origin CSRF on mutations', async () => {
    const { sqlite, db } = fixture();
    try {
      const ownerAuth = await hostedCookie('owner-a');
      const own = await app.request('https://analytics.example/api/sites/site-a/integrations/search-console/status', { headers: { cookie: ownerAuth } }, env(db, true));
      expect(own.status).toBe(200);
      expect(await own.json()).toMatchObject({ configured: true, connected: false });
      const other = await app.request('https://analytics.example/api/sites/site-b/integrations/search-console/status', { headers: { cookie: ownerAuth } }, env(db, true));
      expect(other.status).toBe(404);
      const anonymous = await app.request('https://analytics.example/api/sites/site-a/integrations/search-console/status', {}, env(db, true));
      expect(anonymous.status).toBe(401);
      const csrf = await app.request('https://analytics.example/api/sites/site-a/integrations/search-console/property', {
        method: 'PUT', headers: { cookie: ownerAuth, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify({ propertyUri: 'sc-domain:example.com' }),
      }, env(db, true));
      expect(csrf.status).toBe(403);
    } finally { sqlite.close(); }
  });

  it('disconnects site-scoped credentials and site deletion also cleans them up', async () => {
    const { sqlite, db } = fixture();
    try {
      await addConnection(sqlite);
      const response = await app.request('https://analytics.example/api/sites/site-a/integrations/search-console', { method: 'DELETE', headers: { cookie: await selfHostedCookie(), origin: 'https://analytics.example' } }, env(db));
      expect(response.status).toBe(200);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_console_connections WHERE site_id = ?').get('site-a')).toEqual({ n: 0 });
      await addConnection(sqlite);
      const deleteSite = await app.request('https://analytics.example/api/sites/site-a', { method: 'DELETE', headers: { cookie: await selfHostedCookie(), origin: 'https://analytics.example' } }, env(db));
      expect(deleteSite.status).toBe(200);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_console_connections WHERE site_id = ?').get('site-a')).toEqual({ n: 0 });
    } finally { sqlite.close(); }
  });
});
