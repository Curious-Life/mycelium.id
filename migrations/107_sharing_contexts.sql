-- Sharing contexts: named groups of territories with per-connection access grants
-- Enables multi-faceted identity sharing (Work Self, Social Self, Creative Self, Private Self)

CREATE TABLE IF NOT EXISTS sharing_contexts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_private INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_sharing_contexts_user ON sharing_contexts(user_id);

CREATE TABLE IF NOT EXISTS context_territories (
  context_id TEXT NOT NULL,
  territory_id INTEGER NOT NULL,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (context_id, territory_id),
  FOREIGN KEY (context_id) REFERENCES sharing_contexts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS context_grants (
  context_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  granted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (context_id, connection_id),
  FOREIGN KEY (context_id) REFERENCES sharing_contexts(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_context_grants_conn ON context_grants(connection_id);
