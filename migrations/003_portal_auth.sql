-- Portal authentication tables
-- Run this migration to enable web portal access

-- Passkey credentials table
CREATE TABLE IF NOT EXISTS passkey_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    credential_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used TIMESTAMPTZ DEFAULT NOW(),
    device_name TEXT
);

-- Index for credential lookup
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_credential_id ON passkey_credentials(credential_id);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_id ON passkey_credentials(user_id);

-- Registration tokens (for linking Telegram to passkey registration)
CREATE TABLE IF NOT EXISTS registration_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for token lookup
CREATE INDEX IF NOT EXISTS idx_registration_tokens_token ON registration_tokens(token);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    user_agent TEXT,
    ip_address INET
);

-- Index for session lookup
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Cleanup old sessions (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_sessions()
RETURNS void AS $$
BEGIN
    DELETE FROM sessions WHERE expires_at < NOW();
    DELETE FROM registration_tokens WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- RLS policies
ALTER TABLE passkey_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE registration_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- Allow full access (for API operations via anon key)
CREATE POLICY passkey_credentials_service_policy ON passkey_credentials
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY registration_tokens_service_policy ON registration_tokens
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY sessions_service_policy ON sessions
    FOR ALL USING (true) WITH CHECK (true);

-- Grant table permissions to anon and authenticated roles
-- (RLS policies control row access, but roles still need table-level permissions)
GRANT SELECT, INSERT, UPDATE ON passkey_credentials TO anon;
GRANT SELECT, INSERT, UPDATE ON passkey_credentials TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON registration_tokens TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON registration_tokens TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO authenticated;
