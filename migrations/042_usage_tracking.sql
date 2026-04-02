-- =============================================
-- Usage Tracking for Multi-User
-- =============================================
-- Tracks Claude API usage per user per month.
-- Enables budget enforcement ($20-30/month per user).

-- User usage table - one row per user per month
CREATE TABLE IF NOT EXISTS user_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start DATE NOT NULL DEFAULT date_trunc('month', CURRENT_DATE),
    input_tokens BIGINT DEFAULT 0,
    output_tokens BIGINT DEFAULT 0,
    estimated_cost_cents INTEGER DEFAULT 0,
    budget_limit_cents INTEGER DEFAULT 3000, -- $30 default
    request_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, period_start)
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_user_usage_lookup ON user_usage(user_id, period_start);

-- RLS
ALTER TABLE user_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_usage_owner ON user_usage
    FOR ALL USING (user_id = auth.uid());

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON user_usage TO authenticated;

-- =============================================
-- Increment usage RPC function
-- =============================================
-- Called after every Claude API call to track usage.
-- Upserts into user_usage table for current month.

CREATE OR REPLACE FUNCTION increment_usage(
    p_user_id UUID,
    p_input_tokens INTEGER,
    p_output_tokens INTEGER,
    p_cost_cents INTEGER
)
RETURNS TABLE(
    allowed BOOLEAN,
    remaining_cents INTEGER,
    budget_limit_cents INTEGER,
    total_cost_cents INTEGER
) AS $$
DECLARE
    v_period_start DATE := date_trunc('month', CURRENT_DATE);
    v_budget_limit INTEGER;
    v_new_cost INTEGER;
BEGIN
    -- Upsert usage record
    INSERT INTO user_usage (user_id, period_start, input_tokens, output_tokens, estimated_cost_cents, request_count)
    VALUES (p_user_id, v_period_start, p_input_tokens, p_output_tokens, p_cost_cents, 1)
    ON CONFLICT (user_id, period_start) DO UPDATE SET
        input_tokens = user_usage.input_tokens + EXCLUDED.input_tokens,
        output_tokens = user_usage.output_tokens + EXCLUDED.output_tokens,
        estimated_cost_cents = user_usage.estimated_cost_cents + EXCLUDED.estimated_cost_cents,
        request_count = user_usage.request_count + 1,
        updated_at = NOW();

    -- Get current totals
    SELECT u.budget_limit_cents, u.estimated_cost_cents
    INTO v_budget_limit, v_new_cost
    FROM user_usage u
    WHERE u.user_id = p_user_id AND u.period_start = v_period_start;

    RETURN QUERY SELECT
        (v_new_cost <= v_budget_limit) AS allowed,
        GREATEST(0, v_budget_limit - v_new_cost) AS remaining_cents,
        v_budget_limit AS budget_limit_cents,
        v_new_cost AS total_cost_cents;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION increment_usage(UUID, INTEGER, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION increment_usage(UUID, INTEGER, INTEGER, INTEGER) TO service_role;

-- =============================================
-- Check budget RPC function
-- =============================================
-- Called before Claude API calls to check if user can proceed.

CREATE OR REPLACE FUNCTION check_budget(p_user_id UUID)
RETURNS TABLE(
    allowed BOOLEAN,
    remaining_cents INTEGER,
    budget_limit_cents INTEGER,
    used_cents INTEGER,
    period_start DATE,
    period_end DATE
) AS $$
DECLARE
    v_period_start DATE := date_trunc('month', CURRENT_DATE);
    v_period_end DATE := (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::DATE;
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(u.estimated_cost_cents, 0) < COALESCE(u.budget_limit_cents, 3000) AS allowed,
        GREATEST(0, COALESCE(u.budget_limit_cents, 3000) - COALESCE(u.estimated_cost_cents, 0)) AS remaining_cents,
        COALESCE(u.budget_limit_cents, 3000) AS budget_limit_cents,
        COALESCE(u.estimated_cost_cents, 0) AS used_cents,
        v_period_start AS period_start,
        v_period_end AS period_end
    FROM users usr
    LEFT JOIN user_usage u ON u.user_id = usr.id AND u.period_start = v_period_start
    WHERE usr.id = p_user_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION check_budget(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION check_budget(UUID) TO service_role;

-- =============================================
-- Get usage summary RPC function
-- =============================================
-- Returns usage summary for display in UI.

CREATE OR REPLACE FUNCTION get_usage_summary(p_user_id UUID)
RETURNS TABLE(
    input_tokens BIGINT,
    output_tokens BIGINT,
    total_cost_cents INTEGER,
    budget_limit_cents INTEGER,
    budget_used_percent NUMERIC,
    request_count INTEGER,
    period_start DATE,
    period_end DATE
) AS $$
DECLARE
    v_period_start DATE := date_trunc('month', CURRENT_DATE);
    v_period_end DATE := (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::DATE;
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(u.input_tokens, 0) AS input_tokens,
        COALESCE(u.output_tokens, 0) AS output_tokens,
        COALESCE(u.estimated_cost_cents, 0) AS total_cost_cents,
        COALESCE(u.budget_limit_cents, 3000) AS budget_limit_cents,
        ROUND(COALESCE(u.estimated_cost_cents, 0)::NUMERIC / COALESCE(u.budget_limit_cents, 3000)::NUMERIC * 100, 1) AS budget_used_percent,
        COALESCE(u.request_count, 0) AS request_count,
        v_period_start AS period_start,
        v_period_end AS period_end
    FROM users usr
    LEFT JOIN user_usage u ON u.user_id = usr.id AND u.period_start = v_period_start
    WHERE usr.id = p_user_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_usage_summary(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_usage_summary(UUID) TO service_role;
