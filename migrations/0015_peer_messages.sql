-- 0015 — peer_messages: direct messages exchanged between two connected
-- Mycelium instances (federation Tier-0c). A message is bound to a connection
-- row; `direction` is 'out' (we sent it) or 'in' (a verified peer sent it).
--
-- SECURITY: `content` is the only sensitive column → ENCRYPTED at rest via
-- ENCRYPTED_FIELDS.peer_messages (USER_MASTER_KEY — the user's own data). All
-- other columns are structural state the server queries unencrypted (ids, enums,
-- timestamps, the inbound dedup nonce). Inbound messages are ONLY accepted from
-- an ACCEPTED connection whose did:web signature verifies (handlers.js verify
-- gate) — there is no unauthenticated path to write an 'in' row.
--
-- created_at carries DEFAULT (datetime('now')) and is OMITTED from INSERTs on
-- purpose: the auto-encrypt INSERT parser truncates VALUES at the first ')', so a
-- datetime('now') literal beside an encrypted param would corrupt alignment
-- (same caveat as 0008_connectors). See src/crypto/crypto-local.js.

CREATE TABLE IF NOT EXISTS peer_messages (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,          -- the local vault owner (recipient of 'in', sender of 'out')
  connection_id TEXT NOT NULL,          -- FK → connections.id (the peer relationship)
  direction     TEXT NOT NULL,          -- 'out' | 'in'
  content       TEXT,                   -- ENCRYPTED: the message body
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
