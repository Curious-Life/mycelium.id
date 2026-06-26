-- 0041_categories_provenance.sql — Context Engine L1 provenance: record WHEN a message was
-- categorized and BY WHICH model. The 0038 columns track the labels + that an attempt happened
-- (categories_processed); these two answer "what has been processed, when, and by what model"
-- (operator ask 2026-06-20) — so the UI can show "tagged by llama3.1 · 2h ago" and a future
-- taxonomy/model re-cut can target only rows tagged by an older model.
--
-- Both are plaintext provenance scalars (a timestamp + a model label like 'llama3.1'), NOT
-- message content — same sensitivity class as nlp_processed_at / source (crypto-local
-- ENCRYPTED_FIELDS is an allowlist; unregistered columns stay plaintext). No THREAT-MODEL gate.
--
--   categorized_at    ISO-8601 UTC; stamped when categories_processed flips to 1 (NULL = pre-0041
--                     rows, or never attempted). Distinct from nlp_processed_at (the embed/NLP pass).
--   categories_model  the model that produced the labels, e.g. 'llama3.1' (NULL = unknown/legacy).
--
-- Idempotent: the migrate runner guards each ADD COLUMN with a pragma check (src/db/migrate.js).
ALTER TABLE messages ADD COLUMN categorized_at TEXT;
ALTER TABLE messages ADD COLUMN categories_model TEXT;
