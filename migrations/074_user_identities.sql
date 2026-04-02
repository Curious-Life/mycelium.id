-- User Identity Linking
-- Allows users to link external accounts (Discord, email, etc.) to their MYA account

-- User identities table - stores linked external accounts
CREATE TABLE IF NOT EXISTS user_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    provider TEXT NOT NULL,           -- 'discord', 'email', 'github', etc.
    provider_id TEXT NOT NULL,        -- External ID from provider
    provider_username TEXT,           -- Username/email from provider
    provider_avatar TEXT,             -- Avatar URL from provider
    provider_data JSONB DEFAULT '{}', -- Additional provider-specific data
    verified_at TIMESTAMPTZ,          -- When the identity was verified
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(provider, provider_id)     -- Each external identity can only link to one account
);

-- Index for looking up by provider and provider_id
CREATE INDEX IF NOT EXISTS idx_user_identities_provider ON user_identities(provider, provider_id);
CREATE INDEX IF NOT EXISTS idx_user_identities_user_id ON user_identities(user_id);

-- OAuth state table - stores pending OAuth flows
CREATE TABLE IF NOT EXISTS oauth_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    provider TEXT NOT NULL,
    state TEXT UNIQUE NOT NULL,       -- Random state for CSRF protection
    redirect_url TEXT,                -- Where to redirect after OAuth
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state);

-- Function to find user by provider identity
CREATE OR REPLACE FUNCTION find_user_by_identity(
    p_provider TEXT,
    p_provider_id TEXT
)
RETURNS UUID AS $$
DECLARE
    v_user_id UUID;
BEGIN
    SELECT user_id INTO v_user_id
    FROM user_identities
    WHERE provider = p_provider AND provider_id = p_provider_id;

    RETURN v_user_id;
END;
$$ LANGUAGE plpgsql;

-- Function to link identity to user
CREATE OR REPLACE FUNCTION link_user_identity(
    p_user_id UUID,
    p_provider TEXT,
    p_provider_id TEXT,
    p_provider_username TEXT DEFAULT NULL,
    p_provider_avatar TEXT DEFAULT NULL,
    p_provider_data JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
    v_identity_id UUID;
BEGIN
    INSERT INTO user_identities (
        user_id, provider, provider_id, provider_username,
        provider_avatar, provider_data, verified_at
    )
    VALUES (
        p_user_id, p_provider, p_provider_id, p_provider_username,
        p_provider_avatar, p_provider_data, NOW()
    )
    ON CONFLICT (provider, provider_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        provider_username = EXCLUDED.provider_username,
        provider_avatar = EXCLUDED.provider_avatar,
        provider_data = EXCLUDED.provider_data,
        verified_at = NOW(),
        updated_at = NOW()
    RETURNING id INTO v_identity_id;

    RETURN v_identity_id;
END;
$$ LANGUAGE plpgsql;

-- Cleanup expired OAuth states
CREATE OR REPLACE FUNCTION cleanup_expired_oauth_states()
RETURNS void AS $$
BEGIN
    DELETE FROM oauth_states WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- RLS policies
ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;

-- Service role full access
CREATE POLICY user_identities_service_policy ON user_identities
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY oauth_states_service_policy ON oauth_states
    FOR ALL USING (true) WITH CHECK (true);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON user_identities TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_identities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_states TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_states TO authenticated;
