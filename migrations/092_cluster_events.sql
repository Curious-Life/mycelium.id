-- Cluster growth events — tracks formation, growth, splits, merges, and dissolution
-- of semantic clusters across clustering rebuilds.

CREATE TABLE IF NOT EXISTS cluster_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  cluster_version TEXT NOT NULL,
  level TEXT NOT NULL,                  -- 'atom' | 'territory' | 'theme' | 'realm'
  event_type TEXT NOT NULL,             -- 'formed' | 'grew' | 'split' | 'merged' | 'dissolved' | 'stable'
  cluster_id INTEGER,                   -- new cluster ID (null if dissolved)
  old_cluster_ids TEXT,                 -- JSON array of predecessor IDs
  new_cluster_ids TEXT,                 -- JSON array of successor IDs (for splits)
  jaccard_score REAL,                   -- overlap with best-matching predecessor
  point_count INTEGER,                  -- points in this cluster
  point_delta INTEGER,                  -- change from previous version
  sample_tags TEXT,                     -- JSON: top tags in this cluster
  sample_entities TEXT,                 -- JSON: top entities
  description TEXT,                     -- human-readable event description
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ce_user_version ON cluster_events(user_id, cluster_version);
CREATE INDEX IF NOT EXISTS idx_ce_level_type ON cluster_events(level, event_type);
CREATE INDEX IF NOT EXISTS idx_ce_user_level ON cluster_events(user_id, level, created_at);
