export const TRACKING_HEALTH_RETENTION_HOURS = 30 * 24;
const HOUR_MS = 60 * 60_000;

export type HealthSource = 'browser' | 'server_goal';
export type HealthOutcome = 'accepted' | 'duplicate' | 'warning';

export type BrowserWarningReason =
  | 'inactive_plan'
  | 'invalid_domain'
  | 'invalid_event'
  | 'invalid_goal'
  | 'invalid_url'
  | 'session_mismatch';

export type ServerGoalWarningReason =
  | 'idempotency_conflict'
  | 'invalid_idempotency_key'
  | 'invalid_request'
  | 'receipt_failed'
  | 'session_mismatch'
  | 'session_not_found';

type Condition = { sql: string; args: unknown[] };

export type HealthObservation = {
  siteId: string;
  at: number;
  source: HealthSource;
  outcome: HealthOutcome;
  eventType?: string | null;
  reason?: string | null;
  hostname?: string | null;
  trackerVersion?: string | null;
  goalName?: string | null;
};

export type HealthWarning = { code: string; count: number; lastAt: number };

export type TrackingHealth = {
  retentionDays: 30;
  browser: {
    lastRequestAt: number | null;
    lastEventAt: number | null;
    lastEventType: string | null;
    lastHostname: string | null;
    lastTrackerVersion: string | null;
    requests24h: number;
    analyticsEvents24h: number;
    pageviews24h: number;
    goals24h: number;
    outbound24h: number;
    pings24h: number;
    identifies24h: number;
    duplicates24h: number;
    warnings24h: number;
    warningReasons: HealthWarning[];
  };
  serverGoals: {
    lastRequestAt: number | null;
    lastEventAt: number | null;
    lastGoalName: string | null;
    requests24h: number;
    recorded24h: number;
    duplicates24h: number;
    warnings24h: number;
    warningReasons: HealthWarning[];
  };
};

export function trackingHealthHour(at: number) {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/** Oldest hour retained when the current hour is included in the 720-bucket window. */
export function trackingHealthCutoff(now: number) {
  return trackingHealthHour(now) - (TRACKING_HEALTH_RETENTION_HOURS - 1) * HOUR_MS;
}

function summaryStatement(db: D1Database, observation: HealthObservation, condition?: Condition) {
  const isBrowser = observation.source === 'browser';
  const isAcceptedEvent = isBrowser && observation.outcome === 'accepted' && ['pageview', 'goal', 'outbound'].includes(observation.eventType ?? '');
  const isServerEvent = observation.source === 'server_goal' && observation.outcome === 'accepted';
  const isWarning = observation.outcome === 'warning';
  const where = ` WHERE ${condition?.sql ?? '1'}`;
  return db
    .prepare(
      `INSERT INTO site_tracking_health
       (site_id, last_browser_request_at, last_browser_event_at, last_browser_event_type, last_browser_hostname,
        last_tracker_version, last_server_goal_request_at, last_server_goal_event_at, last_server_goal_name,
        last_warning_at, last_warning_source, last_warning_reason)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${where}
       ON CONFLICT(site_id) DO UPDATE SET
         last_browser_request_at = COALESCE(excluded.last_browser_request_at, last_browser_request_at),
         last_browser_event_at = COALESCE(excluded.last_browser_event_at, last_browser_event_at),
         last_browser_event_type = COALESCE(excluded.last_browser_event_type, last_browser_event_type),
         last_browser_hostname = COALESCE(excluded.last_browser_hostname, last_browser_hostname),
         last_tracker_version = COALESCE(excluded.last_tracker_version, last_tracker_version),
         last_server_goal_request_at = COALESCE(excluded.last_server_goal_request_at, last_server_goal_request_at),
         last_server_goal_event_at = COALESCE(excluded.last_server_goal_event_at, last_server_goal_event_at),
         last_server_goal_name = COALESCE(excluded.last_server_goal_name, last_server_goal_name),
         last_warning_at = COALESCE(excluded.last_warning_at, last_warning_at),
         last_warning_source = COALESCE(excluded.last_warning_source, last_warning_source),
         last_warning_reason = COALESCE(excluded.last_warning_reason, last_warning_reason)`,
    )
    .bind(
      observation.siteId,
      isBrowser ? observation.at : null,
      isAcceptedEvent ? observation.at : null,
      isAcceptedEvent ? observation.eventType : null,
      isBrowser ? observation.hostname ?? null : null,
      isBrowser ? observation.trackerVersion ?? null : null,
      !isBrowser ? observation.at : null,
      isServerEvent ? observation.at : null,
      isServerEvent ? observation.goalName ?? null : null,
      isWarning ? observation.at : null,
      isWarning ? observation.source : null,
      isWarning ? observation.reason ?? null : null,
      ...(condition?.args ?? []),
    );
}

function hourlyStatement(db: D1Database, observation: HealthObservation, condition?: Condition) {
  const where = ` WHERE ${condition?.sql ?? '1'}`;
  return db
    .prepare(
      `INSERT INTO tracking_health_hourly (site_id, hour, source, outcome, event_type, reason, count, last_at)
       SELECT ?, ?, ?, ?, ?, ?, 1, ?${where}
       ON CONFLICT(site_id, hour, source, outcome, event_type, reason) DO UPDATE SET
         count = count + 1, last_at = MAX(last_at, excluded.last_at)`,
    )
    .bind(
      observation.siteId,
      trackingHealthHour(observation.at),
      observation.source,
      observation.outcome,
      observation.eventType ?? '',
      observation.reason ?? '',
      observation.at,
      ...(condition?.args ?? []),
    );
}

export function trackingHealthStatements(db: D1Database, observation: HealthObservation, condition?: Condition) {
  return [summaryStatement(db, observation, condition), hourlyStatement(db, observation, condition)];
}

export async function recordTrackingHealth(db: D1Database, observation: HealthObservation) {
  await db.batch(trackingHealthStatements(db, observation));
}

export async function recordBrowserWarning(
  db: D1Database,
  siteId: string,
  at: number,
  eventType: string,
  reason: BrowserWarningReason,
  trackerVersion?: string | null,
) {
  await recordTrackingHealth(db, { siteId, at, source: 'browser', outcome: 'warning', eventType, reason, trackerVersion });
}

export async function recordServerGoal(
  db: D1Database,
  siteId: string,
  at: number,
  outcome: HealthOutcome,
  goalName?: string | null,
  reason?: ServerGoalWarningReason,
) {
  await recordTrackingHealth(db, { siteId, at, source: 'server_goal', outcome, eventType: 'goal', goalName, reason });
}

export async function pruneTrackingHealth(db: D1Database, now = Date.now()) {
  return db.prepare('DELETE FROM tracking_health_hourly WHERE hour < ?').bind(trackingHealthCutoff(now)).run();
}

type HealthSummaryRow = {
  last_browser_request_at: number | null;
  last_browser_event_at: number | null;
  last_browser_event_type: string | null;
  last_browser_hostname: string | null;
  last_tracker_version: string | null;
  last_server_goal_request_at: number | null;
  last_server_goal_event_at: number | null;
  last_server_goal_name: string | null;
};

type AggregateRow = {
  source: HealthSource;
  outcome: HealthOutcome;
  event_type: string;
  reason: string;
  count: number;
  last_at: number;
};

function count(rows: AggregateRow[], source: HealthSource, outcome?: HealthOutcome, eventType?: string) {
  return rows
    .filter((row) => row.source === source && (!outcome || row.outcome === outcome) && (!eventType || row.event_type === eventType))
    .reduce((sum, row) => sum + Number(row.count), 0);
}

function warnings(rows: AggregateRow[], source: HealthSource): HealthWarning[] {
  return rows
    .filter((row) => row.source === source && row.outcome === 'warning' && row.reason)
    .map((row) => ({ code: row.reason, count: Number(row.count), lastAt: Number(row.last_at) }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

export async function getTrackingHealth(db: D1Database, siteId: string, now = Date.now()): Promise<TrackingHealth> {
  const [summary, aggregate] = await Promise.all([
    db.prepare('SELECT * FROM site_tracking_health WHERE site_id = ?').bind(siteId).first<HealthSummaryRow>(),
    db
      .prepare(
        `SELECT source, outcome, event_type, reason, SUM(count) AS count, MAX(last_at) AS last_at
         FROM tracking_health_hourly WHERE site_id = ? AND hour >= ?
         GROUP BY source, outcome, event_type, reason`,
      )
      .bind(siteId, trackingHealthHour(now) - 23 * HOUR_MS)
      .all<AggregateRow>(),
  ]);
  const rows = aggregate.results;
  const browserWarnings = warnings(rows, 'browser');
  const serverWarnings = warnings(rows, 'server_goal');
  const pageviews = count(rows, 'browser', 'accepted', 'pageview');
  const goals = count(rows, 'browser', 'accepted', 'goal');
  const outbound = count(rows, 'browser', 'accepted', 'outbound');
  return {
    retentionDays: 30,
    browser: {
      lastRequestAt: summary?.last_browser_request_at ?? null,
      lastEventAt: summary?.last_browser_event_at ?? null,
      lastEventType: summary?.last_browser_event_type ?? null,
      lastHostname: summary?.last_browser_hostname ?? null,
      lastTrackerVersion: summary?.last_tracker_version ?? null,
      requests24h: count(rows, 'browser'),
      analyticsEvents24h: pageviews + goals + outbound,
      pageviews24h: pageviews,
      goals24h: goals,
      outbound24h: outbound,
      pings24h: count(rows, 'browser', 'accepted', 'ping'),
      identifies24h: count(rows, 'browser', 'accepted', 'identify'),
      duplicates24h: count(rows, 'browser', 'duplicate'),
      warnings24h: browserWarnings.reduce((sum, warning) => sum + warning.count, 0),
      warningReasons: browserWarnings,
    },
    serverGoals: {
      lastRequestAt: summary?.last_server_goal_request_at ?? null,
      lastEventAt: summary?.last_server_goal_event_at ?? null,
      lastGoalName: summary?.last_server_goal_name ?? null,
      requests24h: count(rows, 'server_goal'),
      recorded24h: count(rows, 'server_goal', 'accepted'),
      duplicates24h: count(rows, 'server_goal', 'duplicate'),
      warnings24h: serverWarnings.reduce((sum, warning) => sum + warning.count, 0),
      warningReasons: serverWarnings,
    },
  };
}
