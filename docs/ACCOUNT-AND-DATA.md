# Account, keys & data — how Mycelium protects and recovers your vault

This explains, for the local Mac app: **where your data lives**, **what the
recovery key is**, **how it survives app updates**, and **how to recover** on a
new machine. It also documents the key scheme for maintainers.

## TL;DR

- Your vault is **one encrypted SQLite database** on your Mac. It lives at
  `~/Library/Application Support/id.mycelium.app/` — **outside** the app bundle,
  so updating or replacing the `.app` never touches your data.
- On first launch you create the vault and are shown **one recovery key** (a
  64-character code). It is stored in your **macOS Keychain** for everyday use,
  and you save a copy somewhere safe. It is the **only** way to recover the vault
  on another computer. It cannot be reset.
- Lost your Keychain (new Mac, wiped account)? Open the app → **Restore** → paste
  the recovery key. You can re-view/back it up any time in **Settings → Recovery
  Key**.
- *(Optional)* Turn on an **app passphrase** (Settings → App Passphrase) to lock
  the app on every launch — the keys then leave the Keychain and are sealed with
  your passphrase. Your recovery key still opens it if you ever forget the passphrase.

## Where data is stored

| What | Path |
|---|---|
| Encrypted vault (messages, mindscape, attachments metadata, …) | `~/Library/Application Support/id.mycelium.app/mycelium.db` |
| Key-check value (verifies your key on unlock) | `…/id.mycelium.app/kcv.json` |
| Encrypted uploaded file bytes | `…/id.mycelium.app/uploads/` |
| Passphrase seal (only if you enable an app passphrase) | `…/id.mycelium.app/vault-lock.json` |

The directory is the OS's standard per-app data location (Tauri's
`app_data_dir()`), passed to the server as `MYCELIUM_DATA_DIR`. On Windows it is
`%APPDATA%\id.mycelium.app`; on Linux `~/.local/share/id.mycelium.app`.

**Migration of an older install.** If you previously ran with the vault inside
the repo (`./data/mycelium.db`), the first launch on the new version copies it
into the durable location and renames the original to
`./data/mycelium.db.migrated-<timestamp>` (it is **copied, never deleted**). This
is one-time and idempotent. Source: `ensureDataDir()` in `src/server-rest.js`.

Override the location for dev/tests with `MYCELIUM_DATA_DIR=/some/dir` (or the
finer `MYCELIUM_DB` / `MYCELIUM_KCV`). See `src/paths.js`.

## The recovery key (one key, not two)

The vault uses two encryption keys internally — **USER_MASTER** (encrypts all
your content) and **SYSTEM_KEY** (encrypts only the operator `secrets` table,
which is empty for a normal user). To keep backup simple, there is exactly **one
secret you ever need to save: USER_MASTER — your recovery key.** SYSTEM_KEY is
*derived* from it:

```
SYSTEM_KEY = HKDF-SHA256(USER_MASTER, info="mycelium:system-key:v1")
```

Both keys are written to the Keychain so the everyday unlock path is unchanged,
but because SYSTEM_KEY is reproducible from USER_MASTER, **one 64-hex key is all
you back up.** Code: `src/account/keystore.js`.

### How it survives app updates

The keys live in the **macOS login Keychain** (services `mycelium-user-master`
and `mycelium-system-key`), not in the app bundle — so updating the app keeps
them. The vault lives in Application Support — so updating the app keeps it. The
recovery key you saved offline is the backup for the *one* case the Keychain
can't cover: a different/wiped machine.

## First run, restore, and re-viewing the key

- **First run** (no keys in the Keychain): the app opens the **Setup** screen
  (`/setup`). "Create my vault" generates the key, stores it, opens the vault,
  and shows the recovery key once — copy it and/or **Download** it as
  `mycelium-recovery-key.txt`, confirm you saved it, and enter.
- **Restore** (new machine / cleared Keychain, vault files present or not): Setup
  → "I already have a recovery key" → paste it. If a vault is already present its
  key-check value rejects a wrong key before anything is written.
- **Re-view**: **Settings → Recovery Key → Show recovery key** (reveal, Copy,
  Download). Served only to localhost.

Endpoints (localhost-only, single-user): `GET/POST /api/v1/account/{status,
setup,restore,recovery-key,unlock,passphrase/enable,passphrase/disable}` — see
`src/account/router.js`. The server serves these even before the vault is open
("setup mode" / "locked mode"); vault routes return `503` until setup/restore/
unlock completes, then boot finishes in-process.

## Optional: lock the app with a passphrase

By default the vault opens automatically using the keys in your Keychain — no
prompt. If you want a second factor (so a stolen but logged-in Mac can't open
your vault), turn on an **app passphrase** in **Settings → App Passphrase**.

When enabled:

- Your two keys are **removed from the Keychain** and instead sealed in
  `…/id.mycelium.app/vault-lock.json`, encrypted with a key derived from your
  passphrase (scrypt). At rest, the keys exist **only** inside that sealed file.
- On every launch the app shows an **Unlock** screen (`/unlock`); enter the
  passphrase to open the vault. The keys then live only in memory for that run.
- **Forgot the passphrase?** Your **recovery key still works** — on the Unlock
  screen choose "Use your recovery key". The passphrase is a *lock*, not a second
  secret to lose; losing it never loses your vault. (Recovering with the key turns
  the passphrase lock off; set a new one in Settings.)
- **Turn it off** in Settings → App Passphrase → Turn off (enter the passphrase):
  the keys go back into the Keychain and the vault auto-opens again.

Invariant: at rest your keys are in **either** the Keychain **or** the sealed
`vault-lock.json`, never both. The seal stores its scrypt parameters, so the cost
can be tuned later without orphaning an existing lock.

> Security note: `vault-lock.json` is brute-forceable offline if someone copies
> it, so the strength of your passphrase matters (minimum 8 characters; longer is
> better — scrypt makes each guess expensive). FileVault remains your first line
> of defense at rest.

## Backing up your vault (and restoring it)

The recovery key only **decrypts data that already exists on this Mac** — it is
**not** a cloud restore. If the Mac is lost or wiped, the key alone cannot bring
your vault back. So Mycelium lets you save an **encrypted backup file** to storage
you control:

- **Back up:** Settings → Security → **Vault Backup → Back up now** (also offered
  as a deliberate prompt right after first-run setup). This downloads a
  `mycelium-vault-<date>.myvault` file — a consistent snapshot of your encrypted
  database, key-check file, and uploaded attachments. It is **ciphertext**: useless
  to anyone without your recovery key. Keep it on an external drive or your own
  cloud storage.
- **Restore on a new device:** on the first-run screen choose **Restore from a
  backup**, pick your `.myvault` file, then **paste your recovery key**. The key is
  verified against the restored vault before anything opens.

What's in the backup: `mycelium.db` (snapshot), `kcv.json` (key-check verifier),
`uploads/` (encrypted attachments), and `remote.json` (non-secret config). What's
**excluded**: `auth.db` (holds the operator password hash + OAuth signing secret —
never shipped off-device; regenerated on restore) and the optional passphrase seal
(a recovery-key restore turns the passphrase lock off).

> **Disaster recovery is yours.** Mycelium is sovereign and zero-knowledge — no
> server ever holds your plaintext, so no one can restore your vault for you. A
> backup file + your recovery key is the only recovery path. Keep both, separately.

**Footgun fixed (2026-06-08):** pasting the recovery key on a device with *no*
vault used to silently create a fresh **empty** vault and report success. `/restore`
now fails closed (`409 no_vault`) when no vault is present — restore a backup (or
copy your data dir) first, then paste the key.

**Accessing a vault served on another machine** (e.g. an always-on Mac or a future
managed host) is a *different* capability — the client talks to a remote Mycelium
*server* over the relay (a ciphertext passthrough), with the key resident only on
the serving machine. See
[`VAULT-BACKUP-AND-REMOTE-ACCESS-DESIGN-2026-06-08.md`](VAULT-BACKUP-AND-REMOTE-ACCESS-DESIGN-2026-06-08.md) §8.

## For maintainers

- `src/paths.js` — single source of truth for the data dir + file paths.
- `src/account/keystore.js` — generate/derive/store/read keys (+ the
  `npm run set-keys` CLI shares it).
- `src/account/keychain-names.js` — the Keychain service names, in one place,
  used by both the reader (`src/crypto/key-source.js`) and the writer.
- `src/account/router.js` + `src/server-rest.js` — setup/locked-mode boot + endpoints.
- `src/account/passphrase-lock.js` — the optional passphrase seal (scrypt + the
  existing AES-GCM envelope); `src/account/session-keys.js` — the in-memory keys
  the clustering child (`src/jobs.js`) reads when the Keychain is empty (lock mode).
- `scripts/verify-account.mjs` (`npm run verify:account`) + `scripts/verify-passphrase-lock.mjs`
  (`npm run verify:passphrase-lock`) — isolated end-to-end checks (ephemeral data
  dir + Keychain names; the seal co-locates in the temp dir).
- `src/account/backup.js` — snapshot (better-sqlite3 online backup) + `.myvault`
  archive build/validate/restore (jszip, STORE); `GET /backup` + `POST /restore-backup`
  in `src/account/router.js`. `scripts/verify-backup.mjs` (`npm run verify:backup`)
  proves the zero-knowledge archive, restore-lands-real-data, and the no-empty-vault
  guard. Design: [`VAULT-BACKUP-AND-REMOTE-ACCESS-DESIGN-2026-06-08.md`](VAULT-BACKUP-AND-REMOTE-ACCESS-DESIGN-2026-06-08.md).

**Existing two-independent-key vaults.** A vault created before this scheme keeps
working (both keys remain in the Keychain). To converge it to the single-key
model — so the *one* recovery key restores it — re-run
`node scripts/set-keys.mjs --user <your USER_MASTER> --force`; safe because the
`secrets` table is empty, so re-deriving SYSTEM_KEY changes nothing.
