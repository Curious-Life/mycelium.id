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
| `rebuild-fresh.mjs <src> <snapshot> <dest>` | Rebuild the vault into a fresh, clean, born-encrypted DB. Copies all readable rows; recovers physically-destroyed rows by id from a clean keyed snapshot (gap-fill). Its **loss guard** fails the run (`exit 8`) when a corrupt table could not be read in one clean forward-or-reverse pass **and** the src can't be counted (`count(*)` → `'ERR'`) — i.e. an unread region may hold rows the snapshot didn't carry. Do not swap on a non-zero exit; run `validate.mjs` (the id-level authority). |
| `validate.mjs <repaired> <snapshot> [src]` | Verify a rebuild before swapping: integrity, content fidelity (SHA-256), corruption-vs-newer-data triage, app-like reads. The authoritative id-level loss check (rebuild-fresh's guard is a fast in-line tripwire). |
| `loss-guard.probe.mjs` | Fast in-memory (no keychain/vault) probe for `loss-guard.mjs` — drives real forward+reverse scans to prove the guard fires when both stop on damage, stays silent on a clean read, and that a `'ERR'` src count no longer silently passes. Run after touching the guard. |

**Full procedure + the live-vault pickup protocol:**
`docs/VAULT-MALFORMED-VACUUM-REPAIR-HANDOFF-2026-06-25.md`.

## Why a fresh-file rebuild (not in-place)

- `DROP TABLE` / `VACUUM` on the corrupt table both walk its damaged b-tree and fail
  on the garbage page pointer — not retryable.
- `PRAGMA writable_schema=ON` is **not honored** by `better-sqlite3-multiple-ciphers`,
  so excising the corrupt schema rows in place is unavailable.

So the rebuild only **reads** from the corrupt source (reliable for good rows) and
**writes** everything into a brand-new file. No plaintext is ever produced.

## Failure mode: a diagnostic-flagged table aborts the copy (`NOT NULL constraint failed`)

**Symptom:** `rebuild-fresh.mjs` aborts mid-copy with e.g.
`FAIL copying messages: NOT NULL constraint failed: messages.role` — for a table
`diagnose.mjs` **explicitly listed as corrupt** (a `Tree N` object).

**Cause (live incident 2026-07-19):** shared-page-transience corruption lets a table
read "fine" on a single `SELECT *` while one specific row still returns garbage (a
`NULL` in a `NOT NULL` column) during the real row-by-row copy. The old one-shot
`isCorrupt()` probe passed, so the table took the fragile `genericCopy` (plain
`INSERT`) path and aborted — instead of the robust path (scan-union + `INSERT OR
IGNORE` + gap-fill) which tolerates it.

**Now handled automatically** (no flag needed in the common case):
- `rebuild-fresh.mjs` runs the source's own `PRAGMA integrity_check` and **auto-forces
  every flagged table down `robustCopy`** — the same corrupt-tree→object map
  `diagnose.mjs` prints. A diagnostic-flagged table can no longer take the clean path.
- If a bad row still surfaces only during `genericCopy` (some case integrity_check
  didn't flag), the copy **degrades to `robustCopy`** for that table instead of
  aborting the whole rebuild.

**Manual override / knobs:**

| Env | Effect |
|---|---|
| `MYCELIUM_REBUILD_FORCE_ROBUST=messages,audit_log` | Force named tables robust even if scans read clean (belt-and-suspenders). |
| `MYCELIUM_REBUILD_NO_AUTOROBUST=1` | Skip the integrity_check auto-derive (faster on a huge vault when naming tables explicitly). |
| `MYCELIUM_REBUILD_SKIP=<csv>` | Leave named tables **empty** (regenerable; b-tree too damaged to enumerate). |
| `MYCELIUM_REBUILD_MAX_ROWID=<n>` | Upper bound for the last-resort rowid range sweep. |
