-- =============================================
-- MYA NLP Pipeline - Schema Extension
-- Adds GLiNER entities, relations, and clustering support
-- =============================================

-- =============================================
-- MESSAGES TABLE EXTENSIONS
-- =============================================

-- GLiNER entity extraction results
-- Format: [{"label": "emotional_state", "text": "anxious", "start": 10, "end": 17, "score": 0.85}]
ALTER TABLE messages ADD COLUMN IF NOT EXISTS entities JSONB;

-- GLiNER relation extraction results
-- Format: [{"head": "meditation", "tail": "peaceful", "label": "practice improves state", "score": 0.72}]
ALTER TABLE messages ADD COLUMN IF NOT EXISTS relations JSONB;

-- Entity summary for embedding enrichment (e.g., "[person:Una] [goal:launch]")
ALTER TABLE messages ADD COLUMN IF NOT EXISTS entity_summary TEXT;

-- Clustering outputs (populated by nightly batch job)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS cluster_id INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS landscape_x FLOAT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS landscape_y FLOAT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS landscape_z FLOAT;

-- NLP processing state (for async queue processing)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS nlp_processed BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS nlp_processed_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS nlp_error TEXT;

-- =============================================
-- DOCUMENTS TABLE EXTENSIONS
-- =============================================

-- Documents also get entity extraction and clustering
ALTER TABLE documents ADD COLUMN IF NOT EXISTS entities JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS relations JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS entity_summary TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS cluster_id INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS landscape_x FLOAT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS landscape_y FLOAT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS landscape_z FLOAT;

-- =============================================
-- BATCH JOBS TABLE
-- =============================================

CREATE TABLE IF NOT EXISTS batch_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type TEXT NOT NULL,  -- 'entity_extraction', 'embedding', 'clustering'
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'running', 'completed', 'failed'
    total_items INTEGER,
    processed_items INTEGER DEFAULT 0,
    failed_items INTEGER DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- INDEXES
-- =============================================

-- Find unprocessed messages for queue backfill
CREATE INDEX IF NOT EXISTS idx_messages_nlp_unprocessed
    ON messages(nlp_processed) WHERE nlp_processed = false;

-- Cluster-based queries
CREATE INDEX IF NOT EXISTS idx_messages_cluster
    ON messages(cluster_id) WHERE cluster_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_cluster
    ON documents(cluster_id) WHERE cluster_id IS NOT NULL;

-- GIN index for entity queries (find messages with specific entity types)
CREATE INDEX IF NOT EXISTS idx_messages_entities_gin
    ON messages USING gin(entities);

CREATE INDEX IF NOT EXISTS idx_documents_entities_gin
    ON documents USING gin(entities);

-- Batch job status queries
CREATE INDEX IF NOT EXISTS idx_batch_jobs_status
    ON batch_jobs(status, created_at DESC);

-- =============================================
-- HELPER FUNCTIONS
-- =============================================

-- Atomically increment batch job progress (called by Modal workers)
CREATE OR REPLACE FUNCTION increment_batch_progress(
    p_job_id UUID,
    p_processed_count INTEGER,
    p_failed_count INTEGER
) RETURNS void AS $$
BEGIN
    UPDATE batch_jobs
    SET
        processed_items = processed_items + p_processed_count,
        failed_items = failed_items + p_failed_count
    WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql;

-- Get cluster summary with top entities
CREATE OR REPLACE FUNCTION get_cluster_summary(p_user_id UUID)
RETURNS TABLE (
    cluster_id INTEGER,
    message_count BIGINT,
    top_entities JSONB,
    date_range TSTZRANGE
) AS $$
BEGIN
    RETURN QUERY
    WITH entity_counts AS (
        SELECT
            m.cluster_id,
            e->>'label' AS label,
            e->>'text' AS entity_text,
            COUNT(*) AS cnt
        FROM messages m,
             jsonb_array_elements(m.entities) AS e
        WHERE m.user_id = p_user_id
          AND m.cluster_id IS NOT NULL
          AND m.cluster_id != -1
        GROUP BY m.cluster_id, e->>'label', e->>'text'
    ),
    ranked_entities AS (
        SELECT
            ec.cluster_id,
            jsonb_build_object('label', ec.label, 'text', ec.entity_text, 'count', ec.cnt) AS entity,
            ROW_NUMBER() OVER (PARTITION BY ec.cluster_id ORDER BY ec.cnt DESC) AS rn
        FROM entity_counts ec
    )
    SELECT
        m.cluster_id,
        COUNT(DISTINCT m.id) AS message_count,
        COALESCE(jsonb_agg(re.entity) FILTER (WHERE re.rn <= 10), '[]'::jsonb) AS top_entities,
        tstzrange(MIN(m.created_at), MAX(m.created_at)) AS date_range
    FROM messages m
    LEFT JOIN ranked_entities re ON m.cluster_id = re.cluster_id
    WHERE m.user_id = p_user_id
      AND m.cluster_id IS NOT NULL
      AND m.cluster_id != -1
    GROUP BY m.cluster_id;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================

-- batch_jobs uses service role only (no user access)
ALTER TABLE batch_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON batch_jobs
    FOR ALL USING (true);

-- =============================================
-- BACKFILL: Mark existing messages as needing NLP processing
-- =============================================

-- Set nlp_processed = false for all existing messages so they get queued
-- Comment this out if you don't want to backfill existing messages
UPDATE messages SET nlp_processed = false WHERE nlp_processed IS NULL;
UPDATE documents SET entities = NULL WHERE entities IS NULL;
