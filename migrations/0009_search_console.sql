CREATE TABLE search_console_connections (
  site_id TEXT PRIMARY KEY,
  property_uri TEXT,
  permission_level TEXT,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  access_token_expires_at INTEGER NOT NULL,
  granted_scope TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
