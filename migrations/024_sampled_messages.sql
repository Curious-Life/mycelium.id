-- =============================================
-- Sampled Messages Tracking
-- =============================================
-- Track which messages were sampled for LLM generation.
-- Enables re-generation with same samples or new samples.

CREATE TABLE sampled_messages (
    id SERIAL PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    sampled_for_type TEXT NOT NULL,  -- 'theme' or 'territory'
    sampled_for_id INT NOT NULL,     -- theme_id or territory_id

    was_truncated BOOLEAN DEFAULT false,
    original_length INT,
    truncated_length INT,

    sampled_at TIMESTAMPTZ DEFAULT NOW(),

    -- Composite unique constraint
    UNIQUE(message_id, sampled_for_type, sampled_for_id)
);

-- RLS
ALTER TABLE sampled_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY sampled_messages_user_policy ON sampled_messages
    FOR ALL USING (user_id = auth.uid());

-- Index for lookups
CREATE INDEX idx_sampled_messages_lookup
    ON sampled_messages(user_id, sampled_for_type, sampled_for_id);
