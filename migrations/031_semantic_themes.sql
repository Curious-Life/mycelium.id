-- =============================================
-- Semantic Themes (Intermediate Level: Realm → Semantic Theme → Territory)
-- =============================================
-- Semantic themes are sub-clusters within each realm (10D space).
-- They represent coherent topics/threads within a major conceptual domain.
--
-- Hierarchy: Messages → Territories → Semantic Themes → Realms
--
-- Key insight: theme_id in messages is computed as HDBSCAN sub-clustering
-- within each 10D realm (cluster_id). This table gives those sub-clusters
-- names and profiles.
--
-- Each territory is assigned to a semantic theme based on its DOMINANT
-- theme_id (the theme_id with most messages in that territory).

CREATE TABLE semantic_themes (
    id SERIAL PRIMARY KEY,
    realm_id INT NOT NULL,           -- Parent realm (cluster_id)
    semantic_theme_id INT NOT NULL,  -- Maps to theme_id from 10D sub-clustering
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Identity
    name TEXT NOT NULL,
    essence TEXT,

    -- Composition (cached counts)
    territory_count INT DEFAULT 0,
    message_count INT DEFAULT 0,

    -- Contained Territories
    territory_ids INT[] DEFAULT '{}',

    -- Entities & Patterns
    top_entities JSONB DEFAULT '[]',           -- [{text, type, count}]
    signature_patterns TEXT[] DEFAULT '{}',

    -- Story
    story_birth TEXT,
    story_arc TEXT,
    story_current_chapter TEXT,

    -- Uncertainty
    uncertainty_open_questions TEXT[] DEFAULT '{}',

    -- Raw LLM response for reparsing
    raw_response TEXT,

    -- Embedding for semantic search
    embedding vector(1024),

    -- Metadata
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    generation_model TEXT DEFAULT 'claude-haiku-4-5-20251001',
    generation_version INT DEFAULT 1,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Composite unique constraint
    UNIQUE(user_id, realm_id, semantic_theme_id)
);

-- RLS
ALTER TABLE semantic_themes ENABLE ROW LEVEL SECURITY;

CREATE POLICY semantic_themes_user_policy ON semantic_themes
    FOR ALL USING (user_id = auth.uid());

-- Indexes
CREATE INDEX idx_semantic_themes_lookup ON semantic_themes(user_id, realm_id, semantic_theme_id);
CREATE INDEX idx_semantic_themes_realm ON semantic_themes(user_id, realm_id);
CREATE INDEX idx_semantic_themes_embedding ON semantic_themes
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- =============================================
-- Add semantic_theme_id to territory_profiles
-- =============================================
-- Links each territory to its parent semantic theme.

ALTER TABLE territory_profiles
ADD COLUMN semantic_theme_id INT;

-- Index for semantic theme lookups
CREATE INDEX idx_territory_profiles_semantic_theme
    ON territory_profiles(user_id, realm_id, semantic_theme_id);

-- =============================================
-- Function: Assign territories to semantic themes
-- =============================================
-- For each territory, find the dominant theme_id from its messages.

CREATE OR REPLACE FUNCTION assign_territories_to_semantic_themes(p_user_id UUID)
RETURNS TABLE(territory_id INT, realm_id INT, semantic_theme_id INT, message_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    WITH territory_theme_counts AS (
        -- Count messages per (territory, theme_id) combination
        SELECT
            m.cluster_3d as t_id,
            m.cluster_id as r_id,
            m.theme_id as st_id,
            COUNT(*) as msg_count
        FROM messages m
        WHERE m.user_id = p_user_id
          AND m.cluster_3d IS NOT NULL
          AND m.theme_id IS NOT NULL
          AND m.theme_id != -1  -- Exclude noise themes
        GROUP BY m.cluster_3d, m.cluster_id, m.theme_id
    ),
    dominant_themes AS (
        -- For each territory, pick the theme_id with most messages
        SELECT DISTINCT ON (t_id)
            t_id,
            r_id,
            st_id,
            msg_count
        FROM territory_theme_counts
        ORDER BY t_id, msg_count DESC
    )
    SELECT
        dt.t_id as territory_id,
        dt.r_id as realm_id,
        dt.st_id as semantic_theme_id,
        dt.msg_count as message_count
    FROM dominant_themes dt;
END;
$$;

-- =============================================
-- Function: Match semantic themes by embedding
-- =============================================
-- For semantic search / context augmentation.

CREATE OR REPLACE FUNCTION match_semantic_themes(
    query_embedding vector(1024),
    match_user_id UUID,
    match_count INT DEFAULT 5
)
RETURNS TABLE(
    realm_id INT,
    semantic_theme_id INT,
    name TEXT,
    essence TEXT,
    territory_count INT,
    message_count INT,
    story_current_chapter TEXT,
    similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        st.realm_id,
        st.semantic_theme_id,
        st.name,
        st.essence,
        st.territory_count,
        st.message_count,
        st.story_current_chapter,
        1 - (st.embedding <=> query_embedding) as similarity
    FROM semantic_themes st
    WHERE st.user_id = match_user_id
      AND st.embedding IS NOT NULL
    ORDER BY st.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- =============================================
-- Function: Bulk update semantic theme embeddings
-- =============================================

CREATE OR REPLACE FUNCTION bulk_update_semantic_theme_embeddings(
    p_user_id UUID,
    p_realm_ids INT[],
    p_semantic_theme_ids INT[],
    p_embeddings vector(1024)[]
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    updated_count INT := 0;
    i INT;
BEGIN
    FOR i IN 1..array_length(p_realm_ids, 1) LOOP
        UPDATE semantic_themes
        SET embedding = p_embeddings[i],
            updated_at = NOW()
        WHERE user_id = p_user_id
          AND realm_id = p_realm_ids[i]
          AND semantic_theme_id = p_semantic_theme_ids[i];

        IF FOUND THEN
            updated_count := updated_count + 1;
        END IF;
    END LOOP;

    RETURN updated_count;
END;
$$;

-- =============================================
-- Function: Get semantic theme stats
-- =============================================

CREATE OR REPLACE FUNCTION get_semantic_theme_stats(
    p_user_id UUID,
    p_realm_id INT,
    p_semantic_theme_id INT
)
RETURNS TABLE(
    territory_count BIGINT,
    message_count BIGINT,
    earliest_message TIMESTAMPTZ,
    latest_message TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(DISTINCT m.cluster_3d) as territory_count,
        COUNT(*) as message_count,
        MIN(m.created_at) as earliest_message,
        MAX(m.created_at) as latest_message
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.cluster_id = p_realm_id
      AND m.theme_id = p_semantic_theme_id;
END;
$$;
