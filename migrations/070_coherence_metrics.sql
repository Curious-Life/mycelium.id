-- Migration: 070_coherence_metrics
-- Description: Add coherence metrics for measuring integration readiness
-- (semantic coherence, flow indicators, cross-frequency coupling)

-- ============================================================================
-- ADD COHERENCE COLUMNS TO PSYCHOLOGICAL_MEASUREMENTS
-- ============================================================================

-- Semantic Coherence - measures how connected/organized thoughts are
ALTER TABLE psychological_measurements
ADD COLUMN IF NOT EXISTS coherence_mean_adjacent REAL,  -- Mean similarity between adjacent turns (0-1)
ADD COLUMN IF NOT EXISTS coherence_variance REAL,       -- Variance in coherence (lower = more stable)
ADD COLUMN IF NOT EXISTS coherence_tangent_count INTEGER DEFAULT 0,  -- Number of sudden coherence drops
ADD COLUMN IF NOT EXISTS coherence_low_freq_power REAL,  -- Theme stability over 10-20 turns
ADD COLUMN IF NOT EXISTS coherence_high_freq_power REAL, -- Concept switching over 2-3 turns
ADD COLUMN IF NOT EXISTS coherence_coupling_strength REAL,  -- Integration of novelty into themes

-- Flow State Indicators - composite markers of optimal cognitive state
ADD COLUMN IF NOT EXISTS flow_score REAL,               -- Composite flow indicator (0-1)
ADD COLUMN IF NOT EXISTS coherent_state BOOLEAN DEFAULT FALSE,  -- Currently above personal baseline
ADD COLUMN IF NOT EXISTS elevated_state BOOLEAN DEFAULT FALSE,  -- Significantly above baseline

-- Exploration Index - composite from entropy metrics
ADD COLUMN IF NOT EXISTS exploration_index REAL;        -- Weighted entropy composite (0-1)

-- ============================================================================
-- ADD CONSTRAINTS
-- ============================================================================

-- Coherence values should be in valid ranges
ALTER TABLE psychological_measurements
ADD CONSTRAINT valid_coherence_mean CHECK (
    coherence_mean_adjacent IS NULL OR
    (coherence_mean_adjacent >= 0 AND coherence_mean_adjacent <= 1)
),
ADD CONSTRAINT valid_coherence_variance CHECK (
    coherence_variance IS NULL OR
    coherence_variance >= 0
),
ADD CONSTRAINT valid_coherence_coupling CHECK (
    coherence_coupling_strength IS NULL OR
    (coherence_coupling_strength >= 0 AND coherence_coupling_strength <= 1)
),
ADD CONSTRAINT valid_flow_score CHECK (
    flow_score IS NULL OR
    (flow_score >= 0 AND flow_score <= 1)
),
ADD CONSTRAINT valid_exploration_index CHECK (
    exploration_index IS NULL OR
    (exploration_index >= 0 AND exploration_index <= 1)
);

-- ============================================================================
-- UPDATE HELPER FUNCTIONS
-- ============================================================================

-- Drop existing function first (return type is changing)
DROP FUNCTION IF EXISTS check_intervention_needed(UUID);

-- Update intervention check to include coherence gating
CREATE OR REPLACE FUNCTION check_intervention_needed(p_user_id UUID)
RETURNS TABLE(
    needs_intervention BOOLEAN,
    reason TEXT,
    severity TEXT,
    is_coherent BOOLEAN,
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
        RETURN QUERY SELECT FALSE, 'No measurements available'::TEXT, 'none'::TEXT, FALSE, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Check for severe stuck state
    IF latest.stuck_level IN ('severe', 'very_severe') THEN
        RETURN QUERY SELECT TRUE, 'High stuck score detected'::TEXT, latest.stuck_level,
                            COALESCE(latest.coherent_state, FALSE), latest.measurement_at;
        RETURN;
    END IF;

    -- Check for critical EWS
    IF latest.ews_trend = 'critical' THEN
        RETURN QUERY SELECT TRUE, 'Critical early warning signals'::TEXT, 'critical'::TEXT,
                            COALESCE(latest.coherent_state, FALSE), latest.measurement_at;
        RETURN;
    END IF;

    -- Check for high volatility
    IF latest.hgf_belief_stability = 'volatile' THEN
        RETURN QUERY SELECT TRUE, 'High belief volatility'::TEXT, 'volatile'::TEXT,
                            COALESCE(latest.coherent_state, FALSE), latest.measurement_at;
        RETURN;
    END IF;

    RETURN QUERY SELECT FALSE, 'No intervention needed'::TEXT, 'none'::TEXT,
                        COALESCE(latest.coherent_state, FALSE), latest.measurement_at;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON COLUMN psychological_measurements.coherence_mean_adjacent IS
'Mean cosine similarity between embedding of adjacent conversation turns. Higher = more organized thinking.';

COMMENT ON COLUMN psychological_measurements.coherence_variance IS
'Variance in turn-to-turn coherence. Lower = more stable thought patterns.';

COMMENT ON COLUMN psychological_measurements.coherence_tangent_count IS
'Count of sudden coherence drops (tangents). More tangents may indicate difficulty maintaining focus.';

COMMENT ON COLUMN psychological_measurements.coherence_coupling_strength IS
'How well novel topics get integrated into existing themes (cross-frequency coupling analog).';

COMMENT ON COLUMN psychological_measurements.flow_score IS
'Composite flow state indicator combining moderate entropy, high coherence, low stuck score.';

COMMENT ON COLUMN psychological_measurements.coherent_state IS
'Whether current coherence is above personal baseline. Used for intervention gating.';

COMMENT ON COLUMN psychological_measurements.elevated_state IS
'Whether current state is significantly above baseline (elevated/optimal). Rare but important.';

COMMENT ON COLUMN psychological_measurements.exploration_index IS
'Weighted composite of entropy metrics (topic, transition, LZ complexity). Higher = more exploratory.';
