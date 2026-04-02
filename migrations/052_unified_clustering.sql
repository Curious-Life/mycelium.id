-- =============================================
-- Unified Clustering Architecture
-- =============================================
-- This migration implements the new clustering pipeline:
-- 256D Nomic embeddings → HDBSCAN atoms → Ward hierarchy → UMAP projection
--
-- Key changes:
-- 1. clustering_points: Unified table for all embeddable content
-- 2. hierarchy_* tables: Store cluster metadata and centroids
-- 3. Supports messages, documents, voice transcripts, reflections

-- =============================================
-- 1. CLUSTERING POINTS (unified embedding table)
-- =============================================

CREATE TABLE IF NOT EXISTS clustering_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Source tracking
    source_type TEXT NOT NULL,  -- 'message', 'document', 'transcript', 'reflection', 'image_description'
    source_id UUID NOT NULL,    -- FK to source table (messages.id, documents.id, attachments.id, etc.)
    content TEXT NOT NULL,      -- The text content to embed

    -- Embedding (256D Nomic v1.5 with 'clustering:' prefix)
    embedding vector(256),
    embedding_model TEXT DEFAULT 'nomic-embed-text-v1.5',

    -- Hierarchy assignments (from Ward clustering)
    atom_id INT,                -- HDBSCAN cluster (fine-grained)
    territory_id INT,           -- Ward cut at ~250 clusters
    theme_id INT,               -- Ward cut at ~30 clusters
    realm_id INT,               -- Ward cut at ~5 clusters
    is_liminal BOOLEAN DEFAULT false,  -- True if HDBSCAN noise (soft-assigned)

    -- UMAP coordinates (for visualization)
    landscape_x FLOAT,          -- 3D x
    landscape_y FLOAT,          -- 3D y
    landscape_z FLOAT,          -- 3D z
    landscape_x_2d FLOAT,       -- 2D x (for mindmap view)
    landscape_y_2d FLOAT,       -- 2D y

    -- Versioning
    cluster_version TIMESTAMPTZ,  -- When this point was last clustered

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, source_type, source_id)
);

-- Indexes for clustering_points
CREATE INDEX IF NOT EXISTS idx_cp_user_source ON clustering_points(user_id, source_type);
CREATE INDEX IF NOT EXISTS idx_cp_needs_embedding ON clustering_points(user_id) WHERE embedding IS NULL;
CREATE INDEX IF NOT EXISTS idx_cp_atom ON clustering_points(user_id, atom_id);
CREATE INDEX IF NOT EXISTS idx_cp_territory ON clustering_points(user_id, territory_id);
CREATE INDEX IF NOT EXISTS idx_cp_theme ON clustering_points(user_id, theme_id);
CREATE INDEX IF NOT EXISTS idx_cp_realm ON clustering_points(user_id, realm_id);
CREATE INDEX IF NOT EXISTS idx_cp_liminal ON clustering_points(user_id, is_liminal) WHERE is_liminal = TRUE;
CREATE INDEX IF NOT EXISTS idx_cp_version ON clustering_points(user_id, cluster_version);

-- =============================================
-- 2. HIERARCHY METADATA TABLES
-- =============================================

-- Atoms (HDBSCAN clusters - fine-grained semantic neighborhoods)
CREATE TABLE IF NOT EXISTS hierarchy_atoms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    atom_id INT NOT NULL,
    territory_id INT NOT NULL,

    -- Centroid for similarity matching
    centroid vector(256),

    -- Stats
    message_count INT DEFAULT 0,

    -- AI-generated (optional, generated on-demand)
    label TEXT,
    description TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, atom_id)
);

CREATE INDEX IF NOT EXISTS idx_ha_territory ON hierarchy_atoms(user_id, territory_id);

-- Territories (~250 clusters from Ward)
CREATE TABLE IF NOT EXISTS hierarchy_territories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    territory_id INT NOT NULL,
    theme_id INT NOT NULL,
    realm_id INT NOT NULL,

    -- Centroid for similarity matching
    centroid vector(256),

    -- Stats
    message_count INT DEFAULT 0,
    atom_count INT DEFAULT 0,

    -- AI-generated
    name TEXT,
    essence TEXT,
    description TEXT,

    -- Entities extracted from content
    top_entities JSONB DEFAULT '[]',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, territory_id)
);

CREATE INDEX IF NOT EXISTS idx_ht_theme ON hierarchy_territories(user_id, theme_id);
CREATE INDEX IF NOT EXISTS idx_ht_realm ON hierarchy_territories(user_id, realm_id);

-- Themes (~30 clusters from Ward)
CREATE TABLE IF NOT EXISTS hierarchy_themes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    theme_id INT NOT NULL,
    realm_id INT NOT NULL,

    -- Centroid for similarity matching
    centroid vector(256),

    -- Stats
    message_count INT DEFAULT 0,
    territory_count INT DEFAULT 0,

    -- AI-generated
    name TEXT,
    essence TEXT,
    description TEXT,

    -- Entities
    top_entities JSONB DEFAULT '[]',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, theme_id)
);

CREATE INDEX IF NOT EXISTS idx_hth_realm ON hierarchy_themes(user_id, realm_id);

-- Realms (~5 clusters from Ward)
CREATE TABLE IF NOT EXISTS hierarchy_realms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    realm_id INT NOT NULL,

    -- Centroid for similarity matching
    centroid vector(256),

    -- Stats
    message_count INT DEFAULT 0,
    theme_count INT DEFAULT 0,
    territory_count INT DEFAULT 0,

    -- AI-generated
    name TEXT,
    essence TEXT,
    description TEXT,
    story TEXT,

    -- Entities
    top_entities JSONB DEFAULT '[]',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(user_id, realm_id)
);

-- =============================================
-- 3. HELPER FUNCTIONS
-- =============================================

-- Sync messages to clustering_points
CREATE OR REPLACE FUNCTION sync_messages_to_clustering_points(p_user_id UUID)
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
      AND NOT EXISTS (
          SELECT 1 FROM clustering_points cp
          WHERE cp.user_id = m.user_id
            AND cp.source_type = 'message'
            AND cp.source_id = m.id
      )
    ON CONFLICT (user_id, source_type, source_id) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    RETURN inserted_count;
END;
$$;

-- Sync documents to clustering_points
CREATE OR REPLACE FUNCTION sync_documents_to_clustering_points(p_user_id UUID)
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
        d.user_id,
        'document',
        d.id,
        d.content,
        d.created_at
    FROM documents d
    WHERE d.user_id = p_user_id
      AND d.content IS NOT NULL
      AND LENGTH(d.content) > 10
      AND NOT EXISTS (
          SELECT 1 FROM clustering_points cp
          WHERE cp.user_id = d.user_id
            AND cp.source_type = 'document'
            AND cp.source_id = d.id
      )
    ON CONFLICT (user_id, source_type, source_id) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    RETURN inserted_count;
END;
$$;

-- Sync voice transcripts to clustering_points
CREATE OR REPLACE FUNCTION sync_transcripts_to_clustering_points(p_user_id UUID)
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
        a.user_id,
        'transcript',
        a.id,
        a.transcript,
        a.created_at
    FROM attachments a
    WHERE a.user_id = p_user_id
      AND a.transcript IS NOT NULL
      AND LENGTH(a.transcript) > 10
      AND NOT EXISTS (
          SELECT 1 FROM clustering_points cp
          WHERE cp.user_id = a.user_id
            AND cp.source_type = 'transcript'
            AND cp.source_id = a.id
      )
    ON CONFLICT (user_id, source_type, source_id) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    RETURN inserted_count;
END;
$$;

-- Sync reflections to clustering_points
CREATE OR REPLACE FUNCTION sync_reflections_to_clustering_points(p_user_id UUID)
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
        r.user_id,
        'reflection',
        r.id,
        r.content,
        r.created_at
    FROM reflections r
    WHERE r.user_id = p_user_id
      AND r.content IS NOT NULL
      AND LENGTH(r.content) > 10
      AND NOT EXISTS (
          SELECT 1 FROM clustering_points cp
          WHERE cp.user_id = r.user_id
            AND cp.source_type = 'reflection'
            AND cp.source_id = r.id
      )
    ON CONFLICT (user_id, source_type, source_id) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    RETURN inserted_count;
END;
$$;

-- Sync image descriptions to clustering_points
CREATE OR REPLACE FUNCTION sync_image_descriptions_to_clustering_points(p_user_id UUID)
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
        a.user_id,
        'image_description',
        a.id,
        a.description,
        a.created_at
    FROM attachments a
    WHERE a.user_id = p_user_id
      AND a.attachment_type IN ('image', 'video')
      AND a.description IS NOT NULL
      AND LENGTH(a.description) > 10
      AND NOT EXISTS (
          SELECT 1 FROM clustering_points cp
          WHERE cp.user_id = a.user_id
            AND cp.source_type = 'image_description'
            AND cp.source_id = a.id
      )
    ON CONFLICT (user_id, source_type, source_id) DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    RETURN inserted_count;
END;
$$;

-- Sync all content types for a user
CREATE OR REPLACE FUNCTION sync_all_to_clustering_points(p_user_id UUID)
RETURNS TABLE (
    messages_added INT,
    documents_added INT,
    transcripts_added INT,
    reflections_added INT,
    image_descriptions_added INT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY SELECT
        sync_messages_to_clustering_points(p_user_id),
        sync_documents_to_clustering_points(p_user_id),
        sync_transcripts_to_clustering_points(p_user_id),
        sync_reflections_to_clustering_points(p_user_id),
        sync_image_descriptions_to_clustering_points(p_user_id);
END;
$$;

-- Bulk update embeddings for clustering_points
CREATE OR REPLACE FUNCTION bulk_update_clustering_embeddings(
    p_ids UUID[],
    p_embeddings vector(256)[]
)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    updated_count INT;
BEGIN
    UPDATE clustering_points cp SET
        embedding = u.embedding,
        updated_at = NOW()
    FROM (
        SELECT
            unnest(p_ids) AS id,
            unnest(p_embeddings) AS embedding
    ) u
    WHERE cp.id = u.id;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

-- Bulk update clustering results
CREATE OR REPLACE FUNCTION bulk_update_clustering_results(
    p_ids UUID[],
    p_atom_ids INT[],
    p_territory_ids INT[],
    p_theme_ids INT[],
    p_realm_ids INT[],
    p_is_liminal BOOLEAN[],
    p_x FLOAT[],
    p_y FLOAT[],
    p_z FLOAT[],
    p_x_2d FLOAT[],
    p_y_2d FLOAT[],
    p_version TIMESTAMPTZ
)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    updated_count INT;
BEGIN
    UPDATE clustering_points cp SET
        atom_id = u.atom_id,
        territory_id = u.territory_id,
        theme_id = u.theme_id,
        realm_id = u.realm_id,
        is_liminal = u.is_liminal,
        landscape_x = u.x,
        landscape_y = u.y,
        landscape_z = u.z,
        landscape_x_2d = u.x_2d,
        landscape_y_2d = u.y_2d,
        cluster_version = p_version,
        updated_at = NOW()
    FROM (
        SELECT
            unnest(p_ids) AS id,
            unnest(p_atom_ids) AS atom_id,
            unnest(p_territory_ids) AS territory_id,
            unnest(p_theme_ids) AS theme_id,
            unnest(p_realm_ids) AS realm_id,
            unnest(p_is_liminal) AS is_liminal,
            unnest(p_x) AS x,
            unnest(p_y) AS y,
            unnest(p_z) AS z,
            unnest(p_x_2d) AS x_2d,
            unnest(p_y_2d) AS y_2d
    ) u
    WHERE cp.id = u.id;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

-- Get clustering stats for a user
CREATE OR REPLACE FUNCTION get_clustering_stats(p_user_id UUID)
RETURNS TABLE (
    source_type TEXT,
    total_count BIGINT,
    embedded_count BIGINT,
    clustered_count BIGINT,
    liminal_count BIGINT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        cp.source_type,
        COUNT(*)::BIGINT as total_count,
        COUNT(cp.embedding)::BIGINT as embedded_count,
        COUNT(cp.cluster_version)::BIGINT as clustered_count,
        COUNT(*) FILTER (WHERE cp.is_liminal = true)::BIGINT as liminal_count
    FROM clustering_points cp
    WHERE cp.user_id = p_user_id
    GROUP BY cp.source_type
    ORDER BY cp.source_type;
END;
$$;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON clustering_points TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON hierarchy_atoms TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON hierarchy_territories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON hierarchy_themes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON hierarchy_realms TO service_role;

GRANT EXECUTE ON FUNCTION sync_messages_to_clustering_points(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION sync_documents_to_clustering_points(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION sync_transcripts_to_clustering_points(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION sync_reflections_to_clustering_points(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION sync_image_descriptions_to_clustering_points(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION sync_all_to_clustering_points(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION bulk_update_clustering_embeddings(UUID[], vector(256)[]) TO service_role;
GRANT EXECUTE ON FUNCTION bulk_update_clustering_results(UUID[], INT[], INT[], INT[], INT[], BOOLEAN[], FLOAT[], FLOAT[], FLOAT[], FLOAT[], FLOAT[], TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION get_clustering_stats(UUID) TO service_role;

-- Enable RLS
ALTER TABLE clustering_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE hierarchy_atoms ENABLE ROW LEVEL SECURITY;
ALTER TABLE hierarchy_territories ENABLE ROW LEVEL SECURITY;
ALTER TABLE hierarchy_themes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hierarchy_realms ENABLE ROW LEVEL SECURITY;

-- RLS policies (service_role bypass, users see their own)
CREATE POLICY "Users see own clustering_points" ON clustering_points
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access clustering_points" ON clustering_points
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users see own hierarchy_atoms" ON hierarchy_atoms
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access hierarchy_atoms" ON hierarchy_atoms
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users see own hierarchy_territories" ON hierarchy_territories
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access hierarchy_territories" ON hierarchy_territories
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users see own hierarchy_themes" ON hierarchy_themes
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access hierarchy_themes" ON hierarchy_themes
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users see own hierarchy_realms" ON hierarchy_realms
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role full access hierarchy_realms" ON hierarchy_realms
    FOR ALL USING (auth.role() = 'service_role');
