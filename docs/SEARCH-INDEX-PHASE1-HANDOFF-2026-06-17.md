# Search Index Phase 1 — Build Handoff (2026-06-17)

**Branch:** `feat/search-phase1-ondisk` (pushed) · **Worktree:** `mycelium-worktrees/search-phase1`
**Design (locked, canonical):** recovered branch `recovered/claude/at-rest-blindness:docs/SEARCH-INDEX-PHASE1-DESIGN-2026-06-16.md` (23-row verification table; §11 staged order). Thinner direction doc on main = `docs/SEARCH-INDEX-ONDISK-PHASE1-DESIGN-2026-06-16.md`.

## Done this session (verified)

1. **Hard-gate spike reproduced in-tree → GO.** `spike/sqlite-vec-encrypted/` (branch `spike/sqlite-vec-encrypted-gate`, pushed). `gate.mjs` 10/10 (sqlite-vec + FTS5 KNN inside encrypted `better-sqlite3-multiple-ciphers`; vec0 UUID TEXT PK direct; fail-closed no/wrong key; WAL reopen). `bench.mjs` reproduced §3a D10: brute 768-d **571ms p50** vs two-stage 256→200→rescore **196ms p50 (2.9×)**. RESULT.md committed.
2. **A′ foundation reconciled onto CURRENT main** (it was 53 commits stale on PR #188's branch). Merged `origin/claude/at-rest-cipher` into this branch; only conflict was the `verify` chain line (kept main's superset + inserted `verify:at-rest` after `verify:foundation`). Brought in: driver alias (`better-sqlite3` → `better-sqlite3-multiple-ciphers@^11.10.0`), `keystore.deriveDbKey`, keyed open in `src/adapter/d1.js`, `pipeline/vault-bridge.js` (Python loopback read/write bridge), Python reroute (`d1_client.py`/`local_db.py`), `src/account/db-cipher-migrate.js` (encrypt-vault migration CLI), `scripts/verify-at-rest.mjs`.
3. **Verified green on current main:** `verify:at-rest` 17/17 GO (incl. bridge A6/A7, migration A5, fail-closed A3); `verify:foundation`, `verify:search`, `verify:search-rehydrate` all GO (the driver swap is non-regressing — it behaves as plain better-sqlite3 with no key).

## ⚠️ Guardrail (carry forward)

**Step 5 (encrypting the live 1.7 GB vault via the migration CLI) is hard-to-reverse → requires explicit operator go.** Steps 1–4 are fixture-only, default-OFF, real vault untouched. Never populate a plaintext on-disk FTS5/vec index on the REAL vault — the real index is built encrypted, only at step 5. Test backends on synthetic fixtures (no real secrets at rest).

## Next: Step 2 — SQLite-backed `LocalBackend` (the scaling win, ~290 LOC)

Build `src/search/backend/sqlite.js` matching the **exact contract** of `src/search/backend/local.js`:
- `query(req) → { hits:[{id,score}], degraded, tier, takenMs }`; `add/upsert(req{id,text,embedding,ts})`; `delete({ids})`; `count()`; `health()`; `_internal()`.
- **ID scheme (must match the hydration layer):** messages = **bare UUID** (no `:`); profiles = **kind-prefixed** (`territory:1`,`realm:N`,…) via `ID_PREFIX`/`stripPrefix` ([d1-loader.js](../src/search/d1-loader.js)). `index.js` hydrates from DB by id ([index.js:99-126](../src/search/index.js)) — backend returns ranked ids only.
- **Keyword:** FTS5 vtable over `(id UNINDEXED, content)`; `bm25()` ranking. **Vector:** vec0 `(id TEXT PRIMARY KEY, embedding float[768] distance_metric=cosine)` + a 256-d matryoshka-prefix table for the **D10 two-stage** (256 shortlist top-200 → rescore by full 768-d cosine in-proc → topK).
- **Fusion UNCHANGED:** reuse `rrf()` ([fusion/rrf.js](../src/search/fusion/rrf.js)) + `temporalBoostWithProvider` ([fusion/temporal.js](../src/search/fusion/temporal.js)). Temporal needs a per-id ts lookup — store `ts` in the FTS row or a side column (replaces `_index.documentTs(id)`).
- **Wire:** `index.js:43-52` — select the SQLite backend behind a flag (default OFF → current in-RAM path); when ON, skip `loadFromDb`. Eventually delete `loadFromDb` + `index/inverted.js`+`bm25.js` (step after maintenance lands).
- **Migration:** FTS5/vec0 DDL as a standalone create (NOT a migrations/ file that re-execs each boot — see D7); load `sqlite-vec` ext at adapter open.

**Gate (new):** `verify:search-sqlite` — fixture DB, seed N rows, assert: capture→immediate search hit (no rebuild), forget→miss, two-stage KNN nearest-first, RRF fusion parity vs in-RAM on the same fixture. §13 criterion: 58k-row fixture search <200 ms, steady RSS < 600 MB. Keep `verify:search`/`verify:search-rehydrate` GO.

Then: **Step 3** incremental maintenance (§8 hooks: capture/enrich/updateContent/forget/profiles) · **Step 4** pipeline read via `vault-bridge.js` (already built — wire `local_db.py` reads) · **Step 5** (gated) encrypt-vault migration on a vault COPY (dry-run first).

## Reconcile TODO
- Copy the canonical locked design doc from `recovered/claude/at-rest-blindness` onto main (it only lives on a recovered branch — loss risk, like the lost spike).
- Re-verify the design's "(sweep-cited)" verification-table rows (2,16,17,18,19,20,21) before the step that depends on each.
