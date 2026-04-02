-- =============================================
-- Hierarchical Clustering: Regions + Themes
-- =============================================
-- Adds theme_id for sub-clustering within regions
-- Updates bulk_update_clusters to handle themes

-- Add theme_id column to messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS theme_id INTEGER;

-- Create index for theme queries
CREATE INDEX IF NOT EXISTS idx_messages_theme ON messages(cluster_id, theme_id);

-- Update bulk_update_clusters to include theme_id
CREATE OR REPLACE FUNCTION bulk_update_clusters(
    p_ids UUID[],
    p_cluster_ids INT[],
    p_theme_ids INT[],
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
        landscape_x = u.x,
        landscape_y = u.y,
        landscape_z = u.z
    FROM (
        SELECT
            unnest(p_ids) AS id,
            unnest(p_cluster_ids) AS cluster_id,
            unnest(p_theme_ids) AS theme_id,
            unnest(p_x) AS x,
            unnest(p_y) AS y,
            unnest(p_z) AS z
    ) u
    WHERE m.id = u.id;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

-- Grant execute to service role
GRANT EXECUTE ON FUNCTION bulk_update_clusters(UUID[], INT[], INT[], FLOAT[], FLOAT[], FLOAT[]) TO service_role;

-- Helper function to get cluster/theme summary
CREATE OR REPLACE FUNCTION get_landscape_summary(p_user_id UUID)
RETURNS TABLE (
    region_id INTEGER,
    theme_id INTEGER,
    message_count BIGINT,
    top_entities JSONB,
    centroid_x FLOAT,
    centroid_y FLOAT,
    centroid_z FLOAT
)
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH entity_counts AS (
        SELECT
            m.cluster_id AS region_id,
            m.theme_id,
            e->>'normalized' AS entity_text,
            e->>'label' AS label,
            COUNT(*) AS cnt
        FROM messages m,
             jsonb_array_elements(m.entities) AS e
        WHERE m.user_id = p_user_id
          AND m.cluster_id IS NOT NULL
          AND m.cluster_id != -1
        GROUP BY m.cluster_id, m.theme_id, e->>'normalized', e->>'label'
    ),
    ranked_entities AS (
        SELECT
            ec.region_id,
            ec.theme_id,
            jsonb_build_object('text', ec.entity_text, 'label', ec.label, 'count', ec.cnt) AS entity,
            ROW_NUMBER() OVER (PARTITION BY ec.region_id, ec.theme_id ORDER BY ec.cnt DESC) AS rn
        FROM entity_counts ec
    )
    SELECT
        m.cluster_id AS region_id,
        m.theme_id,
        COUNT(DISTINCT m.id) AS message_count,
        COALESCE(
            jsonb_agg(re.entity ORDER BY (re.entity->>'count')::int DESC)
            FILTER (WHERE re.rn <= 5),
            '[]'::jsonb
        ) AS top_entities,
        AVG(m.landscape_x)::FLOAT AS centroid_x,
        AVG(m.landscape_y)::FLOAT AS centroid_y,
        AVG(m.landscape_z)::FLOAT AS centroid_z
    FROM messages m
    LEFT JOIN ranked_entities re
        ON m.cluster_id = re.region_id
        AND COALESCE(m.theme_id, -1) = COALESCE(re.theme_id, -1)
    WHERE m.user_id = p_user_id
      AND m.cluster_id IS NOT NULL
    GROUP BY m.cluster_id, m.theme_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_landscape_summary(UUID) TO service_role;
