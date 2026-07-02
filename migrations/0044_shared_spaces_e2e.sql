-- 0044 — Shared spaces E2E: the signed, totally-ordered CIPHERTEXT oplog + sealed CEKs.
--
-- The E2E "Space Key Lockbox" (docs/SHARED-SPACES-E2E-DESIGN-2026-06-30.md): a space's
-- content is replicated as an append-only, owner-Ed25519-signed log whose payloads are
-- END-TO-END ciphertext under a per-space Content Encryption Key (CEK). Members hold the
-- CEK (distributed as sealed key-grants); the owner box / relay / tunnel see ONLY
-- ciphertext. This replaces the rejected read-only-plaintext federation serve.
--
-- `payload` is ALREADY E2E ciphertext (a v4 'space' envelope from space-content.js,
-- encrypted under the CEK), so it is DELIBERATELY a plaintext column — field-level
-- encryption under USER_MASTER would re-grant the OWNER box plaintext access on its own
-- machine, which is the OPPOSITE of the model (the owner is an orderer of ciphertext, a
-- reader only by virtue of being a sealed-to member). The at-rest floor is already
-- whole-file SQLCipher; ENCRYPTED_FIELDS stays empty/untouched. Likewise the sealed CEK
-- `blob` is an HPKE seal openable only by a member's X25519 key.

CREATE TABLE IF NOT EXISTS space_oplog (
  space_id     TEXT NOT NULL,
  seq          INTEGER NOT NULL,            -- owner-assigned total order (0-based)
  op_id        TEXT NOT NULL,               -- idempotency key (author-chosen)
  author_did   TEXT NOT NULL,
  kind         TEXT NOT NULL,               -- 'content' | 'member-add' | 'member-remove' | 'key-grant'
  action       TEXT,                        -- 'put' | 'delete' (content)
  item_ref     TEXT,                        -- item_id (content) / member_did (membership)
  gen          INTEGER,                     -- the CEK generation this entry is under
  item_lamport INTEGER,                     -- per-item LWW ordering
  payload      TEXT,                        -- E2E ciphertext (v4 'space' envelope) — see header
  header_sig   TEXT NOT NULL,               -- owner Ed25519 over canonical(header)+payload
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (space_id, seq),
  UNIQUE (space_id, op_id)
);
CREATE INDEX IF NOT EXISTS idx_space_oplog_item ON space_oplog (space_id, item_ref, item_lamport);

-- Per-(space, generation, recipient) sealed CEK. The blob is sealToX25519 output; only
-- the recipient's X25519 private key (derivable only from their USER_MASTER) unwraps it.
CREATE TABLE IF NOT EXISTS space_cek_grants (
  space_id      TEXT NOT NULL,
  gen           INTEGER NOT NULL,
  recipient_did TEXT NOT NULL,
  blob          TEXT NOT NULL,
  seq           INTEGER,                    -- the oplog seq that introduced this grant
  ts            TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (space_id, gen, recipient_did)
);

-- Owner-authority sidecar: this box's role + the current generation for a space. Avoids
-- a risky ALTER on the users table (per design §2).
CREATE TABLE IF NOT EXISTS space_origin (
  space_id    TEXT PRIMARY KEY,
  is_home     INTEGER NOT NULL DEFAULT 1,   -- 1 = this box is the owner/authority for the space
  current_gen INTEGER NOT NULL DEFAULT 0,
  origin_did  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
