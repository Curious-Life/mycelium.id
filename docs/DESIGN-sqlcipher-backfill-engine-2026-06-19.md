# SQLCipher-collapse Backfill Engine — Sweep-First Design

**Date:** 2026-06-19
**Branch / worktree:** `feat/sqlcipher-backfill-engine` · `mycelium-id-worktrees/backfill-engine` (off `origin/main` `ab196c7`)
**Audience:** the session implementing the backfill engine. **Used by:** Stage A (vectors) + Stage B/C (content) — the shared step that rewrites encrypted-envelope columns to plaintext-inside-SQLCipher.
**Companions:** the three stage designs + [`SQLCIPHER-COLLAPSE-EXECUTION-PLAN-2026-06-19.md`](SQLCIPHER-COLLAPSE-EXECUTION-PLAN-2026-06-19.md). Memories: `at-rest-search-build-perf`, `measure-only-and-key-blocker`, `at-rest-boot-congestion-collapse`.

---

## TL;DR

One reusable, column-parameterized engine that converts a column's encrypted-envelope rows to **plaintext-inside-SQLCipher** — the step every remaining stage shares. It is the riskiest piece (it rewrites the live ~2 GB / 69k-row vault), so it reuses three things the codebase already proved:

- **the search-build heavy-write recipe** — keyset pagination (PAGE=1000), `setImmediate` yield between batches, `wal_autocheckpoint=0` during the bulk write + a single `wal_checkpoint(TRUNCATE)` after (verified: `search/d1-loader.js:181,216`, `search/backend/sqlite.js` beginBulk/endBulk);
- **the at-rest migration safety posture** — back up first, transform, parity-assert, fail-closed (verified: `db-cipher-migrate.js`);
- **the in-app keyed handle** — `db._sqlite` (the raw better-sqlite3 instance, verified `db/index.js:189`) for verbatim envelope reads, plaintext writes, and the `LIKE 'ey%'` 0-envelope assert.

**Key architectural decision (the pivot):** it runs **IN-APP** (a POST route, on the app's own keyed connection), **not** as a spawned child like the measure-only/clustering job. The measure-only child exists only because **Python can't open SQLCipher** (it needs the loopback `vault-bridge.js`); a **JS** backfill opens the keyed vault directly — and a second writer process would contend on SQLCipher's single-writer lock. In-app + batch + `setImmediate` yield keeps the app responsive (the search-build already runs this way), and the app's own writes serialize naturally on the one thread.

---

## Revision history
- **v1 (implied by the stage docs):** "a backfill tool, batched + reversible, like the search-build; run it as an app-triggered job (the measure-only pattern)."
- **v2 (this doc, post-sweep) — pivots:**
  - **Pivot 1 — IN-APP, not a spawned child.** The measure-only/clustering job spawns a child + a loopback bridge *because Python can't open SQLCipher* (`vault-bridge.js` header; `local_db.py:4-24`). The backfill is pure JS/SQL → it uses the app's own keyed `db._sqlite` directly. A child opening the same cipher file = two writers contending (SQLITE_BUSY); in-app = one writer, naturally serialized.
  - **Pivot 2 — write through the RAW handle, not the adapter.** There is **no raw-read adapter method** — `d1Query` always runs `autoDecryptResults` (`d1.js:77-79`), and `autoEncryptParams` would re-encrypt on write if the column were still mapped. So the engine uses `db._sqlite` for *all* three ops: verbatim envelope read (no auto-decrypt), explicit `decrypt`/`decodeStoredVector`, and a plaintext `UPDATE` that bypasses auto-encrypt entirely. This makes the engine correct **regardless** of `ENCRYPTED_FIELDS` state (defence-in-depth on top of the stop-write ordering).
  - **Pivot 3 — one engine, two codecs.** Stage A (vectors) and Stage B/C (content) are the *same* engine parameterized by a per-column codec: `content` (`decrypt(env)→plaintext string`) vs `vector` (`decryptVector(env)→Float32 → encodeVectorRaw→Buffer`, the Stage-A codec). Unifies both stages.
  - **Pivot 4 — the backup is already ciphertext.** Unlike the at-rest migration's `.pre-cipher` (plaintext), the backfill's pre-campaign backup is a copy of the *already-encrypted* vault → ciphertext at rest. No new plaintext-on-disk surface; purge it (Stage-0 `purgePlaintextBackup` discipline) after the campaign verifies.

---

## Threat model
Decrypted plaintext exists only **in-process** (the app already holds the master key + the unlocked handle) and is written back **inside** the mandatory SQLCipher file (Stage 0). No plaintext crosses a process or network boundary (in-app, no bridge, no child env-passing of the key). The pre-campaign backup is a ciphertext copy of the vault (safe at rest), purged after verification. The engine is **fail-closed**: on a codec error, a parity mismatch, or a wrong-length vector, it aborts the batch and leaves the row as-is (still a valid envelope, still read-safe via `isEncrypted`). No new attack surface; `secrets` is never a backfill target.

---

## Sweep findings (consolidated, file:line — read firsthand)

**App-triggered job pattern (`measure-only`):** `POST /mycelium/measure` → `startMeasurementJob` → `startClusteringJob({measureOnly})` (`portal-mindscape.js:351`, `jobs.js:70`) spawns a **child** with keys via an env allowlist (`USER_MASTER`/`SYSTEM_KEY`, `jobs.js:100-121`); the child reaches the keyed vault through the loopback **`vault-bridge.js`** (`run-clustering.sh:92-108`) *because Python can't open SQLCipher* (`vault-bridge.js` header; `local_db.py:4-24`). Single-flight `runningJobId` + `already_running` (`jobs.js:63,83-85`); kill-switch `generateLocked()` (`jobs.js:32-36`). **⇒ the trigger pattern to mirror, but the child+bridge is Python-only; a JS backfill skips it.**

**Heavy-write recipe (search-build):** keyset pagination `… AND id > ? ORDER BY id LIMIT ?`, `PAGE=1000` (`d1-loader.js:69,216`); `await new Promise(r=>setImmediate(r))` yield between batches (`:181`); `bulkAdd` wraps `BATCH=2000` rows in **one** `raw.transaction` (`backend/sqlite.js:229-247`); `beginBulk(){wal_autocheckpoint=0}` / `endBulk(){wal_checkpoint(TRUNCATE); wal_autocheckpoint=1000}` (`backend/sqlite.js`); the lesson: one `SELECT *` of all messages = **313s** event-loop freeze on a 2 GB vault (`d1-loader.js:61-63`); resumability via a persisted `corpus_built` flag in `search_state` (`backend/sqlite.js:313-317`).

**Safety template (at-rest migration):** `wal_checkpoint(TRUNCATE)` → `copyFileSync` → transform → per-table `COUNT(*)` parity (fail-closed: delete temp + throw, original intact) → atomic rename swap (`db-cipher-migrate.js:69-112`). Cross-process lock `acquireLock`/`.vault-init.lock` (`db/init.js:38-65`, `wx` atomic create + pid-stale steal).

**Adapter primitives:** raw handle `db._sqlite = adapter.db` (`db/index.js:189`); no raw-read method (`d1Query` always auto-decrypts, `d1.js:77-79`); `isEncrypted` prefix guard `charCodeAt 101/121` = base64 `'ey'` (`crypto-local.js:723-743`) → the `LIKE 'ey%'` 0-envelope assert; big tables use **TEXT UUID PKs** (`id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))`, `0001_init.sql`) → keyset pagination by `id`. Vector columns are `NEVER_AUTO_DECRYPT` (`crypto-local.js:1791-1811`) → decode via the typed codec.

---

## Design

### The engine — `src/account/backfill.js`
```
backfillColumn(db, { table, column, codec, masterKey, batch=500, signal }) -> { scanned, converted, skipped, doneAtId }
```
- **codec** ∈ `{ kind:'content' }` | `{ kind:'vector', dim }`.
- Uses `db._sqlite` (raw handle) throughout. Per batch (keyset by the table's `id` PK):
  1. `SELECT id, <column> FROM <table> WHERE id > ? ORDER BY id LIMIT ?` (raw — verbatim values).
  2. For each row: if `!isEncrypted(value)` → **skip** (idempotent; already plaintext/BLOB). Else decode:
     - `content`: `plaintext = await decrypt(value, masterKey)` → plaintext string.
     - `vector`: `vec = await decryptVector(value, masterKey, null, dim)` → `Buffer = encodeVectorRaw(vec)` (Stage-A raw bytes).
  3. `UPDATE <table> SET <column>=? WHERE id=?` via the raw handle (plaintext / Buffer — **no auto-encrypt**).
  4. Wrap each batch in `raw.transaction(...)`; `await setImmediate` between batches (yield).
- `beginBulk()`/`endBulk()` (suspend+restore `wal_autocheckpoint`) around the whole column.
- **Resumability:** a `backfill_state(table TEXT, column TEXT, last_id TEXT, done INTEGER, PRIMARY KEY(table,column))` row; resume from `last_id`; idempotent skip-if-plaintext means a re-run is safe even without the cursor.
- **0-envelope assert (the gate):** `SELECT COUNT(*) FROM <table> WHERE <column> LIKE 'ey%'` === 0 → marks `done=1`. This is the precondition Stage C / the writer-flip checks before trusting SQL on the column.

### The job wiring — `src/jobs.js` + a POST route
- `startBackfillJob({ columns, db, dbPath })`: single-flight (mirror `runningJobId`), kill-switch (`MYCELIUM_DISABLE_BACKFILL`/`.backfill-disabled`), progress reporting (rows done / total).
- `POST /portal/mycelium/backfill` (loopback/owner-pinned, like `/measure`): body `{ columns: [{table,column,kind,dim?}], confirm:true }`. Runs **in-app** (no child).
- **Pre-campaign backup:** before the first column, `wal_checkpoint(TRUNCATE)` then `copyFileSync(dbPath, dbPath+'.pre-backfill-<ts>')` (ciphertext copy). Kept until the campaign verifies; purged via the Stage-0 `purgePlaintextBackup`-style self-verifying delete.
- **Lock:** acquire `.vault-init.lock` (reuse `db/init.js` primitive) around the run so a concurrent boot/migration can't race it.

### Module shape & LOC budget
| Change | File | ~LOC |
|---|---|---|
| `backfillColumn` engine (keyset, dual codec, raw handle, batch+yield, WAL) | `src/account/backfill.js` | ~150 |
| `backfill_state` table | `migrations/00NN_backfill_state.sql` | ~6 |
| `startBackfillJob` (single-flight, kill-switch, progress) | `src/jobs.js` | ~70 |
| `POST /portal/mycelium/backfill` | `src/portal-mindscape.js` | ~20 |
| Pre-campaign ciphertext backup + verified purge | `src/account/backfill.js` | ~40 |
| Gate `scripts/verify-backfill.mjs` | `scripts/` + package.json | ~140 |
| **Total** | | **~430** |

### Edge cases (explicit decisions)
- **App writes a new row mid-backfill:** post-stop-write the column is out of `ENCRYPTED_FIELDS` → app writes plaintext → `isEncrypted` false → engine skips it. No race, no double-convert.
- **Crash mid-column:** resumable via `last_id` + idempotent skip-if-plaintext; partially-converted columns read correctly (mixed-state safe). The ciphertext backup is the floor.
- **Codec error on one row (corrupt envelope):** abort that row, log (no plaintext in the log — dims/ids only), leave it as the envelope, continue; the 0-envelope assert will flag it (campaign not "done" until investigated).
- **Vector wrong-length / NEVER_AUTO_DECRYPT:** the engine reads the raw value (not the adapter), so the `NEVER_AUTO_DECRYPT` skip is irrelevant; `decodeStoredVector`/`decryptVector` validates `dim*4`.
- **`secrets` / SYSTEM_KEY:** never a target — the engine refuses any column in `SYSTEM_KEY_TABLES`.
- **`db._sqlite` absent (a backend without it):** fail closed (the engine requires the raw handle; assert at entry).
- **Disk for the backup:** a ~2 GB ciphertext copy — check free space before; one backup per campaign, not per column.

### Test strategy
- **`verify:backfill`** (on a throwaway keyed SQLCipher DB): seed a column with envelopes (content) + a column with vector envelopes; run `backfillColumn`; assert (a) raw reads are now plaintext / raw-Buffer, (b) `LIKE 'ey%'` count == 0, (c) values round-trip identically to the pre-backfill decrypt, (d) idempotent re-run converts 0 + skips all, (e) a deliberately-corrupt row is left as an envelope + flagged, (f) the file stays ciphertext, (g) keyset pagination covers all rows across multiple batches, (h) `secrets` is refused.
- **Copy-test (real vault clone):** run the engine on a clone; golden-diff decrypted-old vs read-new for every row; measure wall-clock + WAL growth; prove the app stays responsive (the `setImmediate` yield).
- Regression: `verify:at-rest{,-purge}`, `verify:secrets`, `verify:leak` (re-framed) stay green.

### Implementation order
1. `backfill_state` migration + `backfillColumn` engine + `verify:backfill` gate (throwaway DB). **← buildable now** (no real vault).
2. `startBackfillJob` + the POST route + the pre-campaign backup + lock.
3. Copy-test on a real-vault clone (needs Stage 0 live) → measure → then drive the Stage A / B/C backfills through it.

### Decision criteria → use it for real
Engine gate GO; copy-test on a clone shows golden-identical values, 0 envelopes, app-responsive, acceptable wall-clock; the ciphertext backup + verified purge proven. Only then point it at the live vault (Stage A vectors first, smallest).

---

## Risks + mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| In-app backfill starves the event loop | Med | App unresponsive during run | `setImmediate` yield + small batch (500); the search-build proves this keeps the app live; cancellable via the job |
| Codec bug writes garbage, loses the envelope | Low | Data loss | Pre-campaign ciphertext backup; per-row round-trip in the gate + copy-test golden-diff before live |
| A second writer (a stray child/CLI) contends | Low | SQLITE_BUSY / corruption | In-app single-writer design + `.vault-init.lock` + single-flight; the engine refuses if it can't take the lock |
| Backup not purged → stale copy on disk | Low | Disk + a ciphertext (not plaintext) copy lingering | Stage-0-style self-verifying purge after the campaign verifies |
| `LIKE 'ey%'` false-negative (a plaintext value starting "ey") | Very low | Assert under-counts | `isEncrypted` full-parse confirms on any `'ey%'` hit; the assert is "candidates"; the per-row engine uses full `isEncrypted`, not the prefix alone |

## Open questions
**Resolved:** in-app (not child); raw handle for read+write+assert; one engine two codecs; backup is ciphertext.
**Deferred:** whether to run the campaign one-column-at-a-time vs a column-set per job (recommend per-column for the cleanest 0-envelope gate); whether to auto-trigger the backfill after a stop-write deploy vs operator-initiated (recommend operator-initiated POST, gated on a fresh backup).

---

## Verification table
| # | Load-bearing assumption | Verified at (read firsthand) |
|---|---|---|
| 1 | A JS backfill can use the app's raw keyed handle (no child, no bridge) | `src/db/index.js:189` (`_sqlite: adapter.db`) |
| 2 | No raw-read adapter method → must use `_sqlite` for verbatim envelopes | `src/adapter/d1.js:77-79` (always `autoDecryptResults`) |
| 3 | WAL bulk discipline: suspend autockpt, single truncate after | `src/search/backend/sqlite.js` beginBulk/endBulk |
| 4 | Keyset pagination + `setImmediate` yield (PAGE=1000) is the proven anti-freeze recipe | `src/search/d1-loader.js:69,181,216` |
| 5 | The 313s single-scan freeze is the failure this avoids | `src/search/d1-loader.js:61-63` |
| 6 | App-trigger + single-flight + kill-switch pattern exists | `src/portal-mindscape.js:351`; `src/jobs.js:63,83-85,32-36` |
| 7 | The child+bridge is Python-only (JS opens SQLCipher directly) | `pipeline/vault-bridge.js` header; `pipeline/local_db.py:4-24` |
| 8 | Safety template: backup→parity→atomic-swap→fail-closed + the lock | `src/account/db-cipher-migrate.js:69-112`; `src/db/init.js:38-65` |
| 9 | `isEncrypted` 'ey' prefix → the `LIKE 'ey%'` 0-envelope assert | `src/crypto/crypto-local.js:723-743` |
| 10 | Big tables use TEXT UUID PKs (keyset-able) | `migrations/0001_init.sql` (`id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))`) |
| 11 | Vector columns NEVER_AUTO_DECRYPT → typed codec, not the adapter | `src/crypto/crypto-local.js:1791-1811` |
