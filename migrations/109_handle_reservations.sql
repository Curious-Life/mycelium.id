-- Global handle uniqueness enforcement (owner D1 only)
CREATE TABLE IF NOT EXISTS handle_reservations (
  handle TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reserved_at TEXT DEFAULT (datetime('now'))
);

-- Deployment audit trail
CREATE TABLE IF NOT EXISTS deployment_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  handle TEXT,
  vps_ip TEXT,
  commit_sha TEXT,
  file_hashes TEXT,
  status TEXT,
  error TEXT,
  deployed_at TEXT DEFAULT (datetime('now'))
);
