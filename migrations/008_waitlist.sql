-- Waitlist table for landing page email signups
CREATE TABLE IF NOT EXISTS waitlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    source TEXT DEFAULT 'landing', -- track where signup came from
    metadata JSONB DEFAULT '{}'
);

-- Index for email lookups
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);

-- Index for analytics (signups over time)
CREATE INDEX IF NOT EXISTS idx_waitlist_created ON waitlist(created_at);

-- RLS policies
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

-- Allow inserts from anyone (public signups)
CREATE POLICY "Allow public inserts" ON waitlist
    FOR INSERT
    WITH CHECK (true);

-- Only allow reads from service role (for admin purposes)
CREATE POLICY "Service role can read" ON waitlist
    FOR SELECT
    USING (auth.role() = 'service_role');
