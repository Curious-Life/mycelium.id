-- Per-channel access policy for the channel-daemon (Telegram groups + Discord
-- channels). Separate from authorization (telegram_groups.active /
-- identity_channels.delivery_enabled = channel on/off) and from the registry —
-- this is WHO within an authorized channel the bot will respond to.
--
--   mode 'owner'     → only the operator's sender id
--   mode 'allowlist' → operator + the ids in allowed_senders_json
--   mode 'open'      → anyone in the (already-authorized) channel  [default]
--
-- allowed_senders_json (JSON array of platform sender ids) is a slice of the
-- operator's social graph → ENCRYPTED at rest (USER_MASTER, ENCRYPTED_FIELDS).
-- The (kind,value) PK stays plaintext so lookups don't need decryption.
CREATE TABLE IF NOT EXISTS channel_access (
  channel_kind         TEXT NOT NULL,
  channel_value        TEXT NOT NULL,
  mode                 TEXT NOT NULL DEFAULT 'open' CHECK (mode IN ('owner', 'allowlist', 'open')),
  allowed_senders_json TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_kind, channel_value)
);
