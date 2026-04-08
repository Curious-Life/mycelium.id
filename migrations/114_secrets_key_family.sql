-- Two-key separation: mark each secret's key family.
-- 'system' = encrypted with operator-managed SYSTEM_KEY (infrastructure secrets)
-- 'user'   = encrypted with customer-managed USER_MASTER_KEY (future: customer-owned secrets)
--
-- All existing secrets were seeded by the operator → default to 'system'.
ALTER TABLE secrets ADD COLUMN key_family TEXT NOT NULL DEFAULT 'system';
