-- Cache the peer's X25519 keyAgreement key + relay inbox on the connection row (federation
-- transport P4.5). Populated on the FIRST successful relay resolve and reused on every
-- subsequent send, so a DM/accept to an ESTABLISHED peer needs NO did.json fetch — the peer
-- can be fully offline and the relay simply holds the sealed envelope until they pull. First
-- contact still resolves live (we can't know a stranger's keys yet). Both are public routing
-- metadata (the CONTENT is E2E-sealed to the key); a future cache-bust on enqueue-reject
-- handles a peer that rotates keys or changes relay.
ALTER TABLE connections ADD COLUMN remote_key_agreement TEXT;
ALTER TABLE connections ADD COLUMN remote_relay_inbox TEXT;
-- When the cache was last refreshed. A cache older than the TTL triggers a re-resolve on the
-- next send (picking up a rotated key / moved relay) when the peer is reachable; if the
-- re-resolve fails (peer offline) the stale cache is still used, so delivery stays offline-
-- tolerant while stale-key loss is bounded to one TTL window instead of forever.
ALTER TABLE connections ADD COLUMN remote_keys_cached_at TEXT;
