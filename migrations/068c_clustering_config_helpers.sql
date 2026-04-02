-- Migration 068c: Helper functions + grants

CREATE OR REPLACE FUNCTION needs_hierarchy_detection(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    config user_clustering_config;
    current_points INTEGER;
    growth_ratio FLOAT;
BEGIN
    SELECT * INTO config
    FROM user_clustering_config
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN TRUE;
    END IF;

    SELECT COUNT(*) INTO current_points
    FROM clustering_points
    WHERE user_id = p_user_id;

    IF config.points_at_detection IS NULL OR config.points_at_detection = 0 THEN
        RETURN TRUE;
    END IF;

    growth_ratio := current_points::FLOAT / config.points_at_detection::FLOAT;

    RETURN growth_ratio >= 1.2;
END;
$$;

CREATE OR REPLACE FUNCTION mark_clustering_rebuild_complete(p_user_id UUID, p_points_count INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE user_clustering_config
    SET
        last_full_rebuild = NOW(),
        points_at_last_rebuild = p_points_count
    WHERE user_id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_user_clustering_config(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION update_user_clustering_config(UUID, INTEGER, INTEGER, INTEGER, INTEGER, FLOAT, FLOAT, FLOAT, FLOAT, FLOAT, FLOAT, FLOAT, FLOAT, FLOAT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION needs_hierarchy_detection(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mark_clustering_rebuild_complete(UUID, INTEGER) TO service_role;
