-- Territory-river precomputed-shape cache (perf: cold-boot first-load).
--
-- GET /api/v1/portal/territory-river decrypts 400+ weekly territory-activation
-- vectors from fisher_trajectory (level='territory', window_type='weekly_step')
-- plus territory_profiles + frequency_snapshots and folds them into the river
-- shape on EVERY open. Idle that is ~1s; on a cold/congested app (boot-time
-- decrypt storm, empty #289 decrypt-once cache) it balloons to ~21s — and the
-- Curious Life page fetches it as its hero, so the first load after every app
-- restart is poor UX.
--
-- The river only changes when the trajectory/profiles are recomputed (a new
-- clustering run, a new weekly step, or a profile re-describe). So we memoise the
-- computed payload keyed by a CHEAP staleness probe (counts + max-timestamps over
-- non-encrypted columns — no vector decrypt). This persisted row lets the
-- cold-boot read decrypt ONE blob instead of 400 vectors; the in-process layer
-- (src/territory-river-cache.js) serves warm hits without touching the DB.
--
-- One row per user (the river is a single per-user aggregate). `payload` holds the
-- full river JSON and is a semantic fingerprint of the vault (territory NAMES +
-- activity series) → encrypted at rest under USER_MASTER (ENCRYPTED_FIELDS in
-- src/crypto/crypto-local.js), atop the whole-file SQLCipher envelope.
CREATE TABLE IF NOT EXISTS territory_river_cache (
  user_id     TEXT PRIMARY KEY,
  cache_key   TEXT NOT NULL,                 -- cheap staleness probe (plaintext, structural)
  payload     TEXT NOT NULL,                 -- encrypted river JSON envelope
  computed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
