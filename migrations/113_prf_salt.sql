-- WebAuthn PRF salt for User Recovery Key (URK) derivation.
-- Each passkey credential gets a unique random salt used to derive
-- the URK via HMAC-SHA-256(credentialSecret, salt) → HKDF → URK.
-- Null = authenticator does not support PRF (falls back to operator-managed mode).
ALTER TABLE passkey_credentials ADD COLUMN prf_salt TEXT;
