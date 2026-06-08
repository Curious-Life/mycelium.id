# Handoff — Vault backup + restore-from-backup + footgun fix (2026-06-08)

## TL;DR

Built **"back up your vault"** (an encrypted `.myvault` snapshot the user saves to
their own storage) + **"restore from backup"**, and fixed the **silent-empty-vault
data-loss footgun**. Designed (not built) the path to opening a vault served on
another machine. Backend is verified end-to-end (`verify:backup` → **GO**, 25/25);
frontend typechecks clean. **Not yet committed** (no commit was requested).

## What shipped (built + verified)

- **`src/account/backup.js`** (new) — `snapshotDb()` (better-sqlite3 *online backup*
  from a fresh connection → one consistent ciphertext file, no WAL-sidecar copy,
  **no key needed** since encryption is column-level), `buildVaultArchive()` /
  `validateArchive()` / `restoreVaultArchive()` (jszip, STORE). Archive =
  `manifest.json` + `mycelium.db` + `kcv.json` + `uploads/**` + optional `remote.json`.
  Excludes `auth.db` (operator hash/signing secret) and `vault-lock.json`.
- **`src/account/router.js`** — `GET /backup` (stream `.myvault`, requires open vault),
  `POST /restore-backup` (busboy multipart → validate-in-temp → atomic move, refuses
  to clobber without `overwrite`, moves prior vault to `*.pre-restore.<ts>`),
  **hardened `POST /restore`** (`409 no_vault` when no `kcv.json` — kills the footgun),
  and **new `needsRecoveryKey`** status field.
- **`src/server-rest.js`** — wires `dbPath`/`uploadsRoot`/`remoteConfigPath` into
  `accountRouter()` (co-located in tests, env-aware in the app).
- **Frontend** — `setup/+page.svelte`: "Restore from a backup" flow (upload → paste
  key), a deliberate **post-setup backup prompt**, and `needsRecoveryKey` handling on
  mount. `SettingsView.svelte`: a **Vault Backup** card (Security tab).
- **`scripts/verify-backup.mjs`** + `verify:backup` in the `npm run verify` chain.

## Verification

- `npm run verify:backup` → **VERDICT: GO**, 25 passed / 0 failed. Decisive checks:
  C1 (plaintext absent from archive — zero-knowledge), E7 (restored vault decrypts
  REAL data, not empty), D2/D3 (no_vault refusal creates no empty db),
  F2/F3/F4 (overwrite refusal + move-aside), G1 (garbage rejected).
- Regression: `verify:account` (18/18), `verify:passphrase-lock` (27/27),
  `verify:control-loopback` (15/15) all GO.
- `portal-app` `npm run check` → 0 errors (had to move 3 pre-existing `* 2.svelte`
  Finder-duplicate files aside to let `svelte-kit sync` run; restored after).

## Design doc

[`docs/VAULT-BACKUP-AND-REMOTE-ACCESS-DESIGN-2026-06-08.md`](VAULT-BACKUP-AND-REMOTE-ACCESS-DESIGN-2026-06-08.md)
— full sweep-first design (verification table, revision history, threat model).
§8 is the **externally-served-vault** design (DESIGN ONLY): the relay is a ciphertext
passthrough; a client opens a remote *server*, never a remote `.db`; introduce a
client `vaultTarget` (local | remote baseUrl+OAuth). Couples to `src/remote/` +
`mycelium-managed/`. Deferred to V2.

## Pickup protocol / open items

1. **Commit** — not done (await user). Suggested: `feat(account): encrypted vault
   backup + restore-from-backup; fix silent-empty-vault footgun`.
2. **Browser smoke** — couldn't run a true browser preview: SvelteKit dev has no
   backend proxy (the app is served *by* the Node REST server on :8787). Authoritative
   proof is the HTTP `verify:backup` gate (hits the exact express routes). A full-stack
   manual smoke (Tauri) before release is the remaining check.
3. **Pre-existing cruft** — `portal-app/src/{lib/views/StreamsView 2.svelte,
   lib/components/people/PeopleNav 2.svelte,routes/(app)/streams/+page 2.svelte}` are
   Finder duplicates that break `svelte-kit sync`. Flagged as a separate cleanup task.
4. **Deferred fast-follows** (named in the design): node-tar streaming for GB-scale
   vaults (jszip buffers in memory today; soft-warn at 1GB, no cap); remote backup-pull
   over the relay (loopback-only now); the client `vaultTarget` + OAuth login UX (§8).
