-- Migration 077: Add sentiment scoring fields to messages
-- Supports: Energy Over Time graph, coherence measurement, transformation arc detection

-- Add sentiment columns to messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sentiment_valence FLOAT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sentiment_arousal FLOAT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sentiment_label TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sentiment_confidence FLOAT;

-- Comments for documentation
COMMENT ON COLUMN messages.sentiment_valence IS 'Sentiment valence from -1 (negative) to +1 (positive), extracted via RoBERTa';
COMMENT ON COLUMN messages.sentiment_arousal IS 'Emotional arousal from 0 (calm) to 1 (excited), extracted via RoBERTa';
COMMENT ON COLUMN messages.sentiment_label IS 'Sentiment label: positive, negative, neutral';
COMMENT ON COLUMN messages.sentiment_confidence IS 'Model confidence 0-1';

-- Create index for sentiment-based queries (energy over time, phase detection)
CREATE INDEX IF NOT EXISTS idx_messages_sentiment ON messages(user_id, created_at, sentiment_valence)
WHERE sentiment_valence IS NOT NULL;

-- Add sentiment to documents as well (for reflection analysis)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sentiment_valence FLOAT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sentiment_label TEXT;

COMMENT ON COLUMN documents.sentiment_valence IS 'Sentiment valence from -1 (negative) to +1 (positive)';
