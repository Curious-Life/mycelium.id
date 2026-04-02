-- =============================================
-- Add Descriptive Columns to Territory & Theme Tables
-- =============================================
-- We're keeping the identity-based columns (for comparison) and adding
-- new descriptive columns. After evaluation, identity columns may be removed.
--
-- Identity columns: Abstract, first-person, poetic ("I am the living threshold...")
-- Descriptive columns: Concrete, topic-focused ("API Integration & Webhooks")

-- =============================================
-- Territory Profiles: Add descriptive columns
-- =============================================

-- Rename identity columns (keep for comparison)
ALTER TABLE territory_profiles RENAME COLUMN name TO name_identity;
ALTER TABLE territory_profiles RENAME COLUMN essence TO essence_identity;

-- Add new descriptive columns
ALTER TABLE territory_profiles ADD COLUMN name TEXT;
ALTER TABLE territory_profiles ADD COLUMN essence TEXT;

-- Add comment to clarify purpose
COMMENT ON COLUMN territory_profiles.name_identity IS 'Identity-based name (poetic, first-person). Kept for comparison.';
COMMENT ON COLUMN territory_profiles.essence_identity IS 'Identity-based essence (autobiographical). Kept for comparison.';
COMMENT ON COLUMN territory_profiles.name IS 'Descriptive name (concrete, topic-focused)';
COMMENT ON COLUMN territory_profiles.essence IS 'Descriptive essence (what topics this territory covers)';

-- =============================================
-- Theme Cards: Add descriptive columns
-- =============================================

-- Rename identity columns (keep for comparison)
ALTER TABLE theme_cards RENAME COLUMN title TO title_identity;
ALTER TABLE theme_cards RENAME COLUMN essence TO essence_identity;

-- Add new descriptive columns
ALTER TABLE theme_cards ADD COLUMN title TEXT;
ALTER TABLE theme_cards ADD COLUMN essence TEXT;

-- Add comments
COMMENT ON COLUMN theme_cards.title_identity IS 'Identity-based title (poetic). Kept for comparison.';
COMMENT ON COLUMN theme_cards.essence_identity IS 'Identity-based essence (autobiographical). Kept for comparison.';
COMMENT ON COLUMN theme_cards.title IS 'Descriptive title (concrete, topic-focused)';
COMMENT ON COLUMN theme_cards.essence IS 'Descriptive essence (what this theme is about)';

-- =============================================
-- Remove NOT NULL constraints from identity columns
-- =============================================
-- Original columns had NOT NULL, which carried over on rename.
-- Legacy data is preserved; new rows only need descriptive columns.

ALTER TABLE territory_profiles ALTER COLUMN name_identity DROP NOT NULL;
ALTER TABLE theme_cards ALTER COLUMN title_identity DROP NOT NULL;

