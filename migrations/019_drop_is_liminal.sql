-- =============================================
-- Drop redundant is_liminal column
-- =============================================
-- is_liminal was a convenience boolean duplicating cluster_id = -1
-- It was never updated by the clustering pipeline, causing stale data
-- The frontend already uses cluster_id = -1 directly

-- Fix get_embedding_stats to use cluster_id = -1 instead
CREATE OR REPLACE FUNCTION get_embedding_stats()
RETURNS TABLE (
    total_messages BIGINT,
    has_search_embedding BIGINT,
    has_cluster_embedding BIGINT,
    has_cluster_id BIGINT,
    noise_count BIGINT
)
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT as total_messages,
        COUNT(embedding)::BIGINT as has_search_embedding,
        COUNT(embedding_cluster)::BIGINT as has_cluster_embedding,
        COUNT(cluster_id)::BIGINT as has_cluster_id,
        COUNT(*) FILTER (WHERE cluster_id = -1)::BIGINT as noise_count
    FROM messages;
END;
$$;

-- Drop the redundant column
ALTER TABLE messages DROP COLUMN IF EXISTS is_liminal;
