-- =============================================
-- Drop Identity Columns
-- =============================================
-- After evaluation, descriptive approach (concrete, topic-focused) is clearly
-- superior to identity approach (poetic, first-person) for practical navigation
-- and understanding of content.
--
-- Identity framing may still have value in different contexts (e.g., narrative
-- interfaces, creative exploration), but for core navigation and retrieval,
-- descriptive labels are more effective.

-- Drop identity columns from territory_profiles
ALTER TABLE territory_profiles DROP COLUMN IF EXISTS name_identity;
ALTER TABLE territory_profiles DROP COLUMN IF EXISTS essence_identity;

-- Drop identity columns from theme_cards
ALTER TABLE theme_cards DROP COLUMN IF EXISTS title_identity;
ALTER TABLE theme_cards DROP COLUMN IF EXISTS essence_identity;
