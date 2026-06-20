# DESIGN — Backfill job wiring + `clustering_points.nomic_embedding` campaign

**Date:** 2026-06-19
**Branch:** `feat/sqlcipher-backfill-nomic` (off `origin/main` `c8a7a90`)
**Skill:** `/sweep-first-design` (3 concurrent Explore sweeps + self-verified reads)
**Predecessors:** [backfill-engine design](DESIGN-sqlcipher-backfill-engine-2026-06-19.md) · [execution plan](SQLCIPHER-COLLAPSE-EXECUTION-PLAN-2026-06-19.md) · [session handoff](SESSION-HANDOFF-2026-06-19-sqlcipher-collapse.md) · [next-PR runbook](SQLCIPHER-COLLAPSE-NEXT-PR-RUNBOOK-2026-06-19.md)
**Audience:** the implementer of this PR + the next Claude Code instance.

---

## What this PR delivers

1. **A runnable in-app backfill job** — `startBackfillJob(...)` in `src/jobs.js` (shares the clustering single-flight + the `jobs` Map status registry) and a **loopback-only, confirm-gated** `POST /api/v1/portal/mycelium/backfill` endpoint.
2. **The first real campaign:** convert `clustering_points.nomic_embedding` from per-field encrypted envelopes → raw little-endian Float32 bytes (dim 256), copy-tested on a clone first.
3. **Flip the one live-capable JS writer** (`pipeline/sync-clustering-points.js`) to `encodeVectorRaw`.

It does **NOT** make Generate (re-cluster) safe — see the **Pivot** below. That is a tracked follow-on.

---

## Revision history

- **v1 (runbook sketch):** Wire `POST /portal/mycelium/backfill`; flip BOTH nomic writers (`cluster.py` + `sync-clustering-points.js`) to `encode_vector_raw`/`encodeVectorRaw`; backfill; assert 0.
- **v2 (this doc — after sweeps):** Two pivots forced by the code:
  - **Pivot A — path.** The portal router mounts at `/api/v1/portal`, not `/portal` ([server-rest.js:284](../src/server-rest.js)). External path is **`/api/v1/portal/mycelium/backfill`**.
  - **Pivot B — `cluster.py` cannot be flipped this PR.** `cluster.py`'s nomic write goes `d1_batch → local_db.batch → _post → json.dumps` ([pipeline/local_db.py:38-49,77-90](../pipeline/local_db.py)). **Python `bytes` are not JSON-serializable**, and base64-over-JSON would bind as TEXT, not a BLOB — raw bytes through the bridge needs a bridge *protocol* change. AND both nomic writers run only in the **non-measure Generate path** ([run-clustering.sh:121-159](../pipeline/run-clustering.sh)), which is **kill-switched** on the live vault. So: flip only the in-app JS writer (`sync-clustering-points.js` uses the in-process `getDb()` adapter → a `Buffer` binds as a BLOB natively); **defer** `cluster.py` (it keeps writing envelopes, which readers dual-read) as a **required precondition before Generate is ever re-enabled.**
  - **Gate hardened.** Because backfill mutates the vault, the endpoint uses the **strictest** trust check — `isTrustedLoopback` (genuine same-host owner; rejects anything proxied/remote even with a valid owner Bearer), not `portalOwnerGate`.

---

## Sweep findings (consolidated, self-verified)

### Job + single-flight + raw handle
- Single-flight guard: `let runningJobId = null` ([jobs.js:63](../src/jobs.js)); checked at [jobs.js:83-85](../src/jobs.js) (`cur.status === 'running' || cur.child`).
- Kill-switch precedent: `generateLocked()` ([jobs.js:32-36](../src/jobs.js)) reads `MYCELIUM_DISABLE_GENERATE` / `.generate-disabled`; measure-only is exempt ([jobs.js:74-79](../src/jobs.js)).
- Job registry + status: `const jobs = new Map()` ([jobs.js:62](../src/jobs.js)); `getJob(jobId)` ([jobs.js:250-254](../src/jobs.js)); polled via `GET /mycelium/generate/status/:id` ([portal-mindscape.js:403-407](../src/portal-mindscape.js)).
- The measure job **spawns a child** (`spawn('bash', [scriptPath], …)` [jobs.js:141-145](../src/jobs.js)). **Backfill must NOT spawn** — it runs in-app on the keyed handle. (`src/account/backfill.js` header states the single-writer-contention rationale.)
- Raw handle: `_sqlite: adapter.db` ([db/index.js:185-189](../src/db/index.js)). Vault path: `dbPath()` ([paths.js:53](../src/paths.js)); the mindscape router already receives `dbPath` ([server-rest.js:284](../src/server-rest.js)).
- `jobs.js` does NOT yet import `backfillColumn` — this PR adds it.

### Endpoint + auth (the crux for a destructive op)
- Both the loopback http listener (127.0.0.1:8787) and the TLS listener (`0.0.0.0:8443`, [server-rest.js:801-806](../src/server-rest.js)) serve the **same** express `app` — so a route's protection comes from its **router middleware**, not the bind.
- The mindscape router is mounted **WITHOUT** `portalOwnerGate` ([server-rest.js:284](../src/server-rest.js)) — fine for its read stubs, **not** for a destructive write.
- `isTrustedLoopback(req)` ([http/loopback.js](../src/http/loopback.js)): socket peer ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1} AND no `x-forwarded-for`/`forwarded`/`x-real-ip`/`x-forwarded-host`. Rejects every proxied/remote request — the same boundary the recovery-key/account routes use.
- `makePortalOwnerGate` ([require-vault-auth.js:170-181](../src/http/require-vault-auth.js)): loopback OR owner static Bearer (incl. WKWebView cookie). **Too permissive** for backfill (would allow remote trigger).
- The measure route ([portal-mindscape.js:351-358](../src/portal-mindscape.js)) reads no body; narrate routes use `express.json({limit:'16kb'})` ([portal-mindscape.js:365](../src/portal-mindscape.js)) — the pattern to mirror for the confirm/targets body.

### Vault lock
- `acquireLock`/`releaseLock` ([db/init.js:38-65](../src/db/init.js)): O_EXCL `.vault-init.lock`, **boot-only, NOT reentrant.** Reusing it for a long backfill would deadlock against any path that re-enters `initVaultStorage`. **Do not reuse it.** The shared `runningJobId` single-flight is the mutual-exclusion mechanism (backfill ⊥ re-cluster — both write `clustering_points`).

### Master key (engine input)
- `getMasterKey()` ([crypto-local.js:2084](../src/crypto/crypto-local.js), exported; imported by enrich/ingest/mind-files) returns the pinned `CryptoKey|Buffer` USER_MASTER. d1-loader ([d1-loader.js:140](../src/search/d1-loader.js)) and sync-clustering-points ([sync-clustering-points.js:119](../pipeline/sync-clustering-points.js)) both use it. The job calls `await getMasterKey()`.

### The column + engine
- `clustering_points.id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))` ([0001_init.sql:255](../migrations/0001_init.sql)) — random-hex TEXT, **not encrypted** → keyset pagination on `id` is safe (NOT the mixed-column ORDER-BY landmine). `nomic_embedding BLOB` (last col, [0001_init.sql:274](../migrations/0001_init.sql)).
- `backfillColumn(rawDb, {table, column, codec, masterKey, batch, pk, signal})` ([backfill.js:50](../src/account/backfill.js)): for `codec.kind==='vector'` it `decryptVector(v, masterKey, null, dim)` → writes `Buffer.from(vec.buffer…)` (raw LE-f32). Idempotent (`typeof v!=='string' || !isEncrypted(v)` → skip — so Buffers/NULLs are left), fail-closed per row, WAL-suspend, `setImmediate` yield. `countRemainingEnvelopes` uses `LIKE 'ey%'` ([backfill.js:30-33](../src/account/backfill.js)) — matches only the **TEXT-typed** envelopes; raw `Buffer` rows store as BLOB type and don't match. Refuses `secrets` ([backfill.js:52](../src/account/backfill.js)).
- Dual-read reader: `_decode_nomic_embedding` ([cluster.py:241-273](../pipeline/cluster.py)) already handles BOTH a base64 envelope str (`is_encrypted` → `decrypt_vector`) AND raw bytes (`np.frombuffer(…float32)`). Reader needs **no** change.
- Codecs present: `encodeVectorRaw`/`decodeStoredVector` ([decode.js:108-142](../src/search/ann/decode.js)); `encode_vector_raw`/`decode_stored_vector` (crypto_local.py). `NOMIC_DIM = 256` ([cluster.py:73](../pipeline/cluster.py)).
- Centroids (`centroid_256/3d`) are `json.dumps(...)` via `d1_batch_encrypted` ([cluster.py:1544-1588](../pipeline/cluster.py)) — auto-encrypt JSON, **Stage B, not this PR.**

---

## Module shapes

### `src/jobs.js` — `startBackfillJob` (+ `backfillLocked`)  (~70 LOC)
```js
import { backfillColumn, countRemainingEnvelopes } from './account/backfill.js';
import { getMasterKey } from './crypto/crypto-local.js';
import { copyFileSync, unlinkSync } from 'node:fs';

export function backfillLocked() {
  if (process.env.MYCELIUM_DISABLE_BACKFILL === '1') return true;
  try { return fs.existsSync(path.join(path.dirname(resolveDbPath()), '.backfill-disabled')); }
  catch { return false; }
}

// columns: [{ table, column, codec:{kind:'vector',dim} | {kind:'content'} }]
export function startBackfillJob({ db, dbPath, columns } = {}) {
  if (backfillLocked()) return { jobId: null, status: 'disabled' };
  const cur = runningJobId ? jobs.get(runningJobId) : null;
  if (cur && (cur.status === 'running' || cur.child)) return { jobId: runningJobId, status: 'already_running' };
  if (!db?._sqlite) return { jobId: null, status: 'unavailable' };
  if (!Array.isArray(columns) || !columns.length) return { jobId: null, status: 'no_columns' };

  const id = `backfill-${jobSeq++}`;
  const job = { id, kind: 'backfill', status: 'running', step: 0, totalSteps: columns.length + 2,
                stageLabel: 'starting', startedAt: Date.now(), child: null, error: null };
  jobs.set(id, job); runningJobId = id;
  const rawDb = db._sqlite;
  const path0 = dbPath || resolveDbPath();

  (async () => {
    let backupPath = null;
    try {
      // 1. pre-campaign ciphertext backup (vault is at-rest encrypted → safe on disk)
      job.stageLabel = 'backup';
      try { rawDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* */ }
      backupPath = `${path0}.pre-backfill-${job.startedAt}`;
      copyFileSync(path0, backupPath);
      job.step = 1;
      // 2. masterKey + per-column backfill
      const masterKey = await getMasterKey();
      for (const c of columns) {
        job.stageLabel = `${c.table}.${c.column}`;
        await backfillColumn(rawDb, { table: c.table, column: c.column, codec: c.codec, masterKey });
        job.step++;
      }
      // 3. assert 0 envelopes per column; purge backup only if all clean
      job.stageLabel = 'verify';
      const remaining = columns.map((c) => ({ c, n: countRemainingEnvelopes(rawDb, c.table, c.column) }));
      const dirty = remaining.filter((r) => r.n > 0);
      if (dirty.length) {
        job.status = 'error';
        job.error = `envelopes remain: ${dirty.map((r) => `${r.c.table}.${r.c.column}=${r.n}`).join(', ')}`;
        // keep the backup for recovery
      } else {
        if (backupPath) { try { unlinkSync(backupPath); } catch { /* */ } }
        job.status = 'done';
      }
    } catch (err) {
      job.status = 'error'; job.error = String(err?.message || err);
      // keep the backup on any failure
    } finally {
      job.step = job.totalSteps; job.finishedAt = Date.now();
      if (runningJobId === id) runningJobId = null;
    }
  })();

  return { jobId: id, status: 'running' };
}
```
(`jobSeq`, `runningJobId`, `jobs`, `resolveDbPath`, `fs`, `path` already exist in `jobs.js`.)

### `src/portal-mindscape.js` — the endpoint  (~22 LOC)
```js
import { startBackfillJob } from './jobs.js';           // (getJob already imported)
import { isTrustedLoopback } from './http/loopback.js';

// Server-side allowlist — the body may ONLY request these named targets, never an
// arbitrary {table,column}. Fail-closed: unknown name → 400. Extended per follow-on.
const BACKFILL_TARGETS = {
  'clustering_points.nomic_embedding': { table: 'clustering_points', column: 'nomic_embedding', codec: { kind: 'vector', dim: 256 } },
};

router.post('/mycelium/backfill', express.json({ limit: '16kb' }), (req, res) => {
  if (!isTrustedLoopback(req)) return fail(res, 403, 'backfill is local-only');           // destructive → loopback owner only
  if (req.body?.confirm !== true) return fail(res, 400, 'confirm:true required');
  const names = Array.isArray(req.body?.targets) ? req.body.targets : [];
  const columns = names.map((n) => BACKFILL_TARGETS[n]).filter(Boolean);
  if (!columns.length || columns.length !== names.length) return fail(res, 400, 'unknown or empty targets');
  try { res.json(startBackfillJob({ db, dbPath, columns })); }
  catch { fail(res, 503, 'backfill is unavailable'); }
});
```

### `pipeline/sync-clustering-points.js` — flip the JS writer  (~6 LOC, 2 sites)
- Import: `import { decryptVector, encodeVectorRaw } from '../src/search/ann/decode.js';` (drop `encryptVector`).
- Sites [~139](../pipeline/sync-clustering-points.js) and [~180](../pipeline/sync-clustering-points.js): `const envelope = await encryptVector(vec, NOMIC_SCOPE, masterKey)` → `const raw = encodeVectorRaw(vec)`; bind `raw` instead of `envelope`. Update the line-136 comment ("Bound as a TEXT param…" → "Bound as a raw LE-f32 BLOB — the column is migrating off envelopes (Stage A)").

### `pipeline/cluster.py` — DEFER + document  (~4 LOC comment only)
At the nomic write ([cluster.py:536](../pipeline/cluster.py)) add a comment: the column is migrating to raw bytes; this writer still emits an envelope because the JSON `d1_batch` bridge cannot carry raw bytes (`local_db._post` json.dumps); readers dual-read, so this is read-safe; **flipping it (bridge blob-param support) is a precondition before Generate is re-enabled.** No code change.

---

## Threat model / security

- **New attack surface:** one HTTP route that mutates the vault. Mitigations, defense-in-depth: (1) `isTrustedLoopback` — genuine same-host owner only, rejects all proxied/remote even with a valid Bearer; (2) `confirm:true` body required; (3) server-side **allowlist** — body can't aim the engine at an arbitrary column; (4) engine refuses `secrets`; (5) `MYCELIUM_DISABLE_BACKFILL` kill-switch; (6) single-flight (no concurrent vault writers). 
- **Zero plaintext leakage:** the engine logs only `id + message` on a failed row (never plaintext); the pre-campaign backup is a copy of the **already-encrypted** vault (ciphertext at rest) and is purged after the 0-envelope assert, or **kept** on any failure for recovery.
- **Fail-closed:** unknown target → 400; non-loopback → 403; missing key/handle → job `unavailable`/`error` (backup retained); a per-row decode error leaves the envelope in place and is surfaced by the 0-envelope assert (which then keeps the backup and marks the job `error`).
- **Ordering law:** stop-write (writer flip ships in the same build) → backfill → assert 0. The column is read dual-mode throughout, so order within the deploy is immaterial to correctness.

---

## Edge cases — explicit decisions

| Case | Decision |
|---|---|
| `cluster.py` re-introduces envelopes if Generate runs | Accepted: Generate is kill-switched; readers dual-read; documented precondition. 0-envelope assert is point-in-time, valid now. |
| A vault **import** re-inserts envelopes ([vault-import.js:418](../src/ingest/vault-import.js)) | Accepted/out-of-scope: import-restore is rare; readers dual-read; re-run backfill after an import. Noted. |
| Backfill + a chat write race during the file copy | The copy happens at job start, before mutation, after a WAL checkpoint; backfill holds single-flight. Incidental writes during the ms-scale copy are an accepted small risk for an operator-triggered maintenance op. |
| Two backfill requests | Second returns `already_running` (shared `runningJobId`). |
| Backfill while a re-cluster is running | Mutually excluded by `runningJobId` (both write `clustering_points`). |
| `LIKE 'ey%'` false-positive on a raw Buffer | Raw bytes store as BLOB type; `LIKE 'ey%'` matches only TEXT — verified by copy-test golden-diff + `countRemainingEnvelopes==0`. |
| Power loss mid-backfill | Engine is idempotent/resumable (skips already-raw rows); the `.pre-backfill` backup remains until a clean verify. |

---

## Test strategy

- **`scripts/verify-backfill-nomic.mjs` (NEW gate `verify:backfill-nomic`)** — on a throwaway **keyed SQLCipher** DB:
  1. Create `clustering_points` with a mix: N envelope rows (written via `encryptVector`), M already-raw rows (`encodeVectorRaw`), K NULLs.
  2. `backfillColumn(raw, {table:'clustering_points', column:'nomic_embedding', codec:{kind:'vector',dim:256}, masterKey})`.
  3. **Golden-diff:** for every originally-envelope row, `decodeStoredVector(newValue, 256)` ≈ `decryptVector(oldEnvelope, …, 256)` within f32 epsilon.
  4. Assert `countRemainingEnvelopes==0`; raw rows untouched (idempotent); NULLs untouched.
  5. File header still ciphertext after the run.
  6. **Gate-logic unit:** `isTrustedLoopback({socket:{remoteAddress:'127.0.0.1'},headers:{}})===true`; `…headers:{'x-forwarded-for':''}` ===false; allowlist rejects an unknown target name. (Skips the python parity assert gracefully if `pipeline/.venv` is absent — CI covers it.)
- **Regression:** `verify:backfill`, `verify:cluster-embed`, `verify:search`, `verify:embed`, `verify:at-rest{,-purge}`, `verify:secrets`, `verify:leak`. Full `npm run verify` in CI.
- **Copy-test on a clone of the REAL vault** (manual, before the live run): `cp` the vault → run the job against the copy via a tiny harness → golden-diff + size delta + ciphertext-confirm. Only then the live `POST`.

---

## Implementation order (each independently checkable)

1. `startBackfillJob` + `backfillLocked` in `src/jobs.js`. Smoke: `node -e` import + a `:memory:`/throwaway call returns `{jobId,status:'running'}`.
2. Endpoint in `src/portal-mindscape.js` (allowlist + `isTrustedLoopback` + `confirm`). Smoke: route returns 403 with an XFF header, 400 without confirm, 400 on unknown target.
3. Flip `sync-clustering-points.js` writer → `encodeVectorRaw` (+ comment). `cluster.py` defer-comment.
4. `scripts/verify-backfill-nomic.mjs` + wire `verify:backfill-nomic` into `package.json`. Run it green.
5. Full `npm run verify` (JS gates locally; trust CI for python). Push → CI green.
6. **Copy-test on a real-vault clone**, golden-diff, measure size delta. THEN rebuild app → live `POST /api/v1/portal/mycelium/backfill {targets:['clustering_points.nomic_embedding'],confirm:true}` → poll status → `done` → confirm `countRemainingEnvelopes==0` live → mindscape still renders.

## Decision criteria for the follow-on (embedding_768 / anchor_vector)
Proceed to the bigger vector columns when: this job is proven on the real vault (0 envelopes, identical clusters, measured size delta), AND the **bridge blob-param** design exists (so the Python writers — `cluster.py`, `compute-anchors.py` — can write raw bytes). That bridge work is the gate for re-enabling Generate.

## Risks + mitigations

| Risk | L | I | Mitigation |
|---|---|---|---|
| Endpoint reachable by a non-owner | Low | High | `isTrustedLoopback` (rejects proxied/remote) + allowlist + confirm + kill-switch |
| Engine corrupts a vector | Low | High | Copy-test golden-diff before live; per-row fail-closed; ciphertext backup kept until clean verify |
| `cluster.py` reintroduces envelopes | Low | Low | Generate kill-switched; dual-read; documented precondition |
| Live file-copy inconsistency | Low | Med | WAL checkpoint + single-flight; operator-triggered; backup is ciphertext |
| `package.json` verify-chain rebase conflict | High | Low | The known recipe (take origin/main's line, re-insert the gate); merge promptly |

## Open questions resolved during sweep
- **External path is `/api/v1/portal/…`, not `/portal/…`** (runbook was wrong).
- **`cluster.py` can't write raw bytes** through the JSON bridge → deferred (not a blocker; not live).
- **Neither nomic writer is live** under measure-only → backfill is a clean one-shot.
- **`isTrustedLoopback` > `portalOwnerGate`** for a destructive op.

## Open questions deferred
- Bridge blob-param protocol (for Python raw-vector writers) — the follow-on's gate.
- `embedding_768` (6 tables) + `anchor_vector` campaign.
- Stage B/C content (the loading-speed root fix).

---

## Verification table

| Assumption | Verified at (read myself) |
|---|---|
| Single-flight `runningJobId` exists + check shape | `src/jobs.js:63,83-85` |
| Kill-switch precedent (`generateLocked`) | `src/jobs.js:32-36,74-79` |
| Job Map + `getJob` + status route | `src/jobs.js:62,250-254` · `src/portal-mindscape.js:403-407` |
| Measure spawns a child; backfill must be in-app | `src/jobs.js:141-145` · `src/account/backfill.js:7-12` |
| Raw handle `db._sqlite`; vault `dbPath()`; router gets dbPath | `src/db/index.js:185-189` · `src/paths.js:53` · `src/server-rest.js:284` |
| Router mounts `/api/v1/portal`; measure/narrate route shapes | `src/server-rest.js:284` · `src/portal-mindscape.js:351-358,365` |
| Both listeners share one `app`; TLS binds 0.0.0.0 | `src/server-rest.js:801-806` |
| `isTrustedLoopback` semantics (strict) | `src/http/loopback.js` (LOOPBACK_PEERS + FORWARD_HEADERS) |
| `makePortalOwnerGate` allows remote Bearer (too permissive) | `src/http/require-vault-auth.js:170-181` |
| `acquireLock` is boot-only, not reentrant (don't reuse) | `src/db/init.js:38-65` |
| `getMasterKey()` exported, returns the pinned USER_MASTER | `src/crypto/crypto-local.js:2084` |
| `clustering_points.id` TEXT random-hex pk; `nomic_embedding BLOB` | `migrations/0001_init.sql:255,274` |
| Engine signature + vector→raw write + idempotent + `LIKE 'ey%'` | `src/account/backfill.js:30-33,50-99` |
| Dual-read reader handles bytes + envelope | `pipeline/cluster.py:241-273` |
| Codecs present (JS + Py); NOMIC_DIM=256 | `src/search/ann/decode.js:108-142` · `pipeline/cluster.py:73` |
| Centroids = JSON auto-encrypt (out of scope) | `pipeline/cluster.py:1544-1588` |
| **PIVOT B:** `d1_batch` JSON bridge can't carry bytes | `pipeline/local_db.py:38-49,77-90` |
| **PIVOT B:** sync writer uses in-process getDb adapter | `pipeline/sync-clustering-points.js:30,119,140` |
| Both nomic writers skipped under measure-only | `pipeline/run-clustering.sh:121-159` |
