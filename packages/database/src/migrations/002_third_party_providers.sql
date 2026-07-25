CREATE TABLE IF NOT EXISTS third_party_provider_configs (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT,
  quota_endpoint TEXT,
  api_key_env TEXT,
  protocol TEXT NOT NULL DEFAULT 'unknown',
  enabled INTEGER NOT NULL DEFAULT 0,
  refresh_interval_minutes INTEGER NOT NULL DEFAULT 15,
  endpoint_verified INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_quota_snapshots (
  provider_id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  FOREIGN KEY(provider_id) REFERENCES third_party_provider_configs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_provider_quota_observed_at ON provider_quota_snapshots(observed_at);
