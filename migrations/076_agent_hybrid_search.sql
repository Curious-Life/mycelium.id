-- Migration 076: Agent-scoped hybrid search function
-- Provides semantic + full-text search for agent messages (Discord bot, etc.)
-- Filters by agent_id instead of user_id for security isolation

CREATE OR REPLACE FUNCTION agent_hybrid_search(
  p_agent_id TEXT,
  p_query TEXT,
  p_query_embedding VECTOR(1024),
  p_after TIMESTAMPTZ DEFAULT NULL,
  p_before TIMESTAMPTZ DEFAULT NULL,
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  result_id UUID,
  result_type TEXT,
  result_content TEXT,
  result_snippet TEXT,
  result_created_at TIMESTAMPTZ,
  result_score FLOAT,
  result_metadata JSONB
) AS $$
DECLARE
  k_rrf INT := 60;  -- RRF constant for score fusion
  v_tsquery tsquery;
BEGIN
  v_tsquery := plainto_tsquery('english', p_query);

  RETURN QUERY
  WITH
  -- Full-text search results
  messages_fts AS (
    SELECT
      m.id,
      'message'::TEXT as type,
      m.content,
      ts_headline('english', m.content, v_tsquery,
        'MaxWords=30, MinWords=15, StartSel=<mark>, StopSel=</mark>') as snippet,
      m.created_at,
      m.metadata,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(m.fts, v_tsquery) DESC) as rank
    FROM messages m
    WHERE m.agent_id = p_agent_id
      AND m.fts @@ v_tsquery
      AND (p_after IS NULL OR m.created_at >= p_after)
      AND (p_before IS NULL OR m.created_at <= p_before)
    LIMIT 50
  ),

  -- Vector similarity search results
  messages_vec AS (
    SELECT
      m.id,
      'message'::TEXT as type,
      m.content,
      LEFT(m.content, 200) as snippet,
      m.created_at,
      m.metadata,
      ROW_NUMBER() OVER (ORDER BY m.embedding <=> p_query_embedding) as rank
    FROM messages m
    WHERE m.agent_id = p_agent_id
      AND m.embedding IS NOT NULL
      AND (p_after IS NULL OR m.created_at >= p_after)
      AND (p_before IS NULL OR m.created_at <= p_before)
    ORDER BY m.embedding <=> p_query_embedding
    LIMIT 50
  ),

  -- Reciprocal Rank Fusion to combine FTS and vector scores
  messages_rrf AS (
    SELECT
      COALESCE(f.id, v.id) as id,
      'message'::TEXT as type,
      COALESCE(f.content, v.content) as content,
      COALESCE(f.snippet, v.snippet) as snippet,
      COALESCE(f.created_at, v.created_at) as created_at,
      COALESCE(f.metadata, v.metadata) as metadata,
      (COALESCE(1.0 / (k_rrf + f.rank), 0) + COALESCE(1.0 / (k_rrf + v.rank), 0))::FLOAT as score
    FROM messages_fts f
    FULL OUTER JOIN messages_vec v ON f.id = v.id
  )

  SELECT
    id as result_id,
    type as result_type,
    content as result_content,
    snippet as result_snippet,
    created_at as result_created_at,
    score as result_score,
    metadata as result_metadata
  FROM messages_rrf
  ORDER BY score DESC
  LIMIT p_limit;

END;
$$ LANGUAGE plpgsql;

-- Grant execute to service role (for backend calls)
GRANT EXECUTE ON FUNCTION agent_hybrid_search TO service_role;

-- Also allow authenticated users (if agent runs with user auth)
GRANT EXECUTE ON FUNCTION agent_hybrid_search TO authenticated;

COMMENT ON FUNCTION agent_hybrid_search IS
'Hybrid search (semantic + full-text) scoped by agent_id.
Used by company agent and other agents to search their own message history.
Security: Only returns messages matching the specified agent_id.';
