-- Fix: Add missing GRANT permissions for anon role
-- The anon role needs explicit permissions to access tables even with RLS policies

-- Grant permissions on passkey_credentials
GRANT SELECT, INSERT, UPDATE ON passkey_credentials TO anon;
GRANT SELECT, INSERT, UPDATE ON passkey_credentials TO authenticated;

-- Grant permissions on registration_tokens
GRANT SELECT, INSERT, UPDATE, DELETE ON registration_tokens TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON registration_tokens TO authenticated;

-- Grant permissions on sessions
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO authenticated;
