-- =============================================
-- Territory Profiles (Agent Identity Documents)
-- =============================================
-- Each cluster_3d value becomes a Territory with an AI agent identity.
-- Multi-user safe: composite unique key on (user_id, territory_id).

CREATE TABLE territory_profiles (
    id SERIAL PRIMARY KEY,
    territory_id INT NOT NULL,  -- Maps to cluster_3d
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Identity
    name TEXT NOT NULL,
    essence TEXT,
    archetype_type TEXT,
    archetype_character TEXT,

    -- Composition (cached counts)
    message_count INT DEFAULT 0,
    explored_count INT DEFAULT 0,
    explored_percent FLOAT DEFAULT 0,

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

    -- Agent Personality
    agent_expertise TEXT,
    agent_curious_about TEXT,
    agent_can_help_with TEXT[] DEFAULT '{}',
    agent_would_consult JSONB DEFAULT '[]',    -- [{territory_name, for}]

    -- Metadata
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    generation_model TEXT DEFAULT 'claude-haiku-4-5-20251001',
    generation_version INT DEFAULT 1,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Composite unique constraint for multi-user support
    UNIQUE(user_id, territory_id)
);

-- RLS
ALTER TABLE territory_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY territory_profiles_user_policy ON territory_profiles
    FOR ALL USING (user_id = auth.uid());

-- Index for efficient lookups
CREATE INDEX idx_territory_profiles_lookup ON territory_profiles(user_id, territory_id);

-- Function to get live territory stats
CREATE OR REPLACE FUNCTION get_territory_stats(p_user_id UUID, p_territory_id INT)
RETURNS TABLE (
    message_count BIGINT,
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
        COUNT(DISTINCT theme_id)::BIGINT as theme_count,
        MIN(created_at) as first_message,
        MAX(created_at) as last_message,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::BIGINT as messages_7d,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::BIGINT as messages_30d,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '90 days')::BIGINT as messages_90d
    FROM messages
    WHERE user_id = p_user_id
      AND cluster_3d = p_territory_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_territory_stats(UUID, INT) TO authenticated;
