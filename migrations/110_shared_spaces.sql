-- Shared spaces: side-by-side territory comparison between connected users
CREATE TABLE IF NOT EXISTS shared_spaces (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  settings_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shared_spaces_conn ON shared_spaces(connection_id);
