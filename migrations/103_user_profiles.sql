-- User profiles for social sharing
-- Cognitive fingerprint stats as columns for queryability
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  handle TEXT UNIQUE,
  display_name TEXT,
  signature TEXT,
  depth_score REAL,
  breadth_score REAL,
  coherence_score REAL,
  exploration_score REAL,
  territory_count INTEGER DEFAULT 0,
  realm_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  member_since TEXT,
  public_realms_json TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
