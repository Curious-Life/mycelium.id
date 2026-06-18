# At-Rest Migration Hardening — Design (2026-06-18)

**Status:** DESIGN (sweep-first complete; spikes RAN). Fixes the bugs that corrupted the first live encryption attempt + makes new-user vaults born-encrypted reliably. Must be gated + rehearsed on a vault copy before any live retry.

## Why (the first attempt failed — sweep + spike findings)

Encrypting the live vault put the app into permanent setup-mode. Root-caused to **four** distinct bugs, only one of which is the race I first saw:

1. **Dual-boot migration RACE.** `src-tauri/src/main.rs` spawns `node src/server-rest.js` (line ~252) AND `node src/index.js --http` (line ~320, background thread) CONCURRENTLY; the stdio MCP server (`node src/index.js`, no flags) is a third. All call `boot()` → `ensureVaultEncrypted` (src/index.js ~113). Two ran the one-time copy→rekey→swap at once → "database disk image is malformed" / corruption.

2. **`ensureVaultSchema` opens UNKEYED before boot.** `completeBoot` (server-rest.js:404) calls `ensureVaultSchema(dbFile)` (server-rest.js:164-168) which does a bare `new Database(dbFile)` + `applyMigrations` BEFORE `boot()`. On ANY encrypted vault that throws "file is not a database" → setup mode. **This — not necessarily corruption — is the likely cause of the setup-mode on relaunch** (it would break even a cleanly-encrypted vault).

3. **New-user "born encrypted" is BROKEN.** SPIKE (ran): `key` pragma on an EXISTING plaintext-with-schema file → **"file is not a database"** (it does NOT encrypt in place; only `rekey` does). The real new-user path = `ensureVaultSchema` writes PLAINTEXT schema → `getDb` does `key` → throws. A fresh EMPTY file + `key` → born encrypted (works), but the schema step runs first, so the file is never empty at the keyed open. Gate B2 missed this by calling `boot()` directly, skipping `completeBoot`/`ensureVaultSchema`.

4. **Plaintext `.pre-cipher` backup left forever** — the whole vault in cleartext in the data dir (security). No secure delete.

Spike results (better-sqlite3-multiple-ciphers): CASE1 fresh-empty + `key` + schema → encrypted ✓ · CASE2 existing-plaintext + `key` → THROWS "file is not a database" · CASE3 existing-plaintext + `rekey` → encrypts in place ✓, reopens with `key` ✓.

## Design

**D1 — Single locked vault-init, consolidated into boot().** New `src/db/init.js` `initVaultStorage({ dbPath, userHex })`:
- Acquire a cross-process exclusive lock (`<dataDir>/.vault-init.lock`, `openSync` `wx`/O_EXCL; pid + mtime; steal only if holder pid dead AND mtime stale). Serializes server-rest + index.js --http + MCP.
- Resolve `dbKeyHex = resolveDbKeyHex(userHex, dbPath)`.
- `ensureVaultSchema(dbPath, schemaKeyHex)` — **key-aware** (D2).
- If `atRestEnabled() && isPlaintextSqlite(dbPath)` → `ensureVaultEncrypted({ dbPath, dbKeyHex })` (migrate an existing plaintext vault; the `rekey` path).
- Release lock. Return `dbKeyHex`.
`boot()` calls `initVaultStorage` then `getDb(dbKeyHex)`; the inline `ensureVaultEncrypted` is removed. `completeBoot` STOPS calling `ensureVaultSchema` (boot owns it now). Both processes block on the same lock → exactly one migrates; the other re-checks `isPlaintextSqlite` → encrypted → no-op.

**D2 — Key-aware `ensureVaultSchema(dbFile, dbKeyHex)`.** schemaKeyHex =
- vault file already encrypted → KEYED (apply schema to encrypted vault, idempotent);
- else fresh (`!existsSync`) AND at-rest on → KEYED → **born encrypted** (empty file + key → encrypted, then `applyMigrations` writes encrypted schema — spike CASE1);
- else (existing plaintext, or at-rest off) → UNKEYED (plaintext; the migration `rekey`s it after).
Fixes bug #2 (encrypted relaunch) AND #3 (new-user born-encrypted).

**D3 — `.pre-cipher` backup lifecycle.** KEEP it through the migration (safety net). After a VERIFIED keyed reopen, securely remove it (overwrite-best-effort + unlink) — gated behind a confirmed-good open, never auto-deleting the only copy before the new vault is proven. Until then, log its path. (Operator may also keep it N days.)

## Gates (must add — the old gate's gap let all 4 bugs through)

`verify:at-rest-migration` (new, replaces/extends the boot test) — exercise the REAL `completeBoot`-equivalent path (schema → migrate → open), not `boot()` directly:
- New-user: fresh vault + at-rest on through `initVaultStorage` → born encrypted + schema present + reads.
- Existing-plaintext: migrate → encrypted, data intact, opens keyed on relaunch.
- Existing-encrypted relaunch (NO flag): self-detect → keyed schema + open works (the bug-#2 regression).
- **CONCURRENCY**: spawn N (≥3) processes calling `initVaultStorage` on the SAME fresh-plaintext vault simultaneously → exactly ONE migrates, ZERO corruption, all N end opening the same encrypted vault. (The race regression.)
- Crash-recovery: kill mid-migration → original plaintext intact + re-run completes.
- `.pre-cipher` secure-delete only after verified reopen.

Then re-rehearse on a COPY of the real 1.8 GB vault before any live retry.
