CREATE TABLE IF NOT EXISTS personnel (
  id TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  authorization_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_personnel_name_id
  ON personnel(name COLLATE NOCASE, id COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  window_started INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0
);