-- Migration 068b: Clustering config functions

CREATE OR REPLACE FUNCTION get_user_clustering_config(p_user_id UUID)
RETURNS user_clustering_config
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    config user_clustering_config;
BEGIN
    SELECT * INTO config
    FROM user_clustering_config
    WHERE user_id = p_user_id;

    IF FOUND THEN
        RETURN config;
    END IF;

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
        0,
        3,
        1,
        5,
        30,
        250
    )
    RETURNING * INTO config;

    RETURN config;
END;
$$;

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
