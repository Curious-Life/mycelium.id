---
name: Bootstrap-secrets must decrypt key names, not just values
description: The Worker returns encrypted key names (Swiss Vault — no master key on Worker). Bootstrap must decrypt both the key column AND value column from the secrets API response.
type: feedback
---

The Worker's GET /api/secrets returns `{ secrets: { ENCRYPTED_KEY: ENCRYPTED_VALUE } }`. Both the dict keys and values are ciphertext (v2 envelopes). The Worker has no master key (Swiss Vault) so it can't decrypt anything.

**Bug found 2026-04-09:** bootstrap-secrets.js was decrypting values but using encrypted key names as-is → `process.env["eyJ2IjoyLCJz..."] = "actual_token"` (useless garbage env var names). All bot tokens appeared to load (injected count matched) but no actual env var like `DISCORD_MYA_BOT_TOKEN` existed.

**Why:** When the key encryption was added (v2 envelopes on the `key` column in the secrets table), the bootstrap code was never updated to also decrypt the key names. It only decrypted values.

**Fix:** In `lib/bootstrap-secrets.js`, decrypt each key name with `decryptValue(encryptedKey, 'user', keys)` before using it as a dict key. Applied to both `bootstrapSecrets()` and `refreshSecrets()`.

**How to apply:** Any time the secrets API response format changes, verify that bootstrap handles ALL encrypted fields. The Worker is a ciphertext passthrough — it never decrypts anything. ALL decryption responsibility is on the VPS side.
