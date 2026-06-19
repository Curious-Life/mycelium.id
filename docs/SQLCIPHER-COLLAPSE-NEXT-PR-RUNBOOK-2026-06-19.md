# SQLCipher Collapse — NEXT PR Runbook (turnkey)

**Date:** 2026-06-19
**This is the immediate next executable PR** after the merged foundation (Stage 0 #299 + codec #302 + engine #303, all live). Read the [session handoff](SESSION-HANDOFF-2026-06-19-sqlcipher-collapse.md) + [execution plan](SQLCIPHER-COLLAPSE-EXECUTION-PLAN-2026-06-19.md) + the [backfill-engine design](DESIGN-sqlcipher-backfill-engine-2026-06-19.md) first.

---

## What this PR is
**Wire the backfill engine into a runnable in-app job, and run the FIRST real backfill campaign on the safest column: `clustering_points.nomic_embedding` (vectors, dim 256).** Smallest, lowest-risk, value-delivering: it's already a BLOB column whose reader (`cluster.py:_decode_nomic_embedding`) *already* dual-reads raw+envelope, so it's the cleanest proof of the whole live pipeline. `embedding_768` (6 tables) + `anchor_vector` are the **follow-on PR**, not this one.

**Why nomic first:** proves the in-app job + pre-campaign backup + copy-test + the engine on real data, on a column where the reader needs zero change, before touching the bigger vector columns or content.

## Definition of done
- The engine runs as `POST /portal/mycelium/backfill` (in-app, single-flight, kill-switch, pre-campaign ciphertext backup, `.vault-init.lock`).
- `clustering_points.nomic_embedding` is fully raw bytes: `SELECT COUNT(*) WHERE nomic_embedding LIKE 'ey%'` == 0.
- New nomic writes are raw (writers flipped); reads still correct (dual-read).
- Copy-tested on a clone of the real vault (golden-diff identical vectors) BEFORE the live run; vault size measured before/after.
- `verify:backfill` + `verify:cluster-embed` + `verify:search` green; full `verify` green; app rebuilt + a live re-cluster returns identical clusters.

---

## Steps (each re-verify file:line with `/sweep-first-design` — `main` moves)

### 0. Setup
```
git fetch origin && git worktree add <wt> origin/main && cd <wt> && git switch -c feat/sqlcipher-backfill-nomic
npm install   # bare worktree needs deps; python gates will skip without pipeline/.venv (CI covers)
```

### 1. Wire the runnable job (backfill engine step 2)
- **`src/jobs.js`** — add `startBackfillJob({ columns, db, dbPath })`: mirror the `runningJobId` single-flight (`jobs.js:63,83-85`); kill-switch `MYCELIUM_DISABLE_BACKFILL` / `.backfill-disabled` (mirror `generateLocked()` `jobs.js:32-36`); progress state. Runs **in-app** (NOT a spawned child — see the design's Pivot 1).
- **Pre-campaign backup** (in the job, before the first column): `db._sqlite.pragma('wal_checkpoint(TRUNCATE)')` then `copyFileSync(dbPath, \`${dbPath}.pre-backfill-${ts}\`)` — a copy of the already-encrypted vault (ciphertext at rest). Acquire `.vault-init.lock` (`src/db/init.js:38-65` `acquireLock`) around the run.
- **`src/portal-mindscape.js`** — add `POST /mycelium/backfill` next to `/measure` (`:351`), loopback/owner-pinned, body `{ columns:[{table,column,kind,dim?}], confirm:true }` → `startBackfillJob(...)`. Refuse without `confirm:true`.
- **Purge the `.pre-backfill` backup** only after the campaign verifies 0 envelopes (reuse the self-verifying pattern of `purgePlaintextBackup`).

### 2. Stop-write: flip the nomic writers to raw (ordering law step 1)
- **`pipeline/cluster.py`** (~:526-537, the `nomic_embedding` UPDATE) — `crypto_local.encrypt_vector(...)` → `crypto_local.encode_vector_raw(...)`; route via plain `d1_batch` (raw bytes, not `batch_encrypted`).
- **`pipeline/sync-clustering-points.js`** (~:139) — `encryptVector(...)` → `encodeVectorRaw(...)`.
- (Readers need NO change: `cluster.py:_decode_nomic_embedding` already dual-reads raw+envelope; any JS reader uses `decodeStoredVector`.)

### 3. Backfill (copy-test FIRST)
- **On a clone** (`cp` the vault file): run `backfillColumn(db._sqlite, { table:'clustering_points', column:'nomic_embedding', codec:{kind:'vector',dim:256}, masterKey, batch:500 })`; golden-diff: decrypt-old (envelope) vs decode-new (raw) for every row → identical Float32; assert `countRemainingEnvelopes==0`; confirm the file stays ciphertext; measure size delta.
- **Then live** via `POST /portal/mycelium/backfill {columns:[{table:'clustering_points',column:'nomic_embedding',kind:'vector',dim:256}],confirm:true}`.

### 4. Gate + verify
- `verify:backfill` (already covers vector round-trip) — extend if needed for the nomic specifics.
- Regression: `verify:cluster-embed`, `verify:search`, `verify:embed`, `verify:at-rest{,-purge}`, `verify:secrets`, `verify:leak`. Full `npm run verify` green (CI).
- Rebuild app → live re-cluster → identical clusters; mindscape renders.

---

## Follow-on PR (after this lands + measures)
`embedding_768` (messages/documents/territory_profiles/realms/semantic_themes/persona_claims — dim 768) + `anchor_vector` (cognitive_anchor_vectors — dim 768): same job, more writer flips (`enrich/service.js:124`, `compute-anchors.py:160`, the import re-encoders), + switch `d1-loader.js:194-195` from `decryptVector` → `decodeStoredVector`, + rewrite `verify:nomic-embedding-encryption` → assert raw. Then **Stage B/C content** (the loading-speed root fix) per its design.

## Gotchas (from the session — heed)
- **`package.json` "verify" chain conflicts on every rebase** (main moves fast). Recipe: take `origin/main`'s line + re-insert your `&& npm run verify:<gate>`; keep BOTH script entries if that block also conflicts; `node -e "JSON.parse(...)"` to validate. Merge promptly.
- **Bare-worktree has no `pipeline/.venv`** → python gates fail locally ("python exit null"), green in CI. Run JS gates locally.
- **Ordering law, per column:** stop-write → backfill → assert 0 envelopes → (then any SQL/writer change that trusts the column). Never SQL-query a mixed column.
- **In-app, single-writer.** Never spawn a 2nd process to write the vault (SQLCipher single-writer contention). The job uses the app's `db._sqlite`.
- **Copy-test before live, always.** Back up (ciphertext copy) before any live backfill; purge only after verified.
- **centroids are NOT vectors here** — `centroid_256/3d` are auto-encrypt JSON → Stage B, not this PR.
