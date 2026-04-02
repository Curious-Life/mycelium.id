-- =============================================
-- Mindscape Enhancements
-- Adds activity timelines and 3D centroids
-- for features: activity sparklines, centroid labels
-- =============================================

-- Activity timeline: JSON array [{month: "2025-12", count: 14}, ...]
ALTER TABLE territory_profiles ADD COLUMN activity_timeline TEXT;
ALTER TABLE realms ADD COLUMN activity_timeline TEXT;

-- 3D centroid for territory label placement in visualization
ALTER TABLE territory_profiles ADD COLUMN centroid_3d TEXT;  -- JSON [x, y, z]
