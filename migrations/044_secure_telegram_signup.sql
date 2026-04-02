-- ============================================================
-- SECURE TELEGRAM SIGNUP MIGRATION
-- Date: 2026-01-23
-- Purpose: Enable secure multi-user Telegram registration
-- ============================================================

-- 1. Add invite code expiration and tracking
ALTER TABLE users
ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES users(id);

-- 2. Create audit log table for registration attempts
CREATE TABLE IF NOT EXISTS auth_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Who attempted
    telegram_id BIGINT NOT NULL,
    telegram_username TEXT,

    -- What they attempted
    action TEXT NOT NULL CHECK (action IN (
        'register_attempt',
        'register_success',
        'register_lockout',
        'start_command',
        'public_command',
        'unauthorized_command',
        'message_blocked'
    )),

    -- Details
    invite_code_hash TEXT,
    success BOOLEAN DEFAULT false,
    failure_reason TEXT,

    -- Context
    ip_address TEXT,
    user_agent TEXT,

    -- Timing
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for rate limiting queries
CREATE INDEX IF NOT EXISTS idx_auth_audit_telegram_time
ON auth_audit_log(telegram_id, created_at DESC);

-- Index for monitoring/alerting
CREATE INDEX IF NOT EXISTS idx_auth_audit_action_time
ON auth_audit_log(action, created_at DESC);

-- Index for invite code analysis (hashed)
CREATE INDEX IF NOT EXISTS idx_auth_audit_code_hash
ON auth_audit_log(invite_code_hash) WHERE invite_code_hash IS NOT NULL;

-- 3. RPC function for rate limit checking
CREATE OR REPLACE FUNCTION check_register_rate_limit(
    p_telegram_id BIGINT,
    p_window_minutes INTEGER DEFAULT 15,
    p_max_attempts INTEGER DEFAULT 5
)
RETURNS TABLE (
    allowed BOOLEAN,
    attempts_used INTEGER,
    lockout_until TIMESTAMPTZ
) AS $$
DECLARE
    v_attempts INTEGER;
    v_lockout_until TIMESTAMPTZ;
BEGIN
    -- Count recent failed attempts
    SELECT COUNT(*) INTO v_attempts
    FROM auth_audit_log
    WHERE telegram_id = p_telegram_id
      AND action = 'register_attempt'
      AND success = false
      AND created_at > NOW() - (p_window_minutes || ' minutes')::INTERVAL;

    -- Check if already locked out
    SELECT MAX(created_at) + INTERVAL '1 hour' INTO v_lockout_until
    FROM auth_audit_log
    WHERE telegram_id = p_telegram_id
      AND action = 'register_lockout'
      AND created_at > NOW() - INTERVAL '1 hour';

    IF v_lockout_until IS NOT NULL AND v_lockout_until > NOW() THEN
        RETURN QUERY SELECT false, v_attempts, v_lockout_until;
        RETURN;
    END IF;

    -- Check if over limit
    IF v_attempts >= p_max_attempts THEN
        -- Log the lockout
        INSERT INTO auth_audit_log (telegram_id, action, failure_reason, created_at)
        VALUES (p_telegram_id, 'register_lockout', 'Too many failed attempts', NOW());

        RETURN QUERY SELECT false, v_attempts, NOW() + INTERVAL '1 hour';
        RETURN;
    END IF;

    RETURN QUERY SELECT true, v_attempts, NULL::TIMESTAMPTZ;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. RPC function for secure invite code claim
CREATE OR REPLACE FUNCTION claim_invite_code_secure(
    p_invite_code TEXT,
    p_telegram_id BIGINT,
    p_username TEXT,
    p_display_name TEXT
)
RETURNS TABLE (
    success BOOLEAN,
    user_id UUID,
    error_code TEXT
) AS $$
DECLARE
    v_user_id UUID;
    v_existing_user UUID;
    v_normalized_code TEXT;
BEGIN
    -- Normalize code
    v_normalized_code := UPPER(TRIM(p_invite_code));

    -- Check if telegram_id already has an account
    SELECT id INTO v_existing_user
    FROM users
    WHERE telegram_id = p_telegram_id;

    IF v_existing_user IS NOT NULL THEN
        RETURN QUERY SELECT false, v_existing_user, 'ALREADY_REGISTERED'::TEXT;
        RETURN;
    END IF;

    -- Find and claim invite code atomically
    UPDATE users
    SET
        telegram_id = p_telegram_id,
        username = COALESCE(p_username, username),
        display_name = COALESCE(p_display_name, display_name),
        status = 'active',
        onboarded_at = NOW()
    WHERE invite_code = v_normalized_code
      AND telegram_id IS NULL
      AND status = 'pending'
      AND (invite_expires_at IS NULL OR invite_expires_at > NOW())
    RETURNING id INTO v_user_id;

    IF v_user_id IS NULL THEN
        -- Add random delay to prevent timing attacks (50-150ms)
        PERFORM pg_sleep(0.05 + random() * 0.1);
        RETURN QUERY SELECT false, NULL::UUID, 'INVALID_OR_EXPIRED'::TEXT;
        RETURN;
    END IF;

    RETURN QUERY SELECT true, v_user_id, NULL::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. RPC function to log auth events
CREATE OR REPLACE FUNCTION log_auth_event(
    p_telegram_id BIGINT,
    p_telegram_username TEXT,
    p_action TEXT,
    p_success BOOLEAN,
    p_invite_code TEXT DEFAULT NULL,
    p_failure_reason TEXT DEFAULT NULL,
    p_ip_address TEXT DEFAULT NULL
)
RETURNS void AS $$
BEGIN
    INSERT INTO auth_audit_log (
        telegram_id,
        telegram_username,
        action,
        success,
        invite_code_hash,
        failure_reason,
        ip_address,
        created_at
    )
    VALUES (
        p_telegram_id,
        p_telegram_username,
        p_action,
        p_success,
        CASE WHEN p_invite_code IS NOT NULL
             THEN encode(sha256(p_invite_code::bytea), 'hex')
             ELSE NULL
        END,
        p_failure_reason,
        p_ip_address,
        NOW()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Update existing pending invites to have expiry (30 days from creation)
UPDATE users
SET invite_expires_at = created_at + INTERVAL '30 days'
WHERE status = 'pending'
  AND invite_expires_at IS NULL
  AND invite_code IS NOT NULL;

-- 7. Create view for admin monitoring (explicitly set security_invoker to avoid linter warning)
DROP VIEW IF EXISTS auth_attempts_summary;
CREATE VIEW auth_attempts_summary
WITH (security_invoker = true) AS
SELECT
    DATE_TRUNC('hour', created_at) as hour,
    action,
    COUNT(*) as count,
    COUNT(DISTINCT telegram_id) as unique_users,
    SUM(CASE WHEN success THEN 1 ELSE 0 END) as successes,
    SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) as failures
FROM auth_audit_log
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE_TRUNC('hour', created_at), action
ORDER BY hour DESC, action;

-- 8. Grant access to service role
GRANT EXECUTE ON FUNCTION check_register_rate_limit TO service_role;
GRANT EXECUTE ON FUNCTION claim_invite_code_secure TO service_role;
GRANT EXECUTE ON FUNCTION log_auth_event TO service_role;

-- 9. RLS for auth_audit_log (service role only, no user access)
ALTER TABLE auth_audit_log ENABLE ROW LEVEL SECURITY;

-- Only service role can access audit logs
CREATE POLICY auth_audit_log_service_only ON auth_audit_log
    FOR ALL
    USING (false)
    WITH CHECK (false);

-- Service role bypasses RLS by default, so this effectively means:
-- - Regular users: no access
-- - Service role: full access
