-- 0015 — peer_messages: direct messages exchanged between two connected
-- Mycelium instances (federation Tier-0c). A message is bound to a connection
-- row; `direction` is 'out' (we sent it) or 'in' (a verified peer sent it).
--
-- SECURITY: `content` is the only sensitive column. It is secret at rest via
-- whole-file SQLCipher (the vault DB is opened with a USER_MASTER-derived key),
-- NOT a per-field envelope: peer_messages was collapsed to plaintext-inside-
-- SQLCipher in the SQLCipher collapse (Cut 4, PR #329), so ENCRYPTED_FIELDS
-- .peer_messages is EMPTY (`secrets` is the lone field-encrypted table). All
-- other columns are structural state the server queries (ids, enums, timestamps,
-- the inbound dedup nonce). Inbound messages are ONLY accepted from an ACCEPTED
-- connection whose did:web signature verifies (handlers.js verify gate) — there
-- is no unauthenticated path to write an 'in' row.
--
-- created_at carries DEFAULT (datetime('now')) and is OMITTED from INSERTs so
-- the DB stamps it. (content is no longer field-encrypted after the collapse, so
-- the auto-encrypt INSERT-parser VALUES-alignment caveat that motivated omitting
-- it no longer applies here — but the DEFAULT stamp is still the right pattern.)

CREATE TABLE IF NOT EXISTS peer_messages (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,          -- the local vault owner (recipient of 'in', sender of 'out')
  connection_id TEXT NOT NULL,          -- FK → connections.id (the peer relationship)
  direction     TEXT NOT NULL,          -- 'out' | 'in'
  content       TEXT,                   -- the message body (secret via whole-file SQLCipher, not field-encrypted)
  remote_nonce  TEXT,                   -- inbound dedup: the verified sender's envelope nonce
  status        TEXT DEFAULT 'sent',    -- out: sending|delivered|failed ; in: received
  read          INTEGER DEFAULT 0,      -- 0=unread (drives the People badge); inbound only
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_peer_messages_conn ON peer_messages(connection_id, created_at);
CREATE INDEX IF NOT EXISTS idx_peer_messages_unread ON peer_messages(user_id, read);
-- Dedup guard: a re-delivered inbound envelope (same nonce on the same connection)
-- must not double-insert. Partial-unique on the inbound nonce.
CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_messages_nonce ON peer_messages(connection_id, remote_nonce)
  WHERE remote_nonce IS NOT NULL;
