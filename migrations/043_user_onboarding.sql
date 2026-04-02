-- User onboarding for multi-user support
-- Adds invite code system and status tracking

-- Make telegram_id nullable (for pre-created users with invite codes)
-- Add status column for account state
-- Add invite_code column for registration

-- Drop the NOT NULL constraint on telegram_id
ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;

-- Add invite_code column (unique, for registration)
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code TEXT UNIQUE;

-- Add status column for account state management
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'over_budget'));

-- Add onboarded_at timestamp
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;

-- Add used_at column to registration_tokens to track token usage
ALTER TABLE registration_tokens ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

-- Index for invite code lookup
CREATE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code) WHERE invite_code IS NOT NULL;

-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON users TO anon;
GRANT SELECT, INSERT, UPDATE ON users TO authenticated;
