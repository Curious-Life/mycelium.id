-- =============================================
-- Realms (Top-Level Continental Groupings)
-- =============================================
-- Realms are the highest level of the mindscape hierarchy.
-- Each realm represents a major conceptual domain based on
-- 10D embedding clusters (cluster_id from HDBSCAN).
--
-- Hierarchy: Messages → Themes → Territories → Realms
--
-- Territories are assigned to realms based on their DOMINANT
-- conceptual cluster (the cluster_id with most messages in that territory).
-- Special: cluster_id = -1 becomes the "Liminal Realm" for noise/edge messages.

CREATE TABLE realms (
    id SERIAL PRIMARY KEY,
    realm_id INT NOT NULL,  -- Maps to cluster_id (10D conceptual cluster)
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Identity
    name TEXT NOT NULL,
    essence TEXT,
    archetype_type TEXT,
    archetype_character TEXT,

    -- Composition (cached counts)
    territory_count INT DEFAULT 0,
    message_count INT DEFAULT 0,

    -- Contained Territories (top territories by message count)
    territory_ids INT[] DEFAULT '{}',

    -- Entities & Patterns
    top_entities JSONB DEFAULT '[]',           -- [{text, type, count}]
    signature_patterns TEXT[] DEFAULT '{}',

    -- Story
    story_birth TEXT,
    story_arc TEXT,
    story_peak_moments TEXT[] DEFAULT '{}',
    story_current_chapter TEXT,

    -- Uncertainty
    uncertainty_open_questions TEXT[] DEFAULT '{}',
    uncertainty_edges TEXT,

    -- Neighboring Realms (with context)
    neighbors JSONB DEFAULT '[]',  -- [{realm_id, name, essence, connection_strength}]

    -- Agent Personality
    agent_expertise TEXT,
    agent_curious_about TEXT,
    agent_can_help_with TEXT[] DEFAULT '{}',

    -- Raw LLM response for reparsing
    raw_response TEXT,

    -- Metadata
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    generation_model TEXT DEFAULT 'claude-haiku-4-5-20251001',
    generation_version INT DEFAULT 1,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Composite unique constraint for multi-user support
    UNIQUE(user_id, realm_id)
);

-- RLS
ALTER TABLE realms ENABLE ROW LEVEL SECURITY;

CREATE POLICY realms_user_policy ON realms
    FOR ALL USING (user_id = auth.uid());

-- Index for efficient lookups
CREATE INDEX idx_realms_lookup ON realms(user_id, realm_id);

-- =============================================
-- Add realm_id to territory_profiles
-- =============================================
-- Links each territory to its parent realm based on dominant cluster.

ALTER TABLE territory_profiles
ADD COLUMN realm_id INT;

-- Add raw_response column if not exists (for reparsing capability)
ALTER TABLE territory_profiles
ADD COLUMN IF NOT EXISTS raw_response TEXT;

-- Index for realm lookups
CREATE INDEX idx_territory_profiles_realm ON territory_profiles(user_id, realm_id);

-- =============================================
-- Realm Neighbors table
-- =============================================
-- Tracks relationships between realms based on shared characteristics.

CREATE TABLE realm_neighbors (
    id SERIAL PRIMARY KEY,
    realm_id INT NOT NULL,
    neighbor_id INT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    connection_type TEXT NOT NULL,  -- 'semantic', 'temporal', 'shared_territories'
    connection_strength FLOAT,       -- 0-1 normalized strength
    shared_territory_count INT DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Composite unique constraint
    UNIQUE(user_id, realm_id, neighbor_id, connection_type)
);

-- RLS
ALTER TABLE realm_neighbors ENABLE ROW LEVEL SECURITY;

CREATE POLICY realm_neighbors_user_policy ON realm_neighbors
    FOR ALL USING (user_id = auth.uid());

-- Index for lookups
CREATE INDEX idx_realm_neighbors_lookup
    ON realm_neighbors(user_id, realm_id, connection_type);

-- =============================================
-- Function to get live realm stats
-- =============================================
CREATE OR REPLACE FUNCTION get_realm_stats(p_user_id UUID, p_realm_id INT)
RETURNS TABLE (
    message_count BIGINT,
    territory_count BIGINT,
    theme_count BIGINT,
    first_message TIMESTAMPTZ,
    last_message TIMESTAMPTZ,
    messages_7d BIGINT,
    messages_30d BIGINT,
    messages_90d BIGINT
)
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT as message_count,
        COUNT(DISTINCT cluster_3d)::BIGINT as territory_count,
        COUNT(DISTINCT theme_id)::BIGINT as theme_count,
        MIN(created_at) as first_message,
        MAX(created_at) as last_message,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::BIGINT as messages_7d,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::BIGINT as messages_30d,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '90 days')::BIGINT as messages_90d
    FROM messages m
    JOIN territory_profiles tp ON m.user_id = tp.user_id AND m.cluster_3d = tp.territory_id
    WHERE m.user_id = p_user_id
      AND tp.realm_id = p_realm_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_realm_stats(UUID, INT) TO authenticated;

-- =============================================
-- Function to assign territories to realms
-- =============================================
-- Assigns each territory to a realm based on its dominant conceptual cluster.
-- A territory's dominant cluster is the cluster_id with the most messages.

CREATE OR REPLACE FUNCTION assign_territories_to_realms(p_user_id UUID)
RETURNS TABLE (
    territory_id INT,
    realm_id INT,
    message_count BIGINT
)
SECURITY INVOKER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH territory_cluster_counts AS (
        SELECT
            cluster_3d as t_id,
            cluster_id as c_id,
            COUNT(*) as msg_count,
            ROW_NUMBER() OVER (PARTITION BY cluster_3d ORDER BY COUNT(*) DESC) as rank
        FROM messages
        WHERE user_id = p_user_id
          AND cluster_3d IS NOT NULL
        GROUP BY cluster_3d, cluster_id
    )
    SELECT
        t_id as territory_id,
        c_id as realm_id,
        msg_count as message_count
    FROM territory_cluster_counts
    WHERE rank = 1;
END;
$$;

GRANT EXECUTE ON FUNCTION assign_territories_to_realms(UUID) TO authenticated;
