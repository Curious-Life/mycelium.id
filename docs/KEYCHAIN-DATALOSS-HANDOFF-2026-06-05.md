# Keychain key-overwrite data-loss — fix handoff (2026-06-05)

## TL;DR

A fresh-key ceremony/test run overwrote the **real** `mycelium-user-master`
Keychain item *in place*. `security add-generic-password -U` keeps **no version
history**, so the prior `USER_MASTER` value was destroyed with no backup. The
clobbered item's value fingerprints identically to a `mycelium-fresh3-user`
test key — a dev/test ceremony ran against the **real login Keychain** instead of
an isolated namespace.

**Blast radius (revised):** the live user data turned out to be SAFE. The only
casualty was a **stale 81MB pre-rotation backup file**
(`~/mycelium.id/data/mycelium.db.migrated-1780393442314`, 132 messages,
2026-04-07..2026-06-01) encrypted under an *older, discarded* key — that file is
unrecoverable. The actual current vault lives at
`~/Library/Application Support/id.mycelium.app/mycelium.db` (~4MB, same 132
messages) and **decrypts cleanly with the current Keychain key**. So this was a
near-miss, not a total loss — but the in-place no-history overwrite is a genuine
data-loss mechanism that could easily have taken the live vault.

This handoff covers the code changes that make the same mistake **impossible to
do silently** going forward.

## Root cause

- `src/account/keystore.js` `kcWrite()` wrote with `security add-generic-password
  -U` — in-place update, no history, no backup.
- Only `scripts/set-keys.mjs` had a guard (`keychainHasKeys() && !--force`); the
  lower `writeKeychain`/`kcWrite` chokepoint had **none**, so any caller (or a
  `--force` run) could destroy the key with no recoverable copy.
- Test/ceremony runs are supposed to namespace away via
  `MYCELIUM_KC_ACCOUNT/USER/SYSTEM` (see `keychain-names.js`); the stray
  `mycelium-firsttest/fresh2/fresh3/freshtest` items prove some runs **forgot**,
  hitting the real account.

## What changed (commit on branch `docs/build-mac-fetch-sidecars`)

Two **independent** defenses at the lowest chokepoint (CLAUDE.md §2 defense-in-depth):

1. **Backup-before-overwrite** — `kcWrite()` reads any prior value and, if it
   DIFFERS, copies it to a timestamped companion `<service>.bak.<ts>` *before*
   replacing. Every overwrite is now recoverable. (`src/account/keystore.js`)
2. **Refuse in the default namespace** — `writeKeychain(..., { force })` throws
   `KeyOverwriteError` when overwriting an existing key with a DIFFERENT value in
   the *real* namespace (`isDefaultNamespace()` = no `MYCELIUM_KC_*` override)
   unless `force:true`. Same-value writes stay idempotent.
   (`src/account/keystore.js`, `src/account/keychain-names.js`)

Plus:

3. **KCV cross-check in `set-keys`** — `kcvMatches()` (new, non-mutating, in
   `src/crypto/keys.js`): if a vault exists and the key being written would NOT
   open it, `set-keys` refuses (exit 3) unless `--force`. Directly closes the
   "generate fresh key over a live vault" hole at its source.
4. **Caller updates** — `/restore` and `/passphrase/disable` pass `force:true`
   (authoritative, KCV-verified / seal-verified keys; prior value still backed
   up). `/setup` stays unforced (so it can never clobber an existing key).
   `set-keys` threads `--force` through and special-cases `KeyOverwriteError`.
5. **`exec` is now injectable** in `keystore.js` (mirrors `key-source.js`) so the
   guard is testable with a mock Keychain — zero risk to real keys, runs on CI/Linux.
6. **Verify gate** — `scripts/verify-keystore.mjs` (`npm run verify:keystore`,
   wired into the full `verify` chain before `verify:account`). 9 hermetic checks:
   backup-on-overwrite, idempotent same-value, refuse-without-force, force+backup,
   ephemeral-not-blocked, `isDefaultNamespace`, no-secret-in-message, and a static
   check that `verify-account` + `verify-passphrase-lock` set all three
   `MYCELIUM_KC_*` overrides.

## Files touched

- `src/account/keychain-names.js` — `isDefaultNamespace()`
- `src/account/keystore.js` — injectable exec, backup-before-overwrite,
  `KeyOverwriteError`, refuse-in-default-ns; default exec suppresses `security`
  stderr noise
- `src/crypto/keys.js` — `kcvMatches()` (non-mutating KCV check)
- `scripts/set-keys.mjs` — KCV cross-check + force threading + async main
- `src/account/router.js` — `/restore` + `/passphrase/disable` pass `force:true`
- `scripts/verify-keystore.mjs` — new gate; `package.json` — script + chain
- `docs/ARCHITECTURE.md` — §6 security model + verification table row

## Verification ledger

- [✓] `npm run verify:keystore` → VERDICT: GO (9/9)
- [✓] `npm run verify:keysource` → GO (read layer unchanged)
- [✓] `npm run verify:account` → GO (ceremony, ephemeral ns)
- [✓] `npm run verify:passphrase-lock` → GO (enable/disable restore, ephemeral ns)
- [✓] Live `security` smoke in an isolated namespace + temp data dir:
      - existing-keys fresh run → refused (exit 2), key intact
      - KCV-mismatch import → refused (exit 3), wrong key NOT written
      - `--force` replace → writes new key AND leaves a `.bak.*` companion holding the old key
      - no residual `mycelium-smoke-*` items after cleanup
- [✓] stderr noise from read-probes eliminated (default exec suppresses it)

## Follow-ups / open items

- **Stray test items still in the login Keychain** (manual cleanup — NOT done by
  this change; left to the user to avoid touching anything by surprise):
  `mycelium-firsttest{,-system,-user}`, `mycelium-fresh2*`, `mycelium-fresh3*`,
  `mycelium-freshtest*`. Remove with
  `security delete-generic-password -a <acct> -s <svc>` once confirmed unneeded.
- **`backupSuffix()` uses `Date.now()` via `new Date()`** — fine in this normal
  Node CLI/server path (NOT a Workflow script).
- Backup companions are intentionally **never auto-deleted** (`deleteKeychain`
  leaves them) — they are recovery artifacts the user prunes by hand after
  confirming the vault opens.
- Consider surfacing a Settings warning if `<service>.bak.*` items exist (signals
  a past overwrite worth investigating). Not built.
