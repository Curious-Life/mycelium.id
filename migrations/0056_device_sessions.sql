-- 0056_device_sessions.sql — portal WebView / web-browser sessions, bound to a device token.
--
-- A device session is NOT a better-auth session. It is a vault-local, narrower
-- credential whose ONLY purpose is to let an ambient COOKIE carry EXACTLY the
-- authority of the device token it was minted from — no more. Two clients use it,
-- one mechanism (docs/UNIFIED-AUTH-DESIGN-2026-07-24.md, "one mechanism, two
-- on-ramps"):
--   • the embedded WKWebView portal (mobile) — cannot set an Authorization header
--     on the SPA's same-origin fetches, so it presents this cookie instead; the
--     backing token comes from QR pairing (device_tokens, kind='phone').
--   • the web browser (relay / any real browser) — after password/passkey login it
--     mints a device_tokens row (kind='web') and this session bound to it, so the
--     sensitive routers accept it (closes D-032).
--
-- It has NO independent lifetime (R0). Validity is derived PER REQUEST from the
-- parent device_tokens row via a JOIN: revoke the token (or let its idle policy
-- expire) and every session dies on the next request, with no expiry race and no
-- refresh machinery. The raw secret is NEVER stored — only its SHA-256 (parity with
-- device_tokens / agent_tokens). Nothing here is sensitive plaintext, so it is
-- deliberately NOT in ENCRYPTED_FIELDS. Written/read only by the :8787 vault-writer
-- process. Denied on import (import-credential-policy.js: device_sessions=deny).
CREATE TABLE IF NOT EXISTS device_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_hash    TEXT NOT NULL UNIQUE,   -- SHA-256 hex of the cookie secret; raw never stored
  device_token_id INTEGER NOT NULL        -- THE BINDING
                  REFERENCES device_tokens(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT,                   -- debounced (>=5 min); LRU eviction orders by this
  revoked_at      TEXT DEFAULT NULL       -- explicit teardown; fail-closed lookups filter on this
);
-- LRU eviction (design §3.5) orders by last_seen_at within a token, so the index carries it.
CREATE INDEX IF NOT EXISTS idx_device_sessions_token ON device_sessions(device_token_id, last_seen_at);
