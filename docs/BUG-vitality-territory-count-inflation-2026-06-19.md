# BUG — Vitality territory count inflated ~52× (territory_vitality accumulation)

**Filed:** 2026-06-19 · **Status:** OPEN — handed to the metric-audit session (not fixed in `feat/curious-life-update`)
**Severity:** MED (display/data-hygiene; corrupts every Vitality number on the Curious Life page; erodes trust)
**Surfaces on:** Curious Life → Vitality card + detail (`/portal/vitality/snapshot`)

## Symptom

The Vitality card reports **~19,482 territories** with a phase split of **1,786 anchor / 9,875 active / 7,821 sparse**. The real grain is **territories** (the *finest* clustering level: realms → themes → territories), and the live vault has only **~372 territories / 21 realms** (per the 2026-06-15 live read recorded in the `measure-only-and-key-blocker` memory).

19,482 ÷ 372 ≈ **52** — i.e. roughly 52 clustering runs' worth of rows, each territory counted once per run.

## Root cause

Two facts combine:

1. **`compute-vitality.js` is append-only.** Every run does a plain `INSERT INTO territory_vitality (...)` with a fresh `crypto.randomUUID()` id and no prior-row `DELETE`/upsert.
   - Evidence: [`pipeline/compute-vitality.js:283-293`](../pipeline/compute-vitality.js) — `INSERT INTO territory_vitality ... VALUES (...)`, one row per territory per invocation.

2. **The snapshot scopes by `MAX(clustering_run_id)`, but the run id is a stable era anchor reused across many runs.** So all ~52 runs within an era share the same `clustering_run_id`, and the snapshot counts every accumulated row under that single id.
   - Evidence: [`src/portal-measurement.js:140-155`](../src/portal-measurement.js) — `SELECT MAX(clustering_run_id) ... ` then `SELECT ... WHERE clustering_run_id = ?` with **no per-territory dedup** and **no `GROUP BY territory_id`**.
   - `runId` source: [`pipeline/compute-vitality.js:332`](../pipeline/compute-vitality.js) — `const runId = process.env.CLUSTERING_RUN_ID || null;`
   - Era-anchor reuse: [`pipeline/run-clustering.sh:177`](../pipeline/run-clustering.sh) — *"uses CLUSTERING_RUN_ID as the era anchor. Skip-existing within an era."*
   - (If `CLUSTERING_RUN_ID` is ever unset, `runId` is `NULL`; `MAX()` returns `NULL`; the snapshot falls back to the all-rows branch — the same inflation by a different route.)

Net: `territory_vitality` grows unbounded across runs, and the snapshot has no "latest write per territory" filter, so the page sums duplicates.

## Why it matters

- Territory count, phase counts, and **avg_vitality** (`vSum/vN` over all rows — [`portal-measurement.js:163-166`](../src/portal-measurement.js)) are all computed over the duplicated set. avg_vitality is a mean so it's *less* visibly wrong, but the counts and phase bars are ~52× inflated.
- The same accumulation likely affects anything else that reads `territory_vitality` without deduping (audit before trusting `/vitality/*`).

## Suggested fixes (for the metric-audit session to choose)

- **Snapshot-side (display-layer, lowest risk):** dedupe to the latest row per `territory_id`, e.g. `ROW_NUMBER() OVER (PARTITION BY territory_id ORDER BY computed_at DESC) = 1`, or `GROUP BY territory_id` taking `MAX(computed_at)`. Fixes the page without touching the pipeline or historical data.
- **Writer-side (root fix):** make `compute-vitality.js` upsert (or `DELETE WHERE user_id = ? AND clustering_run_id = ?` before insert) so a re-run within an era replaces rather than appends.
- **Data hygiene:** one-time cleanup of historical duplicate rows in `territory_vitality` (and re-check `territory_cofire`, `complexity_snapshots`, and other per-run append tables for the same pattern).

## Verification after fix

- `SELECT COUNT(DISTINCT territory_id)` vs `COUNT(*)` for the latest era in `territory_vitality` — should converge (~372).
- Curious Life → Vitality shows ~372 territories with a plausible phase split.
