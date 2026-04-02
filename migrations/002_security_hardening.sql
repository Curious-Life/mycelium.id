-- =============================================
-- MYA Security Hardening
-- Proper RLS policies for defense in depth
-- =============================================

-- Drop the overly permissive policies
DROP POLICY IF EXISTS "Service role full access" ON users;
DROP POLICY IF EXISTS "Service role full access" ON messages;
DROP POLICY IF EXISTS "Service role full access" ON documents;
DROP POLICY IF EXISTS "Service role full access" ON tag_vocabulary;
DROP POLICY IF EXISTS "Service role full access" ON suggested_tags;
DROP POLICY IF EXISTS "Service role full access" ON reflections;
DROP POLICY IF EXISTS "Service role full access" ON tasks;
DROP POLICY IF EXISTS "Service role full access" ON attachments;
DROP POLICY IF EXISTS "Service role full access" ON people;
DROP POLICY IF EXISTS "Service role full access" ON scheduled_events;
DROP POLICY IF EXISTS "Service role full access" ON document_versions;

-- =============================================
-- DENY ALL PUBLIC/ANON ACCESS
-- Only service_role can access (used by Workers)
-- =============================================

-- Users table - service role only
CREATE POLICY "service_role_users" ON users
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Messages table - service role only, scoped to user
CREATE POLICY "service_role_messages" ON messages
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Documents table - service role only
CREATE POLICY "service_role_documents" ON documents
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Tag vocabulary - service role only
CREATE POLICY "service_role_tag_vocabulary" ON tag_vocabulary
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Suggested tags - service role only
CREATE POLICY "service_role_suggested_tags" ON suggested_tags
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Reflections - service role only
CREATE POLICY "service_role_reflections" ON reflections
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Tasks - service role only
CREATE POLICY "service_role_tasks" ON tasks
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Attachments - service role only
CREATE POLICY "service_role_attachments" ON attachments
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- People - service role only
CREATE POLICY "service_role_people" ON people
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Scheduled events - service role only
CREATE POLICY "service_role_scheduled_events" ON scheduled_events
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Document versions - service role only
CREATE POLICY "service_role_document_versions" ON document_versions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- =============================================
-- REVOKE PUBLIC ACCESS
-- Ensure anon role cannot access anything
-- =============================================

REVOKE ALL ON users FROM anon;
REVOKE ALL ON messages FROM anon;
REVOKE ALL ON documents FROM anon;
REVOKE ALL ON tag_vocabulary FROM anon;
REVOKE ALL ON suggested_tags FROM anon;
REVOKE ALL ON reflections FROM anon;
REVOKE ALL ON tasks FROM anon;
REVOKE ALL ON attachments FROM anon;
REVOKE ALL ON people FROM anon;
REVOKE ALL ON scheduled_events FROM anon;
REVOKE ALL ON document_versions FROM anon;

-- Revoke from authenticated too (we only use service_role)
REVOKE ALL ON users FROM authenticated;
REVOKE ALL ON messages FROM authenticated;
REVOKE ALL ON documents FROM authenticated;
REVOKE ALL ON tag_vocabulary FROM authenticated;
REVOKE ALL ON suggested_tags FROM authenticated;
REVOKE ALL ON reflections FROM authenticated;
REVOKE ALL ON tasks FROM authenticated;
REVOKE ALL ON attachments FROM authenticated;
REVOKE ALL ON people FROM authenticated;
REVOKE ALL ON scheduled_events FROM authenticated;
REVOKE ALL ON document_versions FROM authenticated;

-- =============================================
-- SECURITY FUNCTIONS
-- Restrict function execution
-- =============================================

-- Revoke public execute on sensitive functions
REVOKE EXECUTE ON FUNCTION increment_tag_usage FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION match_messages FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION match_documents FROM PUBLIC;

-- Grant only to service_role
GRANT EXECUTE ON FUNCTION increment_tag_usage TO service_role;
GRANT EXECUTE ON FUNCTION match_messages TO service_role;
GRANT EXECUTE ON FUNCTION match_documents TO service_role;

-- =============================================
-- AUDIT LOG (optional but recommended)
-- Tracks all data modifications
-- =============================================

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
    user_id UUID,
    record_id UUID,
    old_data JSONB,
    new_data JSONB,
    ip_address TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on audit log
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Only service_role can access audit log
CREATE POLICY "service_role_audit_log" ON audit_log
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON audit_log FROM anon;
REVOKE ALL ON audit_log FROM authenticated;

-- Index for efficient audit queries
CREATE INDEX idx_audit_log_table ON audit_log(table_name, created_at DESC);
CREATE INDEX idx_audit_log_user ON audit_log(user_id, created_at DESC);

-- =============================================
-- NOTES FOR SUPABASE DASHBOARD CONFIGURATION
-- =============================================
--
-- 1. Go to Settings > API
--    - Disable "Enable anonymous sign-ins" if not needed
--    - Consider IP allowlisting for service_role if possible
--
-- 2. Go to Database > Extensions
--    - Only enable extensions you need (uuid-ossp, vector)
--
-- 3. Go to Settings > Database
--    - Enable "Confirm email" for any user signups
--    - Set strong password policy
--
-- 4. API Keys:
--    - NEVER expose service_role key in client code
--    - Only use anon key for public operations (none in this app)
--    - Rotate keys periodically
--
-- 5. Network:
--    - Consider enabling SSL enforcement
--    - Use connection pooling for production
-- =============================================
