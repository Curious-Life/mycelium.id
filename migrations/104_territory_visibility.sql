-- Per-territory visibility for social sharing
-- Values: 'private' (default) | 'friends' | 'public'
ALTER TABLE territory_profiles ADD COLUMN visibility TEXT DEFAULT 'private';
