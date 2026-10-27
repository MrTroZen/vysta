-- Durable, site-scoped receipts make authoritative server-side goals safe to retry.
CREATE TABLE server_goal_receipts (
  site_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  processing_token TEXT NOT NULL,
  session_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  goal_name TEXT NOT NULL,
  first_received_at INTEGER NOT NULL,
  last_received_at INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, idempotency_key)
);
CREATE INDEX server_goal_receipts_site_time ON server_goal_receipts (site_id, first_received_at);
