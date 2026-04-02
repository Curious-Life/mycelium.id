-- Migration: 069_psychological_measurements
-- Description: Add table for storing psychological state measurements
-- (phi, network, stuck, EWS, HGF volatility, entropy metrics)

-- ============================================================================
-- PSYCHOLOGICAL MEASUREMENTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS psychological_measurements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Time context
    measurement_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    n_turns INTEGER NOT NULL,

    -- Phi (Integration) - computed at theme level (8 topics)
    phi_e REAL,
    phi_normalized REAL,
    phi_interpretation TEXT,  -- 'low', 'moderate', 'high'
    phi_is_significant BOOLEAN DEFAULT FALSE,

    -- Network Metrics - computed at territory level (~200-300 nodes)
    modularity_q REAL,
    global_efficiency REAL,
    mean_participation REAL,
    n_communities INTEGER,
    connector_hubs JSONB,  -- Array of territory IDs that bridge communities

    -- Stuck Detection - computed at theme level (~30 topics)
    stuck_score REAL,
    stuck_confidence REAL,
    stuck_level TEXT,  -- 'not_stuck', 'mild', 'moderate', 'severe'
    stuck_components JSONB,  -- { modularity, pc, return_freq, novelty, velocity, entropy }
    escape_routes JSONB,  -- Suggested topics to explore

    -- Early Warning Signals - computed alongside phi
    ews_autocorrelation REAL,
    ews_variance REAL,
    ews_skewness REAL,
    ews_flickering INTEGER,
    ews_variance_trend REAL,
    ews_autocorr_trend REAL,
    ews_trend TEXT,  -- 'stable', 'increasing', 'critical'

    -- HGF (Hierarchical Gaussian Filter) - Belief Volatility
    -- Uses MYA's hierarchy: territories -> themes -> realms
    hgf_volatility_realm REAL,      -- Life-domain volatility (level 3, ~5 nodes)
    hgf_volatility_theme REAL,      -- Semantic volatility (level 2, ~30 nodes)
    hgf_volatility_territory REAL,  -- Fine-grained volatility (level 1, ~200 nodes)
    hgf_transition_probability REAL, -- Likelihood of state change
    hgf_belief_stability TEXT,      -- 'stable', 'exploring', 'volatile', 'transitioning'

    -- Entropy Metrics - Diversity & Predictability (theme level)
    entropy_topic REAL,             -- Shannon entropy of topic distribution
    entropy_transition REAL,        -- Entropy of topic-to-topic transitions
    entropy_lz_complexity REAL,     -- Lempel-Ziv complexity ratio (0-1)
    entropy_embedding REAL,         -- Semantic space coverage entropy
    entropy_trend TEXT,             -- 'expanding', 'stable', 'contracting'

    -- Derived Indices (combined metrics)
    integration_index REAL,         -- Combined phi + network health
    flexibility_index REAL,         -- Inverse of rigidity/stuckness

    -- Granularity tracking (multi-level computation)
    phi_topic_level TEXT DEFAULT 'theme',
    phi_n_topics INTEGER,
    network_topic_level TEXT DEFAULT 'territory',
    network_n_topics INTEGER,
    stuck_topic_level TEXT DEFAULT 'theme',
    stuck_n_topics INTEGER,

    -- Metadata
    config JSONB DEFAULT '{}',
    warnings TEXT[] DEFAULT '{}',
    completeness REAL DEFAULT 1.0,  -- Fraction of metrics successfully computed

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT valid_phi_interpretation CHECK (
        phi_interpretation IS NULL OR
        phi_interpretation IN ('very_low', 'low', 'moderate', 'high', 'very_high')
    ),
    CONSTRAINT valid_stuck_level CHECK (
        stuck_level IS NULL OR
        stuck_level IN ('not_stuck', 'mild', 'moderate', 'severe', 'very_severe')
    ),
    CONSTRAINT valid_ews_trend CHECK (
        ews_trend IS NULL OR
        ews_trend IN ('stable', 'increasing', 'critical')
    ),
    CONSTRAINT valid_hgf_stability CHECK (
        hgf_belief_stability IS NULL OR
        hgf_belief_stability IN ('stable', 'exploring', 'volatile', 'transitioning')
    ),
    CONSTRAINT valid_entropy_trend CHECK (
        entropy_trend IS NULL OR
        entropy_trend IN ('expanding', 'stable', 'contracting')
    )
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Primary query pattern: user's measurements over time
CREATE INDEX idx_psych_measurements_user_time
    ON psychological_measurements(user_id, measurement_at DESC);

-- Query by time window
CREATE INDEX idx_psych_measurements_window
    ON psychological_measurements(user_id, window_start, window_end);

-- Query latest measurement per user
CREATE INDEX idx_psych_measurements_latest
    ON psychological_measurements(user_id, created_at DESC);

-- Query by stuck level (for intervention triggers)
CREATE INDEX idx_psych_measurements_stuck
    ON psychological_measurements(user_id, stuck_level)
    WHERE stuck_level IN ('moderate', 'severe', 'very_severe');

-- Query by EWS trend (for early warning alerts)
CREATE INDEX idx_psych_measurements_ews
    ON psychological_measurements(user_id, ews_trend)
    WHERE ews_trend = 'critical';

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE psychological_measurements ENABLE ROW LEVEL SECURITY;

-- Users can only view their own measurements
CREATE POLICY "Users can view own measurements"
    ON psychological_measurements
    FOR SELECT
    USING (user_id = auth.uid());

-- Service role has full access (for batch processing)
CREATE POLICY "Service role full access"
    ON psychological_measurements
    FOR ALL
    USING (true);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Get latest measurement for a user
CREATE OR REPLACE FUNCTION get_latest_measurement(p_user_id UUID)
RETURNS psychological_measurements AS $$
    SELECT *
    FROM psychological_measurements
    WHERE user_id = p_user_id
    ORDER BY measurement_at DESC
    LIMIT 1;
$$ LANGUAGE SQL STABLE;

-- Get measurement history for time range
CREATE OR REPLACE FUNCTION get_measurement_history(
    p_user_id UUID,
    p_days_back INTEGER DEFAULT 30
)
RETURNS SETOF psychological_measurements AS $$
    SELECT *
    FROM psychological_measurements
    WHERE user_id = p_user_id
      AND measurement_at >= NOW() - (p_days_back || ' days')::INTERVAL
    ORDER BY measurement_at ASC;
$$ LANGUAGE SQL STABLE;

-- Check if user needs intervention based on stuck/EWS
CREATE OR REPLACE FUNCTION check_intervention_needed(p_user_id UUID)
RETURNS TABLE(
    needs_intervention BOOLEAN,
    reason TEXT,
    severity TEXT,
    latest_measurement_at TIMESTAMPTZ
) AS $$
DECLARE
    latest RECORD;
BEGIN
    SELECT * INTO latest
    FROM psychological_measurements
    WHERE user_id = p_user_id
    ORDER BY measurement_at DESC
    LIMIT 1;

    IF latest IS NULL THEN
        RETURN QUERY SELECT FALSE, 'No measurements available'::TEXT, 'none'::TEXT, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Check for severe stuck state
    IF latest.stuck_level IN ('severe', 'very_severe') THEN
        RETURN QUERY SELECT TRUE, 'High stuck score detected'::TEXT, latest.stuck_level, latest.measurement_at;
        RETURN;
    END IF;

    -- Check for critical EWS
    IF latest.ews_trend = 'critical' THEN
        RETURN QUERY SELECT TRUE, 'Critical early warning signals'::TEXT, 'critical'::TEXT, latest.measurement_at;
        RETURN;
    END IF;

    -- Check for high volatility
    IF latest.hgf_belief_stability = 'volatile' THEN
        RETURN QUERY SELECT TRUE, 'High belief volatility'::TEXT, 'volatile'::TEXT, latest.measurement_at;
        RETURN;
    END IF;

    RETURN QUERY SELECT FALSE, 'No intervention needed'::TEXT, 'none'::TEXT, latest.measurement_at;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE psychological_measurements IS
'Stores psychological state measurements computed from conversation patterns.
Metrics include integration (phi), network structure, stuck detection,
early warning signals, belief volatility (HGF), and entropy measures.
Computed nightly via Modal batch job + on-demand triggers.';

COMMENT ON COLUMN psychological_measurements.phi_e IS
'Phi-E (empirical integrated information) in bits. Higher = more integrated mental state.';

COMMENT ON COLUMN psychological_measurements.stuck_score IS
'Composite score (0-1) indicating repetitive/ruminative patterns. Higher = more stuck.';

COMMENT ON COLUMN psychological_measurements.hgf_volatility_realm IS
'HGF volatility at realm level (~5 life domains). Higher = more unstable beliefs about life areas.';

COMMENT ON COLUMN psychological_measurements.entropy_lz_complexity IS
'Lempel-Ziv complexity ratio (0-1). Higher = more novel patterns, Lower = more repetitive.';

COMMENT ON COLUMN psychological_measurements.integration_index IS
'Combined metric of phi + network health. Higher = healthier psychological integration.';
