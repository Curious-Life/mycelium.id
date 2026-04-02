-- =============================================
-- Territory Living Documents
-- Extends territory_profiles with dynamics, stewardship, and versioning
-- for incremental Claude-powered description generation
-- =============================================

ALTER TABLE territory_profiles ADD COLUMN steward_agent_id TEXT;
ALTER TABLE territory_profiles ADD COLUMN growth_state TEXT;
ALTER TABLE territory_profiles ADD COLUMN energy REAL;
ALTER TABLE territory_profiles ADD COLUMN vitality REAL;
ALTER TABLE territory_profiles ADD COLUMN velocity REAL;
ALTER TABLE territory_profiles ADD COLUMN point_delta INTEGER;
ALTER TABLE territory_profiles ADD COLUMN description_version TEXT;
ALTER TABLE territory_profiles ADD COLUMN point_count_at_description INTEGER;
ALTER TABLE territory_profiles ADD COLUMN moments_of_interest TEXT;
ALTER TABLE territory_profiles ADD COLUMN last_described_at TEXT;

-- Index for finding territories needing refresh
CREATE INDEX IF NOT EXISTS idx_tp_description_version ON territory_profiles(description_version);
CREATE INDEX IF NOT EXISTS idx_tp_steward ON territory_profiles(steward_agent_id);
