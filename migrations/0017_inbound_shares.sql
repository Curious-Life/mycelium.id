-- 0017 — inbound_shares: shares a CONNECTED PEER granted to ME (federation
-- sharing, grantee side). When peer A grants me access to one of their spaces or
-- contexts, A's instance announces it (signed social.mycelium.share.v1) and my
-- instance records a row here. This is the "Shared with you" side that the old
-- one-way /connections/:id/shared could never show.
--
-- SECURITY: `name` is A's label for the share ("Work") — a hint about A's life,
-- received over the wire → ENCRYPTED at rest via ENCRYPTED_FIELDS.inbound_shares.
-- Everything else is structural (ids, enum kind, opaque remote_ref, flags,
-- timestamps). The actual CONTENT is never stored here — it is fetched on demand
-- from A's instance (grant-gated, signed) when the user opens the share.
--
-- `name` is only ever written via the upsert's bound param (never a VALUES
-- datetime() literal beside it), so the auto-encrypt VALUES-paren caveat
-- (see 0008/0015) does not apply. created_at uses DEFAULT and is omitted from INSERT.

CREATE TABLE IF NOT EXISTS inbound_shares (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,        -- local connection to the granter (peer A)
  peer_did      TEXT,                 -- A's verified did:web (used to fetch content)
  kind          TEXT NOT NULL,        -- 'space' | 'context'
  remote_ref    TEXT NOT NULL,        -- A's space_id / context_id (opaque handle here)
  name          TEXT,                 -- ENCRYPTED: A's label for the share
  role          TEXT,                 -- space role: member | contributor
  granted_at    TEXT,                 -- A's grant timestamp (as announced)
  revoked       INTEGER DEFAULT 0,    -- A announced a revoke
  seen          INTEGER DEFAULT 0,    -- I have viewed it (drives the People badge)
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(connection_id, kind, remote_ref)
);

CREATE INDEX IF NOT EXISTS idx_inbound_shares_conn ON inbound_shares(connection_id);
CREATE INDEX IF NOT EXISTS idx_inbound_shares_unseen ON inbound_shares(seen, revoked);
