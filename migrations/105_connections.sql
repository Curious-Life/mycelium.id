-- Connections between users for social sharing
-- Canonical ordering: user_a = min(from, to), user_b = max(from, to)
-- Single row per pair, initiated_by tracks who sent the request
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  overlap_json TEXT,
  overlap_computed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  UNIQUE(user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_connections_a ON connections(user_a, status);
CREATE INDEX IF NOT EXISTS idx_connections_b ON connections(user_b, status);
