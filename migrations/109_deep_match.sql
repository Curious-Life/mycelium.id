-- Deep matching: bilateral consent for noised centroid exchange
ALTER TABLE connections ADD COLUMN deep_match_a INTEGER DEFAULT 0;
ALTER TABLE connections ADD COLUMN deep_match_b INTEGER DEFAULT 0;
ALTER TABLE connections ADD COLUMN deep_overlap_json TEXT;
ALTER TABLE connections ADD COLUMN deep_overlap_computed_at TEXT;
