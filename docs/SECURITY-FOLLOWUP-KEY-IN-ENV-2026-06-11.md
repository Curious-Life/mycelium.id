# Security note — master key in `process.env` (CLAUDE.md §4) — 2026-06-11

⚠️ Internal. Strip before the repo goes AGPL-public (see the pre-release purge checklist).

## TL;DR

For the **primary deployment — Mycelium running on the user's own local computer
(single-user)** — the master key living in `process.env` is an **accepted
same-user-trust boundary, not a vulnerability**. CLAUDE.md §4 ("master key …
never in env") was inherited verbatim from the canonical **multi-tenant VPS**
repo; its threat model (shared host, other tenants reading `/proc/environ`,
cross-tenant inheritance) has no analogue on a machine that is the user's own.
The realistic local adversary is malware running **as the user**, which can read
process memory, the OS keychain, keystrokes, and the vault file regardless of how
the key is held — so `env` vs. `tmpfs` vs. an opaque `CryptoKey` is marginal.

No action required for the local product. The item below is only relevant **if a
shared / multi-tenant host is ever deployed.**

## Finding (factual)

`boot()` writes the master key into `process.env` on **every** start, regardless
of key source:

- [`src/index.js:75`](../src/index.js) — `process.env.ENCRYPTION_MASTER_KEY = userHex`
  runs unconditionally (even with `MYCELIUM_KEY_SOURCE=keychain|1password`). The
  keychain/1Password source protects the key only **at rest** (shell history,
  config files), not at runtime.
- `clearMasterKeyFromEnv()` exists ([`crypto-local.js:1669`](../src/crypto/crypto-local.js))
  but is **never called**: mind-files, identity, blob-store, publish and remote
  read `process.env.ENCRYPTION_MASTER_KEY` lazily, so the key persists in env for
  the process lifetime.

Fixed 2026-06-11: the boot warning no longer points at a non-existent
`migrate-key-to-tmpfs.sh` and no longer reads as a defect — it's now a calm
`console.info` stating this is expected for a local install
([`crypto-local.js`](../src/crypto/crypto-local.js)); the boot comment no longer
claims env storage is "consistent with the key discipline"
([`src/index.js`](../src/index.js)).

## The one thing that *does* matter (and is already handled)

Not leaking the key into spawned child processes. Confirmed closed:

- Every spawn uses an explicit env allowlist — never `env: process.env`. The
  long-lived services (embed `:8091`, transcribe `:8093`, channel daemon) get
  `PATH/HOME/HF_*` only; the master key is **excluded**
  ([`transcribe/supervisor.js:96`](../src/transcribe/supervisor.js)).
- Only first-party crypto children (cluster, claims, chronicles, generate)
  receive `USER_MASTER`/`SYSTEM_KEY`, by necessity ([`jobs.js:81`](../src/jobs.js)).

## If a shared / multi-tenant host is ever deployed

Then §4 regains teeth and the fix is to wire tmpfs end to end:

1. `boot()` writes the key to a `0600` tmpfs file instead of `process.env`.
2. `getMasterKey()` already prefers tmpfs ([`crypto-local.js:1716`](../src/crypto/crypto-local.js)) — keep that.
3. Switch the ~6 env consumers (identity, blob-store, publish, remote, mcp,
   mind-files) off `process.env.ENCRYPTION_MASTER_KEY`.
4. Provide the migration script / fold into provisioning.

Linux-only (tmpfs); non-trivial boot-bridge refactor. Belongs with a managed-tier
review, not the local product.

## "Does this affect Macs / Windows?"

No — not as a server concern. The env/tmpfs item is about the process that *runs
the vault*, which on the primary (local) product is the user's own machine, where
it's an accepted boundary. A future managed tier would run on Linux servers; on
that tier, Mac/Windows machines are **clients** (browser portal, remote MCP,
desktop app), and the only client-side touch is *stronger* key custody via
WebAuthn/passkeys (Touch ID / Secure Enclave, Windows Hello / TPM) — a benefit,
not a risk.
