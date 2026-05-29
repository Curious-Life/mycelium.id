# PR0.2 — Harmonics primitive extensions — Design Doc

**Date:** 2026-05-07
**Companions:**
- [docs/architecture/COGNITIVE-METRICS-SPEC.md](architecture/COGNITIVE-METRICS-SPEC.md) §4.23 + §4.24 + §4.33 + §4.34 — the 4 information-harmonics metrics PR0.2 enables.
- [docs/MEASUREMENT-PLANE-PR0.1-DESIGN-2026-05-07.md](MEASUREMENT-PLANE-PR0.1-DESIGN-2026-05-07.md) — predecessor PR0.1 design (stage-base extraction; locks "harmonics ships as Python" at line 21).
- [docs/COGNITIVE-METRICS-SPEC-HANDOFF-2026-05-07.md](COGNITIVE-METRICS-SPEC-HANDOFF-2026-05-07.md) — Phase 6 handoff (PR0.2 = step 4 of pickup protocol).
- [scripts/requirements.txt](../scripts/requirements.txt) — pinned-deps file with the load-bearing line-9 warning ("DO NOT use >=").

**Audience:** the next session implementing PR0.2 (or pressure-testing this design before implementation).

---

## 0. Revision history

- **v1 (2026-05-07 night, post-PR0.1 ship):** Initial design after 5 parallel Explore sweeps + 4 PyPI pressure-test fetches. Three pivots from the sweep sketches — none from the handoff:

  - **Pivot A — Sweep D recommended `gudhi` for §4.34 TDA. PyPI inventory contradicts.** Sweep D claimed "gudhi 3.12.0 has ARM64 + Python 3.12 wheels" — actually PyPI shows ONLY `gudhi-3.12.0-cp312-cp312-macosx_14_0_universal2.whl` + `manylinux_2_27_x86_64` + `win_amd64`. **NO Linux ARM64 (`manylinux_aarch64`) wheel** at any of the last 3 releases (3.10.1, 3.11.0, 3.12.0). Customer fleet is Linux ARM64 (Hetzner cax11 per `scripts/requirements.txt:1`). Source-build would require CGAL + Boost dev libs via apt (heavy + customer-fleet-hostile). **Pivoted §4.34 to ship H0-persistence-entropy via `scipy.cluster.hierarchy.linkage(method='single')`** — mathematically exact for H0 (single-linkage merge heights = VR-H0 lifetimes), zero new deps. H1 (cycles, Wasserstein narrative-shift detection) DEFERRED to a follow-on PR pending ARM64 TDA-wheel landscape change OR operator decision to accept ripser+`--no-deps` install discipline.

  - **Pivot B — Sweep C cited "mne-connectivity requires scipy ≥1.13" as the disqualifier for PAC.** PyPI metadata pressure-test contradicts: actual requirement is `scipy>=1.4.0`. The DISQUALIFIER is different and stronger: mne-connectivity pulls `mne>=1.6` + `pandas>=1.3.2` + `xarray>=2023.11.0` + `netCDF4>=1.6.5` + `tqdm` — all heavy transitive deps that would blow the 4GB Hetzner RAM budget on import-time alone. **Recommendation kept** (manual Tort-2010 PAC, ~20 LOC numpy + `scipy.signal.hilbert`), but the rationale is corrected from "version constraint" to "dep-weight constraint."

  - **Pivot C — Sweep B's case for PyWavelets verified, but the Haar-vs-DIY decision is genuine.** Sweep B confirmed scipy 1.12 deprecated all wavelet functions (verified — `signal.{daub,qmf,cascade,morlet,morlet2,ricker,cwt}` all gone) AND that PyWavelets has clean ARM64+py312+numpy<3,>=1.25 wheels. **Decision: add PyWavelets** (single new dep, single transitive on numpy already pinned, ARM64+py312 verified, cleanly extensible to Daubechies if future research wants it). Manual Haar (~20 LOC dyadic averaging) was the alternative — rejected because the spec's "WaveletGPT 2024" reference suggests future research may want richer wavelets, and the dep is genuinely clean.

- **Sweeps + pressure-test reads (2026-05-07 night):**
  - Sweep A — Tsipidi harmonic regression coverage (no new dep needed; `scipy.linalg.lstsq` + manual Fourier basis sufficient).
  - Sweep B — signal-processing libs (scipy.signal.hilbert/welch/csd/coherence sufficient; scipy 1.12 wavelet-deprecation verified; PyWavelets recommended).
  - Sweep C — PAC+PLV+AR(1) library choice (manual numpy/scipy recommended; mne/tensorpac/statsmodels rejected).
  - Sweep D — TDA library (PIVOT — see Pivot A above).
  - Sweep E — module placement + cross-language fixture decision (mirror PR0.1 layout: `scripts/harmonics.py` flat alongside `scripts/{stage_base,era_skip,event_emit,fisher}.py`; SKIP cross-language fixture per Python-only family commitment).
  - **Sweep F — Tsipidi 2025 method verification (post-design pressure-test).** Found the actual paper: Tsipidi et al. ACL 2025, "The Harmonic Structure of Information Contours" (arXiv 2506.03902). VERIFIED: the formulation is exactly `f(t) = β₀ + Σₖ (β₁,ₖ·sin(k·2πt/T) + β₂,ₖ·cos(k·2πt/T))` with `A_k = √(β₁,ₖ² + β₂,ₖ²)` — matches my primitive signature byte-for-byte. **The L₁ regularization mentioned in Tsipidi's Appendix D is POST-OLS feature selection** (deciding which harmonics are statistically significant), not regularized OLS — the amplitude formula is unchanged. **Caller-side concern, not primitive signature change.** Sweep F ALSO surfaced two spec-level citation drifts (§4.23 cites SpecDetect as validating FFT-on-embedding-distance — actually SpecDetect operates on token log-probs, NOT embeddings; and "Biemann 2024" attribution appears to be Palominos et al. 2024 Schizophrenia — which validates embedding-distance-as-signal but via time-domain features, not harmonics). These are pre-existing spec issues flagged for operator in §16; not PR0.2 implementation blockers.
  - PyPI fetches: PyWavelets 1.9.0, ripser 0.6.14, gudhi 3.10.1/3.11.0/3.12.0, mne-connectivity 0.8.1, persim 0.3.8, giotto-tda 0.6.2.
  - Direct reads: `packages/metrics/primitives.js` (264 LOC), `packages/metrics/test/primitives_xlang.test.js`, `scripts/tests/generate_primitives_fixture.py`, `scripts/requirements.txt` (33 LOC), `scripts/fisher.py:264-266` (existing FFT precedent), `docs/MEASUREMENT-PLANE-PR0.1-DESIGN-2026-05-07.md:21` (Python-only commitment).
  - Local probe: `scipy.cluster.hierarchy.linkage` + `scipy.spatial.distance.pdist` returns N-1 H0 lifetimes for N points — verified working in pure scipy at the pinned 1.12.0.
  - Web fetches (Sweep F): arXiv 2506.03902 (Tsipidi 2025), arXiv 2508.11343 (SpecDetect — confirmed token-log-prob signal), Palominos et al. 2024 Schizophrenia paper.

---

## 1. Purpose + scope

### What this PR ships

A single new module `scripts/harmonics.py` containing the 10 mathematical primitives the information-harmonics family needs, plus a comprehensive unit-test suite at `scripts/tests/test_harmonics.py`. Plus one new pinned dependency in `scripts/requirements.txt` (`PyWavelets==1.9.0`).

**Primitives (Python, in `scripts/harmonics.py`):**

| § | Function | Implementation | Net new dep |
|---|---|---|---|
| §4.23 | `harmonic_regression(signal, t, K, period=None)` → `dict[int, float]` | `scipy.linalg.lstsq` + manual Fourier basis | none |
| §4.24 | `hilbert_phase(signal)` → `ndarray` | `scipy.signal.hilbert` wrapper | none |
| §4.24 | `hilbert_amplitude(signal)` → `ndarray` | `scipy.signal.hilbert` wrapper | none |
| §4.24 | `pac_tort_2010(low, high, n_bins=18)` → `float` | manual numpy + Hilbert (Tort 2010 modulation index) | none |
| §4.24 | `phase_locking_value(low, high)` → `float` | manual numpy + Hilbert | none |
| §4.24 | `spectral_coherence(x, y, fs, nperseg)` → `(ndarray, ndarray)` | `scipy.signal.coherence` wrapper | none |
| §4.24 | `haar_decompose(signal, levels)` → `list[ndarray]` | `pywt.wavedec(signal, 'haar', level=levels)` wrapper | **PyWavelets** |
| §4.33 | `mean_crossing_rate(signal)` → `float` | manual numpy | none |
| §4.33 | `slope_sign_change_rate(signal)` → `float` | manual numpy | none |
| §4.33 | `autocorrelation_lag1(signal)` → `float` | `np.corrcoef(s[:-1], s[1:])[0,1]` | none |
| §4.33 | `total_spectral_energy(signal)` → `float` | `np.sum(np.abs(np.fft.rfft(signal))**2)` | none |
| §4.34 (H0 only) | `persistence_entropy_h0(points)` → `float` | `scipy.cluster.hierarchy.linkage(pdist(points), 'single')` + manual entropy | none |

Total: **12 primitives**, ~250-350 LOC, **1 new pinned dep** (PyWavelets==1.9.0).

**Tests (Python, in `scripts/tests/test_harmonics.py`):**

Mirrors PR0.1 layout (`test_stage_base.py`, `test_era_skip.py`, `test_event_emit.py`). Pure Python unit tests via pytest (already in `requirements-dev.txt`). Per-primitive: range checks, edge cases (empty, single, NaN, constant, short), known-input/known-output cases (e.g., PLV on identical-phase signals = 1.0; on independent signals ≈ 0; harmonic_regression on a pure cosine recovers β₁=A,β₂=0).

### What this PR does NOT ship

- **JS counterparts.** Per spec + PR0.1 design (line 21 quote): "harmonics ships as Python ... PR0.1 therefore prioritizes Python-side extraction; JS gets smaller treatment (just the orchestrator-side stage template)." No JS primitives, no cross-language fixture for harmonics. (The existing `packages/metrics/primitives.js` + `primitives_xlang.test.js` for entropy/cosine/L2/Gini are unaffected.)

- **TDA H1 (cycles + Wasserstein).** §4.34's open question (handoff D4) — deferred. PR0.2 ships H0-persistence-entropy only. H1 requires either (a) `gudhi` source-build with CGAL/Boost (customer-fleet-hostile) or (b) `ripser` with `--no-deps` install discipline (still safe-ish but adds operational burden). Decision deferred to operator post-PR1 ship.

- **The actual `compute-information-harmonics.py` stage script.** That is PR1. PR0.2 only ships the primitives PR1 will compose; it does not create the family stage, the `cognitive_metrics_harmonic` table, the pipeline-health.js entry, or the era-mode integration. Per `/sweep-first-design` discipline, that's a separate design (which uses PR0.1's `eraAwareCheck` + `runEraStage` factories + the PR0.2 primitives).

- **non-English-validation milestone.** §4.23 spec line 482 mandates a non-English-language `low_confidence` flag before §4.23/4.24/4.33/4.34 ship for non-English windows. That's PR1+ scope (presentation-contract concern, not primitive concern).

- **Embedding decryption helpers.** §4.23 spec line 473 says the family stage decrypts vector envelopes per the existing mind-search d1-loader.js path. That's PR1 wiring, not a primitive.

- **256D truncation.** §4.23 spec line 472: "harmonics has no need for the truncation step (cosine-distance on 768D is mathematically as valid)." Primitives operate on whatever vector dimension the caller passes — they're dimension-agnostic.

---

## 2. Module shape

### `scripts/harmonics.py` — full signatures

```python
"""Mathematical primitives for the information-harmonics metric family.

Single-source for §4.23 / §4.24 / §4.33 / §4.34 of COGNITIVE-METRICS-SPEC.md.
Pure functions: every primitive takes numpy arrays and returns a scalar or
numpy array. No I/O, no D1, no env reads. Composable into the
compute-information-harmonics.py stage (PR1) and unit-testable in isolation.

Why Python-only: per PR0.1 design line 21, the harmonics family ships as
Python (compute-fisher.py precedent + scipy maturity for harmonics math +
gudhi being Python-only when TDA H1 lands). No JS counterpart is planned;
no cross-language fixture pattern.

Dependencies: numpy, scipy (already pinned in requirements.txt). NEW dep:
PyWavelets 1.9.0 (Haar wavelet decomposition for §4.24 non-stationarity
mitigation; clean ARM64+py312 wheel verified).

Spec: docs/architecture/COGNITIVE-METRICS-SPEC.md §4.23/4.24/4.33/4.34.
Sibling: scripts/{stage_base,era_skip,event_emit,fisher}.py.
"""

import numpy as np
from scipy.linalg import lstsq
from scipy.signal import hilbert, coherence
from scipy.spatial.distance import pdist
from scipy.cluster.hierarchy import linkage
import pywt

# ── §4.23 — Tsipidi-method harmonic regression ──────────────────────

def harmonic_regression(
    signal: np.ndarray,
    t: np.ndarray,
    K: int,
    period: float | None = None,
) -> dict[int, float]:
    """
    Fit harmonic regression per Tsipidi et al. ACL 2025 ("The Harmonic
    Structure of Information Contours", arXiv 2506.03902) — pure OLS on
    Fourier basis:

        f(t) = β₀ + Σₖ (β₁,ₖ·sin(k·2πt/T) + β₂,ₖ·cos(k·2πt/T))

    Returns the per-harmonic amplitudes:

        A_k = √(β₁,ₖ² + β₂,ₖ²)

    Args:
      signal: shape (n,), the time series (e.g., embedding-distance signal).
      t:      shape (n,), the timestamps in seconds. Need not be uniform.
      K:      number of harmonic orders to fit. Must satisfy 1 ≤ K ≤ n//2.
      period: fundamental period in seconds. If None, inferred as max(t)-min(t).

    Returns:
      {k: A_k for k in 1..K}; empty dict if signal is too short (n < 2K+1).

    Note on Tsipidi's L₁ feature-selection step:
      Tsipidi 2025 Appendix D applies L₁ regularization POST-OLS to identify
      which harmonics are statistically significant. The amplitudes returned
      here are the raw OLS-derived A_k for ALL k in 1..K. Callers wanting
      Tsipidi-style feature selection should post-process — typical pattern:
      `selected = {k: a for k, a in result.items() if a > threshold}` or
      use sklearn.linear_model.Lasso for principled selection. This primitive
      stays signature-pure; selection policy is a caller decision.

    Edge cases:
      - Empty / length-1 signal → empty dict.
      - Length mismatch (signal vs t) → ValueError.
      - K > n//2 → raises ValueError (Nyquist violation).
      - Constant signal → {k: 0.0 for k} (β₁=β₂=0 is the OLS solution).
      - Sparse non-uniform t → math handles it; basis built from actual t.
    """
    ...

# ── §4.24 — Hilbert + PAC + PLV + spectral coherence + wavelets ─────

def hilbert_phase(signal: np.ndarray) -> np.ndarray:
    """Instantaneous phase via Hilbert transform. Returns radians ∈ (-π, π]."""

def hilbert_amplitude(signal: np.ndarray) -> np.ndarray:
    """Instantaneous amplitude (envelope) via Hilbert transform. Returns ≥0."""

def pac_tort_2010(low: np.ndarray, high: np.ndarray, n_bins: int = 18) -> float:
    """
    Tort 2010 modulation index for phase-amplitude coupling.

    Steps (per Tort, Komorowski, Eichenbaum, Kopell 2010 J Neurophysiol):
      1. φ_low = hilbert_phase(low)
      2. A_high = hilbert_amplitude(high)
      3. Bin A_high by φ_low into n_bins equal-width phase bins.
      4. Normalize the binned-amplitude distribution to a probability vector.
      5. KL divergence from uniform: D_KL(P || U).
      6. MI = D_KL / log(n_bins) ∈ [0, 1].

    Args:
      low:    shape (n,), the slow-band signal.
      high:   shape (n,), the fast-band signal (same length as low).
      n_bins: phase-binning resolution. Default 18 (per literature).

    Returns:
      Modulation index in [0, 1]. 0 = no coupling; 1 = perfect coupling.

    Edge cases:
      - Length mismatch → ValueError.
      - Constant low (no phase variation) → returns 0.0.
      - n < 2·n_bins → returns 0.0 with a warning logged via stderr.
    """

def phase_locking_value(low: np.ndarray, high: np.ndarray) -> float:
    """
    PLV = |⟨exp(i·Δφ(t))⟩| where Δφ = φ_high - φ_low.
    Returns [0, 1]. 1 = perfect lock; 0 = no coupling.
    """

def spectral_coherence(
    x: np.ndarray,
    y: np.ndarray,
    fs: float,
    nperseg: int | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Magnitude-squared coherence C_xy(f) = |S_xy(f)|² / (S_xx(f) · S_yy(f))
    via Welch's method. Returns (frequencies, coherence).
    Thin wrapper over scipy.signal.coherence (1.12.0 verified available).
    """

def haar_decompose(signal: np.ndarray, levels: int) -> list[np.ndarray]:
    """
    Multilevel Haar wavelet decomposition (DWT).
    Returns [cA_n, cD_n, cD_n-1, ..., cD_1] per pywt.wavedec convention.
    Used for §4.24 non-stationarity mitigation (per spec line 502).
    """

# ── §4.33 — Bigram-flow time-domain features (Biemann 2024) ─────────

def mean_crossing_rate(signal: np.ndarray) -> float:
    """Fraction of consecutive sample-pairs where the signal crosses its mean."""

def slope_sign_change_rate(signal: np.ndarray) -> float:
    """Fraction of consecutive triplets where the slope sign flips."""

def autocorrelation_lag1(signal: np.ndarray) -> float:
    """Pearson correlation of signal[:-1] with signal[1:]. ∈ [-1, 1]."""

def total_spectral_energy(signal: np.ndarray) -> float:
    """Σ |FFT(signal)|² (Parseval). Used as SpecDetect-2025 distinguisher."""

# ── §4.34 — Topology persistence entropy (H0 ONLY in PR0.2) ─────────

def persistence_entropy_h0(points: np.ndarray) -> float:
    """
    Persistence entropy of the H0 (connected-components) Vietoris-Rips
    persistence diagram, computed via scipy single-linkage clustering.

    Equivalence: VR-H0 lifetimes ≡ single-linkage merge heights for
    a finite point cloud in R^d. Verified against scipy.cluster.hierarchy
    documentation.

    Args:
      points: shape (n, d), the point cloud (e.g., embedding trajectory).

    Returns:
      Persistence entropy H = -Σ (l_i / L) log(l_i / L), where l_i are
      finite H0 lifetimes (n-1 of them for n points) and L = Σ l_i.
      Returns 0.0 for n < 2.

    Caveat: H0 only — captures clustering structure / "topological
    concentration." H1 (cycles → narrative-reorganization detection per
    arXiv 2506.14836) is DEFERRED. See design doc §0 Pivot A.

    Edge cases:
      - n < 2 → 0.0 (degenerate; no merge structure).
      - All points identical → 0.0 (all lifetimes are 0).
    """
```

---

## 3. Sweep findings (consolidated)

### A — Tsipidi harmonic regression (Sweep A + pressure-test)

- Spec §4.23 lines 470-471: amplitude `A_k = √(β₁,k² + β₂,k²)` of the embedding-distance time series.
- Math: standard OLS with basis [1, cos(2πk·t/T), sin(2πk·t/T) for k in 1..K]. β₁,k = cosine coefficient, β₂,k = sine coefficient.
- Existing FFT precedent: `scripts/fisher.py:264-266` (np.fft.rfft + rfftfreq for periodogram).
- statsmodels NOT needed — `scipy.linalg.lstsq` + manual basis is ~30 LOC.
- Edge cases: K bounded by n//2 (Nyquist); non-uniform t handled by basis construction; constant signal → all amplitudes 0.

### B — scipy.signal availability + wavelet deprecation (Sweep B + pressure-test)

- scipy 1.12.0 has `signal.{hilbert, welch, csd, coherence}` — all directly usable per spec §4.24 line 495 formula.
- scipy 1.12.0 release notes (verified): "All wavelet functions have been deprecated, as PyWavelets provides suitable implementations" — `signal.{daub, qmf, cascade, morlet, morlet2, ricker, cwt}` removed/deprecated.
- Haar wavelets were never in scipy.signal (ricker/morlet were; deprecated regardless).
- PyWavelets 1.9.0 PyPI inventory (pressure-tested): clean wheels for `cp312-cp312-manylinux_2_27_aarch64` + `cp312-cp312-musllinux_1_2_aarch64` + macOS arm64. install_requires = `numpy<3,>=1.25` only — no transitive cascade risk.

### C — PAC + PLV + AR(1) library choice (Sweep C + pressure-test)

- mne-connectivity 0.8.1: install_requires actually includes `mne>=1.6, pandas>=1.3.2, xarray>=2023.11.0, netCDF4>=1.6.5, tqdm` — would inflate venv by 100s of MB and pull pandas/xarray transitively. DISQUALIFIED on weight, not scipy version (Sweep C cited wrong version).
- tensorpac 0.6.5: last release Jul 2020, 5.8yr stale, scipy 1.12.0 untested. DISQUALIFIED.
- statsmodels: 4-5MB for AR(1) one-liner that's already a numpy.corrcoef call. OVERKILL.
- **Decision: manual numpy/scipy implementations** — Tort 2010 PAC is ~20 LOC, PLV is ~5 LOC, AR(1) is 1 LOC. All trace directly to literature (Tort et al. 2010 J Neurophysiol). Audit-friendly; zero new deps.

### D — TDA library choice (Sweep D + PIVOT)

- Sweep D recommended `gudhi==3.12.0`; pressure-test contradicted.
- gudhi PyPI inventory across last 3 versions (3.10.1, 3.11.0, 3.12.0): NO Linux ARM64 (`manylinux_aarch64`) wheel. Customer fleet (Hetzner cax11) IS Linux ARM64 → gudhi unusable without source-build. Source-build needs CGAL + Boost dev libs via apt — heavy + customer-fleet-update-flow incompatible.
- ripser 0.6.14 DOES have ARM64 wheel (`cp312-cp312-manylinux_2_24_aarch64.manylinux_2_28_aarch64`), but install_requires = `Cython, numpy, persim, scipy, scikit-learn` (unpinned sklearn → cascade risk to our pinned sklearn 1.5.2 vs the onnxruntime 1.18 + numpy 1.26.4 chain per `scripts/requirements.txt:3-9`). Mitigation possible (`pip install --no-deps ripser==0.6.14`) but introduces install-discipline burden.
- giotto-tda 0.6.2: HARD-PINS `scikit-learn==1.3.2` (CONFLICT with our 1.5.2). Also no ARM64 wheel. DISQUALIFIED.
- persim 0.3.8: pulls scikit-learn unpinned (same cascade risk).
- **Pivot A: ship VR-H0 only via scipy single-linkage clustering** — `scipy.cluster.hierarchy.linkage(pdist(points), method='single')` returns N-1 merge heights = exactly the H0 persistence diagram lifetimes for N points. Mathematically exact (well-known equivalence in TDA literature: H0 birth-death of a Vietoris-Rips filtration on a metric space corresponds to single-linkage hierarchical clustering — birth=0 for all, death=merge-height). Zero new deps. Verified working at scipy 1.12.0 + numpy 1.26.4.
- H1 (cycles, Wasserstein narrative-shift): DEFERRED. Two paths when operator decides to enable: (a) gudhi source-build pipeline + CGAL/Boost added to customer-fleet provisioning, OR (b) ripser+persim with `--no-deps` install discipline encoded in `update-customers.sh`. Both have real cost; H0 is sufficient for first PR1 ship.

### E — Module placement + cross-language fixture (Sweep E)

- PR0.1 design line 21 (verified by direct read): "harmonics ships as Python ... JS gets smaller treatment (just the orchestrator-side stage template)."
- Existing PR0.1 helper layout: `scripts/{stage_base,era_skip,event_emit}.py` — flat in `scripts/`, not under `scripts/lib/`.
- Existing `scripts/fisher.py` (355 LOC) sets the naming precedent: short module name, flat in scripts/.
- `packages/metrics/primitives.js` line 18 NOTE references a hypothetical `packages/metrics/primitives.py` mirror — but that's for general primitives (entropy/cosine/L2/Gini), NOT for harmonics primitives. Per PR0.1's explicit harmonics-as-Python-only commitment, no mirror is needed for harmonics.
- conftest.py at `scripts/tests/conftest.py` adds `scripts/` to sys.path → tests can `import harmonics` directly.
- Decision: `scripts/harmonics.py` (flat, mirroring `scripts/fisher.py`); `scripts/tests/test_harmonics.py` (mirroring `scripts/tests/test_fisher.py`).
- Cross-language fixture: SKIP entirely. Pattern requires both Python and JS to compute the same operator; harmonics has no JS computation. If a future PR adds JS-side harmonics (very unlikely per spec + portal precedent), introduce the fixture at that time.

---

## 4. Threat model

PR0.2 ships pure mathematical primitives. Threat surface:

- **No I/O.** No D1 access, no env reads, no file writes, no network. All primitives are pure functions over numpy arrays. → no auth/encryption/audit concerns.
- **No plaintext access.** Primitives operate on numerical signals (embedding-distance time series, point clouds). The CALLER (PR1's `compute-information-harmonics.py`) handles the upstream vector-envelope decryption per spec §4.23 line 473. Per CLAUDE.md §7, embedding vectors are sensitive (inversion attacks are real) — but the primitives themselves don't expose vectors, only derived scalar metrics.
- **No new AppArmor profile required.** `scripts/.venv` runs under existing `mycelium-agent` profile (or none, in cron-spawned `pipeline-health.js` context). Primitives import only from `numpy`, `scipy`, `pywt` — all already (or about-to-be) in `scripts/.venv`. No new file paths, no new sockets, no new sub-processes.
- **PyWavelets dep add — supply-chain consideration.** PyPI signature is verifiable; library is widely used (10k+ downloads/day per PyPI metadata) and the maintainer team is academic + active. Risk: pinned version means we don't auto-pull CVE patches. Mitigation: include in the next dependabot-equivalent review cycle.
- **Numerical-instability concerns.** OLS on near-singular bases (short signals + high K) can produce nonsensical amplitudes. Mitigation: explicit Nyquist guard in `harmonic_regression` (raises if K > n//2) + edge-case tests (constant signal → all-zero amplitudes; sparse signal → empty dict).
- **Memory ceiling on H0 persistence.** `scipy.spatial.distance.pdist` on N points is O(N²) memory. For N=2000 (typical 90d journaling window): 16MB for the distance vector — fine. For N=10000 (year window): 400MB — could OOM on 4GB customer VPSes. Mitigation: PR1's caller must enforce a per-window N cap (typical: 500-2000 messages) and fall back to subsampling above that. Documented in the docstring + a hard `N > 5000 → raise ValueError` guard in the primitive.

Per CLAUDE.md §10 ("validate every operation"), every primitive returns a sentinel value or raises on inputs that would silently produce garbage (Nyquist violations, length mismatches, constant inputs to phase computations). No silent fallback to `0.0`.

---

## 5. Edge cases (per primitive — explicit decisions)

| Primitive | Edge case | Decision | Rationale |
|---|---|---|---|
| `harmonic_regression` | n == 0 | return `{}` | Empty signal has no harmonics. Caller checks before persisting. |
| `harmonic_regression` | K > n//2 | raise `ValueError` | Nyquist violation — silently truncating would be lying. |
| `harmonic_regression` | length mismatch (signal vs t) | raise `ValueError` | Caller bug, not a degenerate edge. |
| `harmonic_regression` | constant signal | return `{k: 0.0 for k in 1..K}` | Mathematically correct (β₁=β₂=0 is the OLS solution). |
| `harmonic_regression` | period=None | infer `max(t) - min(t)` | Documented in docstring; tested against fixed-period equivalence. |
| `hilbert_phase`/`amplitude` | constant signal | return `np.zeros_like(signal)` for amplitude, `np.zeros_like(signal)` for phase | Hilbert of constant has zero analytic part; phase is undefined but 0 is the sensible scalar. |
| `pac_tort_2010` | length mismatch | raise `ValueError` | Caller bug. |
| `pac_tort_2010` | n < 2·n_bins | return 0.0 + log warning to stderr | Statistically meaningless but not crash-worthy. |
| `pac_tort_2010` | constant low (no phase variation) | return 0.0 | No phase to bin against. |
| `phase_locking_value` | length mismatch | raise `ValueError` | Caller bug. |
| `phase_locking_value` | constant signal | return 0.0 | No phase variation. |
| `spectral_coherence` | n < 2·nperseg | nperseg auto-shrinks to n//2 (scipy default) | Inherits scipy.signal.coherence semantics. |
| `haar_decompose` | levels=0 | raise `ValueError` | 0-level decomp is meaningless; pywt would silently return [signal]. |
| `haar_decompose` | levels exceeds dyadic limit | raise `ValueError` (delegated to pywt) | pywt's default behavior; we surface the error. |
| `mean_crossing_rate` | n < 2 | return 0.0 | No crossings possible. |
| `slope_sign_change_rate` | n < 3 | return 0.0 | No triplets to check. |
| `autocorrelation_lag1` | n < 2 | return 0.0 | No lag pairs. |
| `autocorrelation_lag1` | constant signal | return 0.0 | corrcoef of zero-variance is NaN; we return 0.0 explicitly. |
| `total_spectral_energy` | empty | return 0.0 | Trivially correct. |
| `persistence_entropy_h0` | n < 2 | return 0.0 | No merge structure. |
| `persistence_entropy_h0` | all points identical | return 0.0 | All lifetimes are 0; entropy is well-defined as 0. |
| `persistence_entropy_h0` | n > 5000 | raise `ValueError` | Memory guard (16MB+ pdist; OOM-risky on 4GB). Caller must subsample. |

---

## 6. Test strategy

`scripts/tests/test_harmonics.py` — pytest, mirroring PR0.1 layout. Per primitive:

| Test class | Tests |
|---|---|
| `TestHarmonicRegression` | (1) pure cos at known frequency recovers β₁=A, β₂=0 (round-trip). (2) pure sin recovers β₁=0, β₂=A. (3) constant signal → all-zero amplitudes. (4) empty signal → empty dict. (5) Nyquist guard (K > n//2) raises. (6) length mismatch raises. (7) non-uniform t fits a known harmonic. (8) sum of two harmonics decomposes correctly. |
| `TestHilbert` | (1) hilbert_phase of pure cos is monotonic increasing modulo 2π. (2) hilbert_amplitude of pure cos is constant ≈ A. (3) constant signal → zero amplitude/phase. |
| `TestPAC` | (1) PAC = 0 on independent signals (random low + random high). (2) PAC > 0.5 on hand-constructed coupled signals (low-freq sine modulating high-freq amplitude). (3) length mismatch raises. (4) constant low → 0.0. (5) MI bounded [0, 1]. |
| `TestPLV` | (1) PLV = 1 on identical-phase signals. (2) PLV ≈ 0 on independent random signals (large n). (3) constant signal → 0. (4) bounded [0, 1]. |
| `TestSpectralCoherence` | (1) coherence of identical signals = 1 at all frequencies. (2) coherence of independent signals ≈ 0 at most frequencies. (3) frequency axis matches scipy convention. |
| `TestHaarDecompose` | (1) levels=1 decomp is detail+approx pair. (2) reconstruction (pywt.waverec) round-trips to original signal. (3) levels=0 raises. (4) excessive levels raises. |
| `TestFlowFeatures` | mean_crossing_rate / slope_sign_change_rate / autocorrelation_lag1 / total_spectral_energy: known-input tests on hand-constructed signals; edge cases (n<2, n<3, constant) documented in table § 5. |
| `TestPersistenceEntropyH0` | (1) 2 distant points → entropy = 0 (single lifetime). (2) Three equidistant points → entropy = log(2) (uniform over 2 lifetimes). (3) Cluster of N collocated points → near-zero entropy. (4) Random gaussian cloud → entropy in [0, log(N-1)]. (5) n=0,1 → 0.0. (6) n > 5000 raises. (7) bounded [0, log(n-1)]. |

Total: ~50 tests across ~12 classes. Run via `cd scripts && pytest tests/test_harmonics.py -v`.

**No cross-language fixture.** Per Sweep E: harmonics is Python-only family; no JS to validate against.

---

## 7. Implementation order

PR0.2 ships as a single PR with these steps (each independently verifiable, none ship-blocking another):

| Step | Scope | LOC est. | Verify |
|---|---|---|---|
| 1 | Add `PyWavelets==1.9.0` to `scripts/requirements.txt` | +1 line | `pip install -r scripts/requirements.txt` succeeds; `python -c "import pywt; print(pywt.__version__)"` prints 1.9.0 |
| 2 | Create `scripts/harmonics.py` with the 12 primitives | ~300 LOC | `python -c "from harmonics import *; print('ok')"` from `scripts/` |
| 3 | Create `scripts/tests/test_harmonics.py` with the test classes | ~400 LOC | `cd scripts && pytest tests/test_harmonics.py -v` — all green |
| 4 | (Optional cleanup) Verify no regression in existing tests | — | `cd scripts && pytest -v` — same count of passes as pre-PR (184 + new tests) |

NO production deploy in PR0.2. Primitives are uncalled until PR1 wires them into the family stage. Admin pull + verify-deploy can happen at PR1's ship time, not PR0.2's. (PR0.2 is structurally a library add — analogous to PR0.1's pure helpers before they were imported.)

---

## 8. Decision criteria for proceeding to PR1

PR0.2 is "done" when:
- All 12 primitives exist in `scripts/harmonics.py` with the documented signatures.
- All 50+ unit tests pass via `pytest tests/test_harmonics.py`.
- `pip install -r scripts/requirements.txt` succeeds in a fresh venv on Linux ARM64 (admin VPS smoke OK, customer VPS deferred until customer-fleet rollout decision).
- 184 (PR0.1 baseline) + new tests all green; zero regression in PR0.1 tests.
- This design doc's verification table (§ 10) all rows pass.

PR1 may begin when PR0.2 ships. PR1 (information-harmonics family stage) will:
- Compose these primitives into a `compute-information-harmonics.py` script.
- Use PR0.1's `stage_base` / `era_skip` / `event_emit` for scaffolding.
- Use PR0.1's `eraAwareCheck` + `runEraStage` for `pipeline-health.js` registration.
- Read decrypted vectors via mind-search d1-loader.js path (per spec §4.23 line 473).
- Write to a new `cognitive_metrics_harmonic` table (migration TBD in PR1).

---

## 9. Risks + mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | PyWavelets ARM64 wheel install fails on Hetzner cax11 | Low (PyPI inventory verified) | Med (blocks PR0.2 ship) | Smoke-install on admin VPS BEFORE merging the PR; rollback plan = revert the requirements.txt line. |
| R2 | numpy 1.26 / scipy 1.12 transitive conflict from PyWavelets | Very low (PyWavelets pins `numpy<3,>=1.25` only) | High (cascades to onnxruntime 1.18 break per requirements.txt line 9 warning) | Smoke-install in fresh venv on admin; if cascade triggered, downgrade PyWavelets pin or roll our own Haar (~20 LOC numpy fallback). |
| R3 | scipy.signal.hilbert numerical instability on short signals | Med | Low | Edge-case tests for n=2, n=3, n=10. Document in docstrings. Constant-signal returns zero explicitly. |
| R4 | scipy single-linkage equivalence to VR-H0 not exact in some pathological case | Very low (well-established TDA result) | Med (would require pivot to ripser+--no-deps) | Cite + verify against simple hand-computed examples in tests (3 collinear points, 4 points at corners of square). |
| R5 | Tort 2010 PAC manual implementation diverges from canonical PAC | Med (algorithm is straightforward but has stylistic variants) | Med | Test against hand-constructed coupled signals where PAC > 0.5 expected; against random where PAC ≈ 0; cite paper formula in docstring. Use the `n_bins=18` default per the literature (Tort et al. 2010 §2.4). |
| R6 | Future operator decides H1 (cycles) is required for §4.34 | Med | Low (documented as deferred; scipy single-linkage still works for H0) | The PR0.2 H0 implementation is non-disruptive — adding H1 later via gudhi or ripser doesn't conflict. |
| R7 | PR1 surface uncovers a primitive missing from PR0.2 | Med | Low | PR1 sweep will identify; PR0.2.1 ships the gap. (This is the standard "PR0.2 has the primitives I currently know harmonics needs; PR1 may surface more" reality.) |
| R8 | Memory blowup on large N for `persistence_entropy_h0` | Med (depends on PR1's window choice) | Med (OOM on 4GB VPS) | Hard guard: raise ValueError if n > 5000. Document in docstring. PR1's caller subsamples to a window-cap. |

---

## 10. Verification table (load-bearing assumptions)

Every assumption file:line-anchored. Future-self / future-Claude can re-verify each row.

| # | Assumption | Verified at | Status |
|---|---|---|---|
| 1 | scripts/requirements.txt warns "DO NOT use >=" for ARM64 chain | scripts/requirements.txt:9 | LIVE — direct read |
| 2 | numpy + scipy pinned at 1.26.4 + 1.12.0 | scripts/requirements.txt:11-12 | LIVE — direct read |
| 3 | Customer fleet is Hetzner cax11 (ARM64) | scripts/requirements.txt:1 | LIVE — header comment |
| 4 | scripts/.venv on customer fleet does NOT include statsmodels, mne, tensorpac, gudhi, ripser, persim, giotto-tda | scripts/requirements.txt full | LIVE — file is 33 LOC, no listed deps |
| 5 | Spec §4.23 algorithm: A_k = √(β₁,k² + β₂,k²) of embedding-distance time series | docs/architecture/COGNITIVE-METRICS-SPEC.md:470-471 | LIVE — direct quote |
| 6 | Spec §4.24 algorithm: PAC (Tort 2010), PLV `\|⟨exp(i·Δφ)⟩\|`, coherence `C_xy(f) = \|S_xy\|² / (S_xx·S_yy)` | COGNITIVE-METRICS-SPEC.md:493-495 | LIVE — direct quote |
| 7 | Spec §4.24 mitigation: "windowed analysis + wavelet decomposition (Haar wavelets per WaveletGPT 2024)" | COGNITIVE-METRICS-SPEC.md:502 | LIVE — direct quote |
| 8 | Spec §4.33 features: mean_crossing_rate, slope_sign_change_rate, autocorrelation_lag1, variance, total_spectral_energy | COGNITIVE-METRICS-SPEC.md:603-607 | LIVE — direct quote |
| 9 | Spec §4.34 algorithm: VR filtration → persistence diagram → persistence entropy H = -Σ(l_i/L)log(l_i/L) | COGNITIVE-METRICS-SPEC.md:623 | LIVE — direct quote |
| 10 | PR0.1 design locks harmonics-as-Python | docs/MEASUREMENT-PLANE-PR0.1-DESIGN-2026-05-07.md:21 | LIVE — direct quote |
| 11 | scipy 1.12.0 deprecated all wavelet functions (signal.{daub,qmf,cascade,morlet,morlet2,ricker,cwt}) | scipy 1.12 release notes | LIVE — Sweep B + scipy.org docs |
| 12 | scipy.signal.hilbert / welch / csd / coherence available in 1.12.0 | scipy 1.12 docs | LIVE — Sweep B WebFetch |
| 13 | PyWavelets 1.9.0 has cp312-cp312 manylinux_aarch64 wheel | PyPI pywavelets/json | LIVE — direct curl + parse |
| 14 | PyWavelets 1.9.0 install_requires = `numpy<3,>=1.25` only | PyPI pywavelets/json | LIVE — direct curl + parse |
| 15 | gudhi has NO Linux ARM64 wheel at 3.10.1 / 3.11.0 / 3.12.0 | PyPI gudhi/json (3 versions) | LIVE — direct curl + parse |
| 16 | ripser 0.6.14 install_requires includes unpinned scikit-learn | PyPI ripser/json | LIVE — direct curl + parse |
| 17 | giotto-tda 0.6.2 hard-pins scikit-learn==1.3.2 (CONFLICT with our 1.5.2) | PyPI giotto-tda/json | LIVE — direct curl + parse |
| 18 | mne-connectivity 0.8.1 install_requires pulls mne/pandas/xarray/netCDF4/tqdm | PyPI mne-connectivity/json | LIVE — direct curl + parse |
| 19 | scipy.cluster.hierarchy.linkage(pdist(X), 'single') returns N-1 H0 lifetimes for N points | local Python REPL probe | LIVE — verified `merge_heights.shape == (N-1,)` for X.shape == (N, d) |
| 20 | conftest.py adds scripts/ to sys.path for tests | scripts/tests/conftest.py:9-12 | LIVE — Sweep E direct read |
| 21 | Existing PR0.1 helpers live FLAT in scripts/, not under scripts/lib/ | scripts/{stage_base,era_skip,event_emit}.py | LIVE — Sweep E ls + direct read |
| 22 | Existing FFT precedent at fisher.py:264-266 (np.fft.rfft + rfftfreq) | scripts/fisher.py:264-266 | LIVE — grep result + direct read |
| 23 | Tsipidi 2025 harmonic regression formulation: `f(t) = β₀ + Σₖ (β₁,ₖ·sin(k·2πt/T) + β₂,ₖ·cos(k·2πt/T))`, `A_k = √(β₁² + β₂²)` | arXiv 2506.03902 (Tsipidi et al. ACL 2025) | LIVE — Sweep F WebFetch |
| 24 | Tsipidi's L₁ regularization is POST-OLS feature selection, not regularized OLS — amplitude formula is unchanged | arXiv 2506.03902 Appendix D | LIVE — Sweep F WebFetch |
| 25 | SpecDetect (arXiv 2508.11343) operates on TOKEN log-probabilities, not embedding distances — spec §4.23 line 467 cross-citation is wrong | arXiv 2508.11343 | LIVE — Sweep F WebFetch (SPEC-LEVEL ISSUE; see §16) |

All 25 rows LIVE. Zero GAP rows. Design is structurally ready for implementation.

---

## 11. Open questions resolved during sweep

- **Q: Add new TDA dep (gudhi) or stay scipy-only?** RESOLVED: scipy-only (gudhi has no ARM64 wheel; ripser has cascade risk). H0 only via scipy single-linkage; H1 deferred.
- **Q: Add PyWavelets or roll our own Haar?** RESOLVED: PyWavelets (clean ARM64+py312 wheel; future-extensible to Daubechies; single-line dep).
- **Q: mne-connectivity or tensorpac for PAC?** RESOLVED: neither — manual numpy/scipy.signal.hilbert (audit-friendly; no cascade risk).
- **Q: statsmodels for AR(1)?** RESOLVED: no — `np.corrcoef(s[:-1], s[1:])[0,1]` is the one-line answer.
- **Q: Module placement — `scripts/harmonics.py` flat vs `scripts/harmonics/` subpackage?** RESOLVED: flat single file (mirrors `scripts/fisher.py` precedent + PR0.1 flat helpers).
- **Q: Cross-language fixture for harmonics?** RESOLVED: SKIP. Harmonics is Python-only family; no JS counterpart.
- **Q: Does Tsipidi 2025 mean textbook OLS-Fourier-basis by "harmonic regression"?** RESOLVED via Sweep F: YES, exactly. arXiv 2506.03902 confirms `f(t) = β₀ + Σₖ (β₁,ₖ·sin + β₂,ₖ·cos)` with `A_k = √(β₁² + β₂²)`. Primitive math is correct as designed.
- **Q: Should the primitive include Tsipidi's L₁ feature-selection step?** RESOLVED via Sweep F: NO — L₁ is POST-OLS feature selection (caller concern). Primitive returns all K amplitudes; PR1's caller can post-threshold or invoke Lasso for Tsipidi-style selection. Documented in primitive docstring.

## 12. Open questions deferred (out of scope; named so they don't ambush PR1)

- **§4.34 H1 (cycles + Wasserstein narrative-shift detection)** — deferred until operator decides whether to accept the install discipline cost. Two paths:
  - (a) gudhi via source-build with CGAL/Boost in customer-fleet provisioning. ~30min build per VPS; needs apt-level prerequisites added.
  - (b) ripser + persim with `--no-deps` install discipline encoded in `update-customers.sh`. ~5min install per VPS; needs `install_requires` discipline maintained.
  - Recommendation when revisited: (b) — lighter, ARM64 wheels already built. Encode the `--no-deps` flag in the customer-fleet update script + add a smoke-test that imports without dependency error.
- **non-English-language low_confidence flag wiring** (spec §4.23 line 482) — PR1 scope (presentation-contract, not primitive).
- **Embedding-distance time-series construction** — primitive helper for cosine-distance on a stream of L2-normalized 768D vectors. §4.23 line 476 says "NO shared cross-stage distance-series primitive — YAGNI; the distance computation is ~3 lines numpy, run it inline." Honored — not in PR0.2.
- **Per-band aggregation** (gamma/beta/alpha/theta/delta) — PR1 scope (caller decides band aggregation; primitives operate on whatever signal the caller passes).
- **`packages/metrics/primitives.py` general-purpose Python mirror of the JS primitives** (referenced in `packages/metrics/primitives.js:18`) — unrelated to harmonics. If/when needed, separate PR. Not in PR0.2 scope.

---

## 13. Glossary (PR0.2-specific terms)

- **VR-H0 persistence diagram:** The set of birth-death pairs for connected components of a Vietoris-Rips filtration on a finite point cloud. For H0 of a metric space, all features are born at filtration value 0; deaths are merge heights. Equivalent to single-linkage clustering's merge sequence.
- **Persistence entropy:** `H = -Σ (l_i / L) log(l_i / L)` where l_i = lifetime of i-th persistent feature, L = Σ l_i. Bounded [0, log N] for N features. Captures distributional concentration of topological features (low entropy = one dominant feature; high = many comparable features).
- **Tort 2010 modulation index:** A specific PAC measure: bin high-frequency amplitude by low-frequency phase into n_bins (default 18); normalize binned-amplitude to a probability vector; compute KL divergence from uniform; normalize by log(n_bins) to bound [0, 1]. Source: Tort, Komorowski, Eichenbaum, Kopell (2010) J Neurophysiol.
- **PLV (phase-locking value):** `|⟨exp(i·Δφ(t))⟩|`. Magnitude of the time-averaged complex exponential of the phase difference between two signals' Hilbert-derived phases. Bounded [0, 1].
- **Haar wavelet:** Simplest possible wavelet basis; dyadic averaging-and-differencing. Used in PR0.2 only as a non-stationarity mitigation tool for §4.24 spectral methods (per spec line 502).
- **Nyquist limit (for harmonic regression):** K ≤ n//2 — fitting more harmonics than half the signal length is mathematically meaningless.

---

## 14. Pickup protocol (for the implementation session)

1. Read this design doc cold, top-down. Don't skim.
2. Verify production state: `git log --oneline -5` should show `ad5d541` (PR0.1) at HEAD or recent.
3. Fresh-venv smoke for PyWavelets: `python -m venv /tmp/pwv && source /tmp/pwv/bin/activate && pip install numpy==1.26.4 scipy==1.12.0 PyWavelets==1.9.0 && python -c "import pywt; print(pywt.__version__)"`. If this fails on your local arch, debug before adding to `scripts/requirements.txt`.
4. Add `PyWavelets==1.9.0` to `scripts/requirements.txt` (after the scipy line).
5. Create `scripts/harmonics.py` with the 12 primitives per §2 signatures.
6. Create `scripts/tests/test_harmonics.py` with the test classes per §6.
7. Run `cd scripts && pytest tests/test_harmonics.py -v`. Iterate until all green.
8. Run `cd scripts && pytest -v` — verify no regression in PR0.1 tests (184 baseline).
9. Commit + push. Per `/deploy-and-verify` discipline: PR0.2 has NO production deploy step (primitives are uncalled until PR1).
10. Update handoff doc + MEMORY.md per `/handoff-discipline`.
11. Begin PR1 design with `/sweep-first-design` (separate Explore agents per concern: vector-decryption pipeline, era-mode integration for embedding stream, cognitive_metrics_harmonic table schema, presentation-contract enforcement for §4.23/§4.24/§4.33/§4.34).

Operator-only decision before step 4: confirm PyWavelets dep add. PR0.2 design recommends YES.

---

## 15. Sweep F outcome — Tsipidi method verified

Post-design Sweep F (operator-requested pressure-test) located the actual paper:

- **Tsipidi, Kiegeland, Nowak, Xu, Wilcox, Warstadt, Cotterell, Giulianelli (2025).** "The Harmonic Structure of Information Contours." ACL 2025 (Long Paper) / arXiv 2506.03902. [aclanthology.org/2025.acl-long.1527](https://aclanthology.org/2025.acl-long.1527).
- **Method confirmed:** OLS on sin/cos Fourier basis, exactly as my primitive's signature implies. Amplitude formula `A_k = √(β₁,ₖ² + β₂,ₖ²)` matches byte-for-byte.
- **L₁ regularization clarification:** Tsipidi Appendix D applies L₁ POST-OLS for feature selection (which harmonics are statistically significant). Per-harmonic AMPLITUDE is unchanged — just zero-out (or lasso-fit) the non-significant β coefficients. **This is a caller concern, not a primitive concern.** Documented in `harmonic_regression` docstring.
- **What's experimental:** Tsipidi applies the method at LINGUISTIC unit boundaries (token, sentence, document). Mycelium's application maps to TEMPORAL bands (gamma=message, beta=10-msg, alpha=day, theta=week, delta=month). No published precedent for this specific band mapping. Spec §4.23 line 478 already acknowledges this with `experimental` rigor classification — Sweep F confirms this honesty is correct.

**Net effect on PR0.2 design:** Zero structural changes. The primitive signature, edge cases, tests, and verification table all hold. Two new verification rows added (23, 24). One new spec-level callout in §16.

---

## 16. Spec-level findings flagged for operator (NOT PR0.2 scope)

Sweep F surfaced two pre-existing citation issues in `docs/architecture/COGNITIVE-METRICS-SPEC.md` §4.23 lines 467 + 478. These are NOT PR0.2 implementation blockers (the primitive math is right regardless), but they affect the spec's scientific-rigor claims and should be operator-decided.

### Finding 1 — SpecDetect mis-cited

Spec §4.23 line 467 cites SpecDetect (arXiv 2508.11343) as validating the FFT-on-embedding-distance approach. **SpecDetect actually operates on token log-probabilities, NOT on embedding distances.** Sweep F WebFetch confirmed: SpecDetect uses DFT total energy `Σ|Xₖ|²` on token-level surprisal sequences for LLM detection. Different signal type, different aggregation. The cross-citation is incorrect.

**Operator options:**
- (a) Remove the SpecDetect cross-reference from §4.23.
- (b) Replace with a note that SpecDetect uses a *different* spectral approach for a *different* signal type (a contrast, not a validation).
- (c) Find a correct citation for "FFT/spectral methods on embedding-distance signals" if one exists in the literature; if none, downgrade the claim to `experimental`.

**Recommendation:** (b) — preserves the literature trail honestly while removing the false-validation claim.

### Finding 2 — Biemann attribution drift

Spec §4.23 line 478 + §4.33 cite "Biemann et al. 2024 Behavior Research Methods" for the embedding-distance-as-information-flow signal. Sweep F could not locate a Biemann 2024 paper matching that description. The actual clinically-validated work is **Palominos et al. 2024 (Schizophrenia, NPJ Schizophrenia / Nature Schizophrenia)** — which validates embedding-distance-as-signal in psychiatric populations, but uses TIME-DOMAIN features (slope sign changes, autocorrelation, mean-crossing rate) — exactly the §4.33 features. Does NOT use harmonic regression.

**Operator options:**
- (a) Replace "Biemann 2024" → "Palominos et al. 2024" throughout §4.23 / §4.33 with the correct PMC link.
- (b) Verify whether a separate Biemann-authored paper exists with this signal+method combo (Sweep F could not find one; an additional literature search may); if found, keep both citations; if not, fix to Palominos.
- (c) If keeping Palominos, note explicitly that the §4.33 time-domain features are validated by Palominos but the §4.23 harmonic regression on embedding-distance is **without published clinical precedent** (still mathematically grounded by Tsipidi 2025 + theoretically grounded by arXiv 2406.03707).

**Recommendation:** (a) + (c) — fix the attribution drift, then accurately characterize the rigor: §4.33 validated-clinical via Palominos; §4.23 validated-mathematical via Tsipidi but experimental-clinical for the band-mapping application.

### Net effect on §4.23 scientific-rigor field

Current spec line 478 says §4.23 is `validated-clinical for the embedding-distance-as-information-flow claim (Biemann et al. 2024 Behavior Research Methods — clinically validated on psychiatric conversation data)`. After fixing both findings, this should read closer to: `validated-clinical for embedding-distance-as-signal (Palominos et al. 2024 NPJ Schizophrenia, time-domain features); validated-mathematical for harmonic regression itself (Tsipidi et al. 2025, ACL); experimental for harmonic regression APPLIED to embedding-distance-at-message-band-grain (no published precedent for this specific composition).`

This downgrade is honest, not pessimistic — it preserves the U20/U21/U23 use-cases but attaches accurate provenance. Aligns with CLAUDE.md "honest UX" and the spec's overclaim-aversion principles (e.g., §4.31 which already applies this pattern to Bedi 2015).

### Tracking for follow-up

These are operator-only decisions on the spec, not PR0.2-implementation work. Recommend:
- File as PR0.0.1 (spec-citation hygiene) — small-win warm-up parallel to PR0.2 implementation; ~30 LOC of spec edits + revision history entry.
- Or absorb into the next spec revision (v1.4) when other §4 stubs get filled.

**Operator decision 2026-05-07: PR0.0.1 approved + ships parallel to PR0.2.**

---

## 17. Time-domain feature extensibility (operator flag 2026-05-07)

Operator flagged (2026-05-07): "lets keep in mind that we may want to do the time domain feature analysis too." This section captures the candidate expansion landscape so a future PR can pick up cleanly.

### Palominos et al. 2024 — full catalog

Per WebFetch of the actual paper (DOI 10.1038/s41537-024-00524-7, *Schizophrenia*), Palominos compute these features on the consecutive-pair embedding-similarity time series:

| # | Palominos feature | In spec §4.33 today? | Notes |
|---|---|---|---|
| 1 | Mean semantic similarity | ❌ | Trivial 1-line numpy; could add as `mean_distance(signal)` |
| 2 | Max semantic similarity | ❌ | Trivial 1-line numpy; could add as `max_distance(signal)` |
| 3 | Min semantic similarity | ❌ | Trivial 1-line numpy; could add as `min_distance(signal)` |
| 4 | Slope Sign Change (SSC) | ✅ | `slope_sign_change_rate` in PR0.2 |
| 5 | Mean Crossing Rate | ✅ | `mean_crossing_rate` in PR0.2 |
| 6 | First-order autocorrelation | ✅ | `autocorrelation_lag1` in PR0.2 |

PLUS geometric features (operate on raw embedding cloud, NOT the distance time series):

| # | Palominos geometric feature | Spec home | Notes |
|---|---|---|---|
| 7 | Total displacement (cumulative Euclidean) | NOT in §4.33 | Sibling family — "trajectory geometry" |
| 8 | Dispersion (around centroid) | NOT in §4.33 | Sibling family — overlaps existing fisher metrics conceptually |
| 9 | Convex hull volume (256D-truncated) | NOT in §4.33 | Sibling family — high-D convex hull is heavy-compute |
| 10 | Convex hull area | NOT in §4.33 | Same |

**Mycelium-specific note:** Palominos uses fastText / BERT / Sentence-Transformers (German). Mycelium's application to Nomic v1.5 768D multilingual embeddings is a method extension, not a direct replication. Cross-corpus transfer is plausible (the wave-domain features are signal-agnostic) but unvalidated for Nomic specifically — this should be in §4.33's `experimental` rigor field.

### Spec-§4.33-as-currently-stated cardinality

Today's §4.33 lists 5 features (lines 603-607):
- `mean_crossing_rate` (matches Palominos #5)
- `slope_sign_change_rate` (matches Palominos #4)
- `autocorrelation_lag1` (matches Palominos #6)
- `variance` (NOT in Palominos — standard signal-processing add)
- `total_spectral_energy` (NOT in Palominos — added per SpecDetect 2025; note SpecDetect citation issue per §16 Finding 1)

PR0.2 ships all 5 as primitives. The expansion candidates from Palominos #1-3 (mean / max / min distance) are trivial 1-line numpy adds (~6 LOC total) and could land as PR0.2.1 OR be absorbed into PR0.2 if operator approves expanding §4.33 in the same cycle.

### Recommendation for PR0.2 scope

**SHIP AS DESIGNED** with the spec-§4.33-current 5 features. Reason: PR0.2 is "ship what the spec says." Expanding §4.33 is a spec-revision concern, not a primitive-implementation concern. Adding the 3 trivial Palominos features later is one-function-per-line cheap; not a structural cost.

### Pre-anticipated PR0.2.1 scope (if operator approves spec expansion)

Future spec v1.4 could expand §4.33 with:
- `mean_distance(signal)` — Palominos #1
- `max_distance(signal)` — Palominos #2
- `min_distance(signal)` — Palominos #3

Plus a NEW sibling metric or new metric family for the geometric features (#7-10). Spec already has the `topology-graph` family (per spec §8) — geometric features may sit there or in a new `embedding-trajectory-geometry` family. Decision deferred to operator at spec v1.4 revision.

### Module extensibility

`scripts/harmonics.py` is intentionally a flat single file. Adding 3 more time-domain primitives is one new section + 3 functions, ~10 LOC total. No restructuring needed. The test file scales identically. PR0.2.1 (if it happens) is a ~20-LOC delta.

**No design change to PR0.2 from this section.** This is forward-looking documentation only, per the operator's "keep in mind" directive.
