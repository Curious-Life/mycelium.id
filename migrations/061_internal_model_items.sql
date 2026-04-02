-- Migration: Add internal_model_items table for decay/reinforcement tracking
-- This enables hypotheses and questions to decay over time unless reinforced

-- Create the internal model items table
CREATE TABLE IF NOT EXISTS internal_model_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Item classification
  section TEXT NOT NULL,  -- 'hypotheses', 'questions', 'observations', 'contradictions', 'patterns', 'dream_fragments'
  content TEXT NOT NULL,

  -- Embedding for semantic matching (reinforcement detection)
  embedding vector(1024),

  -- Lifecycle tracking
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_reinforced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reinforcement_count INTEGER NOT NULL DEFAULT 1,

  -- Status: active (normal), promoted (stable belief), archived (decayed), resolved (contradiction resolved)
  status TEXT NOT NULL DEFAULT 'active',

  -- Optional: link to source (e.g., reflection that created it, dream cycle)
  source_cycle_id UUID REFERENCES cycle_metrics(id) ON DELETE SET NULL,

  -- Metadata for tracking
  metadata JSONB DEFAULT '{}'
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_internal_model_items_user_section
  ON internal_model_items(user_id, section)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_internal_model_items_user_status
  ON internal_model_items(user_id, status);

CREATE INDEX IF NOT EXISTS idx_internal_model_items_reinforcement
  ON internal_model_items(user_id, last_reinforced_at, reinforcement_count)
  WHERE status = 'active';

-- Index for semantic search (reinforcement detection)
CREATE INDEX IF NOT EXISTS idx_internal_model_items_embedding
  ON internal_model_items
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- Comments for documentation
COMMENT ON TABLE internal_model_items IS 'Tracks internal model items (hypotheses, questions, etc.) with decay/reinforcement lifecycle';
COMMENT ON COLUMN internal_model_items.section IS 'Category: hypotheses, questions, observations, contradictions, patterns, dream_fragments';
COMMENT ON COLUMN internal_model_items.reinforcement_count IS 'Number of times this item has been reinforced (semantic match in conversation/reflection)';
COMMENT ON COLUMN internal_model_items.status IS 'Lifecycle status: active, promoted (stable), archived (decayed), resolved';

-- RPC function for semantic matching (reinforcement detection)
CREATE OR REPLACE FUNCTION match_internal_model_items(
  query_embedding vector(1024),
  match_user_id uuid,
  match_threshold float DEFAULT 0.75,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  section text,
  content text,
  created_at timestamptz,
  last_reinforced_at timestamptz,
  reinforcement_count integer,
  status text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    imi.id,
    imi.user_id,
    imi.section,
    imi.content,
    imi.created_at,
    imi.last_reinforced_at,
    imi.reinforcement_count,
    imi.status,
    1 - (imi.embedding <=> query_embedding) AS similarity
  FROM internal_model_items imi
  WHERE imi.user_id = match_user_id
    AND imi.status = 'active'
    AND imi.embedding IS NOT NULL
    AND 1 - (imi.embedding <=> query_embedding) > match_threshold
  ORDER BY imi.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
