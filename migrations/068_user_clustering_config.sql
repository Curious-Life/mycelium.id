-- Migration: User-specific clustering configuration
--
-- Stores per-user detected clustering parameters instead of using global hardcoded values.
-- Parameters are auto-detected via stability analysis (epsilon sweep + bootstrap).
--
-- The hierarchy detection process finds natural clustering levels by:
-- 1. HDBSCAN condensed tree analysis
-- 2. Epsilon sweep to find stable cluster counts
-- 3. Bootstrap resampling for robustness validation

-- Drop existing table if migrating
DROP TABLE IF EXISTS user_clustering_config CASCADE;

CREATE TABLE user_clustering_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Detection metadata
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    detection_version TEXT DEFAULT '1.0',
    points_at_detection INTEGER NOT NULL,

    -- HDBSCAN atom parameters (data-driven)
    hdbscan_min_cluster_size INTEGER NOT NULL DEFAULT 3,
    hdbscan_min_samples INTEGER NOT NULL DEFAULT 1,

    -- Ward hierarchy cuts (per-user detected)
    n_realms INTEGER NOT NULL DEFAULT 5,
    n_themes INTEGER NOT NULL DEFAULT 30,
    n_territories INTEGER NOT NULL DEFAULT 250,

    -- Optimal epsilon values per level (from stability analysis)
    epsilon_realms FLOAT,
    epsilon_themes FLOAT,
    epsilon_territories FLOAT,

    -- Stability scores (0-1, higher = more stable)
    stability_realms FLOAT,
    stability_themes FLOAT,
    stability_territories FLOAT,

    -- Noise percentages at each level
    noise_pct_realms FLOAT,
    noise_pct_themes FLOAT,
    noise_pct_territories FLOAT,

    -- Re-detection triggers
    last_full_rebuild TIMESTAMPTZ,
    points_at_last_rebuild INTEGER,

    -- Unique constraint: one config per user
    CONSTRAINT user_clustering_config_user_unique UNIQUE (user_id)
);

-- Index for fast lookup
CREATE INDEX idx_user_clustering_config_user_id ON user_clustering_config(user_id);

-- Enable RLS
ALTER TABLE user_clustering_config ENABLE ROW LEVEL SECURITY;

-- Users can only see their own config
CREATE POLICY "Users can view own clustering config"
    ON user_clustering_config
    FOR SELECT
    USING (auth.uid() = user_id);

-- Service role can do everything (for Modal clustering jobs)
CREATE POLICY "Service role full access"
    ON user_clustering_config
    FOR ALL
    USING (auth.role() = 'service_role');

-- Function to get or create default config for a user
CREATE OR REPLACE FUNCTION get_user_clustering_config(p_user_id UUID)
RETURNS user_clustering_config
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    config user_clustering_config;
BEGIN
    -- Try to get existing config
    SELECT * INTO config
    FROM user_clustering_config
    WHERE user_id = p_user_id;

    -- Return existing if found
    IF FOUND THEN
        RETURN config;
    END IF;

    -- Create default config if none exists
    INSERT INTO user_clustering_config (
        user_id,
        points_at_detection,
        hdbscan_min_cluster_size,
        hdbscan_min_samples,
        n_realms,
        n_themes,
        n_territories
    ) VALUES (
        p_user_id,
        0,  -- Will be updated on first detection
        3,  -- Default HDBSCAN params
        1,
        5,  -- Default hierarchy cuts (will be auto-detected)
        30,
        250
    )
    RETURNING * INTO config;

    RETURN config;
END;
$$;

-- Function to update config after hierarchy detection
CREATE OR REPLACE FUNCTION update_user_clustering_config(
    p_user_id UUID,
    p_points_count INTEGER,
    p_n_realms INTEGER DEFAULT NULL,
    p_n_themes INTEGER DEFAULT NULL,
    p_n_territories INTEGER DEFAULT NULL,
    p_epsilon_realms FLOAT DEFAULT NULL,
    p_epsilon_themes FLOAT DEFAULT NULL,
    p_epsilon_territories FLOAT DEFAULT NULL,
    p_stability_realms FLOAT DEFAULT NULL,
    p_stability_themes FLOAT DEFAULT NULL,
    p_stability_territories FLOAT DEFAULT NULL,
    p_noise_pct_realms FLOAT DEFAULT NULL,
    p_noise_pct_themes FLOAT DEFAULT NULL,
    p_noise_pct_territories FLOAT DEFAULT NULL,
    p_hdbscan_min_cluster_size INTEGER DEFAULT NULL,
    p_hdbscan_min_samples INTEGER DEFAULT NULL
)
RETURNS user_clustering_config
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    config user_clustering_config;
BEGIN
    INSERT INTO user_clustering_config (
        user_id,
        detected_at,
        points_at_detection,
        n_realms,
        n_themes,
        n_territories,
        epsilon_realms,
        epsilon_themes,
        epsilon_territories,
        stability_realms,
        stability_themes,
        stability_territories,
        noise_pct_realms,
        noise_pct_themes,
        noise_pct_territories,
        hdbscan_min_cluster_size,
        hdbscan_min_samples
    ) VALUES (
        p_user_id,
        NOW(),
        p_points_count,
        COALESCE(p_n_realms, 5),
        COALESCE(p_n_themes, 30),
        COALESCE(p_n_territories, 250),
        p_epsilon_realms,
        p_epsilon_themes,
        p_epsilon_territories,
        p_stability_realms,
        p_stability_themes,
        p_stability_territories,
        p_noise_pct_realms,
        p_noise_pct_themes,
        p_noise_pct_territories,
        COALESCE(p_hdbscan_min_cluster_size, 3),
        COALESCE(p_hdbscan_min_samples, 1)
    )
    ON CONFLICT (user_id) DO UPDATE SET
        detected_at = NOW(),
        points_at_detection = EXCLUDED.points_at_detection,
        n_realms = COALESCE(EXCLUDED.n_realms, user_clustering_config.n_realms),
        n_themes = COALESCE(EXCLUDED.n_themes, user_clustering_config.n_themes),
        n_territories = COALESCE(EXCLUDED.n_territories, user_clustering_config.n_territories),
        epsilon_realms = COALESCE(EXCLUDED.epsilon_realms, user_clustering_config.epsilon_realms),
        epsilon_themes = COALESCE(EXCLUDED.epsilon_themes, user_clustering_config.epsilon_themes),
        epsilon_territories = COALESCE(EXCLUDED.epsilon_territories, user_clustering_config.epsilon_territories),
        stability_realms = COALESCE(EXCLUDED.stability_realms, user_clustering_config.stability_realms),
        stability_themes = COALESCE(EXCLUDED.stability_themes, user_clustering_config.stability_themes),
        stability_territories = COALESCE(EXCLUDED.stability_territories, user_clustering_config.stability_territories),
        noise_pct_realms = COALESCE(EXCLUDED.noise_pct_realms, user_clustering_config.noise_pct_realms),
        noise_pct_themes = COALESCE(EXCLUDED.noise_pct_themes, user_clustering_config.noise_pct_themes),
        noise_pct_territories = COALESCE(EXCLUDED.noise_pct_territories, user_clustering_config.noise_pct_territories),
        hdbscan_min_cluster_size = COALESCE(EXCLUDED.hdbscan_min_cluster_size, user_clustering_config.hdbscan_min_cluster_size),
        hdbscan_min_samples = COALESCE(EXCLUDED.hdbscan_min_samples, user_clustering_config.hdbscan_min_samples)
    RETURNING * INTO config;

    RETURN config;
END;
$$;

-- Function to check if hierarchy re-detection is needed
-- Returns true if: no config exists, or data has grown by 20%+ since last detection
CREATE OR REPLACE FUNCTION needs_hierarchy_detection(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    config user_clustering_config;
    current_points INTEGER;
    growth_ratio FLOAT;
BEGIN
    -- Get current config
    SELECT * INTO config
    FROM user_clustering_config
    WHERE user_id = p_user_id;

    -- No config = definitely needs detection
    IF NOT FOUND THEN
        RETURN TRUE;
    END IF;

    -- Get current point count
    SELECT COUNT(*) INTO current_points
    FROM clustering_points
    WHERE user_id = p_user_id;

    -- If no previous points recorded, needs detection
    IF config.points_at_detection IS NULL OR config.points_at_detection = 0 THEN
        RETURN TRUE;
    END IF;

    -- Calculate growth ratio
    growth_ratio := current_points::FLOAT / config.points_at_detection::FLOAT;

    -- Re-detect if grown by 20% or more
    RETURN growth_ratio >= 1.2;
END;
$$;

-- Function to mark that a full rebuild was completed
CREATE OR REPLACE FUNCTION mark_clustering_rebuild_complete(p_user_id UUID, p_points_count INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE user_clustering_config
    SET
        last_full_rebuild = NOW(),
        points_at_last_rebuild = p_points_count
    WHERE user_id = p_user_id;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_user_clustering_config(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION update_user_clustering_config(UUID, INTEGER, INTEGER, INTEGER, INTEGER, FLOAT, FLOAT, FLOAT, FLOAT, FLOAT, FLOAT, FLOAT, FLOAT, FLOAT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION needs_hierarchy_detection(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION mark_clustering_rebuild_complete(UUID, INTEGER) TO service_role;
