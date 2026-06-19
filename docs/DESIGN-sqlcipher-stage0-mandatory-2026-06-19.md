# Stage 0 — Make SQLCipher at-rest MANDATORY — Sweep-First Design

**Date:** 2026-06-19
**Branch / worktree:** `feat/sqlcipher-stage0-mandatory` · `mycelium-id-worktrees/sqlcipher-stage0` (off `origin/main` `95d80c4`)
**Audience:** the session implementing Stage 0 of the SQLCipher-only collapse.
**Companions:** [`SQLCIPHER-COLLAPSE-HANDOFF-2026-06-19.md`](SQLCIPHER-COLLAPSE-HANDOFF-2026-06-19.md) (the parent plan), [`AT-REST-BLINDNESS-DESIGN-2026-06-11.md`](AT-REST-BLINDNESS-DESIGN-2026-06-11.md), [`DESIGN-decrypt-perf-2026-06-19.md`](DESIGN-decrypt-perf-2026-06-19.md). Memories: `at-rest-boot-congestion-collapse`, `sqlcipher-collapse-decision`, `key-handling-security-audit`.

---

## TL;DR

**Goal (the user's words):** the app must be *encrypted if someone gets into the computer but has not authenticated the vault* — and stay secure **and** performant through the full SQLCipher-only collapse.

**Stage 0's job** is the *precondition* for the whole collapse: guarantee the real vault is **always ciphertext at rest** before later stages strip the per-field encryption layer (after which, any plaintext open would expose previously-protected content).

**The sweep changed the plan.** Three findings from reading live code (not the handoff sketch):

1. **The property already largely holds for shipped users** — the packaged app hard-sets `MYCELIUM_AT_REST=1` (`src-tauri/src/main.rs:275,346`), a fresh vault is born-encrypted / an existing one migrates, and `vaultIsEncrypted()` self-detection then forces keyed-open forever regardless of the flag. So Stage 0 is **not** "turn on encryption" — it's "make the keyed-real-vault invariant *un-regressable*, and stop leaving a plaintext copy on disk."
2. **The biggest actual hole is the un-purged plaintext backup.** `purgePlaintextBackup()` **does not exist on main** (contra memory, which thought PR #253 shipped it). After migration the full plaintext vault is renamed to `<db>.pre-cipher-<ts>` and **kept forever** (`db-cipher-migrate.js:17,110,114`). An attacker with file access reads it directly — defeating the entire goal. **This is the highest-value single change in Stage 0.**
3. **"Remove the plaintext fallback" as written would break 80 gates.** 80 of 199 `verify:*` gates reach the plaintext open *through* `boot()→resolveDbKeyHex` (default-off), and many then inspect raw bytes. The handoff's "keep plaintext only for bare-`new Database` fixtures" is inaccurate. The fix must target the **canonical real vault specifically**, not flip a global default.

**Stage 0 design (two guards + a purge), ~150 LOC + 1 new gate:**
- **Guard A — purge the plaintext backup.** Implement `purgePlaintextBackup()`: after the keyed vault is *proven* to reopen and read, securely delete `<db>.pre-cipher-*`. Self-verifying + fail-safe: refuses to delete unless the live vault is ciphertext, opens keyed, and reads back. Never deletes the only good copy.
- **Guard B — fail-closed on a plaintext *canonical* vault.** When `dbPath === resolveDbPath()` (the real vault) or `MYCELIUM_AT_REST` is on, a plaintext open is a **hard error**, not a silent `null`. Test gates (explicit temp `dbPath` ≠ canonical, flag off) are unaffected → all 80 gates stay green.
- **No global default flip. `secrets` untouched. The three `at-rest` gates + `verify:leak` stay the primary guarantee.**

---

## Revision history

- **v1 (handoff sketch, `SQLCIPHER-COLLAPSE-HANDOFF` §"Stage 0"):** "Remove the plaintext-at-rest fallback (`open.js:43-44` `return null`); keep plaintext only for bare-`new Database` test fixtures."
- **v2 (this doc, post-sweep) — three pivots:**
  - **Pivot 1:** 80/199 gates hit the fallback via `boot()`, not bare `new Database`. Removing/inverting the fallback breaks them and changes the raw-byte-inspection gates' semantics. → Enforce on the **canonical vault path** only (`dbPath === resolveDbPath()`); leave the test default-off path intact. Zero gate edits.
  - **Pivot 2:** The dominant hole for the stated threat is the **persistent plaintext `.pre-cipher` backup**, and `purgePlaintextBackup()` **does not exist** (memory was stale). → Make the purge the centerpiece of Stage 0.
  - **Pivot 3:** The "always ciphertext" property already holds for the packaged app; Stage 0 is hardening an existing invariant + closing the backup hole, not enabling encryption. Reframe scope accordingly.

---

## Threat model (precise)

**The property Stage 0 guarantees:** an adversary with **filesystem access but not the key** (USER_MASTER absent: not in env, macOS Keychain locked, 1Password signed out) sees **only ciphertext** — the main vault, its `-wal`/`-shm`, **and no plaintext `.pre-cipher` copy**. This is "got into the computer but hasn't authenticated the vault."

| In scope (Stage 0 closes / hardens) | Out of scope (accepted, documented) |
|---|---|
| Device/disk theft, cloud-backup/sync exposure of the vault file | A **running, unlocked** process (key in RAM + `process.env.ENCRYPTION_MASTER_KEY`, `index.js:93`) — same-user-while-unlocked trust boundary |
| Plaintext **copy** left on disk after migration (the `.pre-cipher` hole) | Key-in-env at runtime (documented `SECURITY-FOLLOWUP-KEY-IN-ENV-2026-06-11.md`) |
| A real vault regressing to plaintext (dev-from-source, or post-collapse) | No idle re-lock / zero-on-lock yet → **Tier-1 key-lifecycle work**, the budget freed by the collapse |

**Defense-in-depth note:** the genuine *independent* second layer is the OS — **FileVault (different key) underneath SQLCipher** — not a second app-layer sharing USER_MASTER (the layer the collapse removes). Stage 0 should *recommend FileVault-on* in docs; it is the real "two layers, two keys" story.

---

## Sweep findings (consolidated, file:line — read firsthand)

**Open/keying decision — `src/db/open.js`:**
- `atRestEnabled()` (`open.js:18-20`): true iff `MYCELIUM_AT_REST ∈ {1,true,yes,on}`; default **false**.
- `vaultIsEncrypted(dbPath)` (`open.js:24-26`): `exists && !isPlaintextSqlite(dbPath)` — header sniff for the SQLite magic.
- `resolveDbKeyHex(userHex, dbPath)` (`open.js:43-49`): **`if (!vaultIsEncrypted(dbPath) && !atRestEnabled()) return null;`** else require 64-hex USER_MASTER → `deriveDbKey`. The `null` is the plaintext-open fallback. **Self-detection (line 44) means an already-encrypted vault always keys, flag or not.**

**Fail-closed open — `src/adapter/d1.js:41-59`:** `if (!dbKeyHex && vaultIsEncrypted(dbPath)) throw 'refusing to open an at-rest-encrypted vault unkeyed'`. Keying applies `cipher='sqlcipher'` + `key="x'<hex>'"` + `temp_store=MEMORY` **before any statement**.

**Boot — `src/index.js`:** `boot({ dbPath = resolveDbPath(), … })` (`:37-41`); fail-closed if no USER_MASTER/SYSTEM_KEY (`:71-73`); pins key to env (`:93`); `dbKeyHex = initStorage ? await initVaultStorage({dbPath,userHex,…}) : resolveDbKeyHex(...)` (`:119-121`) → `getDb({…,dbKeyHex})` (`:122`). **The real app defaults `dbPath` to `resolveDbPath()`; gates pass an explicit temp `dbPath`.**

**Migration — `src/account/db-cipher-migrate.js`:** `isPlaintextSqlite()` header sniff (`:32-35`); `ensureVaultEncrypted()` checkpoints WAL → copy → `rekey` → **row-count parity check, fail-closed** (`:96-104`, deletes temp + throws on mismatch, original intact) → atomic swap to `<db>.pre-cipher-<ts>` (`:109-112`). **No purge: backup "KEPT, never auto-deleted" (`:17,114`).** `purgePlaintextBackup` — **absent** (grep across `src/`,`scripts/`: 0 defs).

**Packaged-app enforcement — `src-tauri/src/main.rs:275,346`:** both spawn paths `cmd.env("MYCELIUM_AT_REST","1")`.

**Canonical path — `src/paths.js`:** `dbPath()` = `<dataDir>/mycelium.db` unless `MYCELIUM_DB` override (`:50,53`). `index.js:41` + `server-rest.js:404` resolve via this.

**Gate blast radius:** 199 `verify:*` gates; **80 call `boot()`** (→ `resolveDbKeyHex`, default-off plaintext); only `verify-at-rest-boot`/`-migration` set the flag. Pattern (e.g. `verify-leak.mjs:19-20`, `verify-facts.mjs:17-20`): `applyMigrations(new Database(TEMP))` then `boot({dbPath:TEMP, userHex:random,…})`, then raw-byte reads. → A canonical-path-scoped guard leaves all 80 untouched.

**At-rest gates already prove the invariant:** `verify-at-rest.mjs:88` (no magic header), `:147` (WAL/shm opaque), `:102-105` (no-key/wrong-key throw); `verify-at-rest-boot.mjs:82` (self-detect keyed with no flag); `verify-at-rest-migration.mjs:158` (key-match); `verify-leak.mjs:91` (no plaintext column tokens in raw bytes).

---

## Stage 0 design

### Guard A — `purgePlaintextBackup()` (the centerpiece)

**New function in `src/account/db-cipher-migrate.js`:**
```
purgePlaintextBackup({ dbPath, dbKeyHex, log }) -> { purged: string[], skipped: {path,reason}[] }
```
Steps (all checks must pass *before* any unlink — fail-safe):
1. **Live vault is ciphertext:** `!isPlaintextSqlite(dbPath)` (header is not the SQLite magic). Else skip-all + warn.
2. **Live vault opens keyed + reads:** open `dbPath` with `dbKeyHex`, run a sentinel read (`SELECT count(*) FROM sqlite_master` succeeds → key is correct and the cipher is intact). Else skip-all + warn.
3. For each `<dbPath>.pre-cipher-*` sibling: confirm it **is** plaintext (`isPlaintextSqlite` true) — a sanity guard that we're deleting the right kind of file — then `rmSync` it (+ any `-wal`/`-shm` siblings).
4. Return what was purged / skipped; **never throw on a normal skip** (boot must not fail because a backup couldn't be removed) — log loudly.

**Wiring (`src/index.js`, after `getDb` succeeds, ~line 122):** call `purgePlaintextBackup({ dbPath, dbKeyHex, log })` only when `dbKeyHex` is set (the vault is keyed) and `dbPath === resolveDbPath()` (the real vault — never touch a test fixture's siblings). Idempotent (no-op when no backup remains).

**Secure-erase honesty:** on APFS/SSD a plain `rmSync` does not guarantee block erasure (copy-on-write + wear-leveling). We `unlink` and **document** that true at-rest erasure of the backup relies on **FileVault** (whole-disk, different key). This is the correct, non-theatrical statement — do not claim shred-grade deletion.

### Guard B — fail-closed on a plaintext canonical vault

**In `resolveDbKeyHex` (or a thin wrapper at the boot/init layer):** when the vault is the **canonical real vault** (`path.resolve(dbPath) === resolveDbPath({env})`) **or** `atRestEnabled()` is true, a resolution that would yield a **plaintext open of an existing file** is a **hard error**:
```
if ((isCanonical || atRestEnabled()) && !vaultIsEncrypted(dbPath) && existsSync(dbPath) && <migration did not run>)
  throw 'refusing to serve the real vault in plaintext — at-rest is mandatory';
```
- A **fresh** canonical vault with at-rest on is **born-encrypted** (key returned) — not an error.
- An **existing plaintext** canonical vault **migrates** (then is keyed) — not an error.
- The throw only fires if a real vault would otherwise open plaintext (at-rest off on the canonical path, or migration skipped) — i.e. the dev-from-source / post-collapse regression we must forbid.
- **Test gates** pass a temp `dbPath ≠ resolveDbPath()` with the flag off → `isCanonical` false, `atRestEnabled()` false → unchanged `null` → plaintext → **all 80 gates green.**

**Why path-equality, not a new env flag:** zero gate edits, zero launcher changes, and it fails safe (a new real entry point that forgets the flag is still caught because it resolves the canonical path). Considered + rejected: a `MYCELIUM_REQUIRE_AT_REST` the launchers set (more moving parts, a forgotten launcher regresses silently).

### Module shape & LOC budget
| Change | File | ~LOC |
|---|---|---|
| `purgePlaintextBackup()` + helpers | `src/account/db-cipher-migrate.js` | ~55 |
| Wiring (guarded call) | `src/index.js` | ~6 |
| Guard B (fail-closed canonical) | `src/db/open.js` (+ `paths` import) | ~12 |
| New gate `verify-at-rest-purge.mjs` | `scripts/` + `package.json` | ~90 |
| Docs (FileVault recommendation; threat note) | `docs/` + README troubleshooting | ~20 |
| **Total** | | **~180** |

### Edge cases (explicit decisions)
- **Purge runs but live vault read fails (wrong key / corruption):** skip-all, keep every backup, log loudly. Rationale: the backup may be the only recoverable copy. The user's existing manual-delete instruction remains the fallback.
- **Multiple `.pre-cipher-*` (repeated migrations):** purge all that pass the per-file plaintext check (after the live-vault checks pass once). Each is a stale plaintext copy.
- **`-wal`/`-shm` siblings of the backup:** remove with it (they're plaintext fragments).
- **Concurrent boot (the N-process app):** purge is idempotent + guarded by the live-vault checks; a race just means one process no-ops. The migration's existing cross-process lock (`verify-at-rest-migration.mjs:126` "exactly ONE") already serialized the dangerous step.
- **Backup on a different filesystem / permissions:** `rmSync` failure on one path → record as skipped, continue; never throw.
- **Guard B vs an injected real-path test:** a test that *deliberately* set `MYCELIUM_DB` to its temp path AND passed that path would be treated as canonical — acceptable (it opted into the real-vault path); no such gate exists today.

### Test strategy
- **New `verify:at-rest-purge`** (`scripts/verify-at-rest-purge.mjs`): migrate a plaintext fixture → assert one `.pre-cipher` exists → `purgePlaintextBackup` with correct key → assert **backup gone AND live vault still opens keyed AND data intact**. Negatives: refuses when (a) no key, (b) live vault still plaintext, (c) wrong key → keyed read fails → **backup retained**. Assert the canonical-path scoping (a temp-path call is a no-op on unrelated siblings).
- **New assertion in `verify:at-rest-boot`:** a plaintext **canonical** open is **refused** (Guard B) when at-rest would leave it plaintext; a temp-path plaintext open still returns `null` (gates unaffected).
- **Regression floor (must stay green):** the 80 `boot()` gates, `verify:at-rest{,-boot,-migration}`, `verify:leak`, `verify:secrets`. **Full `npm run verify` green before merge** (per `no-hotfixes-production-ready`).
- **Live smoke (rebuilt app, real vault):** confirm (1) vault opens keyed, (2) after a (copy-test) migration the `.pre-cipher` is purged, (3) data intact, (4) a forced plaintext canonical open is refused.

### Implementation order (each independently shippable)
1. **Guard A `purgePlaintextBackup` + gate** — highest value, lowest risk, closes the real hole. Smoke: `npm run verify:at-rest-purge` GO.
2. **Wire purge into boot** (canonical-only, keyed-only). Smoke: boot a copy of the real vault → backup purged, vault serves.
3. **Guard B fail-closed** + the boot-gate assertion. Smoke: `MYCELIUM_AT_REST` off on a canonical plaintext vault → boot refuses.
4. **Full `npm run verify`** GO → PR → rebuild app → live smoke.

---

## End-to-end plan (0 → A → B → C) with verification milestones

The collapse is **lazy/non-destructive** (mixed vaults read correctly), so each stage ships + verifies independently. The **invariant that must hold at every stage:** the vault file is ciphertext at rest and `secrets` stays field-encrypted.

| Stage | Scope | Done when (verification) | Decision to proceed |
|---|---|---|---|
| **0 (this doc)** | SQLCipher mandatory for the real vault + purge the plaintext backup | `verify:at-rest{,-boot,-migration,-purge}` + `verify:leak` GO; full `verify` green; **live**: real vault keyed, `.pre-cipher` purged, plaintext-canonical-open refused | Property "encrypted when unauthenticated, no plaintext copy" confirmed on the real vault |
| **A — vectors** | store embeddings/centroids/anchors as raw bytes inside the cipher (drop `encryptVector`/`encrypt_vector`); remove from `NEVER_AUTO_DECRYPT_COLUMNS` | new `verify:vectors-raw` (round-trips raw, file still ciphertext); `verify:search` GO; nomic/centroid encryption gates retired; **search-build benchmark before/after** | Bloat (~2.43×) + per-vector decrypt gone; no correctness regression in search/mindscape |
| **B — content write-side** | shrink `ENCRYPTED_FIELDS` → `{secrets}`; stop the 12 Python writers **in lockstep**; backfill content columns → plaintext (reversible, batched, copy-tested) | per column: write-plaintext + **0 remaining envelopes**; mixed-row reads still correct; `verify:leak` re-framed ("no plaintext **outside** the cipher file") | each column fully backfilled before any Stage-C query touches it (the #1 landmine) |
| **C — restore SQL + simplify** | move decrypt-then-JS-sort back to SQL (`topology.js`/`territory-docs.js`/`claims.js`/`people.js`); retire ~15 encryption gates; neutralize scope guardians | restored queries **golden-diff identical** to the old JS-sort on a real-vault copy; full `verify` green; `verify:secrets`+`at-rest` still green | the Library list (and mindscape/streams) is a native indexed query — the 14.7s class of latency is gone at the source |

**Overall "secure but performant" definition of done:** (1) the vault is ciphertext at rest with no plaintext copy (Stage 0); (2) reads are transparent cached page-decrypt, hot columns are SQL-indexed (Stage C); (3) `secrets` remains field-encrypted; (4) the freed complexity budget has funded **Tier-1 key-lifecycle** (Touch ID/Secure-Enclave unlock, zero-on-lock, idle re-lock) and closed the **SSRF/BYOK + recovery-key** holes (`prepublish-security-audit`). Stages 0–C are the encryption collapse; the Tier-1 items run alongside and are the *real* local-vault security wins.

---

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Purge deletes the only good copy (key/cipher actually broken) | Low | Critical (data loss) | Multi-gate pre-check (ciphertext + keyed read succeeds) before any unlink; skip-all + retain on any doubt; copy-test on a real-vault clone first |
| Guard B breaks a gate (false "canonical") | Low | CI red | Path-equality to `resolveDbPath()`; 80-gate green is the explicit regression floor; gates pass temp paths |
| Secure-erase expectation gap (SSD/APFS) | Med | Reputational/over-claim | Document FileVault as the real erase layer; don't claim shred-grade unlink |
| Backfill (Stage B) corrupts/loses data on the 2GB vault | Med | Critical | Reversible + batched + autockpt-suspend (search-build lessons); back up + copy-test per column; resumable/idempotent |
| Mixed-column SQL query before backfill (Stage C) | Med | Silent data loss in queries | The ordering constraint: stop-write → backfill → **assert 0 envelopes** → restore-SQL; never query a mixed column |
| Python/JS parity drift during the transition | Med | Mixed columns stay mixed | Stop Python writers **in lockstep** with the JS `ENCRYPTED_FIELDS` shrink (Appendix C of the handoff) |

---

## Open questions

**Resolved during sweep:**
- *Is encryption already on for real users?* Yes — `main.rs` sets the flag, self-detection persists it. Stage 0 hardens, not enables.
- *Does `purgePlaintextBackup` exist?* **No** (memory was stale). Stage 0 builds it.
- *Can we just remove the `null` fallback / invert the default?* No — breaks 80 gates + raw-byte semantics. Scope to the canonical path.
- *How to tell real vault from fixture?* `dbPath === resolveDbPath()`; the real app defaults to it, gates pass temp paths (`index.js:41`).

**Deferred (named so they don't ambush a later stage):**
- Key-in-env at runtime (`index.js:93`) + no idle re-lock → **Tier-1 key-lifecycle**, not Stage 0.
- Scope-guardian removal vs no-op → Stage C decision (keep thin no-op for `secrets` tagging initially).
- `people.name` plaintext dedup key for `ON CONFLICT(name)` → Stage C (needs full `name` backfill or a name-hash).

---

## Verification table

| # | Load-bearing assumption | Verified at (read firsthand) |
|---|---|---|
| 1 | Plaintext open is `resolveDbKeyHex` returning `null` when `!encrypted && !atRest` | `src/db/open.js:43-49` |
| 2 | Self-detection forces keyed-open once a vault is ciphertext (flag-independent) | `src/db/open.js:24-26,30-35` |
| 3 | `atRestEnabled()` defaults false; reads `MYCELIUM_AT_REST` | `src/db/open.js:18-20` |
| 4 | Packaged app hard-sets `MYCELIUM_AT_REST=1` (both spawn paths) | `src-tauri/src/main.rs:275,346` |
| 5 | Real app defaults `dbPath` to `resolveDbPath()`; gates pass explicit temp paths | `src/index.js:37,41`; `scripts/verify-leak.mjs:19-20`, `verify-facts.mjs:17-20` |
| 6 | Canonical path resolution (honors `MYCELIUM_DB`) | `src/paths.js:50,53` |
| 7 | Boot fails closed without USER_MASTER/SYSTEM_KEY | `src/index.js:71-73` |
| 8 | Adapter refuses to open an encrypted vault unkeyed | `src/adapter/d1.js:41-44` |
| 9 | Migration is parity-checked + fail-closed (original intact on mismatch) | `src/account/db-cipher-migrate.js:96-104` |
| 10 | `.pre-cipher-<ts>` backup is created and **never auto-deleted** | `src/account/db-cipher-migrate.js:17,109-112,114` |
| 11 | `purgePlaintextBackup` does **not** exist on main | grep `src/`,`scripts/` → 0 defs (only log/path strings) |
| 12 | 80/199 gates reach plaintext via `boot()`; only 2 set the flag | grep `scripts/verify-*.mjs` (`boot(`=80, `MYCELIUM_AT_REST`=2) |
| 13 | At-rest invariant is asserted by header-sniff + raw-byte scan gates | `verify-at-rest.mjs:88,147`; `verify-leak.mjs:91` |
| 14 | Key stays in `process.env` for process lifetime (accepted) | `src/index.js:93` |
