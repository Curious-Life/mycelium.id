# Cognitive-Measurement Audit — Built Metrics vs. Collected Literature

**Date:** 2026-06-19
**Method:** 8 parallel adversarial auditors, one per method family, each cross-referencing the as-built pipeline (`/Users/altus/Documents/GitHub/mycelium.id`) against the collected research corpus (`Curious-Life/research-agent`, Ada), anchored on the unified spec `research/mycelium-cognitive-measurement-unified-2026-06-04.md`. Plus one live probe against the real vault via the Mycelium MCP.
**Scope:** information-geometry/Fisher · information-harmonics · cross-scale-coupling · criticality · coherence+frequency · embedding-anchor (Tier-1) · topology/graph+clustering · behavioral-temporal + the presentation/honesty layer.

---

## Headline verdict

The **estimators are faithful and the honesty *scaffolding* is real, but the honesty *enforcement* is advisory, several spec-mandated mitigations are dead code, and the clustering substrate underneath everything rests on an unvalidated k.**

- **Math faithfulness is genuinely high.** The Fisher-Rao geodesic is a real Bhattacharyya/Hellinger distance (not a Euclidean shortcut — the single most important check, and it passes); harmonic amplitude is true OLS-on-Fourier-basis (Tsipidi), *better* than the spec's own "FFT" shorthand; the H0-Wasserstein is bit-exact vs `persim` at 67× speed; PAC/PLV/coherence are textbook Tort/PLV/Welch; gzip compression is correctly fed **plaintext, not ciphertext** (the graveyarded ~0.70 constant cannot recur); the Bedi-2015 psychosis overclaim is refused in code.
- **The honesty layer is the project's signature strength — and its biggest latent risk.** CVP fails closed to `pending` and never fabricates a pass; Tier-1 anchors carry `cvp_status='pending'` + `low_confidence=1`; the 32.9%-not-89% criticality caveat is *in the code*. **But** the enforcement guard (`assertNotSurfacedUnlessValidated`) has **zero callers** — must-not-say is prose the agent must voluntarily obey, and the only thing currently preventing diagnostic narration of the Tier-1 affect/insight anchors is that they were *never given a read surface*, not the gate built for exactly this.
- **Three spec-mandated mitigations are defined but never wired:** wavelet decomposition (`haar_decompose`), the Fiedler `graph_spectral_gap`, and Fisher's `velocity_spectrum`. The spec's own recommended defenses against non-stationarity and fragmentation are dead code that docstrings advertise as live.
- **The substrate is an assumption.** Re-clustering's k=2 realm-collapse is real and was patched — but by swapping a biased silhouette selector for an arbitrary `√n` constant. Realm/theme/territory counts are now *assumed*, with no DBCV/ARI validity or stability check. Every metric sits on this.

**No metric is dangerously broken-and-shipping.** The exposure is bounded today by *omission* (many spec metrics are honest NULL stubs or have no read surface). The risk is the day a reader gets wired without the gate.

---

## What is genuinely solid (credit where due)

| Area | Why it's strong | Evidence |
|---|---|---|
| Fisher-Rao geometry | Real `2·arccos(Σ√(pᵢqᵢ))` geodesic on the simplex; geodesic-consistent top-contributor decomposition | `pipeline/fisher.py:77-113,151-193` |
| Null-model z (Fisher) | Genuine pooled-multinomial resampling test; sha256-seed + ±Z_MAX clamp fixes are real & earned | `pipeline/fisher.py:205-247`, `compute-fisher.py:172-182` |
| Harmonic regression | True OLS-on-Fourier-basis via `lstsq`, not FFT — more rigorous than spec shorthand | `pipeline/harmonics.py:87-104` |
| H0 persistence + Wasserstein | Textbook H0-VR; exact vectorized 1-Wasserstein, bit-verified vs `persim` ~5e-11 @ 67× | `pipeline/harmonics.py:207-258`, `compute-cross-scale-coupling.py:206-252` |
| gzip compression | Fed **plaintext** (decrypt-or-skip); ciphertext can't reach gzip; the ~0.70 trap is structurally excluded | `compute-frequency.py:97-108,278-281` |
| Bedi overclaim guard | `low_confidence` hard-forced; `notes` refuses clinical framing; "max coherence ≠ good" corrected | `compute-coherence.py:74-78,119` |
| Keyword elimination | Anchors genuinely replace word-lists/regex (zero residual); affect proxy matches §3.2.4 exactly; Garten-DDR-grounded | `pipeline/compute-anchors.py`, `anchors/definitions.py` |
| CVP harness | Fails closed to `pending`; all 3 criteria correct; never fabricates a pass | `src/metrics/cvp.js:129-195` |
| Criticality honesty | 32.9%/Smit cited *in code*; 89% only cited as "NOT replicated"; direction-blindness recorded; ML detector is an honest `None` stub | `compute-criticality.py:77-80,300,321` |

---

## Systemic findings (the cross-cutting patterns — highest value)

### S1 — Honesty enforcement is advisory, not wired *(HIGH, systemic)*
`validatePresentation` / `assertNotSurfacedUnlessValidated` (`src/metrics/cvp.js:223,253`) have **zero callers** across `src/` and `packages/`. The tool formatters (`src/tools/metrics.js:133-228`) and REST routes (`src/portal-measurement.js:75-122`) emit raw decrypted numbers with prose-only hedging. **Live-confirmed:** `cognitiveState` returned `gamma 0.0448`, `autocorr_lag1 0.341`, `H0 entropy 3.020`, `velocity z 7.63σ` — each *with* an honest hedge bundled in, but nothing forces the agent to honor it, and the gate built to stop this never fires. Safety rests on "no reader exists" for the Tier-1 affect/insight anchors, not on the chokepoint.
→ **Fix:** route every metric read through `assertNotSurfacedUnlessValidated` at the db/tool boundary so the throw is structural; add a guard test that no consumer queries the anchor table outside the gate.

### S2 — Spec-mandated mitigations are dead code *(HIGH, systemic)*
The spec's own recommended defenses are defined but never called:
- **Wavelet** (`haar_decompose`, `harmonics.py:381-403`) — §1.5/§4.23/§4.24 make wavelet the *default over FFT* for non-stationarity. Zero callers. Harmonic + cross-scale signals reach Hilbert/regression raw.
- **`graph_spectral_gap`/Fiedler** (`graph_metrics.py:18-41`) — correct eigensolver, **zero callers**; docstring claims it is "consumed." Metric is not computed or stored.
- **Fisher `velocity_spectrum`/`dominant_period`** (`fisher.py:263-294`) — advertised in the module docstring, never wired.
→ **Fix:** wire them, or downgrade the docstrings/spec from "mitigated/consumed" to "not implemented" so nothing over-promises.

### S3 — Low-N statistical bias is unguarded *(HIGH, cross-scale family)*
PLV has **no N-floor** beyond `MIN_COUPLE_N=8` (`compute-cross-scale-coupling.py:107`). PLV's expected value under *zero* coupling is ≈ √(π/4N) ≈ **0.49 at N=8** — and the slow bands (theta/delta, monthly bins) routinely hit exactly that floor, so the most-biased estimates are written for the *most user-salient* "your month-scale rhythms are coupled" claims. Welch coherence shares the same few-segment upward-to-1 bias. Demeaning before Hilbert is also missing (cosine-distance signals have a large DC offset). AR(1) likewise runs on as few as 3 points.
→ **Fix:** hard N-floor (dozens of quasi-independent samples) or surrogate/permutation debiasing; store effective-N per row; demean before Hilbert.
→ **RESOLVED 2026-06-19** (`compute-cross-scale-coupling.py` + `harmonics.py` + migration `0027_coupling_effective_n.sql`): (a) raw-N floor raised 8 → `MIN_COUPLE_N=24`, gated on the min of the two bands' *native* lengths before interpolation, NULL below it; PAC additionally needs `PAC_MIN_N=36`. (b) PLV is now stored surrogate-debiased — `phase_locking_value_debiased` estimates the chance null with circular-shift surrogates (the smooth/interpolated bands violate the i.i.d. √(π/4N) assumption) and stores the excess over chance. (c) `_safe_hilbert` demeans before the Hilbert transform (kills the cosine-distance DC pedestal). (d) Welch coherence requires `MIN_WELCH_SEGMENTS=5` segments (`_welch_params` sizes `nperseg≈n//4`) else NULL. (e) raw co-occurring N is stored **plaintext** per pair (`couple_eff_n_*`) for read-layer suppression. Gate `verify:cross-scale-coupling` H7–H9 added (GO; live ledger: a delta window estimated γβ=144 / βα=30 while αθ=5 / θδ=1 were suppressed to NULL). *Read-layer suppression using `couple_eff_n_*` is wired-ready but not yet consumed — that joins the S1/S6 honesty-gate work.*

### S4 — Null models are Fisher-only *(HIGH vs §2.5)*
§2.5 mandates a null-model companion for *every* family. Only Fisher (and criticality's *temporal-baseline* z, which is not a true shuffle null) has one. Behavioral entropy is the worst case: "low interval-entropy = routine" cannot be distinguished from a random Poisson process without a shuffle baseline. `grep null_model|shuffle|surrogate` matches only fisher/cluster/criticality.
→ **Fix:** behavioral is the cheapest place to add it (shuffle hour-of-day / Poisson-resample intervals → z). Extend family by family.

### S5 — The clustering substrate's k is unvalidated *(MED-HIGH, foundation)*
The k=2 collapse (silhouette argmax on anisotropic cosine vectors, mean pair-cosine ~0.58 → one realm 78% share) is **real and confirmed** by the code's own comments (`cluster.py:118-123`) and **fixed** — but by a fixed `√n` target (`0.05·√n` ≈ 13 realms), tuned to "match the recovered active count." Realm/theme/territory counts are now *assumptions presented as measurements*; no DBCV, no bootstrap-ARI stability, no Hopkins. Ward HAC also runs on L2-renormalized cosine centroids fed a Euclidean variance objective (uncontrolled spherical-Ward approximation; not what the research's own Ward step does). The research corpus is itself self-contradictory (Feb: keep HDBSCAN; Apr: drop it for Leiden) and the code matches *neither*.
→ **Fix:** keep the `√n` fix (it's correct for the collapse) but stop presenting counts as discovered; add DBCV + bootstrap-ARI as *diagnostics* (store, surface low-confidence when max-share > 0.5 or ARI < 0.6); write a decision log reconciling the k-means+Ward choice against both research docs.

### S6 — Honest caveats live only in the presentation layer, not on the data row *(MED, cross-cutting)*
Bedi/Biemann clinical-extrapolation caveats and the 32.9% sensitivity note live in `contracts.js`/`notes`/`event_emit`, not joined to the metric row. Any future DB/MCP-direct consumer that bypasses the JS layer gets clinically-loaded numbers with no caveat attached. The criticality `headline` strings (the de-facto user-facing artifact) ship without the sensitivity caveat.
→ **Fix:** carry rigor/caveat onto the row (or couple headline+caveat) so it travels with the number.

---

## Per-family verdict

| Family | Estimator | Inputs / wiring | Honesty | Top severity |
|---|---|---|---|---|
| Information geometry / Fisher | FAITHFUL | OK | strong; phantom enum (live) | HIGH — no proxy/frequency-confound guard, no CVP |
| Information harmonics | FAITHFUL (OLS>FFT) | DRIFT — fabricated uniform time grid; wavelet unwired | strong | MED |
| Cross-scale coupling | FAITHFUL | **low-N GUARDED (S3 resolved 2026-06-19)** — N-floor 24, surrogate-debiased PLV, demean-before-Hilbert, segment-gated coherence, plaintext eff-N; wavelet still dead (S2) | strong | MED (was HIGH/S3); wavelet S2 |
| Criticality | FAITHFUL | DRIFT — 90d baseline cap unused; "rising variance" is `var>0` | exemplary (in-code) | MED; + spec's circular "May 5 confirmed" |
| Coherence + frequency | FAITHFUL | DRIFT — gzip labeled as LZ76 (§4.18 wants textbook LZ76) | strong (coherence); gap (frequency has no `notes`) | MED |
| Embedding-anchor (Tier-1) | FAITHFUL | latent — gate defined, unwired; no reader today | strong | MED (defense-in-depth) |
| Topology / graph + clustering | mixed | **BROKEN wiring** — Fiedler & `anchor_band_concentration` unbuilt; cofire 4.15-4.17 stubs; UTC window bias | OK | HIGH (S5) + HIGH (unbuilt-but-advertised) |
| Behavioral-temporal | FAITHFUL | OK (honestly Tier-0) | honest but unsurfaced | HIGH — no null model (S4) |

---

## Live-probe findings (real vault, via MCP `cognitiveState`)

1. **Phantom phase enum `indeterminate`** *(MED, live-caught)* — header shows `Phase: cycling` at all 3 levels, but milestones say "moved from cycling into **indeterminate**". `indeterminate` is in *neither* the spec enum (`cycling|exploring|consolidating|breakthrough`) nor the as-built code enum (`stable|cycling|exploring|transforming`). A third value is leaking from the milestone path. → trace `compute-fisher.py` milestone generation.
2. **Duplicate / contradictory milestones** *(MED, live-caught)* — "5 active milestones" contains 3 identical `phase_shift cycling→indeterminate` and 2 identical `sustained_cycling`, all dated 2026-06-18, and the phase_shift directly contradicts the current `cycling` phase. → milestone dedup + current-phase consistency.
3. **Hedges *do* travel at this surface** *(confirms partial-mitigation)* — the band-not-Hz note, the `low_confidence: raw values only` line, and the flow-shape clinical caveat all appeared bundled with the numbers. So S1 is "advisory but present," not "absent" — for the harmonic family. The Tier-1 anchors remain unsurfaced.

---

## Recommended next steps (priority order)

1. **Wire the gate (S1).** Make `assertNotSurfacedUnlessValidated` a real chokepoint at the db/tool boundary + a guard test. Highest leverage; converts the honesty story from documentation to enforcement.
2. **Fix the live milestone bug.** Phantom `indeterminate` + duplicate/contradictory milestones are user-visible *today*.
3. **Guard low-N coupling (S3).** N-floor + demean + surrogate debiasing, or suppress slow-band PLV/coherence entirely until calibrated.
4. **Add behavioral null model (S4)** and extend §2.5 family by family.
5. **Make clustering k honest (S5).** Store DBCV + bootstrap-ARI; surface low-confidence on degenerate partitions; write the decision log.
6. **Wire or retire the dead mitigations (S2):** wavelet, Fiedler, velocity_spectrum, `anchor_band_concentration`, cofire 4.15-4.17 — build them or stop advertising them.
7. **Carry caveats onto the row (S6).** Rigor/sensitivity notes should travel with the number, not live only in the JS layer.
8. **Decide on gzip vs LZ76 (§4.18):** re-point to textbook `lz76Complexity` or rename the column `gzip_compression_ratio` and document it as a proxy.

---

*Per-family detailed reports (with full file:line finding lists) available on request — this is the consolidated synthesis.*
