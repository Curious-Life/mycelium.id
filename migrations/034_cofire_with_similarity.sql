-- Migration: Enhanced co-fire query with semantic similarity
-- Purpose: Return both co-fire strength AND semantic similarity so Mya
--          can identify interesting gaps (high cofire + low semantic or vice versa)

-- =============================================================================
-- FUNCTION: get_cofire_territories (v2)
-- Now returns semantic_similarity alongside cofire_strength
-- =============================================================================

CREATE OR REPLACE FUNCTION get_cofire_territories(
  p_user_id UUID,
  p_territory_id INT,
  p_scale TEXT DEFAULT 'session',
  p_min_strength FLOAT DEFAULT 0.1,
  p_limit INT DEFAULT 10
)
RETURNS TABLE(
  territory_id INT,
  name TEXT,
  essence TEXT,
  cofire_strength FLOAT,
  semantic_similarity FLOAT,
  last_cofire_at TIMESTAMPTZ,
  message_count INT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_strength_column TEXT;
  v_source_embedding vector(1024);
BEGIN
  -- Get source territory embedding for similarity calc
  SELECT embedding INTO v_source_embedding
  FROM territory_profiles
  WHERE user_id = p_user_id AND territory_id = p_territory_id;

  v_strength_column := CASE p_scale
    WHEN 'immediate' THEN 'cofire_immediate'
    WHEN 'session' THEN 'cofire_session'
    WHEN 'daily' THEN 'cofire_daily'
    WHEN 'weekly' THEN 'cofire_weekly'
    ELSE 'cofire_session'
  END;

  RETURN QUERY EXECUTE format('
    SELECT
      CASE
        WHEN cf.territory_a = $2 THEN cf.territory_b
        ELSE cf.territory_a
      END as territory_id,
      tp.name,
      tp.essence,
      cf.%I as cofire_strength,
      CASE
        WHEN $5 IS NOT NULL AND tp.embedding IS NOT NULL
        THEN (1 - (tp.embedding <=> $5))::FLOAT
        ELSE NULL
      END as semantic_similarity,
      cf.last_cofire_at,
      tp.message_count
    FROM territory_cofire cf
    JOIN territory_profiles tp ON (
      CASE
        WHEN cf.territory_a = $2 THEN cf.territory_b
        ELSE cf.territory_a
      END = tp.territory_id
      AND tp.user_id = $1
    )
    WHERE cf.user_id = $1
      AND (cf.territory_a = $2 OR cf.territory_b = $2)
      AND cf.%I >= $3
    ORDER BY cf.%I DESC
    LIMIT $4
  ', v_strength_column, v_strength_column, v_strength_column)
  USING p_user_id, p_territory_id, p_min_strength, p_limit, v_source_embedding;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION get_cofire_territories(UUID, INT, TEXT, FLOAT, INT) TO authenticated, service_role;
