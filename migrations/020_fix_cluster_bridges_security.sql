-- =============================================
-- Fix cluster_bridges view security
-- =============================================
-- Views default to SECURITY DEFINER which is flagged by Supabase Security Advisor
-- Recreate with security_invoker = true

DROP VIEW IF EXISTS cluster_bridges;

CREATE VIEW cluster_bridges
WITH (security_invoker = true)
AS
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
