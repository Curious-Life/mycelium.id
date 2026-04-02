-- =============================================
-- Dual Clustering: 10D Semantic + 3D Visual
-- =============================================
-- cluster_id (existing) = HDBSCAN on 10D = semantic truth
-- cluster_3d (new) = HDBSCAN on 3D = visual coherence
-- Bridge data shows where 10D clusters are split across 3D space

-- Add 3D clustering column
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cluster_3d INT;

-- Index for 3D cluster queries
CREATE INDEX IF NOT EXISTS idx_messages_cluster_3d ON messages(cluster_3d) WHERE cluster_3d IS NOT NULL;

-- Update bulk_update_clusters to include cluster_3d
DROP FUNCTION IF EXISTS bulk_update_clusters(UUID[], INT[], INT[], JSONB[], FLOAT[], FLOAT[], FLOAT[]);
DROP FUNCTION IF EXISTS bulk_update_clusters(UUID[], INT[], INT[], JSONB[], FLOAT[], FLOAT[], FLOAT[], INT[]);

CREATE OR REPLACE FUNCTION bulk_update_clusters(
    p_ids UUID[],
    p_cluster_ids INT[],
    p_theme_ids INT[],
    p_nearby_regions JSONB[],
    p_xs FLOAT[],
    p_ys FLOAT[],
    p_zs FLOAT[],
    p_watershed_regions INT[],
    p_cluster_3ds INT[]
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
        landscape_z = u.z,
        watershed_region = u.watershed_region,
        cluster_3d = u.cluster_3d
    FROM (
        SELECT
            unnest(p_ids) AS id,
            unnest(p_cluster_ids) AS cluster_id,
            unnest(p_theme_ids) AS theme_id,
            unnest(p_nearby_regions) AS nearby_regions,
            unnest(p_xs) AS x,
            unnest(p_ys) AS y,
            unnest(p_zs) AS z,
            unnest(p_watershed_regions) AS watershed_region,
            unnest(p_cluster_3ds) AS cluster_3d
    ) u
    WHERE m.id = u.id;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION bulk_update_clusters(UUID[], INT[], INT[], JSONB[], FLOAT[], FLOAT[], FLOAT[], INT[], INT[]) TO service_role;

-- View for analyzing bridge relationships (10D clusters split across 3D space)
CREATE OR REPLACE VIEW cluster_bridges AS
WITH cluster_fragments AS (
    SELECT
        cluster_id AS cluster_10d,
        cluster_3d,
        COUNT(*) AS point_count,
        AVG(landscape_x) AS centroid_x,
        AVG(landscape_y) AS centroid_y,
        AVG(landscape_z) AS centroid_z
    FROM messages
    WHERE cluster_id IS NOT NULL
      AND cluster_id != -1
      AND cluster_3d IS NOT NULL
    GROUP BY cluster_id, cluster_3d
),
cluster_stats AS (
    SELECT
        cluster_10d,
        COUNT(DISTINCT cluster_3d) AS fragment_count,
        SUM(point_count) AS total_points,
        MAX(point_count)::FLOAT / SUM(point_count) AS purity
    FROM cluster_fragments
    GROUP BY cluster_10d
)
SELECT
    cf.cluster_10d,
    cf.cluster_3d,
    cf.point_count,
    cf.centroid_x,
    cf.centroid_y,
    cf.centroid_z,
    cs.fragment_count,
    cs.total_points,
    cs.purity,
    CASE
        WHEN cs.fragment_count > 1 THEN true
        ELSE false
    END AS is_split_cluster
FROM cluster_fragments cf
JOIN cluster_stats cs ON cf.cluster_10d = cs.cluster_10d
ORDER BY cs.fragment_count DESC, cf.cluster_10d, cf.point_count DESC;
