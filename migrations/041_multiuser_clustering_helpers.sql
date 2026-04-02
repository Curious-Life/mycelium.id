-- =============================================
-- Multi-User Clustering Helpers
-- =============================================
-- Helper functions for per-user landscape regeneration.
-- These support the Modal nightly clustering job which now
-- processes each user's semantic space independently.

-- Get list of users who have messages with cluster embeddings
-- Used by the nightly orchestrator to spawn per-user jobs
CREATE OR REPLACE FUNCTION get_users_with_cluster_embeddings()
RETURNS TABLE(id UUID) AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT m.user_id
    FROM messages m
    WHERE m.embedding_cluster IS NOT NULL
    AND m.user_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Grant access to authenticated users and service role
GRANT EXECUTE ON FUNCTION get_users_with_cluster_embeddings() TO authenticated;
GRANT EXECUTE ON FUNCTION get_users_with_cluster_embeddings() TO service_role;

-- Comment explaining security model
COMMENT ON FUNCTION get_users_with_cluster_embeddings() IS
'Returns user IDs who have messages with Nomic cluster embeddings.
Used by Modal nightly job to spawn per-user clustering.
SECURITY: Only returns user IDs, no message content.';
