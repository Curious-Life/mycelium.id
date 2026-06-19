-- 0012 — realm describe-state (DESCRIBE-MANAGEMENT-DESIGN-2026-06-11).
-- Realms gain the same chronicle-staleness anchor territories already have:
-- point_count_at_description records the live point count at narration time so
-- the drift gate (describe-chronicles realm pass) can re-narrate when content
-- meaningfully grows/shrinks. PLAINTEXT by design: an integer count, same
-- classification as realms.message_count (structural, needed for compare).
ALTER TABLE realms ADD COLUMN point_count_at_description INTEGER;

-- Naming-pass change detection. 0001 carries describe_input_hash on realms +
-- semantic_themes but NOT on territory_profiles (caught by verify:describe-gating
-- G1 — the design draft wrongly assumed both). PLAINTEXT by design: SHA-256 over
-- sampled message UUIDs (random, never content-derived) + live point count.
ALTER TABLE territory_profiles ADD COLUMN describe_input_hash TEXT;

