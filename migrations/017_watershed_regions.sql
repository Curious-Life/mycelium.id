-- Migration 017: Add watershed region column for dual clustering approach
-- Watershed finds topographic basins (~0% noise, broad regions)
-- HDBSCAN finds dense cores (tighter clusters, noise = liminal points)
-- Together they provide complementary views of the semantic landscape

-- Add watershed_region column
ALTER TABLE messages ADD COLUMN IF NOT EXISTS watershed_region INTEGER;

-- Update bulk_update_clusters to include watershed_region
-- Note: coordinate columns are landscape_x, landscape_y, landscape_z
CREATE OR REPLACE FUNCTION bulk_update_clusters(
    p_ids UUID[],
    p_cluster_ids INTEGER[],
    p_theme_ids INTEGER[],
    p_nearby_regions JSONB[],
    p_xs FLOAT[],
    p_ys FLOAT[],
    p_zs FLOAT[],
    p_watershed_regions INTEGER[] DEFAULT NULL
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '120s'
AS $$
DECLARE
    updated_count INT;
BEGIN
    -- Update with watershed if provided
    IF p_watershed_regions IS NOT NULL THEN
        UPDATE messages m
        SET
            cluster_id = data.cluster_id,
            theme_id = data.theme_id,
            nearby_regions = data.nearby_regions,
            landscape_x = data.x,
            landscape_y = data.y,
            landscape_z = data.z,
            watershed_region = data.watershed_region
        FROM (
            SELECT
                unnest(p_ids) as id,
                unnest(p_cluster_ids) as cluster_id,
                unnest(p_theme_ids) as theme_id,
                unnest(p_nearby_regions) as nearby_regions,
                unnest(p_xs) as x,
                unnest(p_ys) as y,
                unnest(p_zs) as z,
                unnest(p_watershed_regions) as watershed_region
        ) AS data
        WHERE m.id = data.id;
    ELSE
        -- Original behavior without watershed
        UPDATE messages m
        SET
            cluster_id = data.cluster_id,
            theme_id = data.theme_id,
            nearby_regions = data.nearby_regions,
            landscape_x = data.x,
            landscape_y = data.y,
            landscape_z = data.z
        FROM (
            SELECT
                unnest(p_ids) as id,
                unnest(p_cluster_ids) as cluster_id,
                unnest(p_theme_ids) as theme_id,
                unnest(p_nearby_regions) as nearby_regions,
                unnest(p_xs) as x,
                unnest(p_ys) as y,
                unnest(p_zs) as z
        ) AS data
        WHERE m.id = data.id;
    END IF;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

-- Index for watershed queries
CREATE INDEX IF NOT EXISTS idx_messages_watershed_region ON messages(watershed_region) WHERE watershed_region IS NOT NULL;

COMMENT ON COLUMN messages.watershed_region IS 'Watershed segmentation region (topographic basin in KDE density surface). Complements cluster_id (HDBSCAN).';
