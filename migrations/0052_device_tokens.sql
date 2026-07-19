-- 0052_device_tokens.sql — per-device bearer tokens for paired phones.
--
-- Each paired device (a phone that scanned the QR + was owner-approved) gets its
-- OWN token, so a lost/stolen device is revoked in isolation without rotating the
-- shared MYCELIUM_MCP_BEARER (which stays for the MCP harness). Modeled on
-- agent_tokens (migrations/0001_init.sql): the raw token is NEVER stored — only
-- its SHA-256 hash — and a non-null revoked_at means dead. device_label is an
-- owner-visible, NON-secret nickname ("Pixel 9"). No column here is sensitive, so
-- device_tokens is deliberately NOT in ENCRYPTED_FIELDS (a hash + a label + the
-- single owner id). Written/read only by the :8787 vault-writer process.
CREATE TABLE IF NOT EXISTS device_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT NOT NULL UNIQUE,          -- SHA-256 hex of the token (raw token never stored)
  device_label TEXT NOT NULL,                 -- owner-visible nickname, non-secret
  user_id      TEXT NOT NULL,                 -- the single vault owner (tenant key, parity w/ agent_tokens)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,                          -- debounced (≥5 min) — never a per-request write
  revoked_at   TEXT DEFAULT NULL              -- non-null ⇒ token is dead (fail-closed lookups filter on this)
);
