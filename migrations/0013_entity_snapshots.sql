-- 0013 — entity change-log (ENTITY-HISTORY-DESIGN-2026-06-11).
-- Append-only history of every territory + realm's narrative (name/essence/
-- chronicle) and dynamics (energy/coherence/…) so the full evolution is
-- preserved — the describe pipeline otherwise upserts in place and only
-- dissolved rows + backups hold any past.
--
-- ENCRYPTION: `payload` is the ONLY data column and it is encrypted
-- (ENCRYPTED_FIELDS.entity_snapshots). It holds EVERYTHING that describes the
-- user's life — the prose/scalars AND all soft metadata (stage, model,
-- version, cluster era, capture timestamp). Nothing about content or timing is
-- stored plaintext. The remaining columns are the irreducible row-addressing
-- skeleton SQLite needs to find/dedup/order rows: AES-GCM here is
-- non-deterministic, so an encrypted column can never be matched in a
-- WHERE/ORDER BY/UNIQUE (this is why description_version is compared in JS, not
-- SQL). entity_kind/entity_id/snapshot_kind/seq are cluster ids + a sequence
-- counter — they carry no prose and leak strictly less than the plaintext
-- already on territory_profiles (message_count, realm_id, updated_at).
CREATE TABLE IF NOT EXISTS entity_snapshots (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id       TEXT NOT NULL,      -- scope key (single-user vault)
  entity_kind   TEXT NOT NULL,      -- addressing: 'territory' | 'realm'
  entity_id     INTEGER NOT NULL,   -- addressing: territory_id / realm_id
  snapshot_kind TEXT NOT NULL,      -- addressing: 'narrative' | 'dynamics'
  seq           INTEGER NOT NULL,   -- ordering within the (entity, kind) stream
  payload       TEXT NOT NULL,      -- ENCRYPTED JSON: { content, meta:{stage,model,entityVersion,clusterVersion,capturedAt} }
  UNIQUE(user_id, entity_kind, entity_id, snapshot_kind, seq)
);
CREATE INDEX IF NOT EXISTS idx_entity_snapshots_lookup
  ON entity_snapshots(user_id, entity_kind, entity_id, snapshot_kind, seq);
