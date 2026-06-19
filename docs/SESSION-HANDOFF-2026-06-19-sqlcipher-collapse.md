# Session Handoff — SQLCipher Collapse (Layer-2 → SQLCipher-only)

**Date:** 2026-06-19
**Audience:** the next Claude Code instance continuing the SQLCipher collapse.
**Read first, in order:** this doc → [`SQLCIPHER-COLLAPSE-EXECUTION-PLAN-2026-06-19.md`](SQLCIPHER-COLLAPSE-EXECUTION-PLAN-2026-06-19.md) (on main) → the three stage designs + the backfill-engine design (below). Memory: `sqlcipher-collapse-decision` is the cross-session index for all of this.

---

## TL;DR — current state

The whole **collapse FOUNDATION is merged to `main` and live-validated on the real vault.** What remains is the *execution* (rewriting vault data), which is mechanical, proven, and gated.

| Piece | PR / branch | State |
|---|---|---|
| **Stage 0** — SQLCipher mandatory + `purgePlaintextBackup` + fail-closed guard + execution plan | **#299** (squash `3919e2b`) | ✅ MERGED + **live-smoked** |
| **Stage A codec** — `encodeVectorRaw`/`decodeStoredVector` (JS) + `encode_vector_raw`/`decode_stored_vector` (Py) | **#302** | ✅ MERGED (additive, dormant) |
| **Backfill engine** — `src/account/backfill.js` `backfillColumn` + `verify:backfill` | **#303** | ✅ MERGED (additive, dormant) |
| **Library pagination** — first-page-fast + bg-fill (the 14.7s→0.4s bridge) | **#295** | ⏳ **OPEN — recommend merge** (independent of the collapse; CI was green, will need a rebase) |
| Stage A vectors **execution** (flip writers + backfill) | design only | ⛔ NOT started — needs Stage 0 live (it is) |
| Stage B/C content **execution** (shrink ENCRYPTED_FIELDS + backfill + restore SQL) | design only (`feat/sqlcipher-stageBC-content`) | ⛔ NOT started — the loading-speed root fix |

**`main` HEAD when written:** `1bc2789` (it advances fast — other sessions merge often; expect rebases).

**The goal (user's words):** *no data in plaintext by default, highly performant when unlocked; the current loading speed is deplorable.* Stage 0 delivers "no plaintext by default." The loading-speed root fix is **Stage B/C** (still ahead). The #289 decrypt cache + #295 pagination are the live bridges keeping it bearable.

---

## What shipped this session

- **Decision + plan (already on main from a prior session):** `SQLCIPHER-COLLAPSE-HANDOFF-2026-06-19.md` (#291) — the why + the 62-table/392-column inventory.
- **Stage 0** (#299, `3919e2b`): made SQLCipher mandatory for the canonical vault + `purgePlaintextBackup()` (self-verifying, fail-safe; deletes the `.pre-cipher` plaintext copy only after proving the keyed vault reopens) + a fail-closed tripwire. Gate `verify:at-rest-purge` 10/10. Carries the master **execution plan** + the **hard-evidence spike** (GO 8/8: raw-Buffer-in-TEXT round-trips; the ORDER-BY-on-mixed-column landmine).
- **Stage A codec** (#302): the raw-bytes vector codec + dual-read; `verify:vectors-raw` 9/9.
- **Backfill engine** (#303, `0348aa2`): the shared `backfillColumn` (in-app, raw `db._sqlite` handle, keyset + `setImmediate` yield + WAL-suspend, idempotent, fail-closed per row, content/vector codecs, refuses `secrets`); `verify:backfill` 14/14.
- **Three sweep-first design docs** (each with a verification table): Stage 0, Stage A, Stage B/C, + the backfill-engine design. Stage B/C design lives on `feat/sqlcipher-stageBC-content`; the rest are on main.
- **Built the app from main + live-validated** (below).

---

## Live validation (this build — `/Applications/Mycelium.app`, rebuilt from `main`)

- Boots **keyed, no hang** (`:8787` up ~27s). Vault file header is **ciphertext** (`59 2d 18 57…`, not `SQLite`). Unlocks (`/auth/setup-status` → `handle:"hi"`, `setupRequired:false`). **No `.pre-cipher` plaintext backup** on disk.
- Renders real decrypted data: Mindscape **61,215 points · 21 realms · 312 territories**. `#295` Library first page **0.39s** (was 14.7s). Warm reads fast (root 0.004s, single doc 0.002s).
- Bundle confirmed to contain `purgePlaintextBackup` + `backfill.js` + `decodeStoredVector`.
- **GOTCHA:** the *first* HTTP request after boot took **41s** — the one-time SQLCipher boot-warmup window (`at-rest-boot-congestion-collapse`), not a regression; 0.004s once warm.

---

## Execution roadmap (now unblocked — each step is one PR, behind its gate)

The **ordering law** governs every column: **stop-write → backfill → assert 0 envelopes → restore-SQL.** Never query a mixed column (the spike proved ORDER BY mis-orders mid-migration).

1. **Backfill engine step 2** — wire it for real: `POST /portal/mycelium/backfill` (in-app, like `/measure`), single-flight + kill-switch, a **pre-campaign ciphertext backup** (copy the already-encrypted vault; purge after verify), `.vault-init.lock`. Then **copy-test on a clone of the real vault** before any live run.
2. **Stage A vectors** (smallest, measurable): flip the vector writers to `encodeVectorRaw` (`enrich/service.js`, `sync-clustering-points.js`, `cluster.py`, `compute-anchors.py`); backfill `nomic_embedding` → `embedding_768` → `anchor_vector`; rewrite `verify:nomic-embedding-encryption` → assert raw. **Measure −~300 MB + search-build speedup.** (`centroid_256/3d` are NOT here — they're auto-encrypt JSON → Stage B.)
3. **Stage B/C content** (the loading-speed root fix): shrink JS `ENCRYPTED_FIELDS` → `{secrets}` + stop the 48 Python `_enc()` sites **in lockstep** (split: some tables JS, some Python-only — see the Stage B/C design §Pivot 2); backfill **hot-path first** (`documents.{title,summary,metadata}` → mindscape narrative → topology metrics → messages → long tail → Python-only metrics); then **Stage C restore SQL** (`topology.js`/`territory-docs.js`/`claims.js`/`people.js` → real WHERE/ORDER BY; `people.name` → plaintext + `ON CONFLICT(user_id,name)`, NO hash); retire ~10 envelope-assert gates; re-frame `verify:leak`; no-op the scope guardians.

**Done when:** `ENCRYPTED_FIELDS == {secrets}`; 0 envelopes in every non-secrets column; Stage-C SQL golden-diffs identical to the old JS-sort; **Library cold-open sub-second** on the real vault; full `verify` green with `secrets` + at-rest gates intact.

---

## Gotchas (each cost real time this session — heed them)

- **`package.json` "verify" chain conflicts on EVERY rebase.** It's one giant single-line script; `main` advances fast (multiple merges/hour), so every collapse PR conflicted there + sometimes in the script-entry block. **Resolution recipe:** take `origin/main`'s version of the line and re-insert your `&& npm run verify:<gate>` after its neighbor; if the script-entry block also conflicts, keep BOTH entries. A `python3` regex resolver + `node -e "JSON.parse(...)"` validate is the fast path (examples in this session's transcript). **Rebase + merge promptly** to minimize the window.
- **Bare worktrees have no `pipeline/.venv`** → `verify:nomic-embedding-encryption` (and any python-invoking gate) fails locally with "python exit null". **Identical on baseline; green in CI.** Run JS gates locally; trust CI for the python ones. (My `verify:vectors-raw` *skips* the python part gracefully when the venv is absent.)
- **Build from a clean `origin/main` worktree, NOT the main tree** (contested branch). Reuse the 11G Rust cache via `CARGO_TARGET_DIR=<main-tree>/src-tauri/target` + `cargo tauri build --bundles app` (skip DMG) → ~5G staging instead of a 16G cold build. The model stage caches as `[stage] model: cached` — **but a disk-full-interrupted rsync leaves a dangling symlink that the cache check waves through**; if "resource path … model_quantized.onnx doesn't exist", `rm -rf build-staging/hf-cache .build-cache/runtime-*/hf-cache` and rebuild.
- **Disk runs tight** (~19G free; a build needs ~5G with cache-reuse). Reclaimable: Xcode `DerivedData`/`iOS DeviceSupport` + `~/Library/Caches`; APFS clone-sharing means deleting repo build artifacts frees little.
- **Quit the running app gracefully** (`osascript -e 'tell application "Mycelium" to quit'`) before replacing `/Applications/Mycelium.app` — never hard-kill (at-rest vault, live WAL). Install with `ditto` (preserves the ad-hoc signature). Boot ≈ 27s, Keychain auto-unlock.
- **The backfill MUST run in-app** (the app's keyed `db._sqlite`), NOT a spawned child — the measure-only child+`vault-bridge.js` exists only because *Python* can't open SQLCipher; a 2nd JS writer would contend on the single-writer lock.

---

## Open decisions for the operator

1. **Merge #295** (Library pagination) — it's the live loading-speed bridge, independent of the collapse. Recommend yes (needs a rebase first).
2. **Close #253 and #188 as superseded** — #253 was the old "purge plaintext backup" (now shipped properly in Stage 0 #299); #188 is the inert at-rest groundwork. Memory had wrongly believed #253 shipped.
3. **Backfill: eager per-column** (recommended, gated behind a verified copy-test) vs lazy.
4. **Redirect the freed security budget** to the real local-vault wins: finish Touch ID/Secure-Enclave unlock + close the SSRF/BYOK + recovery-key holes (`prepublish-security-audit`).

---

## Pickup protocol

1. Read this doc cold, then the execution plan + the Stage B/C design (`feat/sqlcipher-stageBC-content`).
2. `git fetch && git log origin/main -1` — confirm `3919e2b` (Stage 0) is an ancestor (`git merge-base --is-ancestor 3919e2b origin/main`).
3. Confirm the live app is the Stage-0 build: `head -c16 "$HOME/Library/Application Support/id.mycelium.app/mycelium.db" | xxd` → must NOT be `SQLite`; `curl -s localhost:8787/auth/setup-status` → `handle:"hi"`.
4. `/sweep-first-design` before each execution step (the designs exist; re-verify against current code — `main` moves).
5. **Before ANY live backfill:** back up the vault (ciphertext copy), copy-test the engine on the clone, golden-diff. Honor the ordering law per column.
6. Build/verify in a clean `origin/main` worktree; `git worktree list` first (main tree is contested). Merge promptly (the `package.json` conflict window).

---

## Worktrees & cleanup
- `mycelium-id-worktrees/sqlcipher-stage0` — #299 merged; **safe to `git worktree remove`** (keep if reusing its installed deps for the next build).
- `mycelium-id-worktrees/sqlcipher-stageBC` — holds the Stage B/C design + this handoff (branch `feat/sqlcipher-stageBC-content`). Keep until B/C executes.
- `mycelium-id-worktrees/library-perf` — #295 (open). Keep until merged.
- The stageA + backfill-engine worktrees were already removed post-merge.

## The four collapse docs
- `SQLCIPHER-COLLAPSE-HANDOFF-2026-06-19.md` (#291, main) — decision + inventory.
- `SQLCIPHER-COLLAPSE-EXECUTION-PLAN-2026-06-19.md` (main) — spike + assumptions ledger + sequence.
- `DESIGN-sqlcipher-stage0-mandatory-2026-06-19.md` (main) · `DESIGN-sqlcipher-stageA-vectors-2026-06-19.md` (main) · `DESIGN-sqlcipher-stageBC-content-2026-06-19.md` (this branch) · `DESIGN-sqlcipher-backfill-engine-2026-06-19.md` (this branch).
