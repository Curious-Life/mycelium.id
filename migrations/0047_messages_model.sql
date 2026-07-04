-- 0047_messages_model.sql — record WHICH model produced an assistant message.
-- Plaintext provenance scalar (like `source`): NOT in ENCRYPTED_FIELDS.messages, so
-- it stays queryable + projectable to the timeline (a model NAME is non-secret and is
-- already shown in Settings + the activity feed). Populated on assistant rows only
-- (chat, scheduler, channel replies); user/inbound rows stay NULL. Historical rows
-- (pre-migration) stay NULL → no chip, by design. Additive + nullable → safe at-rest.
ALTER TABLE messages ADD COLUMN model TEXT;
