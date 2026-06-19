-- 0031_message_categories.sql — Context Engine L1 (Phase 1b): per-message life-domain +
-- register labels (taxonomy v1; operator decision 2026-06-19).
--
-- These are plaintext label ENUMS — like source / nlp_processed / status, NOT message
-- content — so the measurement + retrieval surface can GROUP BY them (a life-balance chart,
-- a domain filter) in one SQL query. They carry a coarse category, never the text itself;
-- this follows the established plaintext-enum precedent (crypto-local ENCRYPTED_FIELDS is an
-- allowlist — unregistered columns stay plaintext). There is no THREAT-MODEL.md gate; the
-- sensitivity class matches the already-plaintext source/status enums.
--
--   domain               one of 7 life areas              (NULL = unclassified)
--   register             one of 4 primaries               (Agency/Resonance/Inquiry/Substrate)
--   subregister          one of 12                        (Build … Store)
--   taxonomy_version     guards a future re-cut → a bounded re-label job, never silent drift
--   categories_processed 0/NULL pending → 1 attempted; INDEPENDENT of the nlp_processed state
--                        machine so LLM tagging never collides with embed/nlp.
--
-- Idempotent: the migrate runner guards each ADD COLUMN with a pragma check (src/db/migrate.js).
ALTER TABLE messages ADD COLUMN domain TEXT;
ALTER TABLE messages ADD COLUMN register TEXT;
ALTER TABLE messages ADD COLUMN subregister TEXT;
ALTER TABLE messages ADD COLUMN taxonomy_version TEXT;
ALTER TABLE messages ADD COLUMN categories_processed INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_messages_domain ON messages(user_id, domain);
CREATE INDEX IF NOT EXISTS idx_messages_categories_pending ON messages(user_id, categories_processed);
