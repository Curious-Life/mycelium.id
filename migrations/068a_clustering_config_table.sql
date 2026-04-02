-- Migration 068a: Create user_clustering_config table

DROP TABLE IF EXISTS user_clustering_config CASCADE;

CREATE TABLE user_clustering_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    detection_version TEXT DEFAULT '1.0',
    points_at_detection INTEGER NOT NULL,

    hdbscan_min_cluster_size INTEGER NOT NULL DEFAULT 3,
    hdbscan_min_samples INTEGER NOT NULL DEFAULT 1,

    n_realms INTEGER NOT NULL DEFAULT 5,
    n_themes INTEGER NOT NULL DEFAULT 30,
    n_territories INTEGER NOT NULL DEFAULT 250,

    epsilon_realms FLOAT,
    epsilon_themes FLOAT,
    epsilon_territories FLOAT,

    stability_realms FLOAT,
    stability_themes FLOAT,
    stability_territories FLOAT,

    noise_pct_realms FLOAT,
    noise_pct_themes FLOAT,
    noise_pct_territories FLOAT,

    last_full_rebuild TIMESTAMPTZ,
    points_at_last_rebuild INTEGER,

    CONSTRAINT user_clustering_config_user_unique UNIQUE (user_id)
);

CREATE INDEX idx_user_clustering_config_user_id ON user_clustering_config(user_id);

ALTER TABLE user_clustering_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own clustering config"
    ON user_clustering_config
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Service role full access"
    ON user_clustering_config
    FOR ALL
    USING (auth.role() = 'service_role');
