-- Migration: Territory Co-firing Substrate
-- Purpose: Track which territories actually fire together in conversation,
--          enabling Mya to distinguish "what could relate" (semantic similarity)
--          from "what actually relates in the owner's mind" (observed co-occurrence).

-- =============================================================================
-- TABLE: territory_cofire
-- Stores co-occurrence weights between territory pairs at multiple temporal scales
-- =============================================================================

CREATE TABLE IF NOT EXISTS territory_cofire (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  territory_a INT NOT NULL,  -- Lower territory_id (enforced by CHECK)
  territory_b INT NOT NULL,  -- Higher territory_id

  -- Multi-scale co-firing weights (temporal decay, not raw counts)
  -- Each scale uses exponential decay: weight = exp(-time_delta / half_life)
  cofire_immediate FLOAT DEFAULT 0,  -- half-life 1h: focused work sessions
  cofire_session FLOAT DEFAULT 0,    -- half-life 4h: single conversation session
  cofire_daily FLOAT DEFAULT 0,      -- half-life 24h: daily rhythm
  cofire_weekly FLOAT DEFAULT 0,     -- half-life 7d: project-level patterns

  -- Metadata
  last_cofire_at TIMESTAMPTZ,        -- When these territories last co-occurred
  last_computed TIMESTAMPTZ,         -- When weights were last recalculated

  UNIQUE(user_id, territory_a, territory_b),
  CHECK (territory_a < territory_b)  -- Store only one direction (undirected graph)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_cofire_user_territory_a
  ON territory_cofire(user_id, territory_a);
CREATE INDEX IF NOT EXISTS idx_cofire_user_territory_b
  ON territory_cofire(user_id, territory_b);
CREATE INDEX IF NOT EXISTS idx_cofire_session_strength
  ON territory_cofire(user_id, cofire_session DESC);
CREATE INDEX IF NOT EXISTS idx_cofire_weekly_strength
  ON territory_cofire(user_id, cofire_weekly DESC);

-- RLS
ALTER TABLE territory_cofire ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own cofire data" ON territory_cofire
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to cofire" ON territory_cofire
  FOR ALL USING (auth.role() = 'service_role');

-- =============================================================================
-- FUNCTION: compute_territory_cofire
-- Batch computation of co-firing weights using sliding window approach
-- Called by scheduled job (e.g., nightly at 1am UTC)
-- =============================================================================

CREATE OR REPLACE FUNCTION compute_territory_cofire(p_user_id UUID)
RETURNS TABLE(pairs_updated INT, duration_ms FLOAT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_start_time TIMESTAMPTZ := clock_timestamp();
  v_pairs_updated INT := 0;
  v_msg RECORD;
  v_window_msg RECORD;
  v_time_delta FLOAT;
  v_weight_immediate FLOAT;
  v_weight_session FLOAT;
  v_weight_daily FLOAT;
  v_weight_weekly FLOAT;
  v_territory_a INT;
  v_territory_b INT;
  -- Half-lives in seconds
  v_hl_immediate FLOAT := 3600;      -- 1 hour
  v_hl_session FLOAT := 14400;       -- 4 hours
  v_hl_daily FLOAT := 86400;         -- 24 hours
  v_hl_weekly FLOAT := 604800;       -- 7 days
  -- Window size: 4 * largest half-life captures ~98% of weight
  v_window_seconds FLOAT := v_hl_weekly * 4;
BEGIN
  -- Clear existing co-fire data for fresh computation
  -- (Alternative: incremental updates, but full recompute is simpler for v1)
  DELETE FROM territory_cofire WHERE user_id = p_user_id;

  -- Process messages with territory assignments, ordered by time
  -- Note: cluster_3d is the territory_id in messages table
  FOR v_msg IN
    SELECT m.id, m.created_at, m.cluster_3d as territory_id
    FROM messages m
    WHERE m.user_id = p_user_id
      AND m.cluster_3d IS NOT NULL
    ORDER BY m.created_at
  LOOP
    -- For each message, compare to messages within sliding window
    FOR v_window_msg IN
      SELECT m2.id, m2.created_at, m2.cluster_3d as territory_id
      FROM messages m2
      WHERE m2.user_id = p_user_id
        AND m2.cluster_3d IS NOT NULL
        AND m2.cluster_3d != v_msg.territory_id
        AND m2.created_at >= v_msg.created_at - (v_window_seconds || ' seconds')::INTERVAL
        AND m2.created_at < v_msg.created_at
    LOOP
      -- Calculate time delta in seconds
      v_time_delta := EXTRACT(EPOCH FROM (v_msg.created_at - v_window_msg.created_at));

      -- Calculate decay weights for each scale
      v_weight_immediate := exp(-v_time_delta / v_hl_immediate);
      v_weight_session := exp(-v_time_delta / v_hl_session);
      v_weight_daily := exp(-v_time_delta / v_hl_daily);
      v_weight_weekly := exp(-v_time_delta / v_hl_weekly);

      -- Normalize territory order (a < b)
      IF v_msg.territory_id < v_window_msg.territory_id THEN
        v_territory_a := v_msg.territory_id;
        v_territory_b := v_window_msg.territory_id;
      ELSE
        v_territory_a := v_window_msg.territory_id;
        v_territory_b := v_msg.territory_id;
      END IF;

      -- Upsert co-fire weights
      INSERT INTO territory_cofire (
        user_id, territory_a, territory_b,
        cofire_immediate, cofire_session, cofire_daily, cofire_weekly,
        last_cofire_at, last_computed
      ) VALUES (
        p_user_id, v_territory_a, v_territory_b,
        v_weight_immediate, v_weight_session, v_weight_daily, v_weight_weekly,
        v_msg.created_at, clock_timestamp()
      )
      ON CONFLICT (user_id, territory_a, territory_b) DO UPDATE SET
        cofire_immediate = territory_cofire.cofire_immediate + v_weight_immediate,
        cofire_session = territory_cofire.cofire_session + v_weight_session,
        cofire_daily = territory_cofire.cofire_daily + v_weight_daily,
        cofire_weekly = territory_cofire.cofire_weekly + v_weight_weekly,
        last_cofire_at = GREATEST(territory_cofire.last_cofire_at, v_msg.created_at),
        last_computed = clock_timestamp();

      v_pairs_updated := v_pairs_updated + 1;
    END LOOP;
  END LOOP;

  RETURN QUERY SELECT v_pairs_updated,
    EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000;
END;
$$;

-- =============================================================================
-- FUNCTION: get_cofire_territories
-- Returns territories that co-fire with a given territory
-- Used by Mya's getCoFiring tool
-- =============================================================================

CREATE OR REPLACE FUNCTION get_cofire_territories(
  p_user_id UUID,
  p_territory_id INT,
  p_scale TEXT DEFAULT 'session',  -- 'immediate', 'session', 'daily', 'weekly'
  p_min_strength FLOAT DEFAULT 0.1,
  p_limit INT DEFAULT 10
)
RETURNS TABLE(
  territory_id INT,
  name TEXT,
  essence TEXT,
  cofire_strength FLOAT,
  last_cofire_at TIMESTAMPTZ,
  message_count INT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_strength_column TEXT;
BEGIN
  -- Validate scale parameter
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
  USING p_user_id, p_territory_id, p_min_strength, p_limit;
END;
$$;

-- =============================================================================
-- FUNCTION: get_orphan_territories
-- Returns territories with high content but low connectivity
-- Used by Mya's getOrphans tool
-- =============================================================================

CREATE OR REPLACE FUNCTION get_orphan_territories(
  p_user_id UUID,
  p_min_messages INT DEFAULT 50,
  p_max_connections INT DEFAULT 3,
  p_scale TEXT DEFAULT 'weekly',
  p_limit INT DEFAULT 10
)
RETURNS TABLE(
  territory_id INT,
  name TEXT,
  essence TEXT,
  message_count INT,
  connection_count INT,
  total_cofire_strength FLOAT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_strength_column TEXT;
BEGIN
  v_strength_column := CASE p_scale
    WHEN 'immediate' THEN 'cofire_immediate'
    WHEN 'session' THEN 'cofire_session'
    WHEN 'daily' THEN 'cofire_daily'
    WHEN 'weekly' THEN 'cofire_weekly'
    ELSE 'cofire_weekly'
  END;

  RETURN QUERY EXECUTE format('
    WITH territory_connections AS (
      SELECT
        tp.territory_id,
        tp.name,
        tp.essence,
        tp.message_count,
        COUNT(cf.id) as connection_count,
        COALESCE(SUM(cf.%I), 0) as total_cofire_strength
      FROM territory_profiles tp
      LEFT JOIN territory_cofire cf ON (
        cf.user_id = tp.user_id
        AND (cf.territory_a = tp.territory_id OR cf.territory_b = tp.territory_id)
        AND cf.%I > 0.1
      )
      WHERE tp.user_id = $1
        AND tp.message_count >= $2
      GROUP BY tp.territory_id, tp.name, tp.essence, tp.message_count
    )
    SELECT
      tc.territory_id,
      tc.name,
      tc.essence,
      tc.message_count,
      tc.connection_count::INT,
      tc.total_cofire_strength
    FROM territory_connections tc
    WHERE tc.connection_count <= $3
    ORDER BY tc.message_count DESC, tc.connection_count ASC
    LIMIT $4
  ', v_strength_column, v_strength_column)
  USING p_user_id, p_min_messages, p_max_connections, p_limit;
END;
$$;

-- =============================================================================
-- FUNCTION: get_bridge_territories
-- Returns territories that connect different clusters
-- High connectivity + diverse connections = bridge
-- =============================================================================

CREATE OR REPLACE FUNCTION get_bridge_territories(
  p_user_id UUID,
  p_min_connections INT DEFAULT 5,
  p_scale TEXT DEFAULT 'weekly',
  p_limit INT DEFAULT 10
)
RETURNS TABLE(
  territory_id INT,
  name TEXT,
  essence TEXT,
  message_count INT,
  connection_count INT,
  connected_realms INT,
  total_cofire_strength FLOAT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_strength_column TEXT;
BEGIN
  v_strength_column := CASE p_scale
    WHEN 'immediate' THEN 'cofire_immediate'
    WHEN 'session' THEN 'cofire_session'
    WHEN 'daily' THEN 'cofire_daily'
    WHEN 'weekly' THEN 'cofire_weekly'
    ELSE 'cofire_weekly'
  END;

  RETURN QUERY EXECUTE format('
    WITH territory_connections AS (
      SELECT
        tp.territory_id,
        tp.name,
        tp.essence,
        tp.realm_id,
        tp.message_count,
        COUNT(DISTINCT CASE WHEN cf.territory_a = tp.territory_id THEN cf.territory_b ELSE cf.territory_a END) as connection_count,
        COUNT(DISTINCT tp2.realm_id) as connected_realms,
        COALESCE(SUM(cf.%I), 0) as total_cofire_strength
      FROM territory_profiles tp
      LEFT JOIN territory_cofire cf ON (
        cf.user_id = tp.user_id
        AND (cf.territory_a = tp.territory_id OR cf.territory_b = tp.territory_id)
        AND cf.%I > 0.1
      )
      LEFT JOIN territory_profiles tp2 ON (
        tp2.user_id = tp.user_id
        AND tp2.territory_id = CASE WHEN cf.territory_a = tp.territory_id THEN cf.territory_b ELSE cf.territory_a END
      )
      WHERE tp.user_id = $1
      GROUP BY tp.territory_id, tp.name, tp.essence, tp.realm_id, tp.message_count
    )
    SELECT
      tc.territory_id,
      tc.name,
      tc.essence,
      tc.message_count,
      tc.connection_count::INT,
      tc.connected_realms::INT,
      tc.total_cofire_strength
    FROM territory_connections tc
    WHERE tc.connection_count >= $2
      AND tc.connected_realms > 1  -- Must connect different realms
    ORDER BY tc.connected_realms DESC, tc.connection_count DESC
    LIMIT $3
  ', v_strength_column, v_strength_column)
  USING p_user_id, p_min_connections, p_limit;
END;
$$;

-- =============================================================================
-- FUNCTION: get_cofire_gaps
-- Returns territories with high semantic similarity but low co-firing
-- These are unexplored potential connections
-- =============================================================================

CREATE OR REPLACE FUNCTION get_cofire_gaps(
  p_user_id UUID,
  p_territory_id INT,
  p_min_similarity FLOAT DEFAULT 0.7,
  p_max_cofire FLOAT DEFAULT 0.5,
  p_scale TEXT DEFAULT 'weekly',
  p_limit INT DEFAULT 10
)
RETURNS TABLE(
  territory_id INT,
  name TEXT,
  essence TEXT,
  semantic_similarity FLOAT,
  cofire_strength FLOAT,
  gap_score FLOAT,  -- similarity - cofire (higher = bigger gap)
  message_count INT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_source_embedding vector(1024);
  v_strength_column TEXT;
BEGIN
  v_strength_column := CASE p_scale
    WHEN 'immediate' THEN 'cofire_immediate'
    WHEN 'session' THEN 'cofire_session'
    WHEN 'daily' THEN 'cofire_daily'
    WHEN 'weekly' THEN 'cofire_weekly'
    ELSE 'cofire_weekly'
  END;

  -- Get source territory embedding
  SELECT embedding INTO v_source_embedding
  FROM territory_profiles
  WHERE user_id = p_user_id AND territory_id = p_territory_id;

  IF v_source_embedding IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE format('
    SELECT
      tp.territory_id,
      tp.name,
      tp.essence,
      (1 - (tp.embedding <=> $2)) as semantic_similarity,
      COALESCE(cf.%I, 0) as cofire_strength,
      (1 - (tp.embedding <=> $2)) - COALESCE(cf.%I, 0) as gap_score,
      tp.message_count
    FROM territory_profiles tp
    LEFT JOIN territory_cofire cf ON (
      cf.user_id = tp.user_id
      AND (
        (cf.territory_a = $3 AND cf.territory_b = tp.territory_id)
        OR (cf.territory_b = $3 AND cf.territory_a = tp.territory_id)
      )
    )
    WHERE tp.user_id = $1
      AND tp.territory_id != $3
      AND tp.embedding IS NOT NULL
      AND (1 - (tp.embedding <=> $2)) >= $4
      AND COALESCE(cf.%I, 0) <= $5
    ORDER BY (1 - (tp.embedding <=> $2)) - COALESCE(cf.%I, 0) DESC
    LIMIT $6
  ', v_strength_column, v_strength_column, v_strength_column, v_strength_column)
  USING p_user_id, v_source_embedding, p_territory_id, p_min_similarity, p_max_cofire, p_limit;
END;
$$;

-- =============================================================================
-- FUNCTION: get_territory_cluster
-- Walk outward from a territory, returning connected subgraph
-- =============================================================================

CREATE OR REPLACE FUNCTION get_territory_cluster(
  p_user_id UUID,
  p_territory_id INT,
  p_depth INT DEFAULT 2,
  p_min_strength FLOAT DEFAULT 0.3,
  p_scale TEXT DEFAULT 'session'
)
RETURNS TABLE(
  territory_id INT,
  name TEXT,
  essence TEXT,
  depth INT,
  path_strength FLOAT,
  message_count INT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_strength_column TEXT;
BEGIN
  v_strength_column := CASE p_scale
    WHEN 'immediate' THEN 'cofire_immediate'
    WHEN 'session' THEN 'cofire_session'
    WHEN 'daily' THEN 'cofire_daily'
    WHEN 'weekly' THEN 'cofire_weekly'
    ELSE 'cofire_session'
  END;

  RETURN QUERY EXECUTE format('
    WITH RECURSIVE cluster_walk AS (
      -- Base case: starting territory
      SELECT
        tp.territory_id,
        tp.name,
        tp.essence,
        0 as depth,
        1.0::FLOAT as path_strength,
        tp.message_count,
        ARRAY[tp.territory_id] as visited
      FROM territory_profiles tp
      WHERE tp.user_id = $1 AND tp.territory_id = $2

      UNION ALL

      -- Recursive case: walk to connected territories
      SELECT
        next_tp.territory_id,
        next_tp.name,
        next_tp.essence,
        cw.depth + 1,
        cw.path_strength * cf.%I,
        next_tp.message_count,
        cw.visited || next_tp.territory_id
      FROM cluster_walk cw
      JOIN territory_cofire cf ON (
        cf.user_id = $1
        AND (cf.territory_a = cw.territory_id OR cf.territory_b = cw.territory_id)
        AND cf.%I >= $4
      )
      JOIN territory_profiles next_tp ON (
        next_tp.user_id = $1
        AND next_tp.territory_id = CASE
          WHEN cf.territory_a = cw.territory_id THEN cf.territory_b
          ELSE cf.territory_a
        END
        AND NOT (next_tp.territory_id = ANY(cw.visited))
      )
      WHERE cw.depth < $3
    )
    SELECT DISTINCT ON (cw.territory_id)
      cw.territory_id,
      cw.name,
      cw.essence,
      cw.depth,
      cw.path_strength,
      cw.message_count
    FROM cluster_walk cw
    ORDER BY cw.territory_id, cw.path_strength DESC
  ', v_strength_column, v_strength_column)
  USING p_user_id, p_territory_id, p_depth, p_min_strength;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION compute_territory_cofire(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION get_cofire_territories(UUID, INT, TEXT, FLOAT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_orphan_territories(UUID, INT, INT, TEXT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_bridge_territories(UUID, INT, TEXT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_cofire_gaps(UUID, INT, FLOAT, FLOAT, TEXT, INT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_territory_cluster(UUID, INT, INT, FLOAT, TEXT) TO authenticated, service_role;
