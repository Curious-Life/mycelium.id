-- Add handle to users table as the primary public identity
ALTER TABLE users ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
