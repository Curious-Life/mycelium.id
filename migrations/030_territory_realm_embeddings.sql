-- =============================================
-- Territory & Realm Embeddings for Semantic Search
-- =============================================
-- Adds BGE-M3 embeddings (1024D) to territory_profiles and realms
-- for semantic search. Embeddings are generated from the territory/realm
-- description (name + essence) during agent generation.

-- Add embedding column to territory_profiles
ALTER TABLE territory_profiles
ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Add embedding column to realms
ALTER TABLE realms
ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Create HNSW index for fast territory semantic search
CREATE INDEX IF NOT EXISTS idx_territory_profiles_embedding
ON territory_profiles USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Create HNSW index for fast realm semantic search
CREATE INDEX IF NOT EXISTS idx_realms_embedding
ON realms USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- =============================================
-- Semantic Search Function for Territories
-- =============================================
-- Returns top N territories by semantic similarity to query embedding

CREATE OR REPLACE FUNCTION match_territories(
    query_embedding VECTOR(1024),
    match_user_id UUID,
    match_count INT DEFAULT 3
)
RETURNS TABLE (
    territory_id INT,
    name TEXT,
    essence TEXT,
    realm_id INT,
    message_count INT,
    story_current_chapter TEXT,
    agent_expertise TEXT,
    agent_can_help_with TEXT[],
    uncertainty_open_questions TEXT[],
    top_entities JSONB,
    similarity FLOAT
)
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        tp.territory_id,
        tp.name,
        tp.essence,
        tp.realm_id,
        tp.message_count,
        tp.story_current_chapter,
        tp.agent_expertise,
        tp.agent_can_help_with,
        tp.uncertainty_open_questions,
        tp.top_entities,
        1 - (tp.embedding <=> query_embedding) AS similarity
    FROM territory_profiles tp
    WHERE tp.user_id = match_user_id
      AND tp.embedding IS NOT NULL
    ORDER BY tp.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION match_territories(VECTOR(1024), UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION match_territories(VECTOR(1024), UUID, INT) TO service_role;

-- =============================================
-- Semantic Search Function for Realms
-- =============================================

CREATE OR REPLACE FUNCTION match_realms(
    query_embedding VECTOR(1024),
    match_user_id UUID,
    match_count INT DEFAULT 3
)
RETURNS TABLE (
    realm_id INT,
    name TEXT,
    essence TEXT,
    territory_count INT,
    message_count INT,
    story_current_chapter TEXT,
    agent_expertise TEXT,
    agent_can_help_with TEXT[],
    similarity FLOAT
)
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.realm_id,
        r.name,
        r.essence,
        r.territory_count,
        r.message_count,
        r.story_current_chapter,
        r.agent_expertise,
        r.agent_can_help_with,
        1 - (r.embedding <=> query_embedding) AS similarity
    FROM realms r
    WHERE r.user_id = match_user_id
      AND r.embedding IS NOT NULL
    ORDER BY r.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION match_realms(VECTOR(1024), UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION match_realms(VECTOR(1024), UUID, INT) TO service_role;

-- =============================================
-- Bulk Update Function for Territory Embeddings
-- =============================================
-- Used by Modal to efficiently update embeddings in batch

CREATE OR REPLACE FUNCTION bulk_update_territory_embeddings(
    p_user_id UUID,
    p_territory_ids INT[],
    p_embeddings vector(1024)[]
)
RETURNS INT
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    updated_count INT;
BEGIN
    WITH updates AS (
        SELECT
            unnest(p_territory_ids) AS tid,
            unnest(p_embeddings) AS emb
    )
    UPDATE territory_profiles tp
    SET embedding = u.emb,
        updated_at = NOW()
    FROM updates u
    WHERE tp.user_id = p_user_id
      AND tp.territory_id = u.tid;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION bulk_update_territory_embeddings(UUID, INT[], vector(1024)[]) TO service_role;

-- =============================================
-- Bulk Update Function for Realm Embeddings
-- =============================================

CREATE OR REPLACE FUNCTION bulk_update_realm_embeddings(
    p_user_id UUID,
    p_realm_ids INT[],
    p_embeddings vector(1024)[]
)
RETURNS INT
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
    updated_count INT;
BEGIN
    WITH updates AS (
        SELECT
            unnest(p_realm_ids) AS rid,
            unnest(p_embeddings) AS emb
    )
    UPDATE realms r
    SET embedding = u.emb,
        updated_at = NOW()
    FROM updates u
    WHERE r.user_id = p_user_id
      AND r.realm_id = u.rid;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION bulk_update_realm_embeddings(UUID, INT[], vector(1024)[]) TO service_role;
