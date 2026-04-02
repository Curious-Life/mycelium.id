-- =============================================
-- Theme Cards (Theme Identity Documents)
-- =============================================
-- Each theme within a territory gets an identity card.
-- Themes are sub-regions within territories.

CREATE TABLE theme_cards (
    id SERIAL PRIMARY KEY,
    theme_id INT NOT NULL,
    territory_id INT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Identity
    title TEXT NOT NULL,
    essence TEXT,

    -- Composition
    message_count INT DEFAULT 0,
    explored_count INT DEFAULT 0,
    explored_percent FLOAT DEFAULT 0,
    sample_message_ids UUID[] DEFAULT '{}',
    truncated_message_count INT DEFAULT 0,

    -- Entities
    top_entities JSONB DEFAULT '[]',

    -- Story
    story_birth TEXT,
    story_arc TEXT,
    story_peak TEXT,
    story_current_chapter TEXT,

    -- Uncertainty
    uncertainty_open_questions TEXT[] DEFAULT '{}',
    uncertainty_edges TEXT,

    -- Metadata
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    generation_model TEXT DEFAULT 'claude-haiku-4-5-20251001',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Composite unique constraint
    UNIQUE(user_id, territory_id, theme_id)
);

-- RLS
ALTER TABLE theme_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY theme_cards_user_policy ON theme_cards
    FOR ALL USING (user_id = auth.uid());

-- Indexes
CREATE INDEX idx_theme_cards_territory ON theme_cards(user_id, territory_id);
CREATE INDEX idx_theme_cards_theme ON theme_cards(user_id, theme_id);
