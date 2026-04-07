-- Discovery tables — applied to SEPARATE mycelium-discovery D1 database only
-- Physical isolation from main data (privacy by design)
-- Contains only DP-noised data, LSH hashes, and opt-in settings

CREATE TABLE IF NOT EXISTS discovery_profiles (
  user_id TEXT PRIMARY KEY,
  instance_url TEXT NOT NULL,
  handle TEXT NOT NULL,
  opted_in INTEGER DEFAULT 0,
  centroid_sharing INTEGER DEFAULT 0,
  visibility TEXT DEFAULT 'anyone',
  label_set_json TEXT,
  stats_vector TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_disc_opted ON discovery_profiles(opted_in);

CREATE TABLE IF NOT EXISTS discovery_centroids (
  user_id TEXT NOT NULL,
  territory_id TEXT NOT NULL,
  noised_centroid BLOB,
  epsilon_used REAL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, territory_id)
);

CREATE TABLE IF NOT EXISTS discovery_lsh (
  user_id TEXT NOT NULL,
  table_idx INTEGER NOT NULL,
  hash_value INTEGER NOT NULL,
  territory_id TEXT NOT NULL,
  PRIMARY KEY (user_id, table_idx, territory_id)
);
CREATE INDEX IF NOT EXISTS idx_lsh_lookup ON discovery_lsh(table_idx, hash_value);

CREATE TABLE IF NOT EXISTS discovery_dismissed (
  user_id TEXT NOT NULL,
  dismissed_user_id TEXT NOT NULL,
  dismissed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, dismissed_user_id)
);
