# Search Index Phase 1 — Build Handoff (2026-06-17)

**Branch:** `feat/search-phase1-ondisk` (pushed) · **Worktree:** `mycelium-worktrees/search-phase1`
**Design (locked, canonical):** recovered branch `recovered/claude/at-rest-blindness:docs/SEARCH-INDEX-PHASE1-DESIGN-2026-06-16.md` (23-row verification table; §11 staged order). Thinner direction doc on main = `docs/SEARCH-INDEX-ONDISK-PHASE1-DESIGN-2026-06-16.md`.

## Done this session (verified)

1. **Hard-gate spike reproduced in-tree → GO.** `spike/sqlite-vec-encrypted/` (branch `spike/sqlite-vec-encrypted-gate`, pushed). `gate.mjs` 10/10 (sqlite-vec + FTS5 KNN inside encrypted `better-sqlite3-multiple-ciphers`; vec0 UUID TEXT PK direct; fail-closed no/wrong key; WAL reopen). `bench.mjs` reproduced §3a D10: brute 768-d **571ms p50** vs two-stage 256→200→rescore **196ms p50 (2.9×)**. RESULT.md committed.
2. **A′ foundation reconciled onto CURRENT main** (it was 53 commits stale on PR #188's branch). Merged `origin/claude/at-rest-cipher` into this branch; only conflict was the `verify` chain line (kept main's superset + inserted `verify:at-rest` after `verify:foundation`). Brought in: driver alias (`better-sqlite3` → `better-sqlite3-multiple-ciphers@^11.10.0`), `keystore.deriveDbKey`, keyed open in `src/adapter/d1.js`, `pipeline/vault-bridge.js` (Python loopback read/write bridge), Python reroute (`d1_client.py`/`local_db.py`), `src/account/db-cipher-migrate.js` (encrypt-vault migration CLI), `scripts/verify-at-rest.mjs`.
3. **Verified green on current main:** `verify:at-rest` 17/17 GO (incl. bridge A6/A7, migration A5, fail-closed A3); `verify:foundation`, `verify:search`, `verify:search-rehydrate` all GO (the driver swap is non-regressing — it behaves as plain better-sqlite3 with no key).

## ⚠️ Guardrail (carry forward)

**Step 5 (encrypting the live 1.7 GB vault via the migration CLI) is hard-to-reverse → requires explicit operator go.** Steps 1–4 are fixture-only, default-OFF, real vault untouched. Never populate a plaintext on-disk FTS5/vec index on the REAL vault — the real index is built encrypted, only at step 5. Test backends on synthetic fixtures (no real secrets at rest).

## Step 2 — SQLite-backed backend ✅ DONE (commit `77e7f40`)

`src/search/backend/sqlite.js` (`createSqliteBackend`) + `src/search/sqlite/schema.js` + gate `verify:search-sqlite` (wired into the chain). **12/12 GO**: keyword hit/miss, two-stage 256→768 KNN nearest-first, hybrid RRF fusion, idempotent upsert, forget removal, temporal ordering, contract shape, **100% keyword parity vs in-RAM backend**, perf N=4000 hybrid **p50=8ms RSS=96MB**, stub-embedder embed path. Matches `createLocalBackend`'s contract exactly; rrf/temporal reused verbatim. Fixture-only, default-OFF. Bug caught + fixed: decoupled 768/256 inserts so a valid 768-d vector is never dropped when its 256-d prefix is degenerate. `sqlite-vec@0.1.7-alpha.2` added as a dep.

## Step 2b — flag-select wiring ✅ DONE (commit `55a533e`)

`createSearchHelpers` selects the backend: default in-RAM (unchanged); `MYCELIUM_SEARCH_BACKEND=sqlite` (or `deps.searchBackend`) → `createSqliteBackend` over `db._sqlite` (raw handle now exposed on the db namespace). On-disk index persists, so `ensureBuilt` populates ONCE via `loadFromDb` when empty, then skips. Gate `verify:search-sqlite` 15/15 (SQ12a/b/c: selects+populates, 2nd boot skips rebuild, default keeps in-RAM); `verify:search` 39/39 + `verify:search-rehydrate` GO (default non-regressing).

## Step 3 — incremental maintenance ✅ DONE (commit `3fba5ff`)

On-disk index stays fresh on every write (no rebuild). NO-OP for the in-RAM backend.
- Persisted build-flag (`search_state` + `isCorpusBuilt`/`markCorpusBuilt`); `ensureBuilt` keys off it, not `count()>0`.
- searchHelpers maintenance API (sqlite-only): `noteUpsert` (fts+vec), `noteVector` (vector-only, preserves ts/fts), `noteDelete`.
- Hooks: capture new-insert + edit ([capture.js](../src/ingest/capture.js)) → `noteUpsert`; enrichment `embedding_768` write ([enrich/service.js:124](../src/enrich/service.js)) → `noteVector` (no re-decrypt); forget already calls `backend.delete` ([curate.js:190](../src/tools/curate.js)).
- Gate `verify:search-sqlite` 19/19 (SQ13 build-flag, SQ14 capture→searchable-no-rebuild e2e, SQ15 noteVector+ts-preserved, SQ16 in-RAM no-op). Non-regressing: `verify:ingest` / `verify:enrich` / `verify:search` GO.
- **Deferred:** profile (territory/realm/theme) incremental upserts — covered by the full `loadFromDb` build + `refreshSearchIndex`; Generate is kill-switched anyway. Add a `noteUpsert` on the describe/clustering profile-write path when Generate returns.

## Step 4 — pipeline read bridge ✅ DONE (commit `8fc9851`)

`pipeline/vault-bridge.js` + Python reroute landed with the A′ foundation; reroute is **opt-in** (`MYCELIUM_DB_BRIDGE_URL`; unset → direct `sqlite3.connect`, non-breaking). New gate `verify:pipeline-readbridge` (6/6, in chain after `verify:at-rest`) proves the actual clustering read shapes on an encrypted vault: P1 `cluster.py:274` content-JOIN parity, P2 `nomic_embedding` (TEXT envelope + NULL) parity, P3 raw-BLOB rejection, P4 Python `local_db` reroute e2e.

**⚠️ Pre-step-5 requirement surfaced by P3:** the bridge rejects BLOB result columns, so **every `clustering_points.nomic_embedding` must be a TEXT envelope or NULL — no legacy raw BLOBs** — before the vault is encrypted, else clustering reads break. Ties to the `sync-clustering-points` insert-only backfill (see [[measurement-pipeline-recluster-unsafe]]). Add a pre-migration check (`SELECT count(*) FROM clustering_points WHERE typeof(nomic_embedding)='blob'` must be 0). The full §13 byte-identical-Generate criterion is deferred (Generate is kill-switched).

### Then: Step 5 — encrypt the live vault (⚠️ GATED on explicit operator go)
`src/account/db-cipher-migrate.js` (built, `verify:at-rest` A5 GO). Dry-run on a vault COPY first; build-new-encrypted + atomic swap + keep the plaintext copy. Only after this is the on-disk index encrypted at rest — so flipping `MYCELIUM_SEARCH_BACKEND=sqlite` to default should pair with step 5 (else a plaintext on-disk content/vector index sits on disk — the at-rest regression). Until then the backend stays opt-in for dev/testing.

### (superseded) Original Step 3 plan

**FIRST fix the build signal (prerequisite):** 2b's `ensureBuilt` uses `count()>0` to mean "already populated". Once step-3 incremental adds exist, a single capture before the first query makes `count>0` and would SKIP the full `loadFromDb`. Replace with a persisted flag: add `search_state(key TEXT PRIMARY KEY, value TEXT)` to `schema.js` + `isCorpusBuilt()`/`markCorpusBuilt()` on the sqlite backend; `ensureBuilt` (sqlite) → if `isCorpusBuilt()` skip, else `loadFromDb` then `markCorpusBuilt()`.

**Hook points (§8) — add a no-op-unless-sqlite maintenance API on searchHelpers** (`noteUpsert({id,text,embedding,ts})` → `backend.add`; `noteDelete(ids)` → `backend.delete`; guarded by `backendKind==='sqlite'` so the default path is zero-change):
- **New message** — `captureMessage` insert ([ingest/capture.js:148](../src/ingest/capture.js)): `noteUpsert` FTS (content, ts; no vector yet).
- **Content edit** — `captureMessage` update ([capture.js:174](../src/ingest/capture.js)) / `db.messages.updateContent`: re-`noteUpsert`.
- **Vector ready** — enrichment writes `embedding_768` ([enrich/service.js](../src/enrich/service.js)): `noteUpsert` with the just-computed Float32Array (no decrypt).
- **Forget** — already wired ([curate.js:190](../src/tools/curate.js) calls `backend.delete`) ✓.
- **Profiles** — territory/realm/theme name+essence writes (clustering/describe): `noteUpsert` the prefixed id.

`captureMessage`/enrich reach the active backend via `getMindSearch()` (registry) — NOTE the registry import bug found this session (`src/db/messages.js:689` imports the non-existent `../mind-search/registry.js`; should be `../search/registry.js`) — spawned as task_b403f299; fix or avoid that path.

**Gate** (extend `verify:search-sqlite`): capture a new message → it's searchable with NO rebuild/populate; edit → new content searchable, old gone; enrich adds a vector → hybrid finds it; forget → gone. Then a 2nd boot with the flag ON does NOT rebuild (isCorpusBuilt). Only after this is green should the default flip to sqlite (separate decision).

### Original Step 2b spec (kept for reference) — wire into `index.js` (flag-select, default OFF)
`createSearchHelpers` ([index.js:43-52](../src/search/index.js)) currently always builds `createLocalBackend` + `loadFromDb`. Add a flag (e.g. `MYCELIUM_SEARCH_BACKEND=sqlite` / a config) that instead builds `createSqliteBackend({ sqliteDb: <raw vault handle>, embedder, userId })` and SKIPS `loadFromDb`. Needs the raw better-sqlite3 handle reachable from the assembled db namespace (the adapter exposes `db` — see `src/adapter/d1.js` return; thread it through `src/db/index.js` to search). On a plaintext vault the index must be POPULATED once (one-time build from existing rows — a small CLI or a guarded boot build); on the encrypted vault that population happens during the step-5 migration. **Keep default OFF until step 3 maintenance lands** (else the on-disk index goes stale on writes). Smoke: `verify:search` stays GO; flag ON → fixture search hits without a rebuild.

### Original Step 2 spec (kept for reference)

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
