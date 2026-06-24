-- 0008 — dedicated `connectors` table (single-account; connectionId == adapter id).
--
-- Moves connector OPERATIONAL STATE off the `connector:<id>:state` secret blob
-- (which forced an O(all-secrets) decrypt-in-JS on every scheduler cycle to
-- enumerate connectors) into a real, queryable table. Mirrors the `ai_providers`
-- pattern: plaintext queryable columns (id/provider/status/cursor/counts/
-- timestamps) for normal WHERE/JOIN, with the user-describing PII columns
-- ENCRYPTED at rest via ENCRYPTED_FIELDS.connectors (USER_MASTER_KEY — this is
-- the user's own data, NOT operator infra, so it is NOT a SYSTEM_KEY table).
--
-- What stays in `secrets` (SYSTEM key, see store.js):
--   connector:<id>:tokens  → OAuth access/refresh tokens
--   connector:<id>:oauth   → transient { oauthState, pkceVerifier } during connect
-- Tokens never belong in this table. See docs/DESIGN-connectors-tier2-2026-06-04.md §3.
--
-- ENCRYPTED columns (ENCRYPTED_FIELDS.connectors): account_label, last_error,
-- recent_runs. Everything else is plaintext by design (structural state the
-- scheduler queries: enums, counts, cursors, timestamps).
--
-- created_at/updated_at carry DEFAULT (datetime('now')) and are OMITTED from
-- INSERTs on purpose: the auto-encrypt INSERT parser truncates VALUES at the
-- first ')' so a `datetime('now')` literal inside VALUES would corrupt param
-- alignment. UPDATEs set updated_at = datetime('now') in the SET clause, which
-- the UPDATE parser handles correctly (paren-aware split). See crypto-local.js.

CREATE TABLE IF NOT EXISTS connectors (
  id              TEXT PRIMARY KEY,          -- connectionId; for single-account == adapter id (gmail/linear/mock)
  user_id         TEXT NOT NULL,             -- tenant filter / JOIN key
  provider        TEXT,                       -- adapter provider key (gmail/linear/…); resolved from the registry
  account_label   TEXT,                       -- ENCRYPTED: connected account identifier (PII)
  status          TEXT,                       -- enum: disconnected|connecting|connected|syncing|error
  cursor          TEXT,                       -- incremental sync watermark
  connected_at    TEXT,
  last_sync_at    TEXT,
  last_ok_at      TEXT,
  last_error_at   TEXT,
  last_error      TEXT,                       -- ENCRYPTED: provider error detail
  idle_streak     INTEGER,                    -- idle-backoff input (consecutive no-net-new pulls)
  items_last_sync INTEGER,
  items_created   INTEGER,
  items_updated   INTEGER,
  items_deduped   INTEGER,
  budget_date     TEXT,                       -- UTC day for the daily item budget counter
  items_today     INTEGER,                    -- items pulled toward today's budget
  recent_runs     TEXT,                       -- ENCRYPTED JSON: last-10 run log (may carry error strings)
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_connectors_user ON connectors(user_id);
