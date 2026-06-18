-- 0024_llm_usage_cache_tokens.sql — prompt-caching accounting (G2 Lever 2).
--
-- Records how many input tokens were served from / written to the provider's
-- prompt cache, alongside the existing input/output counts. Counts only, never
-- text (§1) — same boundary as the rest of llm_usage.
--
-- NOTE: bare ADD COLUMN is made idempotent across the re-exec-every-boot migration
-- runner by src/db/migrate.js (column-existence guard, per migrations/0004).
ALTER TABLE llm_usage ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE llm_usage ADD COLUMN cache_write_tokens INTEGER DEFAULT 0;
