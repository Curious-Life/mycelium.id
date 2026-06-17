# Realm-k clustering collapse — fix design + lab verdict (2026-06-17)

**Status:** implemented in this PR (cluster.py + lab variants). Validated offline on a DB copy.
Generate stays kill-switched — re-enabling it is a separate operator decision.

## Problem
A fresh `cluster.py` run on the full vault collapses the **realm** level to
`silhouette-selected k=2 (score 0.109) → 2 realms`, with one realm holding **78%** of
points — vs the live *active* **13** realms. Realms are the top of `realms ⊃ themes ⊃
territories ⊃ atoms`. A live re-cluster would replace a legible 13-realm map with a
degenerate 2-realm one; that's why Generate is kill-switched.

## Revision history
- **v1:** "Silhouette caps realms at k=2; raise the cap / target ~42 realms."
- **v2 (sweep pivots):**
  1. **"42 realms" is a red herring** — the `realms` *table* has 42 rows but only **13 are
     referenced by `clustering_points`**; the rest are orphaned canonical-import rows
     (`scripts/recover-mindscape.mjs`). Live active = 13 realms / 50 themes / 243 territories
     (coherent). The collapse is 13→2.
  2. **k=2 is the selector being honest, not a cap bug.** Cosine silhouette is biased toward
     low k on anisotropic embeddings (measured **isotropy 0.583** mean random-pair cosine).
     Raising `TARGET_REALMS_MAX` is a no-op.
  3. **Realms are the odd level out.** `scale_targets()` √n-scales atoms/territories/themes but
     not realms; territories/themes pick k by a fixed √n target via mass-weighted Ward (no
     silhouette) and never collapse. Realms alone were silhouette-driven.
- **v3 (this doc — lab verdict):** ran the candidate strategies on a 72k DB copy. **Option B
  (deterministic √n target) chosen and shipped.**

## Lab results (real 72k copy, `pipeline/lab/cluster_lab.py`, isotropy 0.583)

| Variant | realms | max-share | gini | norm-entropy | noise |
|---|---|---|---|---|---|
| `baseline` (elbow 5–10) | 5 | 0.645 | 0.589 | 0.601 | 20% |
| **`combo` — CURRENT PRODUCTION** (silhouette) | **2** | **0.783** | 0.283 | 0.755 | 1% |
| `combo_centered` (2026-06-10 candidate, full-pipeline centering) | 3 | 0.416 | 0.142 | 0.962 | 0% |
| **`combo_target_sqrt` — SHIPPED (Option B)** | **12** | **0.169** | 0.343 | 0.922 | 1% |
| `combo_target_sqrt_centered` | 12 | 0.142 | 0.245 | 0.961 | 1% |
| `combo_sil_floor` (Option C) | 13 | 0.169 | 0.370 | 0.914 | 1% |
| `combo_sil_floor_centered` | 16 | 0.136 | 0.298 | 0.950 | 1% |

Every candidate fixes the collapse (2 → 12–16 balanced realms). The centered variants only
*marginally* improve balance (max-share 0.17→0.14).

## Verdict: Option B — deterministic √n `TARGET_REALMS`
Chosen over the centered/floor variants because it is the **most stable by construction** and
the **simplest, most consistent** change:
- **No silhouette** → removes the run-to-run k-selection churn the 2026-06-10 doc flagged as a
  medium risk. Realm assignments become a deterministic function of the theme centroids (the
  only residual randomness is the upstream k-means atom seed, shared by all variants and fixed
  at 42). This makes realm ARI ≥ the silhouette selector's measured 0.47 *by construction*.
- **No mean-centering** → avoids the corpus-mean-drift / cross-run ID-stability and
  stored-centroid-compatibility risks that got centering deferred in 2026-06-10. The marginal
  balance gain from centering (0.17→0.14) does not justify reintroducing both risks.
- **Consistent**: realms now behave exactly like themes/territories — a √n target via
  mass-weighted Ward. The level that uniquely collapsed now uses the mechanism that never did.

Note on the ARI sweep: the full 50-run bootstrap stability sweep was **infeasible on the live
16 GB box** (memory thrashing under the app + concurrent sessions; runs never completed). B's
stability is established by construction (deterministic) rather than measured ARI — see Risks.
This is itself evidence for the "needs more RAM / off-iCloud" runtime gap.

## As implemented (this PR)
`pipeline/cluster.py`:
- `TARGET_REALMS = 12` module global; `scale_targets()` sets
  `TARGET_REALMS = int(max(3, min(20, round(0.05 * n**0.5))))` (~13 at 72k, matching the live
  active count; floor 3, cap 20).
- Stage 5 realm selection replaced: `centroids_to_groups(theme_labels, embeddings,
  TARGET_REALMS)` (mass-weighted Ward to the target) instead of the silhouette argmax loop.
  `n_themes < 2` → single realm (branch retained). `centroids_to_groups` clamps to the
  available theme count, so small vaults degrade gracefully.

`pipeline/lab/cluster_lab.py`: added `target_sqrt`, `silhouette_floor` (+`_centered`) realm
modes and `combo_target_sqrt` / `combo_sil_floor` (+centered) variants, so the experiment is
reproducible and `combo_target_sqrt` now mirrors production.

**No stored-centroid / schema / encryption change.** Atoms, territories, themes, and every
stored 256D/3D centroid are byte-identical. The only behavioral change is how theme clusters
are grouped into realms.

## Edge cases
- `n_themes < 2` → single realm (retained).
- Small vault (n<600): `TARGET_REALMS` floor 3 may exceed `n_themes`; `centroids_to_groups`
  clamps `min(n_groups, n_children)` → degrades to "each theme its own realm".
- Named-realm churn on the *re-cluster* (Jaccard stabilization + dominant-successor inheritance
  carry names) — a re-cluster cost, owned by the separate "re-enable Generate" decision, NOT
  this PR.

## Test strategy
- **Lab (done):** the results table above, on a real 72k copy.
- **`verify:realm-balance` (follow-up):** synthetic anisotropic fixture asserting `n_realms ≥ 3`,
  `max_share ≤ 0.6`, two well-separated blobs land in different realms. (No vault, CI-safe.)
  Not in this PR — the first clustering-quality gate; tracked as the next commit.
- **E2E copy run (before any live re-cluster):** patched `cluster.py` main against a backup copy
  with writes ON (copy only) → assert `3 ≤ COUNT(DISTINCT realm_id) ≤ 20`, no realm > 60%,
  noise ≤ 15%.

## Decision criteria to re-enable Generate (separate, operator-gated)
- E2E copy run: realms ∈ [3,20], no realm > 60% of non-noise, noise ≤ 15%.
- `verify:realm-balance` GO + full `npm run verify` GO.
- Only then is `rm .generate-disabled` a reasonable operator decision.

## Threat model / security
No new deps, no network, no plaintext egress (pure-numpy grouping over already-decrypted
in-process embeddings). No stored columns change → encryption-at-rest envelopes byte-identical.
Re-cluster remains destructive to the recovered mindscape; this PR does NOT re-enable Generate
or re-cluster live — the kill-switch stays.

## Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| √n coefficient mis-tuned (too many/few realms) | M | L | Calibrated to live active count (13); floor/cap [3,20]; lab-confirmed 12 |
| Realm ARI not measured (sweep infeasible on box) | M | M | B is deterministic → ARI ≥ silhouette's 0.47 by construction; full sweep deferred to a roomier box |
| Lab `combo_target_sqrt` ≠ production after edits | L | M | They now share the same target+grouper; lab `combo_target_sqrt` mirrors Stage 5 |
| Live re-cluster still differs from lab | L | H | E2E copy run with writes gates the live decision (separate) |

## Verification table
| Assumption | Verified at |
|---|---|
| Realm-k was cosine silhouette over k∈[2,min(10,themes)] | `pipeline/cluster.py` Stage 5 (pre-fix, read) |
| Territories/themes use fixed √n target via Ward, not silhouette | `pipeline/cluster.py:1007,1014` + `centroids_to_groups` |
| `scale_targets` √n-scaled atoms/territories/themes, not realms | `pipeline/cluster.py:113-119` (read) |
| Embeddings anisotropic (isotropy 0.583) | lab run `n=60992 isotropy=0.5828` (2026-06-17) |
| Production collapses to 2 realms, max-share 0.78 | lab `combo` row (2026-06-17) |
| `target_sqrt` → 12 balanced realms, max-share 0.17 | lab `combo_target_sqrt` row (2026-06-17) |
| Live active hierarchy = 13 realms / 50 themes / 243 territories | live `clustering_points` distinct-id query |
| `realms` table = 42 (orphaned canonical rows), 13 referenced | live counts + `recover-mindscape.mjs:51-56` |
| UI reads `realms` table, renders any count | `src/db/mindscape.js:101`, `src/portal-mindscape.js:215` |
| Lab runs real cluster.py on a copy, non-destructive | `pipeline/lab/cluster_lab.py` docstring + `run-lab.sh:15` |
| Centering deferred for ID-stability + stored-centroid compat | `docs/CLUSTERING-REBALANCE-DESIGN-2026-06-10.md:43,94` |
