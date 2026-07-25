CREATE TABLE IF NOT EXISTS nxtcodex_quota_history (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'nxtcodex',
  key_id TEXT,
  status TEXT NOT NULL,
  total INTEGER,
  used INTEGER,
  remaining INTEGER,
  unit TEXT NOT NULL,
  reset_at TEXT,
  seconds_until_reset INTEGER,
  checked_at TEXT NOT NULL,
  source TEXT NOT NULL,
  raw_headers_json TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_nxtcodex_quota_checked_at ON nxtcodex_quota_history(checked_at);
