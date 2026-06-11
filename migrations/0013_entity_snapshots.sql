-- 0013 — entity change-log (ENTITY-HISTORY-DESIGN-2026-06-11).
-- Append-only history of every territory + realm's narrative (name/essence/
-- chronicle) and dynamics (energy/coherence/…) so the full evolution is
-- preserved — the describe pipeline otherwise upserts in place and only
-- dissolved rows + backups hold any past. One row per (entity, snapshot_kind,
-- seq); dedup-vs-latest in the writer means identical re-narrations don't append.
-- payload is the ONLY encrypted column (ENCRYPTED_FIELDS.entity_snapshots) — a
-- JSON blob holding the prose or the scalars, uniformly encrypted; all other
-- columns are structural keys/labels (plaintext per crypto-local classification).
CREATE TABLE IF NOT EXISTS entity_snapshots (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id         TEXT NOT NULL,
  entity_kind     TEXT NOT NULL,      -- 'territory' | 'realm'
  entity_id       INTEGER NOT NULL,   -- territory_id / realm_id (stable across re-cluster)
  snapshot_kind   TEXT NOT NULL,      -- 'narrative' | 'dynamics'
  stage           TEXT,               -- narrative: 'name' | 'chronicle' ; dynamics: NULL
  seq             INTEGER NOT NULL,   -- monotonic per (user, entity_kind, entity_id, snapshot_kind)
  payload         TEXT NOT NULL,      -- ENCRYPTED JSON blob
  entity_version  TEXT,               -- description_version / generation_version label
  cluster_version TEXT,               -- Generate era; join key to cluster_events
  generation_model TEXT,              -- narrator label
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, entity_kind, entity_id, snapshot_kind, seq)
);
CREATE INDEX IF NOT EXISTS idx_entity_snapshots_lookup
  ON entity_snapshots(user_id, entity_kind, entity_id, snapshot_kind, seq);
