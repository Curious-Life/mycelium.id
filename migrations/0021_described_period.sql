-- 0021 — Covered-period provenance for narration (Context Capsule, Phase 1).
--
-- Records the time-span a description was BASED ON, so the next narration can tell
-- the model "your prior essence covered Jan–Mar; here is Apr–Jun to fold in" instead
-- of re-describing blind. Plaintext ISO 8601, same shape as the sibling describe
-- metadata (last_described_at, point_count_at_description) already on these tables.
-- The activity histogram reuses the existing (unused) activity_timeline TEXT column —
-- no new column needed for that.
--
-- Idempotent: ALTER TABLE ADD COLUMN is wrapped per-statement by applyMigrations
-- (src/db/migrate.js) so re-running on a populated DB is a no-op once applied.
ALTER TABLE territory_profiles ADD COLUMN described_period_start TEXT;
ALTER TABLE territory_profiles ADD COLUMN described_period_end TEXT;
ALTER TABLE realms ADD COLUMN described_period_start TEXT;
ALTER TABLE realms ADD COLUMN described_period_end TEXT;
