-- =============================================
-- Bulk Cluster Update Function
-- Enables 50-100x faster DB updates for clustering jobs
-- =============================================

-- Bulk update cluster assignments for messages
-- Uses unnest() to process arrays efficiently in a single UPDATE statement
CREATE OR REPLACE FUNCTION bulk_update_clusters(
    p_ids UUID[],
    p_cluster_ids INT[],
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
        landscape_x = u.x,
        landscape_y = u.y,
        landscape_z = u.z
    FROM (
        SELECT
            unnest(p_ids) AS id,
            unnest(p_cluster_ids) AS cluster_id,
            unnest(p_x) AS x,
            unnest(p_y) AS y,
            unnest(p_z) AS z
    ) u
    WHERE m.id = u.id;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

-- Grant execute to service role (Modal uses service key)
GRANT EXECUTE ON FUNCTION bulk_update_clusters(UUID[], INT[], FLOAT[], FLOAT[], FLOAT[]) TO service_role;
