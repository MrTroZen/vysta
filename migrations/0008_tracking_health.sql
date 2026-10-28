-- Bounded, site-scoped diagnostics for owner-facing tracking health.
CREATE TABLE site_tracking_health (
  site_id TEXT PRIMARY KEY,
  last_browser_request_at INTEGER,
  last_browser_event_at INTEGER,
  last_browser_event_type TEXT,
  last_browser_hostname TEXT,
  last_tracker_version TEXT,
  last_server_goal_request_at INTEGER,
  last_server_goal_event_at INTEGER,
  last_server_goal_name TEXT,
  last_warning_at INTEGER,
  last_warning_source TEXT,
  last_warning_reason TEXT
);

CREATE TABLE tracking_health_hourly (
  site_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  source TEXT NOT NULL,
  outcome TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, hour, source, outcome, event_type, reason)
);
CREATE INDEX tracking_health_hourly_retention ON tracking_health_hourly (hour);
CREATE INDEX tracking_health_hourly_site_time ON tracking_health_hourly (site_id, hour);
