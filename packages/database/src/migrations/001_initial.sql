PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  installed INTEGER NOT NULL DEFAULT 0,
  version TEXT,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT,
  path TEXT NOT NULL,
  git_remote TEXT,
  git_branch TEXT,
  repository_name TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  project_id TEXT,
  model TEXT,
  process_id INTEGER,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  status TEXT NOT NULL,
  accuracy TEXT NOT NULL DEFAULT 'unavailable',
  is_demo INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS token_usage_events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  accuracy TEXT NOT NULL,
  session_id TEXT,
  project_id TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL,
  currency TEXT,
  estimation_method TEXT,
  timestamp TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS collector_sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  path_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  last_offset INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS model_pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model_pattern TEXT NOT NULL,
  input_per_million REAL NOT NULL,
  output_per_million REAL NOT NULL,
  cache_read_per_million REAL,
  cache_write_per_million REAL,
  effective_from TEXT NOT NULL,
  source_url TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ignored_projects (
  project_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS aliases (
  project_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON token_usage_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON token_usage_events(provider);
CREATE INDEX IF NOT EXISTS idx_usage_project ON token_usage_events(project_id);
CREATE INDEX IF NOT EXISTS idx_usage_session ON token_usage_events(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_demo ON projects(is_demo);
