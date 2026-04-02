-- Migration: Topology queries for dream cycle
-- Purpose: SQL functions to find global gaps and unexpected connections
--          for topology-aware autonomous reflection

-- =============================================================================
-- FUNCTION: get_global_cofire_gaps
-- Find territory pairs with high semantic similarity but low co-fire
-- These are unexplored connections worth investigating
-- =============================================================================

CREATE OR REPLACE FUNCTION get_global_cofire_gaps(
  p_user_id UUID,
  p_min_similarity FLOAT DEFAULT 0.65,
  p_max_cofire FLOAT DEFAULT 10.0,  -- Absolute threshold, not relative
  p_limit INT DEFAULT 10
)
RETURNS TABLE(
  territory_a_id INT,
  territory_a_name TEXT,
  territory_b_id INT,
  territory_b_name TEXT,
  semantic_similarity FLOAT,
  cofire_strength FLOAT,
  gap_score FLOAT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH territory_pairs AS (
    SELECT
      tp1.territory_id as t1_id,
      tp1.name as t1_name,
      tp2.territory_id as t2_id,
      tp2.name as t2_name,
      (1 - (tp1.embedding <=> tp2.embedding))::FLOAT as sim
    FROM territory_profiles tp1
    CROSS JOIN territory_profiles tp2
    WHERE tp1.user_id = p_user_id
      AND tp2.user_id = p_user_id
      AND tp1.territory_id < tp2.territory_id
      AND tp1.embedding IS NOT NULL
      AND tp2.embedding IS NOT NULL
      AND (1 - (tp1.embedding <=> tp2.embedding)) >= p_min_similarity
  )
  SELECT
    tp.t1_id as territory_a_id,
    tp.t1_name as territory_a_name,
    tp.t2_id as territory_b_id,
    tp.t2_name as territory_b_name,
    tp.sim as semantic_similarity,
    COALESCE(cf.cofire_weekly, 0)::FLOAT as cofire_strength,
    (tp.sim - LEAST(COALESCE(cf.cofire_weekly, 0) / 100.0, 1.0))::FLOAT as gap_score
  FROM territory_pairs tp
  LEFT JOIN territory_cofire cf ON (
    cf.user_id = p_user_id
    AND cf.territory_a = tp.t1_id
    AND cf.territory_b = tp.t2_id
  )
  WHERE COALESCE(cf.cofire_weekly, 0) <= p_max_cofire
  ORDER BY gap_score DESC
  LIMIT p_limit;
END;
$$;

-- =============================================================================
-- FUNCTION: get_unexpected_connections
-- Find territory pairs with high co-fire but low semantic similarity
-- These reveal hidden connections in the owner's thinking
-- =============================================================================

CREATE OR REPLACE FUNCTION get_unexpected_connections(
  p_user_id UUID,
  p_max_similarity FLOAT DEFAULT 0.35,
  p_min_cofire_relative FLOAT DEFAULT 0.5,  -- Relative to max cofire for user
  p_limit INT DEFAULT 10
)
RETURNS TABLE(
  territory_a_id INT,
  territory_a_name TEXT,
  territory_b_id INT,
  territory_b_name TEXT,
  semantic_similarity FLOAT,
  cofire_strength FLOAT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_max_cofire FLOAT;
BEGIN
  -- Get max cofire for this user to compute relative threshold
  SELECT MAX(cofire_weekly) INTO v_max_cofire
  FROM territory_cofire
  WHERE user_id = p_user_id;

  IF v_max_cofire IS NULL OR v_max_cofire = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    cf.territory_a as territory_a_id,
    tp1.name as territory_a_name,
    cf.territory_b as territory_b_id,
    tp2.name as territory_b_name,
    CASE
      WHEN tp1.embedding IS NOT NULL AND tp2.embedding IS NOT NULL
      THEN (1 - (tp1.embedding <=> tp2.embedding))::FLOAT
      ELSE NULL
    END as semantic_similarity,
    cf.cofire_weekly as cofire_strength
  FROM territory_cofire cf
  JOIN territory_profiles tp1 ON (
    tp1.user_id = cf.user_id
    AND tp1.territory_id = cf.territory_a
  )
  JOIN territory_profiles tp2 ON (
    tp2.user_id = cf.user_id
    AND tp2.territory_id = cf.territory_b
  )
  WHERE cf.user_id = p_user_id
    AND cf.cofire_weekly >= (v_max_cofire * p_min_cofire_relative)
    AND tp1.embedding IS NOT NULL
    AND tp2.embedding IS NOT NULL
    AND (1 - (tp1.embedding <=> tp2.embedding)) <= p_max_similarity
  ORDER BY cf.cofire_weekly DESC
  LIMIT p_limit;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION get_global_cofire_gaps(UUID, FLOAT, FLOAT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_unexpected_connections(UUID, FLOAT, FLOAT, INT) TO authenticated, service_role;
