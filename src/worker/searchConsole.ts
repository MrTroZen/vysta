import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { currentUser, siteAccessSql } from './auth';
import type { AppEnv, Env } from './env';
import { randomId, signToken, verifyToken } from './lib/crypto';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const OAUTH_COOKIE = 'vysta_gsc_oauth';
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;
const GOOGLE_TIMEOUT_MS = 10_000;
const MAX_RANGE_DAYS = 500;
const MAX_START_ROW = 1_000_000;
const DEFAULT_ROW_LIMIT = 1_000;
const MAX_ROW_LIMIT = 25_000;
const DIMENSIONS = ['date', 'query', 'page', 'device'] as const;

type Dimension = (typeof DIMENSIONS)[number];
type TokenType = 'access' | 'refresh';

interface ConnectionRow {
  site_id: string;
  property_uri: string | null;
  permission_level: string | null;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_token_expires_at: number;
  granted_scope: string;
  connected_at: number;
  updated_at: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

interface GoogleProperty {
  siteUrl?: unknown;
  permissionLevel?: unknown;
}

interface GoogleRow {
  keys?: unknown;
  clicks?: unknown;
  impressions?: unknown;
  ctr?: unknown;
  position?: unknown;
}

interface GoogleSearchResponse {
  rows?: unknown;
  metadata?: { first_incomplete_date?: unknown };
}

export class SearchConsoleError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireConfig(env: Env) {
  if (!env.GSC_GOOGLE_CLIENT_ID || !env.GSC_GOOGLE_CLIENT_SECRET || !env.GSC_OAUTH_REDIRECT_URI || !env.GSC_TOKEN_ENCRYPTION_KEY) {
    throw new SearchConsoleError('search_console_not_configured', 503, 'Search Console is not configured.');
  }
  let redirect: URL;
  try {
    redirect = new URL(env.GSC_OAUTH_REDIRECT_URI);
  } catch {
    throw new SearchConsoleError('search_console_not_configured', 503, 'Search Console redirect URI is invalid.');
  }
  if (!['https:', 'http:'].includes(redirect.protocol)) {
    throw new SearchConsoleError('search_console_not_configured', 503, 'Search Console redirect URI is invalid.');
  }
  return {
    clientId: env.GSC_GOOGLE_CLIENT_ID,
    clientSecret: env.GSC_GOOGLE_CLIENT_SECRET,
    redirectUri: redirect.toString(),
    encryptionKey: env.GSC_TOKEN_ENCRYPTION_KEY,
  };
}

function b64url(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function encryptionKey(value: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromB64url(value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'));
  } catch {
    throw new SearchConsoleError('search_console_key_invalid', 500, 'Search Console encryption key is invalid.');
  }
  if (bytes.byteLength !== 32) {
    throw new SearchConsoleError('search_console_key_invalid', 500, 'Search Console encryption key must contain exactly 32 bytes.');
  }
  return bytes;
}

function tokenAad(siteId: string, type: TokenType) {
  return new TextEncoder().encode(`vysta:gsc:v1:${siteId}:${type}`);
}

export async function encryptSearchConsoleToken(keyValue: string, siteId: string, type: TokenType, token: string): Promise<string> {
  if (!token) throw new Error('token is required');
  const key = await crypto.subtle.importKey('raw', encryptionKey(keyValue), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: tokenAad(siteId, type), tagLength: 128 },
    key,
    new TextEncoder().encode(token),
  );
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ciphertext))}`;
}

export async function decryptSearchConsoleToken(keyValue: string, siteId: string, type: TokenType, envelope: string): Promise<string> {
  try {
    const parts = envelope.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('invalid envelope');
    const iv = fromB64url(parts[1]);
    const ciphertext = fromB64url(parts[2]);
    if (iv.byteLength !== 12 || ciphertext.byteLength < 17) throw new Error('invalid envelope');
    const key = await crypto.subtle.importKey('raw', encryptionKey(keyValue), 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: tokenAad(siteId, type), tagLength: 128 },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof SearchConsoleError) throw error;
    throw new SearchConsoleError('search_console_token_unreadable', 500, 'Stored Search Console credentials cannot be decrypted.');
  }
}

interface OAuthState {
  nonce: string;
  userId: string;
  siteId: string;
  expiresAt: number;
}

function encodeState(state: OAuthState) {
  return b64url(new TextEncoder().encode(JSON.stringify(state)));
}

export async function createSearchConsoleState(secret: string, userId: string, siteId: string, now = Date.now()) {
  const state: OAuthState = { nonce: randomId(18), userId, siteId, expiresAt: now + STATE_TTL_MS };
  return { state: state.nonce, cookie: await signToken(secret, encodeState(state)), expiresAt: state.expiresAt };
}

export async function verifySearchConsoleState(
  secret: string,
  cookie: string | undefined,
  nonce: string | undefined,
  userId: string,
  now = Date.now(),
): Promise<OAuthState | null> {
  const encoded = await verifyToken(secret, cookie);
  if (!encoded || !nonce) return null;
  try {
    const state = JSON.parse(new TextDecoder().decode(fromB64url(encoded))) as OAuthState;
    if (
      typeof state.nonce !== 'string' ||
      typeof state.userId !== 'string' ||
      typeof state.siteId !== 'string' ||
      typeof state.expiresAt !== 'number' ||
      state.nonce !== nonce ||
      state.userId !== userId ||
      state.expiresAt <= now
    ) return null;
    return state;
  } catch {
    return null;
  }
}

function scopeGranted(scope: string | undefined) {
  return (scope ?? '').split(/\s+/).includes(GSC_SCOPE);
}

async function tokenRequest(env: Env, body: URLSearchParams): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch {
    throw new SearchConsoleError('search_console_upstream_unavailable', 502, 'Google OAuth is temporarily unavailable.');
  }
  const tokens: TokenResponse = await response.json<TokenResponse>().catch(() => ({}));
  if (!response.ok) {
    if (tokens.error === 'invalid_grant') {
      throw new SearchConsoleError('search_console_reconnect_required', 401, 'Search Console must be reconnected.');
    }
    throw new SearchConsoleError('search_console_oauth_failed', 502, 'Google OAuth failed.');
  }
  return tokens;
}

async function connection(db: D1Database, siteId: string) {
  return db.prepare('SELECT * FROM search_console_connections WHERE site_id = ?').bind(siteId).first<ConnectionRow>();
}

async function saveTokens(
  env: Env,
  siteId: string,
  tokens: TokenResponse,
  existing: ConnectionRow | null,
  now = Date.now(),
) {
  const config = requireConfig(env);
  if (!tokens.access_token || !Number.isFinite(tokens.expires_in) || Number(tokens.expires_in) <= 0) {
    throw new SearchConsoleError('search_console_oauth_failed', 502, 'Google returned an incomplete token response.');
  }
  const scope = tokens.scope ?? existing?.granted_scope;
  if (!scopeGranted(scope)) {
    throw new SearchConsoleError('search_console_scope_rejected', 403, 'Search Console read access was not granted.');
  }
  const refreshEncrypted = tokens.refresh_token
    ? await encryptSearchConsoleToken(config.encryptionKey, siteId, 'refresh', tokens.refresh_token)
    : existing?.refresh_token_encrypted;
  if (!refreshEncrypted) {
    throw new SearchConsoleError('search_console_refresh_missing', 400, 'Google did not return offline access. Reconnect and grant consent.');
  }
  const accessEncrypted = await encryptSearchConsoleToken(config.encryptionKey, siteId, 'access', tokens.access_token);
  const expiresAt = now + Number(tokens.expires_in) * 1_000;
  await env.DB.prepare(
    `INSERT INTO search_console_connections
       (site_id, property_uri, permission_level, access_token_encrypted, refresh_token_encrypted,
        access_token_expires_at, granted_scope, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id) DO UPDATE SET
       access_token_encrypted = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       access_token_expires_at = excluded.access_token_expires_at,
       granted_scope = excluded.granted_scope,
       updated_at = excluded.updated_at`,
  )
    .bind(
      siteId,
      existing?.property_uri ?? null,
      existing?.permission_level ?? null,
      accessEncrypted,
      refreshEncrypted,
      expiresAt,
      scope,
      existing?.connected_at ?? now,
      now,
    )
    .run();
}

async function refreshAccessToken(env: Env, row: ConnectionRow, now = Date.now()) {
  const config = requireConfig(env);
  const refreshToken = await decryptSearchConsoleToken(config.encryptionKey, row.site_id, 'refresh', row.refresh_token_encrypted);
  const tokens = await tokenRequest(
    env,
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  );
  await saveTokens(env, row.site_id, tokens, row, now);
  const updated = await connection(env.DB, row.site_id);
  if (!updated) throw new SearchConsoleError('search_console_not_connected', 409, 'Search Console is not connected.');
  return { row: updated, accessToken: tokens.access_token! };
}

async function validAccessToken(env: Env, siteId: string, forceRefresh = false) {
  const config = requireConfig(env);
  const row = await connection(env.DB, siteId);
  if (!row) throw new SearchConsoleError('search_console_not_connected', 409, 'Search Console is not connected.');
  if (forceRefresh || row.access_token_expires_at <= Date.now() + REFRESH_SKEW_MS) return refreshAccessToken(env, row);
  return {
    row,
    accessToken: await decryptSearchConsoleToken(config.encryptionKey, siteId, 'access', row.access_token_encrypted),
  };
}

function googleError(status: number): SearchConsoleError {
  if (status === 401) return new SearchConsoleError('search_console_reconnect_required', 401, 'Search Console must be reconnected.');
  if (status === 403) return new SearchConsoleError('search_console_forbidden', 403, 'Google denied access to this Search Console property.');
  if (status === 429) return new SearchConsoleError('search_console_rate_limited', 503, 'Google Search Console is temporarily rate limited.');
  return new SearchConsoleError('search_console_upstream_failed', 502, 'Google Search Console is temporarily unavailable.');
}

async function googleRequest<T>(env: Env, siteId: string, url: string, init: RequestInit = {}): Promise<T> {
  let forcedRefresh = false;
  let transientRetry = false;
  for (;;) {
    const { accessToken } = await validAccessToken(env, siteId, forcedRefresh);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
    } catch {
      if (!transientRetry) {
        transientRetry = true;
        continue;
      }
      throw new SearchConsoleError('search_console_upstream_unavailable', 502, 'Google Search Console is temporarily unavailable.');
    }
    if (response.ok) return response.json<T>();
    if (response.status === 401 && !forcedRefresh) {
      forcedRefresh = true;
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && !transientRetry) {
      transientRetry = true;
      continue;
    }
    throw googleError(response.status);
  }
}

export async function listSearchConsoleProperties(env: Env, siteId: string) {
  const result = await googleRequest<{ siteEntry?: GoogleProperty[] }>(env, siteId, 'https://www.googleapis.com/webmasters/v3/sites');
  return (Array.isArray(result.siteEntry) ? result.siteEntry : [])
    .filter((entry) => typeof entry.siteUrl === 'string' && typeof entry.permissionLevel === 'string')
    .map((entry) => ({ propertyUri: entry.siteUrl as string, permissionLevel: entry.permissionLevel as string }));
}

export async function selectSearchConsoleProperty(env: Env, siteId: string, propertyUri: string) {
  if (!propertyUri || propertyUri.length > 2_048) throw new SearchConsoleError('search_console_property_invalid', 400, 'Choose a valid property.');
  const properties = await listSearchConsoleProperties(env, siteId);
  const selected = properties.find((property) => property.propertyUri === propertyUri);
  if (!selected) throw new SearchConsoleError('search_console_property_unavailable', 400, 'That property is not accessible to this Google account.');
  await env.DB.prepare('UPDATE search_console_connections SET property_uri = ?, permission_level = ?, updated_at = ? WHERE site_id = ?')
    .bind(selected.propertyUri, selected.permissionLevel, Date.now(), siteId)
    .run();
  return selected;
}

function isoDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export interface SearchPerformanceInput {
  startDate?: string;
  endDate?: string;
  dimensions?: string[];
  rowLimit?: number;
  startRow?: number;
}

function performanceInput(input: SearchPerformanceInput) {
  if (!isoDate(input.startDate) || !isoDate(input.endDate)) {
    throw new SearchConsoleError('search_console_date_invalid', 400, 'Use valid startDate and endDate values in YYYY-MM-DD format.');
  }
  const start = Date.parse(`${input.startDate}T00:00:00Z`);
  const end = Date.parse(`${input.endDate}T00:00:00Z`);
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (end < start || end > today || (end - start) / 86_400_000 + 1 > MAX_RANGE_DAYS) {
    throw new SearchConsoleError('search_console_date_range_invalid', 400, `Date ranges must be inclusive, no more than ${MAX_RANGE_DAYS} days, and not in the future.`);
  }
  const dimensions = input.dimensions ?? [];
  if (dimensions.length > DIMENSIONS.length || new Set(dimensions).size !== dimensions.length || dimensions.some((d) => !DIMENSIONS.includes(d as Dimension))) {
    throw new SearchConsoleError('search_console_dimensions_invalid', 400, 'Dimensions must be unique and selected from date, query, page, and device.');
  }
  const rowLimit = input.rowLimit ?? DEFAULT_ROW_LIMIT;
  const startRow = input.startRow ?? 0;
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > MAX_ROW_LIMIT || !Number.isInteger(startRow) || startRow < 0 || startRow > MAX_START_ROW) {
    throw new SearchConsoleError('search_console_pagination_invalid', 400, 'Pagination values are outside the allowed range.');
  }
  return { startDate: input.startDate, endDate: input.endDate, dimensions: dimensions as Dimension[], rowLimit, startRow };
}

const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export async function getSearchConsolePerformance(env: Env, siteId: string, input: SearchPerformanceInput) {
  const values = performanceInput(input);
  const row = await connection(env.DB, siteId);
  if (!row) throw new SearchConsoleError('search_console_not_connected', 409, 'Search Console is not connected.');
  if (!row.property_uri) throw new SearchConsoleError('search_console_property_required', 409, 'Select a Search Console property first.');
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(row.property_uri)}/searchAnalytics/query`;
  const query = (body: Record<string, unknown>) => googleRequest<GoogleSearchResponse>(env, siteId, endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startDate: values.startDate, endDate: values.endDate, type: 'web', dataState: 'final', ...body }),
  });
  const totalsResponse = await query({ rowLimit: 1 });
  const rowsResponse = values.dimensions.length
    ? await query({ dimensions: values.dimensions, rowLimit: values.rowLimit, startRow: values.startRow })
    : { rows: [] };
  const total = Array.isArray(totalsResponse.rows) ? (totalsResponse.rows[0] as GoogleRow | undefined) : undefined;
  const rawRows = Array.isArray(rowsResponse.rows) ? (rowsResponse.rows as GoogleRow[]) : [];
  const rows = rawRows.slice(0, values.rowLimit).map((result) => {
    const keys = Array.isArray(result.keys) ? result.keys : [];
    const dimensions: Partial<Record<Dimension, string>> = {};
    values.dimensions.forEach((dimension, index) => {
      if (typeof keys[index] === 'string') dimensions[dimension] = keys[index] as string;
    });
    return {
      dimensions,
      clicks: number(result.clicks),
      impressions: number(result.impressions),
      ctr: number(result.ctr),
      position: number(result.position),
    };
  });
  const incomplete = totalsResponse.metadata?.first_incomplete_date ?? rowsResponse.metadata?.first_incomplete_date;
  return {
    source: 'google-search-console' as const,
    propertyUri: row.property_uri,
    startDate: values.startDate,
    endDate: values.endDate,
    dimensions: values.dimensions,
    totals: { clicks: number(total?.clicks), impressions: number(total?.impressions), ctr: number(total?.ctr), position: number(total?.position) },
    rows,
    nextStartRow: rawRows.length === values.rowLimit ? values.startRow + values.rowLimit : null,
    incompleteFrom: typeof incomplete === 'string' ? incomplete : null,
  };
}

export function searchConsoleErrorResponse(c: Context<AppEnv>, error: unknown) {
  if (error instanceof SearchConsoleError) return c.json({ error: error.code, message: error.message }, error.status as 400);
  return c.json({ error: 'search_console_failed', message: 'Search Console request failed.' }, 500);
}

export async function searchConsoleStatus(c: Context<AppEnv>) {
  try {
    const configured = !!(c.env.GSC_GOOGLE_CLIENT_ID && c.env.GSC_GOOGLE_CLIENT_SECRET && c.env.GSC_OAUTH_REDIRECT_URI && c.env.GSC_TOKEN_ENCRYPTION_KEY);
    const row = await connection(c.env.DB, c.get('site').id);
    return c.json({
      configured,
      connected: !!row,
      property: row?.property_uri ? { propertyUri: row.property_uri, permissionLevel: row.permission_level } : null,
      connectedAt: row?.connected_at ?? null,
      updatedAt: row?.updated_at ?? null,
    });
  } catch (error) {
    return searchConsoleErrorResponse(c, error);
  }
}

export async function searchConsoleOauthStart(c: Context<AppEnv>) {
  try {
    const config = requireConfig(c.env);
    const state = await createSearchConsoleState(c.env.SESSION_SECRET, c.get('user').id, c.get('site').id);
    setCookie(c, OAUTH_COOKIE, state.cookie, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/api/integrations/search-console/oauth/callback',
      maxAge: STATE_TTL_MS / 1_000,
    });
    const query = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: GSC_SCOPE,
      state: state.state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
    });
    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
  } catch (error) {
    return searchConsoleErrorResponse(c, error);
  }
}

export async function searchConsoleOauthCallback(c: Context<AppEnv>) {
  const finish = (status: 'connected' | 'failed') => c.redirect(`/?integration=search-console&status=${status}`);
  const cookie = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: '/api/integrations/search-console/oauth/callback' });
  try {
    const config = requireConfig(c.env);
    const callbackUrl = new URL(c.req.url);
    if (`${callbackUrl.origin}${callbackUrl.pathname}` !== config.redirectUri) return finish('failed');
    const user = await currentUser(c);
    if (!user) return finish('failed');
    const state = await verifySearchConsoleState(c.env.SESSION_SECRET, cookie, c.req.query('state'), user.id);
    const code = c.req.query('code');
    if (!state || !code || c.req.query('error')) return finish('failed');
    const access = siteAccessSql(c.env, user);
    const site = await c.env.DB.prepare(`SELECT s.id FROM sites s WHERE s.id = ? AND ${access.sql}`)
      .bind(state.siteId, ...access.params)
      .first<{ id: string }>();
    if (!site) return finish('failed');
    const tokens = await tokenRequest(
      c.env,
      new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      }),
    );
    await saveTokens(c.env, state.siteId, tokens, await connection(c.env.DB, state.siteId));
    return finish('connected');
  } catch {
    return finish('failed');
  }
}

export async function searchConsoleProperties(c: Context<AppEnv>) {
  try {
    return c.json({ properties: await listSearchConsoleProperties(c.env, c.get('site').id) });
  } catch (error) {
    return searchConsoleErrorResponse(c, error);
  }
}

export async function searchConsoleSelectProperty(c: Context<AppEnv>) {
  try {
    const body: { propertyUri?: unknown } = await c.req.json<{ propertyUri?: unknown }>().catch(() => ({}));
    if (typeof body.propertyUri !== 'string') throw new SearchConsoleError('search_console_property_invalid', 400, 'Choose a valid property.');
    return c.json({ property: await selectSearchConsoleProperty(c.env, c.get('site').id, body.propertyUri) });
  } catch (error) {
    return searchConsoleErrorResponse(c, error);
  }
}

export async function searchConsolePerformance(c: Context<AppEnv>) {
  try {
    const dimensions = (c.req.query('dimensions') ?? '').split(',').filter(Boolean);
    const rowLimitValue = c.req.query('rowLimit');
    const startRowValue = c.req.query('startRow');
    return c.json(await getSearchConsolePerformance(c.env, c.get('site').id, {
      startDate: c.req.query('startDate'),
      endDate: c.req.query('endDate'),
      dimensions,
      rowLimit: rowLimitValue === undefined ? undefined : Number(rowLimitValue),
      startRow: startRowValue === undefined ? undefined : Number(startRowValue),
    }));
  } catch (error) {
    return searchConsoleErrorResponse(c, error);
  }
}

export async function searchConsoleDisconnect(c: Context<AppEnv>) {
  await c.env.DB.prepare('DELETE FROM search_console_connections WHERE site_id = ?').bind(c.get('site').id).run();
  return c.json({ ok: true });
}
