-- Chronicle tracking: track which messages have been analyzed per territory
-- so we can incrementally update descriptions without re-processing

-- Track the high-water mark of analyzed content per territory
ALTER TABLE territory_profiles ADD COLUMN chronicle_cursor TEXT DEFAULT NULL;
-- JSON: { "last_source_id": "...", "last_created_at": "...", "analyzed_count": N, "total_at_analysis": N }

-- Store the full chronicle text (the living document) separately from the name/essence
ALTER TABLE territory_profiles ADD COLUMN chronicle TEXT DEFAULT NULL;

-- Track how many Claude tokens were used for this territory's chronicle
ALTER TABLE territory_profiles ADD COLUMN chronicle_model TEXT DEFAULT NULL;
