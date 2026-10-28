import type { Context } from 'hono';
import { classify } from '../shared/sources';
import { isAutomaticActionName } from '../shared/actions';
import { isOutcomeEventName } from '../shared/outcomeGoals';
import { siteOwnerActive } from './auth';
import { getSite, type AppEnv, type Site } from './env';
import { isBot, parseUA } from './lib/ua';
import { creditedSessionSql } from './payments';
import { enabledOutcomeGoals, outcomeStatements } from './outcomeGoals';
import { recordBrowserWarning, trackingHealthStatements } from './trackingHealth';

const TYPES = new Set(['pageview', 'goal', 'outbound', 'ping', 'identify']);
const MAX_PING_MS = 10 * 60_000;

interface Payload {
  w: string;
  t: string;
  u: string;
  r?: string;
  vid: string;
  sid: string;
  sw?: number;
  n?: string;
  p?: Record<string, unknown>;
  d?: number;
  eid?: string;
  tv?: string;
}

const clip = (s: unknown, n = 255): string | null =>
  typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null;

const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

interface EventGate {
  eventId: string;
  processingToken: string;
  trackerVersion: string | null;
}

const RECEIPT_PREDICATE =
  'EXISTS (SELECT 1 FROM ingestion_receipts ir WHERE ir.site_id = ? AND ir.event_id = ? AND ir.processing_token = ?)';

function gateFor(body: Payload): EventGate | null {
  if (!body.eid) return null;
  return { eventId: body.eid, processingToken: crypto.randomUUID(), trackerVersion: clip(body.tv, 32) };
}

function gateArgs(siteId: string, gate: EventGate): unknown[] {
  return [siteId, gate.eventId, gate.processingToken];
}

function startReceipt(db: D1Database, siteId: string, type: string, gate: EventGate, now: number) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO ingestion_receipts
       (site_id, event_id, event_type, processing_token, first_received_at, last_received_at, tracker_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(siteId, gate.eventId, type, gate.processingToken, now, now, gate.trackerVersion);
}

function finishReceipt(db: D1Database, siteId: string, gate: EventGate, now: number) {
  return db
    .prepare(
      `UPDATE ingestion_receipts
       SET last_received_at = ?, duplicate_count = duplicate_count + CASE WHEN processing_token = ? THEN 0 ELSE 1 END
       WHERE site_id = ? AND event_id = ?`,
    )
    .bind(now, gate.processingToken, siteId, gate.eventId);
}

function gatedUpdate(
  db: D1Database,
  sql: string,
  params: unknown[],
  siteId: string,
  gate: EventGate | null,
) {
  if (!gate) return db.prepare(sql).bind(...params);
  return db.prepare(`${sql} AND ${RECEIPT_PREDICATE}`).bind(...params, ...gateArgs(siteId, gate));
}

export function normalizePath(pathname: string): string {
  let p = pathname || '/';
  try {
    p = decodeURI(p);
  } catch {}
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.slice(0, 500);
}

function stripWww(h: string) {
  return h.replace(/^www\./, '').toLowerCase();
}

/** Is `hostname` the site's domain or one of its subdomains? */
export function belongsTo(hostname: string, domain: string): boolean {
  const h = stripWww(hostname);
  const d = stripWww(domain);
  return h === d || h.endsWith('.' + d);
}

export async function handleEvent(c: Context<AppEnv>) {
  const raw = await c.req.text();
  if (raw.length > 8192) return c.body(null, 413);
  let body: Payload;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.body(null, 400);
  }
  if (
    !body ||
    !isId(body.w) ||
    !TYPES.has(body.t) ||
    !isId(body.vid) ||
    !isId(body.sid) ||
    (body.eid !== undefined && !isId(body.eid))
  )
    return c.body(null, 400);

  const ua = c.req.header('user-agent') ?? '';
  if (isBot(ua)) return c.body(null, 202);

  const site = await getSite(c.env.DB, body.w);
  if (!site) return c.body(null, 404);
  const now = Date.now();
  // Hosted mode: stop recording when the owner's plan has ended (quietly, so their site never shows errors).
  if (!siteOwnerActive(c.env, site)) {
    await recordBrowserWarning(c.env.DB, site.id, now, body.t, 'inactive_plan', clip(body.tv, 32));
    return c.body(null, 202);
  }

  let url: URL;
  try {
    url = new URL(body.u);
  } catch {
    await recordBrowserWarning(c.env.DB, site.id, now, body.t, 'invalid_url', clip(body.tv, 32));
    return c.body(null, 400);
  }
  // Only accept data for the site's own domain, so nobody can pollute your stats from elsewhere.
  if (!belongsTo(url.hostname, site.domain)) {
    await recordBrowserWarning(c.env.DB, site.id, now, body.t, 'invalid_domain', clip(body.tv, 32));
    return c.body(null, 403);
  }

  await ingest(c.env.DB, site, body, url, ua, geoOf(c), now);
  return c.body(null, 202);
}

export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

/** City-level coordinates, rounded to 2 decimals (~1 km) so no precise location is ever stored. */
function coord(v: unknown, max: number): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && Math.abs(n) <= max ? Math.round(n * 100) / 100 : null;
}

/**
 * Visitor location. When the script is proxied through your own domain (to dodge ad blockers),
 * Cloudflare sees the proxy's location, so trust the proxy's geo headers when present (Vercel sets these).
 */
function geoOf(c: Context<AppEnv>): Geo {
  const h = (n: string) => {
    const v = c.req.header(n);
    try {
      return v ? decodeURIComponent(v) : null;
    } catch {
      return v ?? null;
    }
  };
  if (h('x-vercel-ip-country')) {
    return {
      country: h('x-vercel-ip-country'),
      region: h('x-vercel-ip-country-region'),
      city: h('x-vercel-ip-city'),
      lat: coord(h('x-vercel-ip-latitude'), 90),
      lon: coord(h('x-vercel-ip-longitude'), 180),
    };
  }
  const cf = (c.req.raw as { cf?: IncomingRequestCfProperties }).cf;
  return {
    country: (cf?.country as string) ?? null,
    region: (cf?.region as string) ?? null,
    city: (cf?.city as string) ?? null,
    lat: coord(cf?.latitude, 90),
    lon: coord(cf?.longitude, 180),
  };
}

export async function ingest(
  db: D1Database,
  site: Site,
  body: Payload,
  url: URL,
  ua: string,
  geo: Geo,
  now: number,
) {
  const path = normalizePath(url.pathname);
  const { t, vid, sid } = body;
  const gate = gateFor(body);
  const health = (outcome: 'accepted' | 'duplicate', condition?: { sql: string; args: unknown[] }) =>
    trackingHealthStatements(
      db,
      {
        siteId: site.id,
        at: now,
        source: 'browser',
        outcome,
        eventType: t,
        hostname: url.hostname.toLowerCase(),
        trackerVersion: clip(body.tv, 32),
      },
      condition,
    );
  const acceptedHealth = gate
    ? health('accepted', { sql: RECEIPT_PREDICATE, args: gateArgs(site.id, gate) })
    : health('accepted');
  const duplicateHealth = gate
    ? health('duplicate', { sql: `NOT ${RECEIPT_PREDICATE}`, args: gateArgs(site.id, gate) })
    : [];

  if (t === 'ping') {
    const ms = Math.max(0, Math.min(MAX_PING_MS, Math.round(Number(body.d) || 0)));
    if (gate) {
      await db.batch([
        startReceipt(db, site.id, t, gate, now),
        gatedUpdate(
          db,
          'UPDATE sessions SET duration = MIN(duration + ?, 86400000), last_seen_at = ? WHERE site_id = ? AND id = ? AND visitor_id = ?',
          [ms, now, site.id, sid, vid],
          site.id,
          gate,
        ),
        ...acceptedHealth,
        ...duplicateHealth,
        finishReceipt(db, site.id, gate, now),
      ]);
      return;
    }
    await db.batch([
      db
        .prepare('UPDATE sessions SET duration = MIN(duration + ?, 86400000), last_seen_at = ? WHERE site_id = ? AND id = ? AND visitor_id = ?')
        .bind(ms, now, site.id, sid, vid),
      ...acceptedHealth,
    ]);
    return;
  }

  if (t === 'identify') {
    const p = body.p ?? {};
    const insert = gate
      ? db
          .prepare(
            `INSERT OR IGNORE INTO visitors (site_id, id, first_seen)
             SELECT ?, ?, ? WHERE ${RECEIPT_PREDICATE}`,
          )
          .bind(site.id, vid, now, ...gateArgs(site.id, gate))
      : db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, vid, now);
    const update = gatedUpdate(
      db,
      'UPDATE visitors SET user_id = COALESCE(?, user_id), email = COALESCE(?, email), name = COALESCE(?, name) WHERE site_id = ? AND id = ?',
      [clip(p.user_id, 128), clip(p.email, 200)?.toLowerCase() ?? null, clip(p.name, 128), site.id, vid],
      site.id,
      gate,
    );
    await db.batch(
      gate
        ? [startReceipt(db, site.id, t, gate, now), insert, update, ...acceptedHealth, ...duplicateHealth, finishReceipt(db, site.id, gate, now)]
        : [insert, update, ...acceptedHealth],
    );
    return;
  }

  const existing = await db
    .prepare('SELECT visitor_id FROM sessions WHERE site_id = ? AND id = ?')
    .bind(site.id, sid)
    .first<{ visitor_id: string }>();

  // Prevent session hijacking: reject events if the session was created by a different visitor.
  if (existing && existing.visitor_id !== vid) {
    await recordBrowserWarning(db, site.id, now, t, 'session_mismatch', clip(body.tv, 32));
    return;
  }

  const stmts: D1PreparedStatement[] = gate ? [startReceipt(db, site.id, t, gate, now)] : [];
  const outcomeRules = t === 'pageview' ? await enabledOutcomeGoals(db, site.id) : [];
  if (!existing) {
    stmts.push(...newSession(db, site, body, url, path, ua, geo, now, gate));
  }

  if (t === 'pageview') {
    if (existing) {
      stmts.push(
        gatedUpdate(
          db,
          'UPDATE sessions SET pageviews = pageviews + 1, exit_page = ?, last_seen_at = ? WHERE site_id = ? AND id = ?',
          [path, now, site.id, sid],
          site.id,
          gate,
        ),
      );
    }
    stmts.push(insertEvent(db, site.id, sid, vid, now, 'pageview', null, path, null, gate));
    stmts.push(...claimPayment(db, site.id, vid, url, now, gate));
    stmts.push(...outcomeStatements(db, site.id, sid, vid, path, now, outcomeRules));
  } else if (t === 'goal') {
    const name = clip(body.n, 64);
    if (!name || isOutcomeEventName(name)) {
      await recordBrowserWarning(db, site.id, now, t, 'invalid_goal', clip(body.tv, 32));
      return;
    }
    // Reserved automatic actions never persist properties, even if a modified client sends them.
    const props = !isAutomaticActionName(name) && body.p && typeof body.p === 'object' ? JSON.stringify(body.p).slice(0, 1000) : null;
    stmts.push(
      gatedUpdate(
        db,
        'UPDATE sessions SET goals = goals + 1, last_seen_at = ? WHERE site_id = ? AND id = ?',
        [now, site.id, sid],
        site.id,
        gate,
      ),
      insertEvent(db, site.id, sid, vid, now, 'goal', name, path, props, gate),
    );
  } else if (t === 'outbound') {
    const target = clip(body.n, 500);
    if (!target) {
      await recordBrowserWarning(db, site.id, now, t, 'invalid_event', clip(body.tv, 32));
      return;
    }
    stmts.push(
      gatedUpdate(
        db,
        'UPDATE sessions SET last_seen_at = ? WHERE site_id = ? AND id = ?',
        [now, site.id, sid],
        site.id,
        gate,
      ),
      insertEvent(db, site.id, sid, vid, now, 'outbound', target, path, null, gate),
    );
  }
  stmts.push(...acceptedHealth, ...duplicateHealth);
  if (gate) stmts.push(finishReceipt(db, site.id, gate, now));
  await db.batch(stmts);
}

/**
 * Dodo sends buyers back to your return URL with ?payment_id=pay_... . Seeing that on a pageview tells us
 * exactly which visitor made the payment, even when the checkout had no metadata.
 */
function claimPayment(
  db: D1Database,
  siteId: string,
  vid: string,
  url: URL,
  now: number,
  gate: EventGate | null,
): D1PreparedStatement[] {
  const paymentId = url.searchParams.get('payment_id') ?? url.searchParams.get('subscription_id');
  if (!paymentId || !/^(pay|sub)_[\w-]{4,64}$/.test(paymentId)) return [];
  const claim = gate
    ? db
        .prepare(
          `INSERT OR IGNORE INTO payment_claims (site_id, payment_id, visitor_id, ts)
           SELECT ?, ?, ?, ? WHERE ${RECEIPT_PREDICATE}`,
        )
        .bind(siteId, paymentId, vid, now, ...gateArgs(siteId, gate))
    : db
        .prepare('INSERT OR IGNORE INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, ?, ?, ?)')
        .bind(siteId, paymentId, vid, now);
  return [
    claim,
    // The webhook usually arrives first; link that payment now if nothing else already did.
    gatedUpdate(
      db,
      `UPDATE payments SET visitor_id = ?, matched_by = 'return_page',
           session_id = (${creditedSessionSql()})
         WHERE site_id = ? AND (id = ? OR subscription_id = ?) AND visitor_id IS NULL`,
      [vid, siteId, vid, now + 60_000, siteId, paymentId, paymentId],
      siteId,
      gate,
    ),
    gatedUpdate(
      db,
      `UPDATE visitors SET email = COALESCE(email, (SELECT email FROM payments WHERE site_id = ? AND (id = ? OR subscription_id = ?) LIMIT 1)),
           name = COALESCE(name, (SELECT name FROM payments WHERE site_id = ? AND (id = ? OR subscription_id = ?) LIMIT 1))
         WHERE site_id = ? AND id = ?`,
      [siteId, paymentId, paymentId, siteId, paymentId, paymentId, siteId, vid],
      siteId,
      gate,
    ),
  ];
}

function insertEvent(
  db: D1Database,
  siteId: string,
  sid: string,
  vid: string,
  ts: number,
  type: string,
  name: string | null,
  path: string,
  props: string | null,
  gate: EventGate | null,
) {
  if (gate) {
    return db
      .prepare(
        `INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props, event_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${RECEIPT_PREDICATE}`,
      )
      .bind(siteId, sid, vid, ts, type, name, path, props, gate.eventId, ...gateArgs(siteId, gate));
  }
  return db
    .prepare('INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(siteId, sid, vid, ts, type, name, path, props);
}

function newSession(
  db: D1Database,
  site: Site,
  body: Payload,
  url: URL,
  path: string,
  ua: string,
  geo: Geo,
  now: number,
  gate: EventGate | null,
): D1PreparedStatement[] {
  let referrer: string | null = null;
  let referrerDomain: string | null = null;
  if (body.r) {
    try {
      const r = new URL(body.r);
      // Navigation between your own pages/subdomains is not a referral.
      if (/^https?:$/.test(r.protocol) && !belongsTo(r.hostname, site.domain)) {
        referrerDomain = stripWww(r.hostname);
        referrer = (r.hostname + normalizePath(r.pathname)).slice(0, 500);
      }
    } catch {
      // android-app://com.google.android.gm and friends
      const m = /^android-app:\/\/([\w.]+)/.exec(body.r);
      if (m) referrerDomain = m[1];
    }
  }
  const q = url.searchParams;
  const utm = {
    source: clip(q.get('utm_source'), 100),
    medium: clip(q.get('utm_medium'), 100),
    campaign: clip(q.get('utm_campaign'), 200),
    term: clip(q.get('utm_term'), 200),
    content: clip(q.get('utm_content'), 200),
  };
  const ref = clip(q.get('ref') ?? q.get('via'), 100);
  const { source, channel } = classify({ referrerDomain, utmSource: utm.source, utmMedium: utm.medium, ref });
  const { browser, os, device } = parseUA(ua, Number(body.sw) || undefined);
  const pageviews = body.t === 'pageview' ? 1 : 0;

  const visitor = gate
    ? db
        .prepare(
          `INSERT OR IGNORE INTO visitors (site_id, id, first_seen)
           SELECT ?, ?, ? WHERE ${RECEIPT_PREDICATE}`,
        )
        .bind(site.id, body.vid, now, ...gateArgs(site.id, gate))
    : db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, body.vid, now);
  const sessionSql = gate
    ? `INSERT OR IGNORE INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, entry_page, exit_page,
          referrer, referrer_domain, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref,
          country, region, city, browser, os, device, lat, lon)
       SELECT ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${RECEIPT_PREDICATE}`
    : `INSERT OR IGNORE INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, entry_page, exit_page,
          referrer, referrer_domain, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref,
          country, region, city, browser, os, device, lat, lon)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const sessionArgs = [
    site.id,
    body.sid,
    body.vid,
    now,
    now,
    stripWww(url.hostname),
    path,
    path,
    referrer,
    referrerDomain,
    source,
    channel,
    utm.source,
    utm.medium,
    utm.campaign,
    utm.term,
    utm.content,
    ref,
    geo.country,
    geo.region,
    geo.city,
    browser,
    os,
    device,
    geo.lat,
    geo.lon,
  ];
  const session = db
    .prepare(sessionSql)
    .bind(...sessionArgs, ...(gate ? gateArgs(site.id, gate) : []));

  return [
    visitor,
    session,
    // Separate statement so concurrent first events (pageview + goal racing) never double count.
    ...(pageviews
      ? [
          gatedUpdate(
            db,
            'UPDATE sessions SET pageviews = pageviews + 1 WHERE site_id = ? AND id = ?',
            [site.id, body.sid],
            site.id,
            gate,
          ),
        ]
      : []),
  ];
}
