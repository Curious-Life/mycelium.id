-- Durable dedup + per-sender ordering for the federation pull loop (transport P4).
-- A pulled envelope's (sender_did, nonce) is recorded here so a re-pull (ack failed /
-- process restart) never re-dispatches it, and a replayed / out-of-order send
-- (sender_seq <= the max already seen for that sender) is rejected. Vault DB; nonce +
-- sender_did are plaintext routing/replay metadata (the CONTENT was E2E-sealed).
-- This is the durable replacement for the in-memory ±5-min nonce window, which cannot
-- work once an envelope may sit in the relay queue for days before delivery.
CREATE TABLE IF NOT EXISTS federation_seen (
  sender_did  TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  sender_seq  INTEGER,
  seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sender_did, nonce)
);
CREATE INDEX IF NOT EXISTS idx_federation_seen_seq ON federation_seen(sender_did, sender_seq);
