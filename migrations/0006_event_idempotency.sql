-- Browser event receipts make retries and replays idempotent within each site.
CREATE TABLE ingestion_receipts (
  site_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processing_token TEXT NOT NULL,
  first_received_at INTEGER NOT NULL,
  last_received_at INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  tracker_version TEXT,
  PRIMARY KEY (site_id, event_id)
);
CREATE INDEX ingestion_receipts_site_time ON ingestion_receipts (site_id, first_received_at);

ALTER TABLE events ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX events_site_event_id ON events (site_id, event_id) WHERE event_id IS NOT NULL;
