# Measure-only stage perf: frequency + cross-scale-coupling — HANDOFF 2026-06-19

**TL;DR** — The two stages that dominated a measure-only run are fixed.
`compute-frequency.py` (~553s) was a **missing-index** defect; `compute-cross-scale-coupling.py`
(~318s) was **persim's O(n³) Wasserstein**. Measured first on a 69k-message benchmark vault,
fixed, verified. Branch `perf/measure-stage-frequency-coupling` (commit `0085420`, pushed).
Both verify gates GO. **Deploy = rebuild the app bundle** (migration ships the index, and the
packaged pipeline ships the new stage code); then a live measure run will show the new durations.

## What was measured (69k-msg benchmark vault, real schema/indexes)

| Stage | Before | After | Factor |
|---|---|---|---|
| `compute-frequency.py` | ~553s (prod) | seconds | — |
| `compute-cross-scale-coupling.py` | ~318s (prod) / ~300s (bench) | **49.9s** (bench) | 6.4× |

Cross-scale phase split (bench, after): decrypt_vectors 4.7s · **ripser 38.4s** · wasserstein
4.0s (was 266.9s) · coupling 1.5s.

## Fix 1 — compute-frequency.py: missing composite index

Root cause (proven by `EXPLAIN QUERY PLAN`): the per-window message query
`WHERE user_id=? AND created_at >= ? AND created_at < date(?,'+1 day') ORDER BY created_at LIMIT 200`
has **no index that serves (user_id equality + created_at range + created_at order)** together.
Without `ANALYZE` stats SQLite picks a `user_id`-prefixed index (e.g. `idx_messages_nlp_created`)
then a **`USE TEMP B-TREE FOR ORDER BY`** — so each of the ~124 windows (month/week/day)
scans **and sorts the user's entire message set**. On the SQLCipher vault every such scan
decrypts the whole index/table footprint → ~9 min. Migration 0018 explicitly skipped `messages`
("messages already has idx_messages_created_at") — but that single-column index loses to the
`user_id`-prefixed ones in the planner.

**Fix:** `migrations/0026_messages_user_created_index.sql` →
`CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at);`
EXPLAIN then shows a tight `SEARCH ... USING idx_messages_user_created (user_id=? AND created_at>? AND created_at<?)`
that stops at LIMIT — **with and without stats**. Mirrors the existing
`idx_clustering_user_created` / `idx_tasks_user_created` / `idx_documents_user_created`. Idempotent.
The stage code is unchanged → behavior/correctness unchanged, only the DB plan improves.

## Fix 2 — compute-cross-scale-coupling.py: exact fast Wasserstein

Root cause (phase timers): `persim.wasserstein` was 266.9s of ~300s (87%). It builds an
`(M+N)²` cost matrix and runs the **O((M+N)³) Hungarian assignment** (`scipy.linear_sum_assignment`)
on H0 diagrams of up to ~2000 bars (monthly/delta windows).

**Fix:** `_h0_wasserstein1()` — an exact closed-form-fast specialization. Every **H0 bar is born
at filtration 0**, so both diagrams lie on the line `birth=0`; the W1 distance is a monotone
alignment DP over the sorted death-multisets (match `|a−b|` / send either to the diagonal at
`death/√2`, persim's exact geometry). The inner running-min is a prefix minimum, so each DP row
vectorizes via `np.minimum.accumulate` → O(m·n) but numpy-fast, no Python inner loop.
**Verified bit-for-bit vs persim** (max abs err ~5e-11 over 900+ random diagrams AND real H0
diagrams) at ~67× the speed (267s → 4s). Drops persim as a runtime dep for this stage.

Also added: content-free `[cross-scale timing]` phase timers (I/O-vs-compute split, visible on
live runs) and verify gate **H6** (DP-vs-persim parity) to guard the exactness claim.

## Verification

- `npm run verify:frequency` → **GO** (FQ0–FQ5; compression TCR still real, metrics encrypted at rest)
- `npm run verify:cross-scale-coupling` → **GO** (H0–H6; **H6** = exact-Wasserstein parity <1e-6)
- `npm run verify:measurement-schema` / `verify:at-rest-migration` / `verify:stage-accounting` → GO
- Live measure run: **PENDING deploy** (see below).

## Deploy / live-confirm protocol

1. **Rebuild the app bundle** (Tauri). On next launch `applyMigrations` creates
   `idx_messages_user_created` on the live vault and the bundle ships the new
   `compute-cross-scale-coupling.py`. (The currently-running packaged app uses its old bundle —
   migration 0026 and the stage change are NOT live until rebuilt.)
2. Trigger a measure-only run (`POST /portal/mycelium/measure`).
3. Confirm via `GET /portal/measurement-health`: `pipeline_state.last_duration_ms` for
   `frequency` and `cross-scale-coupling` should drop from ~553s/~318s to seconds/~50s.

## Remaining / follow-ups (not blocking)

- **ripser (~38s) is now the largest chunk of cross-scale-coupling.** Within the 60s goal with
  ~10s margin. If more headroom is wanted later, the lowest-risk lever is the delta (monthly,
  ~2000-pt) windows; reducing `PERSISTENCE_MAX_N` for this stage would speed ripser but changes
  topology fidelity (the metric is `low_confidence`/experimental) — validate before touching.
- `fetch_envelopes_chunked` uses `D1_BATCH=100` → ~690 bridge round-trips for 69k embeddings in
  prod. Small relative to ripser; raising the batch is a shared-constant change (legacy D1 path) —
  left alone.
- Migration numbered **0026** (not 0025): `0025_documents_updated_at_index.sql` is taken by another
  in-flight branch. No collision.

## Files

- `migrations/0026_messages_user_created_index.sql` (new)
- `pipeline/compute-cross-scale-coupling.py` (`_h0_wasserstein1` + phase timers)
- `scripts/verify-cross-scale-coupling.mjs` (gate H6 parity)
