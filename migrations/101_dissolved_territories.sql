-- Track dissolved territories for historical preservation
ALTER TABLE territory_profiles ADD COLUMN dissolved_at TEXT;
ALTER TABLE territory_profiles ADD COLUMN dissolved_version TEXT;

CREATE INDEX IF NOT EXISTS idx_territory_dissolved ON territory_profiles(dissolved_at);
