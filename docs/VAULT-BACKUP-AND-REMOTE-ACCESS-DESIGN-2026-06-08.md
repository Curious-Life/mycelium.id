# Vault Backup + Path to an Externally-Served Vault — Design

**Date:** 2026-06-08
**Status:** Design locked (sweep-first), backend implementation in progress
**Skill trail:** `/sweep-first-design` (5 Explore sweeps + 3 self-verified pressure-test reads)
**Scope:** (1) export the *encrypted* vault to user-controlled storage; (2) restore it on a
new device by dropping the backup file + pasting the recovery key; (3) close the
silent-empty-vault data-loss footgun; (4) **design** the path to opening a vault that is
*served on another machine* (managed/relay). (1)–(3) build now; (4) is a forward-looking
architecture section that couples to `mycelium-managed/` and is **not** built here.

---

## 0. Headline

Mycelium today has **no vault-data backup**. The recovery key only *decrypts data that
already exists on the device*; it is **not** a cloud restore. Worse, pasting the recovery
key on a device with **no vault file silently creates a fresh EMPTY vault** and reports
success — so device loss = total data loss *even with the key in hand*
(`src/account/router.js:84-86` skips the KCV check when `kcv.json` is absent;
`src/server-rest.js:241` then calls `ensureVaultSchema()` unconditionally, materialising an
empty schema; `unlock()` writes a fresh `kcv.json`, `src/crypto/keys.js:41-49`).

This design adds a **ciphertext snapshot** of the vault that the user saves to their own
storage, a **restore-from-backup** path that lands the snapshot on disk so the existing
`/account/restore` key-paste opens the *real* data, and it **hardens `/restore`** so a bare
key-paste with no vault present can never again masquerade as a successful restore.

The backup is **zero-knowledge by construction**: the snapshot is the SQLite file's
*ciphertext pages* — every sensitive column is an AES-256-GCM wrapped-DEK envelope
(`src/crypto/crypto-local.js`), so the backup needs no key to *produce* and is useless to a
thief without the recovery key. The relay never enters this path; backup/restore is a
local, loopback-gated operation, exactly like the rest of the account ceremony.

---

## 1. What physically *is* the vault (verified)

Under `dataDir()` (`src/paths.js:39-63`):

| File / dir | Purpose | Encrypted at rest? | In backup? | Why |
|---|---|---|---|---|
| `mycelium.db` (+ `-wal`, `-shm`) | all user data; WAL mode (`src/adapter/d1.js:32`) | **yes** — column-level envelopes | **yes** (as a `.backup()` snapshot — single consistent file, sidecars folded in) | irreplaceable |
| `kcv.json` | key-check verifier (`src/crypto/keys.js:43-48`) | non-secret verifier | **yes** | its *presence* is what makes `/restore` verify-the-key instead of creating an empty vault |
| `uploads/<userId>/<uuid>.enc` | attachment blobs (`src/ingest/blob-store.js:11,22`) | **yes** — `MYCB` magic + AES-256-GCM envelope | **yes** | user data the DB references (`attachments.local_path`); a DB-only backup loses them |
| `remote.json` | non-secret remote config (`src/remote/config.js:6`) | non-secret | **optional** (yes, for seamless restore) | convenience |
| `auth.db` | better-auth: operator password hash + OAuth signing secret + sessions (`src/auth.js`) | **plaintext hash/secret** | **NO — excluded** | holds a password hash we will not ship off-device; regenerable; a stale signing secret would invalidate sessions on restore anyway |
| `vault-lock.json` | passphrase seal (only if passphrase lock on) (`src/paths.js:60`) | sealed | **NO — excluded** | recovery-key restore turns the passphrase lock *off* (`src/account/router.js:93`); re-establish after restore |
| `ollama/`, `caddy/`, `generate-stats.json` | runtime caches | n/a | **NO** | regenerable |

**Threat model for the backup file:** an attacker who steals it *without* the recovery key
gets only ciphertext. Embedding vectors are encrypted too
(`crypto-local.js` `NEVER_AUTO_DECRYPT_COLUMNS`: `embedding_768`, `nomic_embedding`,
`anchor_vector`). **Accepted residual leak** (unchanged from on-disk state): structural
metadata is plaintext in the SQLite file — row counts, timestamps, `documents.path`
folder names, `territory_profiles.message_count` (`crypto-local.js:362`). This is the
*same* exposure as the live `mycelium.db`; the backup adds no new plaintext. Documented,
accepted.

---

## 2. Snapshot primitive — the pivot

**Rejected (v1 sketch):** `cpSync(mycelium.db)` + copy `-wal`/`-shm` (the pattern at
`src/server-rest.js:83-84`). Copying three live files races the writer — a torn snapshot.

**Rejected:** reach the *live* better-sqlite3 handle and call `.backup()`. Pivoted away
because `boot()` returns `db` = the **domains object**, and the raw handle is `adapter.db`
which is **not** threaded out (`src/db/index.js:53,145`). Plumbing it through
`boot → completeBoot → server` couples backup into the boot contract.

**Chosen:** open a **fresh** `new Database(dbPath)` connection inside the backup route and
call `db.backup(tmpSnapshotPath)` (better-sqlite3's online-backup API — verified present:
`typeof db.backup === 'function'`). WAL supports multiple connections; the backup reads a
transactionally-consistent state and folds WAL frames in, yielding **one** consistent
`.db` file with no sidecars. **No key needed** — it copies ciphertext pages. Fully
decoupled from boot. Close the connection in `finally`.

```js
// src/account/backup.js
export async function snapshotDb(srcDbPath, destPath) {
  const src = new Database(srcDbPath, { fileMustExist: true });
  try { await src.backup(destPath); } finally { src.close(); }
}
```

---

## 3. Archive format

A single `.myvault` file = a **ZIP** built with `jszip` (already a dependency —
`package.json:156`; **no new dependency added to the vault**), STORE compression
(ciphertext + already-encrypted blobs are incompressible; STORE = zero CPU):

```
manifest.json          { v:1, createdAt, app, dbBytes, kcvSha256, uploadCount }
mycelium.db            ← the .backup() snapshot (ciphertext)
kcv.json               ← verifier (REQUIRED on restore)
remote.json            ← optional, if present
uploads/<userId>/...   ← .enc blobs, tree preserved
```

`manifest.kcvSha256` lets restore confirm the snapshot and the kcv belong together. The
manifest contains **no secrets**.

**Memory note (accepted for V1):** jszip buffers the archive in memory. A desktop
single-user vault (the cited real-world size is 81MB, `keystore.js:18`) is well within a
Node heap. **Deferred fast-follow:** switch to streaming (`node-tar`) if/when GB-scale
vaults appear — flagged, not silently capped. A soft warning is logged above
`BACKUP_SOFT_LIMIT_BYTES` (default 1GB) rather than refusing.

---

## 4. The data-loss footgun fix (security / fail-closed)

`POST /account/restore` is hardened: if `!existsSync(kcvPath)` → **`409 no_vault`**
("There's no vault on this device yet — restore a backup first, or create a new vault.").
This is safe because every legitimate caller of `/restore` runs *after* a vault exists:

- first-run `/setup` writes `kcv.json` via `unlock()` before the reveal step re-enters the
  key (verified: `unlock()` writes kcv when absent, `keys.js:41-49`; reveal re-posts to
  `/restore`, `setup/+page.svelte`);
- restore-from-backup lands `kcv.json` on disk *before* the key-paste;
- a hand-copied data dir already has `kcv.json`.

No legitimate flow needs `/restore` to *create* a vault. This single guard makes the silent
empty-vault impossible. (`ensureVaultSchema` stays — it's correct for `/setup`; it's the
*unverified `/restore`* that was the bug.)

---

## 5. Status state machine — new `needsRecoveryKey`

`GET /account/status` (`src/account/router.js:42-55`) gains one derived field:

```
needsRecoveryKey = vaultExists && !open && !passphraseEnabled
```

Meaning "vault files are present but the keychain can't open them" — i.e. a hand-copied
data dir, or the moment right after restore-from-backup lands the files. The boot path
auto-opens when the keychain holds matching keys (`server-rest.js:312`), so `open=false`
with files present and no passphrase ⇒ the user must paste the recovery key. This state was
previously unrepresented (the UI would mis-route to `/setup`). Existing fields
(`needsSetup`, `locked`) are unchanged; this is purely additive.

UI gating becomes: `needsSetup` → Create / Restore-from-backup · `locked` → passphrase
unlock · `needsRecoveryKey` → paste recovery key · else → app.

---

## 6. Endpoints (all inherit the loopback gate at `router.js:36-39`)

| Method · path | Body / response | Notes |
|---|---|---|
| `GET /account/backup` | → `Content-Disposition: attachment; filename="mycelium-vault-<date>.myvault"`, the zip bytes | requires vault **open** (`isInitialized()`); ciphertext out; loopback-only |
| `POST /account/restore-backup` | multipart (`busboy`, the `src/portal-uploads.js:70-89` pattern) → `{ ok, needsKey:true }` | refuse if `kcvPath` already exists unless `overwrite=true`; if overwriting, move the existing data dir aside first (mirrors the keystore backup-before-overwrite ethos, `keystore.js:19-21`) |
| `POST /account/restore` *(hardened)* | unchanged success shape | now `409 no_vault` when `!existsSync(kcvPath)` |
| `GET /account/status` *(extended)* | `+ needsRecoveryKey` | additive |

`accountRouter()` gains `dataDir`, `dbPath`, `uploadsRoot` in its deps (wired from
`server-rest.js`, which already resolves `effectiveDbPath`/`effectiveKcvPath`).

**Restore-backup ordering (fail-closed):** validate the zip (manifest + `mycelium.db` +
`kcv.json` present, `kcvSha256` matches) **into a temp dir first**; only on full success
atomically move files into `dataDir`; never leave a half-written vault. If a vault already
exists and `overwrite`, rename the old dir to `dataDir.pre-restore.<ts>` before moving.

---

## 7. Frontend

- **Onboarding Step 1** (`portal-app/src/routes/setup/+page.svelte`): the `intro` state gains
  a secondary action **"Restore from a backup"** → file picker → `POST /restore-backup` →
  on `needsKey`, transition to the existing `restore` (paste-key) state, which now succeeds
  because `kcv.json` is on disk.
- **Post-generation backup prompt (deliberate moment):** after the recovery-key `reveal`
  step (`setup/+page.svelte:175-227`), a new card sets the honest expectation —
  *"Your recovery key only unlocks data on THIS device. If this Mac is lost, your vault is
  gone unless you also keep a backup file."* with **"Back up my vault"** (downloads the
  `.myvault`) and **"I'll do this later."** Even at first-run (near-empty vault) this
  establishes the file + the habit.
- **Settings → Security/Data** (`portal-app/src/lib/views/SettingsView.svelte`, Security tab,
  next to the recovery-key card ~line 1184): a **Vault Backup** card — "Back up my vault"
  (download) + "Restore from a backup" (upload, for completeness; primary restore is
  onboarding). Reuses the existing blob-download pattern (`<a download>` + blob URL) and the
  `fetch('/api/v1/…', { credentials:'same-origin', 'X-CSRF-Token' })` helper
  (`portal-app/src/lib/api.ts`). No Tauri plugin needed — the webview is loopback to
  `127.0.0.1:8787` and HTML5 download/upload works (`src-tauri/src/main.rs:348`).
- **`/unlock` / layout routing** (`portal-app/src/routes/+layout.svelte:33-39`): honor
  `needsRecoveryKey` → route to the paste-key surface.

---

## 8. Item (3) — path to an externally-served vault (DESIGN ONLY, V2-adjacent)

**Verified invariant:** there is **no** code path where the app opens a vault whose *data*
lives elsewhere. All plaintext access is localhost (`src/index.js:39`,
`src/http/loopback.js`). The existing "remote" machinery (`src/remote/router.js`,
`connect-managed`) tunnels the relay to **your own running server**; the relay is a **dumb
ciphertext passthrough** — TLS terminates on *your* Mac (Caddy), frpc forwards ciphertext,
the master key never leaves the serving machine (`src/remote/runtime.js` header).

So "accessing an externally-served Mycelium vault" is **not** "open a remote `.db`." It is:
**a client speaks to a remote Mycelium *server* over the relay, authenticated by OAuth; the
key lives only on the serving machine.** Two server homes:

1. **Your own always-on machine** — *already shipped* (relay tunnel to your Mac + remote
   MCP/OAuth, `src/server-http.js`, `connect-managed`). A second device reaches it via the
   handle URL + OAuth.
2. **Managed VPS** (future, `mycelium-managed/`) — the same server, run for you on a VPS.
   Still single-tenant-per-process in spirit; V2 introduces the multi-tenant tier
   (`docs/REDESIGN-LIVING-SPEC.md`).

**Client "vault locator" abstraction (the new seam to build when item 3 lands):** the
portal/client today hard-assumes loopback. Introduce a `vaultTarget`:
`{ kind: 'local' }` (default, loopback) **or** `{ kind: 'remote', baseUrl:
'https://<handle>.mycelium.id', auth: <oauth session> }`. All vault-data `fetch`es route
through one helper that prepends `baseUrl` and attaches the bearer/session. `require-vault-auth`
already validates networked requests (`src/http/require-vault-auth.js`), so the *server*
side is ready; the *client* side needs the locator + an OAuth login flow (DCR/PKCE already
served at `/mcp` discovery).

**How backup generalizes to a served vault:** the SERVER owns `/account/backup`; the
operator pulls the **ciphertext** snapshot over the authenticated remote API (so a managed
host can never lock the user in — sovereignty preserved). Managed *could* offer scheduled
snapshots pushed to **user-controlled** storage, still ciphertext, relay/host never holding
plaintext. Restore onto a fresh server (local **or** VPS) = upload `.myvault` + the operator
supplies the recovery key to that server. DR responsibility stays with the user by design.

**Deferred (out of scope here, named so they don't ambush V2):** the client OAuth-login
UX; switching a running client between local and remote targets; multi-tenant key-wrap
(V2); scheduled/managed backups; making `/account/backup` reachable *over the relay*
(today it's loopback-only — correct for V1; remote-pull is a deliberate V2 decision with
its own auth review).

---

## 9. Module shape & LOC budget (±20%)

| File | Change | LOC |
|---|---|---|
| `src/account/backup.js` | **new** — `snapshotDb`, `buildVaultArchive`, `restoreVaultArchive`, `validateArchive` | ~190 |
| `src/account/router.js` | +`GET /backup`, +`POST /restore-backup`, harden `/restore`, +`needsRecoveryKey`, widen deps | ~75 |
| `src/server-rest.js` | pass `dataDir`/`dbPath`/`uploadsRoot` into `accountRouter()` | ~6 |
| `scripts/verify-backup.mjs` | **new** verify gate | ~170 |
| `package.json` | `verify:backup` into the chain | ~2 |
| `portal-app/.../setup/+page.svelte` | restore-from-backup + post-gen prompt | ~90 |
| `portal-app/.../views/SettingsView.svelte` | Vault Backup card | ~70 |
| `portal-app/.../+layout.svelte`, `/unlock` | honor `needsRecoveryKey` | ~20 |
| **Total** | | **~620** |

---

## 10. Test strategy (`scripts/verify-backup.mjs`, matches the `verify:*` convention)

1. **snapshot round-trips** — seed a vault, `snapshotDb()`, open the snapshot, assert row
   counts + a decrypted cell match the source (key applied to the *copy*).
2. **archive contents** — `buildVaultArchive()` produces a zip with `manifest.json`,
   `mycelium.db`, `kcv.json`, and every `uploads/**` entry; `kcvSha256` matches.
3. **restore lands real data, not empty** — into a clean temp `dataDir`,
   `restoreVaultArchive()` then `unlock()` with the key → assert the seeded rows decrypt
   (the regression test for the headline bug).
4. **hardened `/restore` fails closed** — with no `kcv.json`, `/restore` returns
   `409 no_vault` and **creates no db file**.
5. **restore refuse-overwrite** — existing vault + no `overwrite` → refused; with
   `overwrite` → old dir renamed aside, new data present.
6. **status** — `needsRecoveryKey` true exactly when `vaultExists && !open &&
   !passphraseEnabled`.
7. **leak check** — grep the produced archive bytes for a known plaintext seed string →
   absent (ciphertext only); `auth.db` absent from the archive.

Smoke (per `/deploy-and-verify`): REST+portal on :8787 — `GET /api/v1/account/backup`
downloads a file; restore it into a fresh `MYCELIUM_DATA_DIR` and confirm the data opens.

---

## 11. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Backup buffered in memory for a huge vault | low (V1) | OOM | STORE only; soft-limit log; node-tar streaming fast-follow (named) |
| Snapshot inconsistent under concurrent writes | low | corrupt copy | better-sqlite3 `.backup()` online API (consistent + retries); single-user desktop has near-zero write contention |
| Restore overwrites a good vault | low | data loss | refuse without `overwrite`; rename-aside before move; validate-in-temp-first |
| `auth.db` leaks operator hash via backup | — | — | **excluded** from the archive (§1) |
| Hardened `/restore` breaks the reveal re-entry | low | onboarding blocked | verified `unlock()` writes `kcv.json` before reveal re-posts (§4); test #4 guards it |
| Backup reachable over relay (future) leaks ciphertext to a thief w/ session | n/a (loopback-only now) | — | loopback gate inherited; remote-pull deferred with its own auth review (§8) |

---

## 12. Verification table

| # | Assumption (load-bearing) | Verified at (read myself) |
|---|---|---|
| 1 | Vault = `mycelium.db`(+wal/shm) + `kcv.json` + `uploads/` + `remote.json`; `auth.db`/`vault-lock.json` separate | `src/paths.js:53-63`, `src/ingest/blob-store.js:11,22`, `src/remote/config.js:6` |
| 2 | DB is WAL mode; raw handle created in adapter | `src/adapter/d1.js:31-33` |
| 3 | `boot()` returns domains as `db`; raw handle is `adapter.db`, **not** threaded out | `src/db/index.js:52-53,145`; `src/index.js:92,105` |
| 4 | better-sqlite3 `.backup()` exists | runtime check `typeof db.backup === 'function'` → `function` |
| 5 | Column-level encryption ⇒ snapshot is ciphertext needing no key | `src/adapter/d1.js` (autoEncrypt/Decrypt at query boundary); `src/crypto/crypto-local.js` envelopes |
| 6 | `kcv.json` is a non-secret verifier; safe to back up | `src/crypto/keys.js:12,43-48` |
| 7 | The footgun: `/restore` skips KCV when no `kcv.json`; `completeBoot` then `ensureVaultSchema` makes empty vault | `src/account/router.js:84-86`; `src/server-rest.js:241`; `src/crypto/keys.js:41-49` |
| 8 | `unlock()` writes `kcv.json` on first run (so reveal re-entry is safe post-harden) | `src/crypto/keys.js:41-49` |
| 9 | Account router is loopback-gated; new endpoints inherit it | `src/account/router.js:36-39` |
| 10 | `server-rest.js` resolves `effectiveDbPath`/`effectiveKcvPath` + mounts account router | `src/server-rest.js:206-216,333-338` |
| 11 | `jszip` + `busboy` already deps (no new dep) | `package.json:154-156`; multipart pattern `src/portal-uploads.js:70-89` |
| 12 | No `/portal/export` served in `src/` (frontend wiring is dead; different primitive) | grep `src/` → no match; reference only in `reference/server-routes/portal-export-import.js` |
| 13 | Relay is ciphertext passthrough; no path opens a remote `.db`; all plaintext is loopback | `src/index.js:39`; `src/http/loopback.js`; `src/remote/runtime.js` header; `src/http/require-vault-auth.js` |
| 14 | Status derives state from `vaultExists`/`open`/`passphraseEnabled`; auto-boot when keychain matches | `src/account/router.js:42-55`; `src/server-rest.js:312` |
| 15 | Verify-gate convention (`verify:*` scripts in the `npm run verify` chain) | `package.json:14-21,97` |

---

## 13. Revision history

- **v1 sketch** — file-copy `cpSync(mycelium.db, -wal, -shm)` per `server-rest.js:83-84`,
  and call `.backup()` on the live handle.
- **v2 (this doc)** — pivoted both: (a) `cpSync` of three live files races the writer →
  use `.backup()` online snapshot; (b) the live raw handle is **not** exposed via
  `boot()`/`dbHandle` (`db/index.js:145`) → open a **fresh** connection in the route, which
  is also more decoupled and, because encryption is column-level, needs **no key**. Added
  the `/restore` hardening + `needsRecoveryKey` status state after confirming the
  empty-vault footgun end-to-end. Chose `jszip` (existing dep) over adding `node-tar`,
  with streaming named as a deferred fast-follow.
