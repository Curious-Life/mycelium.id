-- =============================================
-- Nomic v1.5 Cluster Embeddings
-- =============================================
-- Dual embedding architecture:
-- - embedding (BGE-M3, 1024D): Real-time search via Cloudflare Workers AI
-- - embedding_cluster (Nomic v1.5, 256D): Clustering via Modal batch
--
-- Why Nomic v1.5:
-- - Apache 2.0 license (no restrictions)
-- - Matryoshka trained (structure preserved under truncation)
-- - Explicit 'clustering:' task prefix
-- - 768D base → truncate to 256D for efficient UMAP

-- Add clustering embedding column (256D for Matryoshka truncation)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding_cluster vector(256);

-- Track which model generated the clustering embedding
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding_cluster_model TEXT;

-- Mark liminal/noise points explicitly (easier queries than cluster_id = -1)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_liminal BOOLEAN DEFAULT false;

-- Index for finding un-embedded messages (batch job queries)
CREATE INDEX IF NOT EXISTS idx_messages_embedding_cluster_null
ON messages(id) WHERE embedding_cluster IS NULL;

-- Note: We don't add IVFFlat index on embedding_cluster because:
-- 1. These embeddings are only used for batch UMAP+HDBSCAN, not real-time search
-- 2. The batch job loads all embeddings into memory anyway
-- 3. Saves storage and maintenance overhead

-- Helper function to check embedding coverage
CREATE OR REPLACE FUNCTION get_embedding_stats()
RETURNS TABLE (
    total_messages BIGINT,
    has_search_embedding BIGINT,
    has_cluster_embedding BIGINT,
    has_cluster_id BIGINT,
    liminal_count BIGINT
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
        COUNT(*) FILTER (WHERE is_liminal = true)::BIGINT as liminal_count
    FROM messages;
END;
$$;

GRANT EXECUTE ON FUNCTION get_embedding_stats() TO service_role;

-- Bulk update function for cluster embeddings (efficient batch writes)
CREATE OR REPLACE FUNCTION bulk_update_cluster_embeddings(
    p_ids UUID[],
    p_embeddings vector(256)[],
    p_model TEXT
) RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    updated_count INT;
BEGIN
    UPDATE messages m SET
        embedding_cluster = u.embedding,
        embedding_cluster_model = p_model
    FROM (
        SELECT
            unnest(p_ids) AS id,
            unnest(p_embeddings) AS embedding
    ) u
    WHERE m.id = u.id;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION bulk_update_cluster_embeddings(UUID[], vector(256)[], TEXT) TO service_role;
