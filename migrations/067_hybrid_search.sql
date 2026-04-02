-- Migration: Hybrid Search (Full-text + Vector)
-- Adds tsvector columns, GIN indexes, and hybrid_search function

-- ============================================================================
-- PART 1: Add tsvector columns (nullable, not generated to avoid table lock)
-- ============================================================================

-- Messages: full-text on content
ALTER TABLE messages ADD COLUMN IF NOT EXISTS fts tsvector;

-- Documents: full-text on title + content
ALTER TABLE documents ADD COLUMN IF NOT EXISTS fts tsvector;

-- Attachments: full-text on transcript + description
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS fts tsvector;

-- ============================================================================
-- PART 2: Create GIN indexes for full-text search
-- Note: In production, run these with CONCURRENTLY outside transaction
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_documents_fts ON documents USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_attachments_fts ON attachments USING GIN (fts);

-- ============================================================================
-- PART 3: Triggers to auto-populate fts on INSERT/UPDATE
-- ============================================================================

-- Messages trigger
CREATE OR REPLACE FUNCTION messages_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_fts_update ON messages;
CREATE TRIGGER messages_fts_update
  BEFORE INSERT OR UPDATE OF content ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_fts_trigger();

-- Documents trigger
CREATE OR REPLACE FUNCTION documents_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts := to_tsvector('english',
    COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_fts_update ON documents;
CREATE TRIGGER documents_fts_update
  BEFORE INSERT OR UPDATE OF title, content ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_fts_trigger();

-- Attachments trigger
CREATE OR REPLACE FUNCTION attachments_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts := to_tsvector('english',
    COALESCE(NEW.transcript, '') || ' ' || COALESCE(NEW.description, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS attachments_fts_update ON attachments;
CREATE TRIGGER attachments_fts_update
  BEFORE INSERT OR UPDATE OF transcript, description ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_fts_trigger();

-- ============================================================================
-- PART 4: Backfill function (run separately, in batches)
-- ============================================================================

CREATE OR REPLACE FUNCTION backfill_fts(
  p_table TEXT,
  p_batch_size INT DEFAULT 1000
) RETURNS INT AS $$
DECLARE
  v_updated INT := 0;
  v_batch INT;
BEGIN
  LOOP
    IF p_table = 'messages' THEN
      UPDATE messages
      SET fts = to_tsvector('english', COALESCE(content, ''))
      WHERE id IN (
        SELECT id FROM messages WHERE fts IS NULL LIMIT p_batch_size
      );
    ELSIF p_table = 'documents' THEN
      UPDATE documents
      SET fts = to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(content, ''))
      WHERE id IN (
        SELECT id FROM documents WHERE fts IS NULL LIMIT p_batch_size
      );
    ELSIF p_table = 'attachments' THEN
      UPDATE attachments
      SET fts = to_tsvector('english', COALESCE(transcript, '') || ' ' || COALESCE(description, ''))
      WHERE id IN (
        SELECT id FROM attachments WHERE fts IS NULL LIMIT p_batch_size
      );
    END IF;

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_updated := v_updated + v_batch;

    EXIT WHEN v_batch = 0;

    -- Brief pause to reduce load
    PERFORM pg_sleep(0.1);
  END LOOP;

  RETURN v_updated;
END;
$$ LANGUAGE plpgsql;

-- Run backfill (comment out if running separately):
-- SELECT backfill_fts('messages');
-- SELECT backfill_fts('documents');
-- SELECT backfill_fts('attachments');

-- ============================================================================
-- PART 5: Hybrid Search Function
-- ============================================================================

CREATE OR REPLACE FUNCTION hybrid_search(
  p_user_id UUID,
  p_query TEXT,
  p_query_embedding VECTOR(1024),
  p_types TEXT[] DEFAULT ARRAY['messages', 'documents', 'people', 'territories', 'attachments'],
  p_after TIMESTAMPTZ DEFAULT NULL,
  p_before TIMESTAMPTZ DEFAULT NULL,
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  result_id UUID,
  result_type TEXT,
  result_title TEXT,
  result_content TEXT,
  result_snippet TEXT,
  result_path TEXT,
  result_territory_id INT,
  result_territory_name TEXT,
  result_created_at TIMESTAMPTZ,
  result_score FLOAT
) AS $$
DECLARE
  k_rrf INT := 60;  -- RRF constant (standard value, don't change without testing)
  v_tsquery tsquery;
BEGIN
  -- Parse query once
  v_tsquery := plainto_tsquery('english', p_query);

  RETURN QUERY
  WITH
  -- =========================================================================
  -- MESSAGES: Full-text search
  -- =========================================================================
  messages_fts AS (
    SELECT
      m.id,
      'message'::TEXT as type,
      NULL::TEXT as title,
      m.content,
      ts_headline('english', m.content, v_tsquery,
        'MaxWords=30, MinWords=15, StartSel=<mark>, StopSel=</mark>') as snippet,
      NULL::TEXT as path,
      m.cluster_id as territory_id,
      m.created_at,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.fts, v_tsquery) DESC) as rank
    FROM messages m
    WHERE 'messages' = ANY(p_types)
      AND m.user_id = p_user_id
      AND m.fts @@ v_tsquery
      AND (p_after IS NULL OR m.created_at >= p_after)
      AND (p_before IS NULL OR m.created_at <= p_before)
    LIMIT 50
  ),

  -- MESSAGES: Vector search
  messages_vec AS (
    SELECT
      m.id,
      'message'::TEXT as type,
      NULL::TEXT as title,
      m.content,
      LEFT(m.content, 200) as snippet,
      NULL::TEXT as path,
      m.cluster_id as territory_id,
      m.created_at,
      ROW_NUMBER() OVER (ORDER BY m.embedding <=> p_query_embedding) as rank
    FROM messages m
    WHERE 'messages' = ANY(p_types)
      AND m.user_id = p_user_id
      AND m.embedding IS NOT NULL
      AND (p_after IS NULL OR m.created_at >= p_after)
      AND (p_before IS NULL OR m.created_at <= p_before)
    ORDER BY m.embedding <=> p_query_embedding
    LIMIT 50
  ),

  -- MESSAGES: RRF fusion
  messages_rrf AS (
    SELECT
      COALESCE(f.id, v.id) as id,
      'message'::TEXT as type,
      NULL::TEXT as title,
      COALESCE(f.content, v.content) as content,
      COALESCE(f.snippet, v.snippet) as snippet,
      NULL::TEXT as path,
      COALESCE(f.territory_id, v.territory_id) as territory_id,
      COALESCE(f.created_at, v.created_at) as created_at,
      (COALESCE(1.0 / (k_rrf + f.rank), 0) + COALESCE(1.0 / (k_rrf + v.rank), 0))::FLOAT as score
    FROM messages_fts f
    FULL OUTER JOIN messages_vec v ON f.id = v.id
  ),

  -- =========================================================================
  -- DOCUMENTS: Full-text search
  -- =========================================================================
  documents_fts AS (
    SELECT
      d.id,
      'document'::TEXT as type,
      d.title,
      d.content,
      ts_headline('english', d.content, v_tsquery,
        'MaxWords=30, MinWords=15, StartSel=<mark>, StopSel=</mark>') as snippet,
      d.path,
      d.cluster_id as territory_id,
      d.created_at,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(d.fts, v_tsquery) DESC) as rank
    FROM documents d
    WHERE 'documents' = ANY(p_types)
      AND d.user_id = p_user_id
      AND d.fts @@ v_tsquery
      AND (p_after IS NULL OR d.created_at >= p_after)
      AND (p_before IS NULL OR d.created_at <= p_before)
    LIMIT 50
  ),

  -- DOCUMENTS: Vector search
  documents_vec AS (
    SELECT
      d.id,
      'document'::TEXT as type,
      d.title,
      d.content,
      LEFT(d.content, 200) as snippet,
      d.path,
      d.cluster_id as territory_id,
      d.created_at,
      ROW_NUMBER() OVER (ORDER BY d.embedding <=> p_query_embedding) as rank
    FROM documents d
    WHERE 'documents' = ANY(p_types)
      AND d.user_id = p_user_id
      AND d.embedding IS NOT NULL
      AND (p_after IS NULL OR d.created_at >= p_after)
      AND (p_before IS NULL OR d.created_at <= p_before)
    ORDER BY d.embedding <=> p_query_embedding
    LIMIT 50
  ),

  -- DOCUMENTS: RRF fusion
  documents_rrf AS (
    SELECT
      COALESCE(f.id, v.id) as id,
      'document'::TEXT as type,
      COALESCE(f.title, v.title) as title,
      COALESCE(f.content, v.content) as content,
      COALESCE(f.snippet, v.snippet) as snippet,
      COALESCE(f.path, v.path) as path,
      COALESCE(f.territory_id, v.territory_id) as territory_id,
      COALESCE(f.created_at, v.created_at) as created_at,
      (COALESCE(1.0 / (k_rrf + f.rank), 0) + COALESCE(1.0 / (k_rrf + v.rank), 0))::FLOAT as score
    FROM documents_fts f
    FULL OUTER JOIN documents_vec v ON f.id = v.id
  ),

  -- =========================================================================
  -- ATTACHMENTS: Full-text search only (no embeddings on attachments)
  -- =========================================================================
  attachments_results AS (
    SELECT
      a.id,
      'attachment'::TEXT as type,
      COALESCE(a.description, 'Attachment') as title,
      COALESCE(a.transcript, a.description, '') as content,
      ts_headline('english', COALESCE(a.transcript, a.description, ''), v_tsquery,
        'MaxWords=30, MinWords=15, StartSel=<mark>, StopSel=</mark>') as snippet,
      NULL::TEXT as path,
      NULL::INT as territory_id,
      a.created_at,
      -- FTS-only score, normalized to RRF scale
      (1.0 / (k_rrf + ROW_NUMBER() OVER (ORDER BY ts_rank_cd(a.fts, v_tsquery) DESC)))::FLOAT as score
    FROM attachments a
    WHERE 'attachments' = ANY(p_types)
      AND a.user_id = p_user_id
      AND a.fts @@ v_tsquery
      AND (p_after IS NULL OR a.created_at >= p_after)
      AND (p_before IS NULL OR a.created_at <= p_before)
    LIMIT 20
  ),

  -- =========================================================================
  -- PEOPLE: Simple text match
  -- =========================================================================
  people_results AS (
    SELECT
      p.id,
      'person'::TEXT as type,
      p.name as title,
      p.relationship as content,
      p.relationship as snippet,
      p.document_path as path,
      NULL::INT as territory_id,
      p.created_at,
      -- Exact name match scores higher
      (CASE
        WHEN LOWER(p.name) = LOWER(p_query) THEN 0.05
        WHEN LOWER(p.name) LIKE LOWER(p_query) || '%' THEN 0.03
        ELSE 0.02
      END)::FLOAT as score
    FROM people p
    WHERE 'people' = ANY(p_types)
      AND p.user_id = p_user_id
      AND p.name ILIKE '%' || p_query || '%'
    LIMIT 10
  ),

  -- =========================================================================
  -- TERRITORIES: Text match on name/essence
  -- =========================================================================
  territory_results AS (
    SELECT
      NULL::UUID as id,
      'territory'::TEXT as type,
      t.name as title,
      t.essence as content,
      t.essence as snippet,
      NULL::TEXT as path,
      t.territory_id,
      NULL::TIMESTAMPTZ as created_at,
      -- Territory matches get moderate score
      (CASE
        WHEN LOWER(t.name) LIKE '%' || LOWER(p_query) || '%' THEN 0.04
        ELSE 0.025
      END)::FLOAT as score
    FROM territory_profiles t
    WHERE 'territories' = ANY(p_types)
      AND t.user_id = p_user_id
      AND (t.name ILIKE '%' || p_query || '%' OR t.essence ILIKE '%' || p_query || '%')
    LIMIT 10
  ),

  -- =========================================================================
  -- COMBINE ALL RESULTS
  -- =========================================================================
  all_results AS (
    SELECT id, type, title, content, snippet, path, territory_id, created_at, score
    FROM messages_rrf
    UNION ALL
    SELECT id, type, title, content, snippet, path, territory_id, created_at, score
    FROM documents_rrf
    UNION ALL
    SELECT id, type, title, content, snippet, path, territory_id, created_at, score
    FROM attachments_results
    UNION ALL
    SELECT id, type, title, content, snippet, path, territory_id, created_at, score
    FROM people_results
    UNION ALL
    SELECT id, type, title, content, snippet, path, territory_id, created_at, score
    FROM territory_results
  ),

  -- Add territory names via join
  results_with_territory AS (
    SELECT
      r.id,
      r.type,
      r.title,
      r.content,
      r.snippet,
      r.path,
      r.territory_id,
      tp.name as territory_name,
      r.created_at,
      r.score
    FROM all_results r
    LEFT JOIN territory_profiles tp ON r.territory_id = tp.territory_id AND tp.user_id = p_user_id
  )

  SELECT
    id as result_id,
    type as result_type,
    title as result_title,
    content as result_content,
    snippet as result_snippet,
    path as result_path,
    territory_id as result_territory_id,
    territory_name as result_territory_name,
    created_at as result_created_at,
    score as result_score
  FROM results_with_territory
  ORDER BY score DESC
  LIMIT p_limit;

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PART 6: Grant permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION hybrid_search TO authenticated;
GRANT EXECUTE ON FUNCTION backfill_fts TO service_role;

-- ============================================================================
-- Usage examples:
--
-- Basic search:
-- SELECT * FROM hybrid_search(
--   'user-uuid-here',
--   'funding strategy',
--   '[0.1, 0.2, ...]'::vector(1024)
-- );
--
-- Filtered search:
-- SELECT * FROM hybrid_search(
--   'user-uuid-here',
--   'meeting notes',
--   '[...]'::vector(1024),
--   ARRAY['messages', 'documents'],  -- types filter
--   '2026-01-01'::timestamptz,       -- after
--   NULL,                             -- before
--   10                                -- limit
-- );
-- ============================================================================
