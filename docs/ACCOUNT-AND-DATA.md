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

## Where data is stored

| What | Path |
|---|---|
| Encrypted vault (messages, mindscape, attachments metadata, …) | `~/Library/Application Support/id.mycelium.app/mycelium.db` |
| Key-check value (verifies your key on unlock) | `…/id.mycelium.app/kcv.json` |
| Encrypted uploaded file bytes | `…/id.mycelium.app/uploads/` |

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
setup,restore,recovery-key}` — see `src/account/router.js`. The server serves
these even before the vault is open ("setup mode"); vault routes return `503`
until setup/restore completes, then boot finishes in-process.

## For maintainers

- `src/paths.js` — single source of truth for the data dir + file paths.
- `src/account/keystore.js` — generate/derive/store/read keys (+ the
  `npm run set-keys` CLI shares it).
- `src/account/keychain-names.js` — the Keychain service names, in one place,
  used by both the reader (`src/crypto/key-source.js`) and the writer.
- `src/account/router.js` + `src/server-rest.js` — setup-mode boot + endpoints.
- `scripts/verify-account.mjs` (`npm run verify:account`) — isolated end-to-end
  checks (ephemeral data dir + Keychain names).

**Existing two-independent-key vaults.** A vault created before this scheme keeps
working (both keys remain in the Keychain). To converge it to the single-key
model — so the *one* recovery key restores it — re-run
`node scripts/set-keys.mjs --user <your USER_MASTER> --force`; safe because the
`secrets` table is empty, so re-deriving SYSTEM_KEY changes nothing.
