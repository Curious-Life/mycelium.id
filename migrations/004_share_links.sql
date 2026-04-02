-- Create share_links table for public message sharing
-- Required by migration 005_public_share_function.sql

CREATE TABLE IF NOT EXISTS share_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    password_hash TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    max_views INTEGER,
    view_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);
CREATE INDEX IF NOT EXISTS idx_share_links_user ON share_links(user_id);
CREATE INDEX IF NOT EXISTS idx_share_links_message ON share_links(message_id);
