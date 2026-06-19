# DESIGN — Fisher P2 (surface-gate) + P3 (basis-free embedding-trajectory cross-check)

**Status:** LOCKED design, NOT built. Build spec for P2 + P3 of the Fisher faithfulness plan.
**Date:** 2026-06-19
**Parent:** `docs/DESIGN-fisher-faithfulness-2026-06-19.md` (this supersedes its high-level P2/P3 sketch with sweep-verified build detail).
**Skill:** sweep-first-design (4 parallel Explore sweeps + own-eyes verification of the build-critical facts).

---

## Part 0 — Headline

Two phases, independent, both small-to-moderate:

- **P2 — surface-gate movement (consistency, small).** `fisher_trajectory` already has a freshness budget (`freshness.js` METRIC_BUDGETS, 26h), but `db.fisher.getTrajectory` applies **no freshness hedge** — a stale movement card presents numbers as authoritative. Wire the existing freshness hedge into the Fisher read path, exactly as the harmonic readers do.

- **P3 — basis-free embedding-trajectory cross-check (SOTA robustness).** A new Python stage computes, per week per scope, the **centroid angular drift** of message embeddings (768D) + a **dispersion** scalar — a movement signal that does NOT depend on the clustering basis. Displayed beside the Fisher velocity with an **agreement** indicator: agreement ⇒ "real movement"; divergence ⇒ "the clustering redrew the map." Metric resolved at the bounce: centroid angular distance + dispersion, **not Fréchet** (n ≲ d).

**Decision locked by a health-honesty argument:** P3 writes to a **NEW `embedding_trajectory` table** (migration `0031`) with its **own freshness family**, NOT extra columns on `fisher_trajectory`. Reason: `embedding-novelty` already UPDATEs a sibling table (`complexity_snapshots`) and is therefore invisible to `/measurement-health` (that table's freshness tracks `compute-complexity`, not the novelty stage) — a known attribution gap. The whole measurement-health effort exists to make stage failures visible; a new table with its own `METRIC_BUDGET` + `FAMILY_STAGE` entry keeps the cross-check honestly health-tracked.

---

## Part 1 — The metric (P3)

Per **weekly_step** window × scope (realm/theme/territory), over messages whose `clustering_points` row falls in the window:

1. **Centroid** `c_t = normalize(mean(unit embeddings in (window, scope)))`. Embeddings are L2-normalized Nomic v1.5 768D at ingest; the mean of unit vectors is not unit → re-normalize.
2. **Centroid drift velocity** `v_t = arccos(clip(⟨c_{t-1}, c_t⟩, -1, 1))` — angular (geodesic on the sphere). Degrades gracefully at low n; directly interpretable ("your semantic center moved"). NOT a covariance/Fréchet distance (256/768D covariance from ~100–300 weekly messages is n ≲ d, ill-conditioned — bounce Q3).
3. **Dispersion** `s_t = 1 − mean_i ⟨x_i, c_t⟩` — mean cosine-to-centroid, "did the week diversify" (captures what Fréchet would, robustly). Centroid drift is blind to spread; this is the cheap second moment.
4. **Headline = `centroid_drift_baseline_z`** — reuse `src/metrics/baseline-z.js` (trailing-exclusive, degenerate-fail-closed) over the per-scope drift series. Same self-normalization principle as the Fisher and LZ work.
5. **Confidence:** a window with `< N_MIN` (15, the Fisher constant) messages in the scope → `low_confidence`, no drift.

**Agreement with Fisher — RESOLVED (bounce 2026-06-19): a 2×2 quadrant, NOT a symmetric scalar.** A Spearman/sign-agreement collapses the two off-diagonals into "they disagree" and destroys exactly the directionality that makes the cross-check worth building — the two disagreements mean OPPOSITE things. Output a categorical state over (Fisher moved?) × (embedding moved?), both axes baseline-z'd through P0's `baseline-z.js` (`fisher_velocity_baseline_z` × `centroid_drift_baseline_z`), "moved" = `|z| > 2`:

| | embedding flat | embedding moved |
|---|---|---|
| **Fisher moved** | **Basis-suspect** — geometry says you moved, content didn't → discount the Fisher spike. Chip: *"the map may have shifted, not your thinking."* (Fisher false-positive / basis artifact.) | **Corroborated** — basis-dependent + basis-free agree → trust it. Chip: *"real movement."* |
| **Fisher flat** | **Settled** — both calm → trust the calm. | **Hidden drift** — content moved within your territories but the distribution can't see it → Chip: *"movement your topic-map didn't catch."* (Fisher false-negative / intra-territory drift.) |

Rules: **deadzones, not a hard split** — only call basis-suspect / hidden-drift when one z is clearly past its band and the other clearly below, so the chip doesn't flap week to week; the marginal middle is "consistent." **Low-confidence if either side is below its N-floor** (never a basis-suspect chip on a 5-message week). The chip compares **centroid-drift-z ↔ fisher-velocity-z** (both "how much did the center of attention move"); the **dispersion scalar pairs with `activation_entropy`** as a drill-detail spread axis, NOT in the headline chip.

**Spearman is kept but repurposed** — a slow per-user calibration/health signal (do the two velocity series co-move over a long window?), NOT the per-window chip. Near-zero long-run Spearman ⇒ the topic-map may be misconfigured for this user, or their movement is genuinely mostly intra-territory → meta-information for the honesty layer, not a user-facing number.

**P3b scoping:** ship **basis-suspect** first (the load-bearing quadrant — the literal reason the cross-check exists); **hidden-drift** is the immediate fast-follow (free — both z's already exist). Never ship the symmetric Spearman as the per-window primary.

---

## Part 2 — Storage (P3): new `embedding_trajectory` table

Migration **`0031_embedding_trajectory.sql`** (next free index — verified, highest is `0030`). Keyed identically to `fisher_trajectory` so rows align 1:1 for the cross-check:

```sql
CREATE TABLE IF NOT EXISTS embedding_trajectory (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  level TEXT NOT NULL,                 -- 'realm' | 'theme' | 'territory'   (plaintext, structural)
  window_type TEXT NOT NULL,           -- 'weekly_step'                      (plaintext, structural)
  window_start TEXT NOT NULL,          -- plaintext, structural
  window_end TEXT NOT NULL,            -- plaintext, structural
  centroid_drift REAL,                 -- ENCRYPTED — angular drift vs prev window
  centroid_drift_z REAL,              -- ENCRYPTED — baseline-z of the drift (headline)
  dispersion REAL,                     -- ENCRYPTED — mean cosine-to-centroid
  message_count INTEGER NOT NULL,      -- plaintext, structural
  low_confidence INTEGER NOT NULL DEFAULT 0,   -- plaintext flag
  clustering_run_id TEXT NOT NULL,     -- plaintext — MUST equal the fisher_trajectory run_id
  UNIQUE(user_id, level, window_type, window_start, clustering_run_id)
);
```

- **Encryption:** the three derived scalars (`centroid_drift`, `centroid_drift_z`, `dispersion`) are caller-encrypted by the Python stage via `stage_crypto.enc` (the embedding-novelty pattern) and registered in `ENCRYPTED_FIELDS['embedding_trajectory']` in `crypto-local.js` so the JS adapter auto-decrypts. They are derived numbers, NOT raw vectors → they do NOT go in `NEVER_AUTO_DECRYPT_COLUMNS` (that set is only `embedding_768`/`nomic_embedding`/`anchor_vector`). Structural columns stay plaintext.
- **Run alignment:** `clustering_run_id` is resolved by the SAME `make_run_id` rule Fisher uses (`os.environ['CLUSTERING_RUN_ID'] or stage_base.derive_era_id(user_id)`), guaranteeing the cross-check rows key to the same era as `fisher_trajectory`.

---

## Part 3 — The stage (P3): `pipeline/compute-embedding-trajectory.py`

Mirrors `compute-embedding-novelty.py`. Slots at **Step 7b** in `run-clustering.sh` (immediately after Fisher / Step 7 — it needs `clustering_points` territory/realm assigned by Step 2 and aligns to Fisher's run).

1. Resolve `run_id` (Fisher rule) + `now`/history horizon. For each `level ∈ {realm, theme, territory}`, for each `weekly_step` window (`windows_for`):
   - Fetch `(source_id, scope_id, created_at)` for the window from `clustering_points` (`source_type='message'`, `created_at` in [ws, we)); `scope_id` = `territory_id` / `realm_id` / `theme_id` directly off `clustering_points` (all populated by `cluster.py` Step 2 — verified). ~15 lines of new SQL (a 1:1 variant of `extract_activations._build_count_sql`).
   - `fetch_envelopes_chunked` + `decrypt_vectors` (768D float32, reused as-is) → per-scope embedding sets.
   - Per scope: centroid, drift vs previous window's centroid, dispersion. Then `baselineZ`-equivalent over the per-scope drift series (Python port of the JS primitive, or compute drift here and let the read layer compute the baseline-z — see Part 5 decision).
   - `low_confidence` when `message_count < N_MIN`.
   - UPSERT into `embedding_trajectory` (`stage_crypto.enc` on the three scalars).
2. **Health:** wrap with `stage_result.run_main('compute-embedding-trajectory', main)` + `finalize(...)` (fail-loud + records pipeline_state).
3. **Measure-only + kill-switch:** runs in both modes (Steps 4–16 always run); read-only (never calls `cluster.py`) → exempt from the Generate kill-switch, like embedding-novelty.
4. **Cost:** ≤1–2s/vault (earlier feasibility sweep).

**Freshness registration (the health-honesty payoff):** add to `freshness.js`:
- `METRIC_BUDGETS`: `{ table: 'embedding_trajectory', timestamp_column: 'computed_at', budget_ms: 26*HOUR, cadence: '24h', description: 'Basis-free embedding-space movement cross-check.' }`
- `FAMILY_STAGE`: `embedding_trajectory: 'compute-embedding-trajectory'`

So `/measurement-health` can say "cross-check stale BECAUSE compute-embedding-trajectory failed."

---

## Part 4 — Surface-gate movement (P2)

`fisher_trajectory` is in `METRIC_BUDGETS` (26h) but **`db.fisher.getTrajectory` applies no freshness hedge** (verified — `src/db/fisher.js:149-182` returns rows unguarded). The surface-gate's column-family map (`surface-gate.js`) covers only harmonic + anchor families, not Fisher; Fisher's gate is **freshness**, not CVP. So P2 =

- Compute `familyFreshness('fisher_trajectory')` at the movement read boundary (the `/trajectory/summary` + `/trajectory/current` endpoints, or inside `db.fisher`), and attach a `stale`/`fresh` + `reason` hedge to the payload — mirroring how the harmonic readers hedge. When stale, the UI shows the existing "early signal · advisory" envelope instead of presenting the σ as authoritative.
- Apply the same hedge to the new `embedding_trajectory` cross-check read.

Small + mechanical; no schema change.

---

## Part 5 — Display (P3)

- **Endpoint:** new `GET /trajectory/cross-check?level=realm` in `src/portal-measurement.js` — reads `embedding_trajectory` for the run, returns `{ centroid_drift_z, centroid_drift_low_confidence, dispersion, agreement, fisher_velocity_baseline_z }` (computes agreement against the Fisher series already available via `db.fisher`). Cleaner than bloating `/trajectory/summary`.
  - **Decision — where the baseline-z is computed:** compute `centroid_drift` per window in the Python stage (stored), but compute `centroid_drift_z` (baseline-z) in the **read layer** from the stored drift series — same display-layer pattern as P0's `velocity_baseline_z` (reuses `src/metrics/baseline-z.js`, no Python port, keeps the primitive single-sourced). The stored `centroid_drift_z` column is then optional/redundant — **drop it from the schema; store only `centroid_drift` + `dispersion`** and derive the z on read. (Simplifies Part 2: two encrypted scalars, not three.)
- **UI:** in `CuriousLifeView.svelte` movement detail, after the P0 stat-row, add a cross-check row: `centroid drift (σ)` + an **agreement chip** ("tracks Fisher" / "diverges — map may have shifted"). Insertion point verified: the `stat-row` block in the `active === 'movement'` panel.

---

## Part 6 — Verification table (load-bearing assumptions)

| Assumption | Verified at |
|---|---|
| Next migration index is `0031` | `migrations/` listing — own-eyes (highest `0030_territory_river_cache`) |
| embedding-novelty has NO own freshness family → UPDATE-sibling hides stage health | `src/metrics/freshness.js:28,40` — own-eyes (only `complexity_snapshots:'compute-complexity'`) → justifies a NEW table |
| `fisher_trajectory` keyed `UNIQUE(user_id, level, window_type, window_start, clustering_run_id)` | `migrations/0001_init.sql:1168-1190` (sweep, quoted) |
| Derived scalars register in `ENCRYPTED_FIELDS[table]`, not `NEVER_AUTO_DECRYPT` | `crypto-local.js:621,1791-1829` (sweep, quoted) |
| `clustering_points` carries `created_at`+`territory_id`+`realm_id`+`theme_id`+`source_id`, populated by `cluster.py` Step 2 | `migrations/0001_init.sql:12-22` + `cluster.py:1378-1387` (sweep, quoted) |
| `fetch_envelopes_chunked`+`decrypt_vectors` reusable, 768D float32 | `compute_information_harmonics.py:404-446` (sweep, quoted) |
| `windows_for('weekly_step')` reusable | `compute-fisher.py:194-231` (sweep, quoted) |
| Stage runs in measure-only + is kill-switch exempt (read-only) | `run-clustering.sh:116-159` + `src/jobs.js:32-79` (sweep, quoted) |
| `run_id` via `CLUSTERING_RUN_ID or derive_era_id` aligns to Fisher era | `compute-fisher.py:740-749` + `stage_base.py:56-92` (sweep, quoted) |
| Fisher reads apply NO freshness hedge (P2 slot) | `src/db/fisher.js:149-182` — own-eyes (no `familyFreshness` call) |
| Fisher family present in `METRIC_BUDGETS` (26h) | `src/metrics/freshness.js:24-25` (sweep, quoted) |
| Movement display insertion point = movement-detail `stat-row` | `CuriousLifeView.svelte` `active==='movement'` panel — own-eyes (P0 edit) |

---

## Part 7 — Threat model / security

- The stage reads `messages.embedding_768` (semantic fingerprints, CLAUDE.md §7) — Python only, via the existing decrypt path; **no raw vector leaves Python**, none logged.
- Outputs are derived scalars (`centroid_drift`, `dispersion`) caller-encrypted via `stage_crypto.enc` + registered in `ENCRYPTED_FIELDS['embedding_trajectory']`; structural columns plaintext. No new plaintext surface, no new boundary.
- P2 touches already-decrypted Fisher metrics; adds only a freshness hedge.

---

## Part 8 — Test strategy

- **`verify:embedding-trajectory`** (mirror `verify:embedding-novelty`): seeded vault → stage exits 0; `embedding_trajectory` rows written; `centroid_drift`/`dispersion` columns are envelopes at rest + the JS adapter decrypts; centroid drift deterministic on a fixed embedding fixture; `low_confidence` set for `< N_MIN` windows; run_id equals the Fisher run_id.
- **`verify:embedding-trajectory-encryption`** — columns ciphertext at rest, structural plaintext (the fisher-encryption gate is the template).
- **`verify:fisher-display`** extend (P2): `/trajectory/summary` payload carries a freshness hedge; stale → advisory envelope, not an authoritative σ.
- **Cross-check agreement** test: on a fixture where Fisher and embedding velocities agree, `agreement=true`; on a divergent fixture (basis shifted), `agreement=false`.

---

## Part 9 — Implementation order

1. **P2** (freshness hedge on Fisher reads) — small, independent, ship first.
2. **P3a** — migration `0031` + `compute-embedding-trajectory.py` (stage + health + run alignment) + `ENCRYPTED_FIELDS` + `FAMILY_STAGE`/`METRIC_BUDGETS` registration + `verify:embedding-trajectory` (+ encryption gate). Live-verify the stage on the real vault (measure-only run).
3. **P3b** — `/trajectory/cross-check` endpoint (baseline-z on read) + `CuriousLifeView.svelte` cross-check row + agreement chip + gate extension.

Each step independently shippable + gated.

## Part 10 — Open questions

**RESOLVED (bounce 2026-06-19):** the agreement definition is the 2×2 quadrant in Part 1, not a symmetric scalar. No further bounce needed unless the quadrant model surfaces something during implementation.
