-- =============================================
-- Territory Activity View (Live Dashboard)
-- =============================================
-- Computed on-demand view of territory activity.
-- Used for trend detection and activity stats.

CREATE OR REPLACE VIEW territory_activity
WITH (security_invoker = true)
AS
SELECT
    user_id,
    cluster_3d as territory_id,
    COUNT(*) as total_messages,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as messages_7d,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as messages_30d,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '90 days') as messages_90d,
    MIN(created_at) as first_active,
    MAX(created_at) as last_active,
    COUNT(DISTINCT DATE_TRUNC('month', created_at)) as active_months,
    CASE
        WHEN COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') >
             COUNT(*) FILTER (WHERE created_at BETWEEN NOW() - INTERVAL '14 days'
                                                    AND NOW() - INTERVAL '7 days') * 1.2
        THEN 'growing'
        WHEN MAX(created_at) < NOW() - INTERVAL '30 days'
        THEN 'dormant'
        ELSE 'stable'
    END as trend
FROM messages
WHERE cluster_3d IS NOT NULL
  AND cluster_3d != -1
GROUP BY user_id, cluster_3d;
