-- Migration 100: Clustering pipeline cleanup
--
-- Fixes:
-- 1. UNIQUE constraint on clustering_points to prevent duplicates
-- 2. Composite indexes for query performance
-- 3. Consolidate territory_profiles to one canonical user_id
-- 4. Clean up orphaned profiles from old clustering runs

-- 1. Unique constraint (prevents duplicate points on re-sync)
CREATE UNIQUE INDEX IF NOT EXISTS idx_clustering_unique
  ON clustering_points(source_type, source_id);

-- 2. Composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_clustering_user_territory
  ON clustering_points(user_id, territory_id);
CREATE INDEX IF NOT EXISTS idx_clustering_user_realm
  ON clustering_points(user_id, realm_id);
CREATE INDEX IF NOT EXISTS idx_territory_profiles_territory_user
  ON territory_profiles(territory_id, user_id);

-- 3. Delete duplicate territory_profiles (keep the one with most data)
-- First: find the canonical user_id (the one with most clustering_points)
-- Then: delete profiles for other user_ids that have the same territory_id

-- Delete territory_profiles where user_id != canonical AND a profile exists for canonical
DELETE FROM territory_profiles
WHERE user_id != '1206312513013293168'
AND territory_id IN (
  SELECT territory_id FROM territory_profiles WHERE user_id = '1206312513013293168'
);

-- 4. Delete orphaned territory_profiles (no matching clustering_points)
DELETE FROM territory_profiles
WHERE territory_id NOT IN (
  SELECT DISTINCT territory_id FROM clustering_points WHERE territory_id IS NOT NULL
);

-- 5. Delete orphaned realm entries
DELETE FROM realms
WHERE realm_id NOT IN (
  SELECT DISTINCT realm_id FROM clustering_points WHERE realm_id IS NOT NULL
);

-- 6. Delete orphaned semantic_themes
DELETE FROM semantic_themes
WHERE semantic_theme_id NOT IN (
  SELECT DISTINCT theme_id FROM clustering_points WHERE theme_id IS NOT NULL
);

-- 7. Clean up test data
DELETE FROM clustering_points WHERE user_id IN ('test-user', 'test-user2');
