-- =============================================
-- Batched Sync Functions
-- =============================================
-- Sync functions that process in batches to avoid Cloudflare timeout (60s)

-- Batched sync messages (processes up to p_limit at a time)
CREATE OR REPLACE FUNCTION sync_messages_to_clustering_points_batched(
    p_user_id UUID,
    p_limit INT DEFAULT 1000
)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    inserted_count INT;
BEGIN
    INSERT INTO clustering_points (user_id, source_type, source_id, content, created_at)
    SELECT
        m.user_id,
        'message',
        m.id,
        m.content,
        m.created_at
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.content IS NOT NULL
      AND LENGTH(m.content) > 0
      AND NOT EXISTS (
          SELECT 1 FROM clustering_points cp
          WHERE cp.user_id = m.user_id
            AND cp.source_type = 'message'
            AND cp.source_id = m.id
      )
    LIMIT p_limit
    ON CONFLICT (user_id, source_type, source_id) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    RETURN inserted_count;
END;
$$;

-- Get count of messages not yet synced
CREATE OR REPLACE FUNCTION get_unsynced_message_count(p_user_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    count_result INT;
BEGIN
    SELECT COUNT(*)::INT INTO count_result
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.content IS NOT NULL
      AND LENGTH(m.content) > 0
      AND NOT EXISTS (
          SELECT 1 FROM clustering_points cp
          WHERE cp.user_id = m.user_id
            AND cp.source_type = 'message'
            AND cp.source_id = m.id
      );
    RETURN count_result;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION sync_messages_to_clustering_points_batched(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION get_unsynced_message_count(UUID) TO service_role;
