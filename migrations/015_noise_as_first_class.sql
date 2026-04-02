-- =============================================
-- Noise as First-Class Citizen
-- =============================================
-- Noise points are meaningful: transitions, bridges, novel exploration
-- Instead of forcing them into clusters, we preserve them with context

-- Add nearby_regions column for noise points (and optionally clustered points)
-- Stores K nearest regions with distances for context
ALTER TABLE messages ADD COLUMN IF NOT EXISTS nearby_regions JSONB;

-- Example value for a noise point:
-- [{"region": 3, "distance": 0.12}, {"region": 7, "distance": 0.14}]
-- This shows the point is between regions 3 and 7 - a bridge/transition

-- Index for querying noise points
CREATE INDEX IF NOT EXISTS idx_messages_noise ON messages(cluster_id) WHERE cluster_id = -1;

-- Update bulk_update_clusters to handle nearby_regions
CREATE OR REPLACE FUNCTION bulk_update_clusters(
    p_ids UUID[],
    p_cluster_ids INT[],
    p_theme_ids INT[],
    p_nearby_regions JSONB[],
    p_x FLOAT[],
    p_y FLOAT[],
    p_z FLOAT[]
) RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    updated_count INT;
BEGIN
    UPDATE messages m SET
        cluster_id = u.cluster_id,
        theme_id = u.theme_id,
        nearby_regions = u.nearby_regions,
        landscape_x = u.x,
        landscape_y = u.y,
        landscape_z = u.z
    FROM (
        SELECT
            unnest(p_ids) AS id,
            unnest(p_cluster_ids) AS cluster_id,
            unnest(p_theme_ids) AS theme_id,
            unnest(p_nearby_regions) AS nearby_regions,
            unnest(p_x) AS x,
            unnest(p_y) AS y,
            unnest(p_z) AS z
    ) u
    WHERE m.id = u.id;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION bulk_update_clusters(UUID[], INT[], INT[], JSONB[], FLOAT[], FLOAT[], FLOAT[]) TO service_role;

-- View for analyzing noise patterns
-- Use security_invoker to respect RLS of the querying user (not view owner)
DROP VIEW IF EXISTS noise_analysis;
CREATE VIEW noise_analysis
WITH (security_invoker = true)
AS
SELECT
    m.id,
    m.content,
    m.created_at,
    m.nearby_regions,
    m.landscape_x,
    m.landscape_y,
    m.landscape_z,
    m.entities,
    -- Extract bridge info: is this point between multiple regions?
    CASE
        WHEN jsonb_array_length(m.nearby_regions) >= 2
             AND (m.nearby_regions->1->>'distance')::float - (m.nearby_regions->0->>'distance')::float < 0.1
        THEN true
        ELSE false
    END AS is_bridge_point
FROM messages m
WHERE m.cluster_id = -1
  AND m.nearby_regions IS NOT NULL;
