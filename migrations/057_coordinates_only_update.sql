-- =============================================
-- Coordinates-Only Update Function
-- =============================================
-- This function updates ONLY the 3D/2D visualization coordinates
-- without touching cluster assignments (atom_id, territory_id, theme_id, realm_id).
-- Use this when you want to regenerate the UMAP projection with new parameters
-- without changing which clusters points belong to.

-- Bulk update ONLY coordinates (preserves cluster assignments)
CREATE OR REPLACE FUNCTION bulk_update_coordinates_only(
    p_ids UUID[],
    p_x FLOAT[],
    p_y FLOAT[],
    p_z FLOAT[],
    p_x_2d FLOAT[],
    p_y_2d FLOAT[],
    p_version TIMESTAMPTZ
)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    updated_count INT;
BEGIN
    UPDATE clustering_points cp SET
        landscape_x = u.x,
        landscape_y = u.y,
        landscape_z = u.z,
        landscape_x_2d = u.x_2d,
        landscape_y_2d = u.y_2d,
        cluster_version = p_version,
        updated_at = NOW()
    FROM (
        SELECT
            unnest(p_ids) AS id,
            unnest(p_x) AS x,
            unnest(p_y) AS y,
            unnest(p_z) AS z,
            unnest(p_x_2d) AS x_2d,
            unnest(p_y_2d) AS y_2d
    ) u
    WHERE cp.id = u.id;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION bulk_update_coordinates_only(UUID[], FLOAT[], FLOAT[], FLOAT[], FLOAT[], FLOAT[], TIMESTAMPTZ) TO service_role;
