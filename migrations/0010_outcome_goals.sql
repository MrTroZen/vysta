-- Owner-configured, page-based confirmed outcomes.
CREATE TABLE outcome_goal_rules (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'starts_with')),
  path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (site_id, id)
);
CREATE INDEX outcome_goal_rules_site ON outcome_goal_rules (site_id, deleted_at, created_at);
CREATE UNIQUE INDEX outcome_goal_rules_unique_active_match
  ON outcome_goal_rules (site_id, match_type, path) WHERE deleted_at IS NULL;

-- One configured outcome is recorded at most once in a visit.
CREATE TABLE outcome_goal_receipts (
  site_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  processing_token TEXT NOT NULL,
  first_matched_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, session_id, rule_id)
);
CREATE INDEX outcome_goal_receipts_site_time ON outcome_goal_receipts (site_id, first_matched_at);
