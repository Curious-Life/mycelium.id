-- =============================================
-- OBSIDIAN IMPORT SUPPORT
-- Adds note links tracking and document import metadata
-- =============================================

-- =============================================
-- NOTE LINKS (Wiki Link Graph)
-- =============================================

CREATE TABLE IF NOT EXISTS note_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    source_type TEXT NOT NULL,              -- 'document' | 'message'
    source_id UUID NOT NULL,
    source_path TEXT,                       -- Original path for resolution
    target_name TEXT NOT NULL,              -- [[this part]]
    target_path TEXT,                       -- Resolved path if found
    target_id UUID,                         -- Resolved document ID
    link_type TEXT NOT NULL,                -- 'wiki' | 'embed' | 'markdown'
    anchor TEXT,                            -- #heading or #^block-id
    display_text TEXT,                      -- [[target|this part]]
    resolved BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(user_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(user_id, target_name);
CREATE INDEX IF NOT EXISTS idx_note_links_target_id ON note_links(target_id) WHERE target_id IS NOT NULL;

-- =============================================
-- DOCUMENT EXTENSIONS
-- =============================================

-- Source type for deduplication and origin tracking
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'native';
-- Values: 'native' | 'claude_import' | 'obsidian' | 'openai_import'

-- Original path in source system (for dedup on re-import)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_path TEXT;

-- Content hash for change detection
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Index for source path lookups (deduplication)
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(user_id, source_type, source_path)
    WHERE source_type IS NOT NULL AND source_path IS NOT NULL;

-- =============================================
-- IMPORT JOBS (Progress Tracking)
-- =============================================

CREATE TABLE IF NOT EXISTS import_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    import_type TEXT NOT NULL,              -- 'obsidian' | 'claude' | 'openai'
    status TEXT DEFAULT 'pending',          -- 'pending' | 'processing' | 'complete' | 'failed'
    total_items INTEGER DEFAULT 0,
    processed_items INTEGER DEFAULT 0,
    stats JSONB DEFAULT '{}',
    errors JSONB DEFAULT '[]',
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_user ON import_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status) WHERE status = 'processing';

-- =============================================
-- RLS POLICIES
-- =============================================

ALTER TABLE note_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;

-- Note links: users can only access their own
CREATE POLICY note_links_owner ON note_links
    FOR ALL USING (user_id = auth.uid());

-- Import jobs: users can only access their own
CREATE POLICY import_jobs_owner ON import_jobs
    FOR ALL USING (user_id = auth.uid());

-- =============================================
-- GRANTS
-- =============================================

GRANT SELECT, INSERT, UPDATE, DELETE ON note_links TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON import_jobs TO authenticated;

-- =============================================
-- HELPER FUNCTIONS
-- =============================================

-- Resolve note links by matching target names to document paths
CREATE OR REPLACE FUNCTION resolve_note_links(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
    resolved_count INTEGER := 0;
BEGIN
    -- Match by exact path
    UPDATE note_links nl
    SET target_id = d.id,
        target_path = d.path,
        resolved = TRUE
    FROM documents d
    WHERE nl.user_id = p_user_id
      AND nl.resolved = FALSE
      AND d.user_id = p_user_id
      AND (
          -- Exact source_path match
          d.source_path = nl.target_name
          OR d.source_path = nl.target_name || '.md'
          -- Filename match (Obsidian default behavior)
          OR d.path LIKE '%/' || nl.target_name
          OR d.path LIKE '%/' || nl.target_name || '.md'
          OR d.path = nl.target_name
      );

    GET DIAGNOSTICS resolved_count = ROW_COUNT;
    RETURN resolved_count;
END;
$$ LANGUAGE plpgsql;

-- Get document by source path (for deduplication)
CREATE OR REPLACE FUNCTION get_document_by_source(
    p_user_id UUID,
    p_source_type TEXT,
    p_source_path TEXT
)
RETURNS UUID AS $$
DECLARE
    doc_id UUID;
BEGIN
    SELECT id INTO doc_id
    FROM documents
    WHERE user_id = p_user_id
      AND source_type = p_source_type
      AND source_path = p_source_path
    LIMIT 1;

    RETURN doc_id;
END;
$$ LANGUAGE plpgsql;
