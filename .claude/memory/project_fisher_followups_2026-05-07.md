---
name: Fisher pipeline follow-ups (post-Phase-1)
description: Pre-existing fisher pipeline issues surfaced during Phase 1 PR 1.2 admin smoke (2026-05-07). Sweep-first-design done — 2 of 3 reclassified as NOT bugs after evidence. ONE real fix remains. Design at docs/FISHER-FOLLOWUPS-DESIGN-2026-05-07.md. NOT Phase 1 blockers.
type: project
originSessionId: 7829d406-4f6e-460f-9bb4-5d4289f7de73
---
Surfaced during Phase 1 PR 1.2 admin smoke + pipeline-health audit on 2026-05-07.

**Why:** User asked to ensure full fisher pipeline is healthy while Phase 1 ships. Audit found three pre-existing issues that are NOT Phase 1 introductions and NOT Phase 1 blockers.

**Design doc:** `docs/FISHER-FOLLOWUPS-DESIGN-2026-05-07.md` — sweep-first-design protocol applied. 3 parallel Explore sweeps + 1 live D1 verification. 5 pivots from v1 framing. 16-row verification table.

**Reclassification after sweep:**
- Follow-up #1 (era-format MAX bug): REAL. Single-PR fix described below. ~30 LOC bundled.
- Follow-up #2 (NULL pipeline_state.cluster): NOT A BUG. cluster.py has zero pipeline_state references; pipeline-health.js is the sole writer; manual `nohup` invocations bypass it; era.js fallback (era.js:58-62) self-heals via `MAX(territory_profiles.updated_at WHERE dissolved_at IS NULL)`. Documentation comment in pipeline-health.js cluster stage only.
- Follow-up #3 (fisher-cleanup not GC-ing): NOT A BUG. Verified via D1 query — 2026-05-04 cleanup recorded `before=5, after=2, purged=3`, query worked correctly. `fisher-20260428T10` survives because at May 4 cleanup time it was the second-most-recent era (top-2 by MAX(computed_at)). Cleanup runs WEEKLY, next tick 2026-05-11 will purge it. Documentation comment in pipeline-health.js fisher-cleanup stage only.

**How to apply:**
1. **Era-format MAX bug (the one real fix)** — `MAX(clustering_run_id)` on fisher_trajectory is lex-ordered, but two formats coexist:
   - `era-${ISO timestamp}` (canonical, from packages/metrics/era.js:55)
   - `fisher-YYYYMMDDTHH` (legacy fallback in compute-fisher.py:638-639 when CLUSTERING_RUN_ID env absent)
   
   ASCII 'f' (102) > 'e' (101), so any `fisher-...` era beats all `era-...` eras in MAX, regardless of which is chronologically newer. Consumers (db-d1/fisher.js:64-69, portal-trajectory.js:108-113) read `MAX(clustering_run_id)` to find the "latest" era — they get stale data from any surviving legacy `fisher-...` row.
   
   **Admin state 2026-05-07:** `fisher-20260428T10` (7839 rows, ~9 days old) was MAX before my PR 1.2 smoke run. Smoke run created `fisher-20260507T07` (today's date wins lex), temporarily restoring correct chronology — but only by coincidence.
   
   **Fix per design doc (single bundled PR, ~30 LOC, no migration):**
   - `scripts/compute-fisher.py:703-706` — rename fallback to produce `era-${datetime.now(UTC).isoformat()}` (exact format-match with era.js:55) plus stderr warning. This way ALL era-ids share `era-${digit-first}` shape, MAX aligns with chrono.
   - `scripts/tests/test_compute_fisher.py:114-116` — update `test_default_format` to assert `era-` prefix + ISO datetime regex.
   - `packages/server/routes/portal-trajectory.js:107-108` and `packages/core/db-d1/fisher.js:21-22` — fix stale comments (currently document the OPPOSITE of reality, claiming `fisher-YYYYMMDDTHH` is canonical).
   - `scripts/pipeline-health.js` cluster stage + fisher-cleanup stage — add comment blocks explaining #2 + #3 as expected behavior.
   - **NO one-shot DELETE.** Smoke run's `fisher-20260507T07` rows hold valid R_recent data needed by PR 1.3 consumers; natural fisher-cleanup tick on 2026-05-11 evicts legacy rows once enough canonical eras accumulate.

**Order of operations:**
- Ship as a single PR after Phase 1 PR 1.3 + 1.4 land (no overlap with fleet recompute).
- After 2026-05-11 fisher-cleanup tick: verify zero `fisher-%` rows remain on admin (falsifiable per design doc § "Decision criteria").
- Pre-existing `era-bootstrap-YYYYMMDD` lex bug (era.js:69 — `b` > digit) NOT in scope; affects only fresh-provision cold-starts. Track separately.
