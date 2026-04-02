-- Add contact attribution fields to messages for imported conversations
-- contact_id: FK to people table (who this message is from/about)
-- conversation_id: groups messages into threads (LinkedIn conv ID, etc.)

ALTER TABLE messages ADD COLUMN contact_id TEXT;
ALTER TABLE messages ADD COLUMN conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
