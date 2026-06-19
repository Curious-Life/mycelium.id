# Vitality Data Hygiene — Design

**Date:** 2026-06-19
**Status:** LOCKED (sweep-first, 3 Explore sweeps + self-verified reads + live data)
**Scope:** Fix the three vitality data-quality bugs surfaced by the live metric audit: (1) `territory_vitality` accumulates duplicate rows (19,482 rows for 152 territories); (2) `/vitality/snapshot` serves a stale `backfill-v1` run; (3) `engagement_depth_normalized` shows 0. Out of scope (named): the sibling `topology_audit_snapshots` accumulation (needs a different fix — it depends on its prior row).

---

## 0. Headline

The live audit found vitality serving **19,482 rows for 152 distinct territories (~128×)**, all tagged `clustering_run_id="backfill-v1"`, with `engagement_depth_normalized=0` everywhere. Three independent root causes, **two real fixes + one freebie**:

| Bug | Root cause | Fix |
|---|---|---|
| 128× duplicate rows | `compute-vitality.js` does a pure `INSERT` (random-UUID id, no dedup, no DELETE-before) → every run accumulates | **DELETE-before-insert** (clear-all, the cofire pattern) + stamp a real era run id |
| Snapshot serves `backfill-v1` | `/vitality/snapshot` picks the run via **lexicographic `MAX(clustering_run_id)`** → `"backfill-v1" > "era-2026-…"` (b>e); the fresh run's NULL-id rows are excluded | Select the latest run by **`computed_at`**, not string max |
| `engagement_depth=0` | The `backfill-v1` rows predate the column (`ALTER … DEFAULT 0`); the snapshot shows that stale run | **Subsumed** — fixing the snapshot surfaces the fresh run's real values (smoke-verify) |

The clear-all writer also **self-cleans the live vault** on the next measure run — no risky manual DELETE on the encrypted vault.

---

## 1. Revision history

- **v1 (audit sketch):** "vitality has 19k dup rows + a dead engagement_depth metric + a stale snapshot — fix all three as separate bugs."
- **v2 (after Sweep 1 + self-read `compute-vitality.js:194,198,247,283-293`):** PIVOT — `engagement_depth=0` is **not** a formula bug. `engagement_depth = (msg_count/p90)*coherence`; the same `coherence` drives `diversification` (line 198), whose live values reach 0.883 → coherence is non-zero. The `backfill-v1` rows are 0 because the column was `ALTER`-added with `DEFAULT 0` after the backfill ran. So engagement_depth is a **stale-data symptom**, fixed by the snapshot/dedup fix, not a separate code change. Reclassified to smoke-verify.
- **v2 (after Sweep 2 + self-read `portal-measurement.js:140-156`):** confirmed the snapshot's `MAX(clustering_run_id)` is lexicographic and the fresh measure-run rows carry `clustering_run_id=NULL` (measure-only never sets `CLUSTERING_RUN_ID`), so they're invisible to the snapshot.
- **v2 (after Sweep 3 + self-read `topology-audit.js:13,25,203`):** SCOPED OUT topology_audit — it has the same INSERT-accumulate pattern BUT computes `m2_delta`/`m2_trend` *vs the prior run*, so clear-all would break it. Different fix; deferred. Vitality has **no** cross-run dependency → clear-all is safe.

---

## 2. Sweep findings (consolidated, file:line)

### Writer (the duplication)
- `pipeline/compute-vitality.js:283-293` — `INSERT INTO territory_vitality (id, …) VALUES (?, …)` with `crypto.randomUUID()` as `id` and `runId` as `clustering_run_id`. **No DELETE-before, no ON CONFLICT.** Every run appends.
- Schema `migrations/0001_init.sql:1419-1432` — PK is `id` (random UUID) only; **no UNIQUE on (user_id, territory_id, clustering_run_id)**; the two indices (`idx_tv_computed`, `idx_tv_user_territory`) don't enforce uniqueness. `engagement_depth_normalized REAL DEFAULT 0` is the **last** column (ALTER-added after the original set).
- `runId` source: `compute-vitality.js` CLI wrapper — `process.env.CLUSTERING_RUN_ID || null`. Measure-only (`jobs.js`) does **not** set `CLUSTERING_RUN_ID` → fresh rows get `clustering_run_id=NULL`.
- The territory_profiles cache write (`compute-vitality.js:301-307`) is an `UPDATE … WHERE user_id=? AND territory_id=?` — **deduped** (1 row/territory); unaffected. This is what the Mindscape 3D scene reads (`portal-mindscape.js:138 currentVitality/currentPhase`), so the *map* is not duplicated — only the *vitality page snapshot* is.
- `backfill-v1` string is **absent from the repo** (grep) → it was an external `CLUSTERING_RUN_ID="backfill-v1"` invocation run ~128× (152×128≈19,482).
- Systemic check: cofire + neighbors DELETE-before-insert; complexity/fisher/frequency/harmonics ON CONFLICT DO UPDATE. **Only vitality + topology_audit accumulate.** No retention/prune job anywhere.

### Reader (the stale snapshot)
- `src/portal-measurement.js:140-143` — `SELECT MAX(clustering_run_id) AS run_id FROM territory_vitality` then filters `WHERE clustering_run_id = ?`. `MAX` over TEXT is lexicographic → `"backfill-v1"` wins; `MAX` ignores NULL → the fresh NULL rows can never be selected.
- `:162-177` — `summary.territory_count = territories.length` over **all** returned rows → inflated to 19,482.
- Consumer: `portal-app/src/lib/views/VitalityView.svelte` reads `/portal/vitality/snapshot` (the inflated surface). The MCP `territoryDetail` reads `ORDER BY computed_at DESC LIMIT 1` (correct, by timestamp) — so the agent path already gets fresh data.

### engagement_depth (the freebie)
- `compute-vitality.js:247` `engagementDepth = clamp((num(t.message_count)/p90Messages) * coherence, 0, 1)`; `coherence = num(t.coherence)` (`:194`). `diversification` (`:198`) `= coherence*0.7 + min(energy*50,1)*0.3` — live max 0.883 > 0.3 ⇒ coherence is non-zero ⇒ a fresh run computes engagement_depth > 0. The 0s are the backfill's `DEFAULT 0`.

---

## 3. Threat model / security

- **Encryption boundary:** the 6 vitality metric columns are SEC-3 encrypted (`crypto-local.js`); `clustering_run_id`, `computed_at`, `territory_id`, `phase` are plaintext. The DELETE-before keys on plaintext `user_id`; the snapshot orders/filters on plaintext `computed_at`/`clustering_run_id`. **No ciphertext used in a predicate, no plaintext leak.**
- **Data-loss risk (the one real risk):** clear-all DELETEs all vitality rows for the user before re-inserting. If the stage then fails mid-insert, vitality is empty until the next run. Mitigation: vitality is fully recomputable from the existing mindscape (no source data lost), and the stage-result fail-loud (Gap #3) makes a partial write abort + visible. The territory_profiles cache (the map surface) is untouched. This matches the accepted cofire/neighbors tradeoff (both clear-all).
- **No new attack surface** — no new endpoint, table, or IPC. The fix is one DELETE + one SELECT change.
- **Audit:** the run id is now a real era (meaningful), improving traceability vs the prior NULL.

---

## 4. Module shape (signatures + LOC)

### 4.1 `pipeline/compute-vitality.js` (~6 LOC)
- Inside `computeVitality()`, immediately before the insert loop (after the dryRun guard), add the clear-all:
  ```js
  // Idempotent current-snapshot semantics (mirrors compute-cofire/neighbors):
  // replace this user's vitality rows each run so re-runs don't accumulate
  // (the table had no dedup key → 128× duplication). No cross-run dependency:
  // growth/reach read CURRENT cofire+graph, never prior vitality rows.
  await db.rawQuery(`DELETE FROM territory_vitality WHERE user_id = ?`, [userId]);
  ```
- In the CLI wrapper (`runCli`), derive a real run id instead of NULL:
  ```js
  const runId = process.env.CLUSTERING_RUN_ID
    || await db.metrics.getCurrentEra(USER_ID).catch(() => null);
  ```
  (`db.metrics.getCurrentEra` exists — `src/db/metrics.js`. Falls back to `era-<territory_profiles.updated_at>` / bootstrap. Stamping a real id makes the run sortable and meaningful; with clear-all there's a single run, but the id still beats NULL.)

### 4.2 `src/portal-measurement.js` `/vitality/snapshot` (~6 LOC)
Replace the lexicographic run pick with recency-by-`computed_at`:
```js
// Latest run by RECENCY (computed_at), not lexicographic MAX(clustering_run_id)
// — string max picked a stale 'backfill-v1' over 'era-…' (b>e) and ignored NULL
// run ids. `IS ?` matches a NULL run id too.
const latest = ((await db.rawQuery(
  `SELECT clustering_run_id FROM territory_vitality WHERE user_id = ? ORDER BY computed_at DESC LIMIT 1`,
  [u.id])).results || [])[0];
const sql = latest
  ? `SELECT … FROM territory_vitality WHERE user_id = ? AND clustering_run_id IS ? ORDER BY territory_id`
  : `SELECT … FROM territory_vitality WHERE user_id = ? ORDER BY territory_id`;
const params = latest ? [u.id, latest.clustering_run_id] : [u.id];
```
`run_id` in the response becomes `latest?.clustering_run_id ?? null`.

### 4.3 `scripts/verify-vitality.mjs` (~20 LOC, EXTEND)
Add: (a) **idempotency** — run `computeVitality` twice; assert `territory_vitality` row count == territory count (not 2×); (b) **snapshot recency** — seed two runs with different `computed_at` (an older `"zzz-newer-string"` run + a newer `"era-…"` run); assert the snapshot returns the **newer-by-computed_at** run even though its id sorts *before* the other (proves we don't use string MAX).

**Total LOC: ~32.** No migration (the clear-all self-cleans live data on next run).

---

## 5. Edge cases — explicit decisions

- **History loss (clear-all).** Decided: acceptable. No reader consumes multi-run vitality history (snapshot = latest run; territoryDetail = latest by timestamp; the map = territory_profiles cache). A vitality *trend* feature, if ever wanted, gets its own design + a windowed/ON-CONFLICT scheme. clear-all matches the proven cofire/neighbors pattern and self-heals the backfill.
- **NULL run id still possible** (if `getCurrentEra` throws and env unset). The snapshot's `clustering_run_id IS ?` handles NULL; clear-all means at most one run regardless. So a NULL id is harmless.
- **Two runs, same `computed_at` second.** `ORDER BY computed_at DESC LIMIT 1` picks one row; all rows of a run share its id → the filter returns the whole run. After clear-all there's only one run anyway.
- **topology_audit_snapshots** (same accumulate bug) — NOT fixed here: `m2_delta`/`m2_trend` read the prior snapshot, so clear-all would break the delta. Deferred to its own fix (keep-last-2 or compute-delta-then-prune).
- **engagement_depth still 0 after fix?** If the fresh-run smoke shows engagement_depth=0, then coherence or message_count is genuinely 0 on territory_profiles (a deeper cluster-stage issue) — that becomes a separate ticket. Hypothesis (coherence>0 per diversification) says it'll be non-zero.

---

## 6. Test strategy

| Test | Asserts |
|---|---|
| `verify:vitality` (EXTEND) | (a) two `computeVitality` runs → ONE set of rows (dedup, no 2×); (b) snapshot picks latest-by-`computed_at`, not lexicographic MAX (seed a string-greater-but-older run + a string-lesser-but-newer run; newer wins); (c) existing encryption/decryption asserts still GO. |
| `verify:metrics-rest` (NO CHANGE) | snapshot route still 200 + shape intact. |
| Live smoke | After patching + a measure-only run: `/vitality/snapshot` returns ~152–253 rows (one run), `summary.territory_count` ≈ real territory count (not 19,482), and `engagement_depth_normalized` is **non-zero** (confirms the stale-data hypothesis). |
| `npm run verify` | Full chain green before merge. |

---

## 7. Implementation order

1. **Writer dedup + run id** (`compute-vitality.js`). Smoke: `verify:vitality` idempotency assert GO.
2. **Snapshot recency** (`portal-measurement.js`). Smoke: `verify:vitality` recency assert + `verify:metrics-rest` GO.
3. **Full `npm run verify`** green.
4. **Patch bundle + measure-only run on the live vault**; confirm snapshot shows one clean run + non-zero engagement_depth (resolves engagement_depth + proves the live data self-cleaned).
5. **PR + merge.**

---

## 8. Decision criteria / done

- `territory_vitality` row count == distinct territory count after a run (no accumulation).
- `/vitality/snapshot` `summary.territory_count` matches the live territory count (~152–253), not 19,482; `run_id` is the freshest run.
- `engagement_depth_normalized` non-zero on the live snapshot post-run (or a separate ticket filed if still 0).
- `verify:vitality` + full `npm run verify` GREEN; GitHub CI green.

---

## 9. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| clear-all wipes vitality then stage fails → empty vitality | Low | Low | Recomputable; fail-loud (Gap #3) surfaces it; map (territory_profiles) untouched; matches cofire |
| `getCurrentEra` slow/throws | Low | Low | `.catch(()=>null)`; clear-all makes the id non-critical |
| Other (future) reader expects multi-run history | Low | Med | None today (verified all 3 readers); documented as deferred feature |
| `clustering_run_id IS ?` not supported by adapter binding | Low | Med | SQLite supports `x IS ?` with NULL bind; verified in `verify:vitality` recency test |

---

## 10. Verification table

| Assumption | Verified at |
|---|---|
| Writer is pure INSERT with random-UUID id, no dedup/DELETE-before | `pipeline/compute-vitality.js:283-293` (read) |
| Schema PK is `id` only; no unique on (user,territory,run); engagement_depth is ALTER-added DEFAULT 0 | `migrations/0001_init.sql:1419-1432` (sweep, to re-read at impl) |
| Snapshot picks run via lexicographic `MAX(clustering_run_id)`; summary counts all returned rows | `src/portal-measurement.js:140-143,162-177` (read) |
| Fresh measure-run rows carry `clustering_run_id=NULL` (measure-only doesn't set CLUSTERING_RUN_ID) | `src/jobs.js:103-121` (read — no CLUSTERING_RUN_ID in childEnv) |
| `engagement_depth=(msg/p90)*coherence`; coherence non-zero (drives diversification, live max 0.883) | `pipeline/compute-vitality.js:194,198,247` (read) + live `/vitality/snapshot` data |
| territory_profiles cache is UPDATE (deduped) + is what the map reads (not the snapshot) | `pipeline/compute-vitality.js:301-307`; `src/portal-mindscape.js:138` (sweep) |
| Vitality has NO cross-run dependency (growth/reach use current cofire+graph) | `pipeline/compute-vitality.js:200-247` (read) |
| topology_audit DOES depend on prior run (m2_delta) → excluded from clear-all | `pipeline/topology-audit.js:13,25,203` (read) |
| `db.metrics.getCurrentEra(userId)` exists for run-id derivation | `src/db/metrics.js` getCurrentEra (sweep, to re-read at impl) |
| Only vitality + topology_audit accumulate; others dedup | sweep across compute-* writers (to spot-check at impl) |
