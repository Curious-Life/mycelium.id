# vault-repair

Recovery tooling for a vault that **opens and reads fine but fails `VACUUM` with
`database disk image is malformed`** — the signature of a row/page-level
"table-by-table recovery" that left B-tree page-linkage damage (shared pages,
invalid child pointers, corrupt overflow chains, leaked pages).

These are **operational one-offs**, not part of the app boot path. Run them with
the app **quit** (a concurrent writer is what causes this class of corruption) and
**always against a copy first**. They open the vault keyed via the app's own scheme
(`USER_MASTER` from the macOS Keychain → `deriveDbKey`); key material is never logged.

| Script | Purpose |
|---|---|
| `diagnose.mjs <vault.db>` | Read-only. Enumerate the blast radius: structural checks, corrupt-tree → object map, which data tables are actually corrupt, exact unreadable rowids. |
| `rebuild-fresh.mjs <src> <snapshot> <dest>` | Rebuild the vault into a fresh, clean, born-encrypted DB. Copies all readable rows; recovers physically-destroyed rows by id from a clean keyed snapshot (gap-fill). |
| `validate.mjs <repaired> <snapshot> [src]` | Verify a rebuild before swapping: integrity, content fidelity (SHA-256), corruption-vs-newer-data triage, app-like reads. |

**Full procedure + the live-vault pickup protocol:**
`docs/VAULT-MALFORMED-VACUUM-REPAIR-HANDOFF-2026-06-25.md`.

## Why a fresh-file rebuild (not in-place)

- `DROP TABLE` / `VACUUM` on the corrupt table both walk its damaged b-tree and fail
  on the garbage page pointer — not retryable.
- `PRAGMA writable_schema=ON` is **not honored** by `better-sqlite3-multiple-ciphers`,
  so excising the corrupt schema rows in place is unavailable.

So the rebuild only **reads** from the corrupt source (reliable for good rows) and
**writes** everything into a brand-new file. No plaintext is ever produced.
