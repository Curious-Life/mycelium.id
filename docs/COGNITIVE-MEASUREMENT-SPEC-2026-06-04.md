<!-- Recovered VERBATIM from the 2026-06-04 Claude Code session transcript (81a1e163-86e3-41a7-a3bf-f23513d9ade1.jsonl, user paste at line 172). -->
<!-- This is the operator's research synthesis / source-of-truth for the measurement-layer buildout (metric families E1 / C1 / H1 / X1). -->
<!-- Do not edit: preserved verbatim as the canonical spec input. -->

# Mycelium Cognitive Measurement System
## Theory, Design, and Implementation Specification

**Date**: 2026-06-04
**Version**: Unified v1.0
**Compiled by**: Ada (Research Agent)
**Sources**: Original metric spec (v1.2, 2026-05-07), SOTA comparison (23 daily scans, 500+ papers), keyword-measures audit (2026-06-04)
**Status**: COMPLETE — unified document replacing `cognitive-measurement-sota-vs-mycelium-2026-06-04.md` + `keyword-measures-audit-2026-06-04.md` + original metric inventory

---

## Table of Contents

1. [Theoretical Foundations](#1-theoretical-foundations)
2. [Design Principles and Constraints](#2-design-principles-and-constraints)
3. [Metric Design Decisions](#3-metric-design-decisions)
4. [Implementation Specification](#4-implementation-specification)
5. [Method Families and Pipeline Architecture](#5-method-families-and-pipeline-architecture)
6. [Structural Integrity Invariants](#6-structural-integrity-invariants)
7. [Use-Case Catalog](#7-use-case-catalog)
8. [Open Questions and Future Directions](#8-open-questions-and-future-directions)
9. [Graveyard](#9-graveyard)
10. [References](#10-references)

---

# Part I: Theory

## 1. Theoretical Foundations

### 1.1 Information Geometry — The Mathematical Bedrock

Mycelium's measurement layer rests on **information geometry** — cognitive states are probability distributions; the space of all possible states is a statistical manifold; movement through this space *is* cognitive development. The natural distance between two distributions on this manifold is the **Fisher-Rao metric**:

```
d(theta_1, theta_2) = integral sqrt(dtheta^T I(theta) dtheta)
```

where `I(theta)` is the Fisher information matrix. By **Cencov's theorem (1982)**, the Fisher-Rao metric is the *unique* invariant Riemannian metric on probability simplices — not a design choice, a mathematical constraint. Every other distance metric either reduces to this one or discards information.

**SOTA confirmation (2024-2026)**:
- Xiao et al. 2026 (arXiv:2605.22598): first-principles derivation that efficient coding under constraint DRIVES neural systems toward criticality — Fisher-Rao geometry is what emerges at the optimum
- FRInGe (arXiv:2605.06404): Fisher-Rao geodesics on the simplex produce more stable attributions than Euclidean paths
- FishBack (arXiv:2605.17231): >97% deviation from Euclidean geometry in embedding space — Fisher-Rao is not a marginal improvement, it's a different geometry
- Diagonal Fisher weighting captures 70-85% of full Riemannian benefit at 10% implementation cost (Ada research, Feb 2026)

**Assessment**: Mycelium's foundation is best-in-class. No competitor uses information geometry for cognitive measurement from text. The Fisher-Rao metric is not a design choice — it's a mathematical theorem. **No changes needed to the foundation.**

**Confidence**: 98%

### 1.2 The Proxy Validity Challenge

The most important methodological finding from the 23-day scan: every Tier 1 metric using embedding geometry is epistemologically exposed.

**The 12 dimensions of proxy validity risk:**

| Dimension | Key Paper | Finding |
|---|---|---|
| 1. Frequency confound | arXiv:2605.06506 | Word frequency > surprisal for metaphor novelty |
| 2. Parse multiplicity | arXiv:2605.15440 | Restricting parse count raises predicted surprisal ~40% toward human-level |
| 3. Authorial style | arXiv:2605.10606 | Embeddings encode authorial style; persists through LLM rewriting |
| 4. Brain-LM alignment debunked | Nature Comms 2026 | Brain-LLM alignment literature is artifact of confounds |
| 5. Inverse scaling | Day 19-20 | Larger LMs predict fMRI data WORSE; replicated |
| 6. Knowledge-Decision Gap | ActTraitBench | Self-report vs behavioral consistency widens with model scale |
| 7. Stability-correctness decoupling | arXiv:2606.01202 | Stable answers aren't correct ones |
| 8. Calibration failure taxonomy | Days 20-21 | Three-tier failure across model scales |
| 9. The Proxy Presumption | Li et al. 2025 (arXiv:2605.07409) | Formalizes the problem; introduces CVP |
| 10. Ground-truth-free evaluation | arXiv:2606.03650 | Framework for evaluating without ground truth |
| 11. Cross-lingual robustness | arXiv:2605.21049 | Brain-alignment robustness confirmed but mechanism unexplained |
| 12. DSF metric | arXiv:2606.00467 | 2/3 of zero-shot errors resist correction |

**Mycelium's defense**: Using embedding-distance as a time-series signal rather than interpreting individual embeddings as direct measurements is the strongest available mitigation. But the **Construct Validity Protocol (CVP)** from Li et al. must be adopted formally as a mandatory gate for every Tier 1 metric before shipping.

**Confidence**: 95%

### 1.3 Criticality and Phase Transitions — Theory Solid, Detection Failing

**The theory is stronger than ever**: Two independent first-principles derivations converged in Day 13 — criticality is the inevitable outcome of efficient coding under constraint.

**The detection methods are failing**:
- Helmich & Schreuder 2024 (Nature Reviews Psychology): "little support for EWS based on CSD in clinical psychology"
- Smit et al. 2025: **32.9% sensitivity**, 83.8% specificity in depression transition detection (N=37, EMA 5x/day, 4 months)
- Schiepek's 89% figure: **NOT REPLICATED** in subsequent studies
- ML-based CSD detection outperforms traditional AR(1)+variance in 6/8 system comparisons (Communications Physics, 2025)

**Implication**: The criticality family needs honest sensitivity claims and ML-augmented alternatives, not removal.

**Confidence**: 95% on diagnosis, 85% on fix

### 1.4 Coherence — The Most Universal Metric

The universal coherence formula `C(a,b) = |<a(t) . b*(t+tau)>| / sqrt(<|a|^2> . <|b|^2>)` appears in every domain measured across 300+ papers.

**Key insight**: Maximum consciousness is NOT maximum coherence (1.0 = rigidity) — it's the partially coherent zone (~0.4-0.8), edge of criticality.

**Clinical anchor**: Bedi et al. 2015 — declining semantic coherence predicts psychosis onset (100% accuracy in clinical high-risk cohort). **MASSIVE overclaim risk**: accuracy was on 34 high-risk youths, 5 of whom transitioned — the most overfit result in the field.

**Confidence**: 95%

### 1.5 Information Harmonics — Mycelium's Novel Frontier

**Nobody has applied PAC/PLV/spectral coherence methods from neuroscience to text information contours** — this is Mycelium's unique contribution.

**Validation chain**:
- Tsipidi et al. ACL 2025: surprisal contours exhibit harmonic structure at discourse-unit scales
- Biemann et al. 2024 (Behavior Research Methods): clinically validated bigram semantic distance features — schizophrenia = fewer slope sign changes; depression = higher autocorrelation
- SpecDetect 2025: FFT on embedding-distance sequences carries meaningful harmonic structure
- arXiv:2406.03707: autoregressive embeddings encode predictive sufficient statistics — cosine distance is a principled surprisal proxy

**The v1.1 Tier 2->1 pivot was correct**: retains 80-90% of signal at sentence-level-and-above, eliminates LLM dependency.

**Missing**: Wavelet decomposition should be default over FFT (handles non-stationarity; WaveletGPT 2024). No Latvian validation milestone scheduled. NEPA upgrade path should be prioritized.

**Confidence**: 90%

### 1.6 The Keyword-to-Embedding Paradigm Shift

**Key paper**: Pokropek 2026, "From keyword-based text measures to latent variables: confirmatory factor analysis with word embeddings" (EPJ Data Science) — demonstrates that keyword-based constructs can be reformulated as latent variables in embedding space using CFA on cosine similarities.

**Principle**: If a measure counts occurrences of predetermined words, it is keyword-based. If it uses a fixed lexicon to score sentiment, it is keyword-based. If it uses a regex to detect grammatical patterns, it is keyword-based (regex is just a keyword pattern with wildcards). Model-based approaches (spaCy dependency parsing, embedding geometry) are NOT keyword-based — they learn representations, not match strings.

**Structural consequence**: Embedding-anchor clusters (small sets of ~10 seed phrases per construct) replace all word-list dependencies. This eliminates:
- Per-language word-list maintenance
- LIWC licensing issues
- The Latvian word-list gap (structurally, not as a workaround)
- Paraphrase blindness inherent in keyword matching

### 1.7 Compression and Complexity

- Huang et al. COLM 2024: r = -0.95 between compression efficiency and benchmark intelligence in LMs
- Wang et al. PNAS 2025: human brain is 96% compressible
- LZ76 (Lempel-Ziv 1976): mathematically validated, well-understood
- The broken gzip-on-ciphertext metric (~0.70 constant) is correctly identified and graveyarded
- Assembly Theory (Cronin/Walker): future companion — hierarchical composition complexity

**Confidence**: 90%

### 1.8 Personality from Text

- ICLR 2026: LLM-as-rater achieves r = 0.38-0.64 vs validated instruments
- ActTraitBench: Knowledge-Decision Gap — LLMs that know personality traits don't reliably exhibit them in behavior; gap WIDENS with scale
- Machine Psychometrics: IRT-based profiling more informative than single Big Five scores
- SLMs measure prompt artifacts, not psychological constructs

**Assessment**: Keep as opt-in with maximum overclaim guardrails.

**Confidence**: 85%

### 1.9 Embedding Trajectories and Dynamical Systems

- Bedi et al. 2015: semantic space literally shrinks in psychosis (confirmed across 5+ languages)
- arXiv:2602.16273: Lyapunov spectral analysis of speech embeddings robustly separates psychotic from healthy speech
- PLRNNs (npj Digital Medicine 2025): nonlinear state-space models outperform transformers for mood forecasting
- simlandr (Li/Xu 2022): potential landscapes for psychological states — basins of attraction, barrier heights

**Missing**: Potential landscape estimation would allow visualization of attractor basins — "where your thinking tends to settle and what it takes to shift."

**Confidence**: 85%

### 1.10 Topological Data Analysis

- arXiv:2506.14836: persistence entropy on embedding trajectories detects narrative shifts
- TDA on fMRI data is well-established; text application is frontier
- Wasserstein distance between persistence diagrams provides cleaner event detection

**Confidence**: 75%

---

# Part II: Design

## 2. Design Principles and Constraints

### 2.1 Multi-Tier Privacy Architecture

| Tier | Access Level | Description |
|---|---|---|
| **Tier 0** | Territory IDs only | No content access. Phase, territory activation, topology metrics. |
| **Tier 1** | Embedding-aware | Nomic 256D vectors. Geometric/spectral analysis. No plaintext. |
| **Tier 2** | Plaintext-aware | Decrypted text. Linguistic, compression, personality metrics. |
| **Tier 3** | Sensor-aware (future) | EEG/HRV hardware data. Deferred to post-Phase 6. |

**Design constraint**: Every metric must justify its tier. Tier 2 metrics require AppArmor profiles, process isolation, and audit rows. Tier upgrades (moving a metric to a lower tier) are always preferred.

### 2.2 Spec-Sheet Template (10 Fields)

Every metric MUST populate these fields before shipping:

1. **Identity** — canonical_name, tier, owning_stage, schema_location
2. **Semantic** — one_line, bounds, interpretation, unit_of_change
3. **Algorithm** — formula, canonical_impl, cross_language, dependencies
4. **Inputs** — window_types, time_horizon, baseline_reference, per_message_or_per_window
5. **Honesty contract** — noise_floor, staleness_budget, per_language_calibration, known_failure_modes
6. **Scientific rigor** — label (validated-clinical / validated-mathematical / well-grounded-heuristic / experimental), literature, validation_evidence, predictive_validity_in_mycelium_context
7. **Presentation contract** — agent_may_say, agent_must_not_say, refusal_mode, user_voice_grounding, portal_surface
8. **Threat-model delta** — tier_justification, plaintext_exposure_scope, apparmor_profile, audit_event
9. **Method family** — family, shared_pipeline
10. **Cross-scale shape** — scales, cross_scale_aggregation, harmonic_decomposition

### 2.3 Construct Validity Protocol (CVP) — Mandatory Gate

Every Tier 1 metric using embedding geometry must pass CVP before shipping:

1. **Discriminant validity**: metric varies with target construct, not confounds
2. **Incremental validity**: metric adds signal over simpler baselines (word count, message count)
3. **Confound neutralization**: controlled for topic, style, authorship axes

This is a ~2-day audit per metric family, not per metric.

### 2.4 Anchor Cluster Management

The embedding-anchor approach (replacing all keyword-based measures) introduces a system component: **anchor cluster definitions**. These are small sets of seed phrases (~10 per construct) defining semantic regions in Nomic 256D space.

**Requirements**:
- Version controlled (anchor changes = metric changes)
- Per-construct validation (does the cluster capture the construct?)
- Periodic review (embedding model updates may shift positions)
- One-time setup cost that eliminates ongoing per-language word-list maintenance

### 2.5 Null Model Z-Scores

Every metric must have a null-model companion: "what would this metric's value be for shuffled/random data?" The Fisher-trajectory pipeline already computes null-model z-scores — extend this pattern to every family.

### 2.6 Bootstrap Confidence Intervals (S3)

For metrics where observed N is within a small multiple of the noise-floor minimum, emit bootstrap CIs alongside point estimates: 1000-sample bootstrap, report (median, 5th, 95th percentile). Tier 1 initially; Tier 2 deferred.

## 3. Metric Design Decisions

### 3.1 Summary of All Decisions

| Metric | Section | Current Method | Decision | Replacement/Change | Tier |
|---|---|---|---|---|---|
| `phase_recent` | 4.1 | Fisher-Rao + Hellinger | **KEEP** | — | 0 |
| `dominant_territories_recent` | 4.2 | Top-N territory IDs | **KEEP** | — | 0 |
| `embedding_stance_shift_within_territory` | 4.3 | STUB | **KEEP + REFINE** | Centroid drift only (not LLM-tagged) | 1 |
| `territory_recurrence_interval` | 4.4 | Time-since-last-active | **KEEP** | — | 0 |
| `insight_word_density` | 4.5 | Word-list (LIWC/Empath) | **REPLACE** | `insight_embedding_proximity` | 2->1 |
| `tense_shift_density` | 4.6 | Verb-tense regex | **REPLACE** | `temporal_frame_shift_density` (spaCy morph) | 2->2 |
| `lexical_diversity_mtld` | 4.7 | McCarthy & Jarvis MTLD | **KEEP** | — | 2 |
| `lexical_diversity_hdd` | 4.8 | HD-D hypergeometric | **KEEP** | — | 2 |
| `mean_sentence_length` | 4.9 | Tokens per sentence | **KEEP** | Mandate spaCy sentencizer (not regex) | 2 |
| `syntactic_depth` | 4.10 | spaCy dependency parser | **KEEP** | Already model-based | 2 |
| `inner_territory_presence` | 4.11 | STUB | **KEEP + REFINE** | Embedding-space distance to "reflection" anchor | 1 |
| `reflective_marker_density` | 4.12 | Word-list match | **REPLACE** | `reflective_embedding_density` | 2->1 |
| `sentiment_volatility_within_window` | 4.13 | VADER lexicon | **REPLACE** | `affective_volatility_within_window` (embedding affect proxy) | 2->1 |
| `sentiment_polarity_trend` | 4.14 | GRAVEYARDED v1.2 | — | Redundant with 4.13 + 4.33 | — |
| `cofire_new_edge_rate` | 4.15 | Edge counting | **KEEP** | — | 0 |
| `cofire_delta` | 4.16 | Graph delta | **KEEP** | — | 0 |
| `cofire_edge_half_life` | 4.17 | Per-edge decay | **KEEP** | — | 0 |
| `compression_ratio_lz76_plaintext` | 4.18 | LZ76 on plaintext | **KEEP** | — | 2 |
| `embedding_novelty_ratio` | 4.19 | NN distance fraction | **KEEP** | — | 1 |
| `conceptual_breadth_embedding_entropy` | 4.20 | Embedding entropy | **KEEP + REFINE** | Add CVP validation | 1 |
| `per_language_message_share` | 4.21 | Language detection | **KEEP** | — | 0 |
| `activation_smoothness` | 4.22 | Fisher velocity z | **KEEP** | — | 0-1 |
| `information_harmonic_amplitude` | 4.23 | FFT on embedding-distance | **KEEP** | Wavelet over FFT as default | 1 |
| `cross_scale_coupling` | 4.24 | PAC/PLV/coherence | **KEEP** | — | 1 |
| `critical_slowing_autocorrelation` | 4.25 | AR(1) coefficient | **KEEP + REFINE** | Update sensitivity claims (32.9%, not 89%) | 0 |
| `critical_slowing_variance` | 4.26 | Rolling K stddev | **KEEP + REFINE** | Companion only, not standalone | 0 |
| `phase_lock_event_sigma` | 4.27 | Cross-scale z-scores | **KEEP** | — | 0 |
| `lyapunov_exponent_trajectory` | 4.28 | Rosenstein 1993 | **KEEP + REFINE** | Min 100 trajectory points, low_confidence | 1 |
| `anchor_band_concentration` | 4.29 | Territory count above threshold | **KEEP** | — | 0 |
| `integrative_complexity_score` | 4.30 | AutoIC / trained classifier | **KEEP** | Verify not keyword-based at implementation | 2 |
| `semantic_coherence_adjacent` | 4.31 | Cosine similarity | **KEEP** | — | 1 |
| `compression_intelligence_proxy` | 4.32 | Same as 4.18 | **REMOVE** | Fold into 4.18 prose | — |
| `bigram_flow_features` | 4.33 | Time-domain features | **KEEP** | — | 1 |
| `topology_persistence_entropy` | 4.34 | TDA persistence | **KEEP + REFINE** | Add Wasserstein distance for event detection | 1 |
| `big_five_text_estimate` | 4.35 | LLM-as-rater | **KEEP** (opt-in) | Defaults OUT | 2 |

### 3.2 Keyword Elimination — Detailed Replacements

The following 5 metrics had keyword/lexicon/regex dependencies and are replaced with embedding-based alternatives:

#### 3.2.1 `insight_word_density` -> `insight_embedding_proximity`

**Old**: Word-list match (LIWC/Empath) per window / total tokens. Counts occurrences of predetermined "insight words."

**New**: For each message embedding, compute cosine similarity to an "insight/reflection" anchor cluster in Nomic 256D space. Anchor cluster defined by ~10 seed phrases ("I just realized", "now I understand", "looking back I see") embedded once at system init. Per-window metric = mean proximity to insight anchor across messages.

**Tier change**: 2 -> 1 (no plaintext needed)
**Advantages**: Language-agnostic, captures paraphrases, no word-list licensing, eliminates Latvian gap
**Validation**: Correlate with human-rated insight scores; Pokropek 2026 CFA framework for psychometric validation
**Confidence**: 90%

#### 3.2.2 `tense_shift_density` -> `temporal_frame_shift_density`

**Old**: Verb-tense regex per language (language-specific keyword templates).

**New**: Use spaCy/Stanza morphological analysis (neural model, not regex) to extract verb tense tags per message. Count tense transitions within window. SpaCy's `Token.morph` provides `Tense=Past|Pres|Fut` from a trained model.

**Tier change**: 2 -> 2 (still needs tokenized text, but model-based not regex)
**Fallback for Tier 1**: Embedding-distance between consecutive messages captures temporal reorientation as geometric signal
**Confidence**: 85%

#### 3.2.3 `reflective_marker_density` -> `reflective_embedding_density`

**Old**: Word-list match (insight words + negation + tense-shift markers).

**New**: Cosine similarity of each message embedding to a "reflection" anchor cluster (seed phrases: "looking back", "I've been thinking about", "what I notice is", "on reflection", "I wonder if", "when I consider"). Per-window metric = fraction of messages above calibrated proximity threshold.

**Tier change**: 2 -> 1
**Relationship to insight proximity**: Distinct anchor clusters — insight = "aha moment" realization; reflection = deliberate self-examination. May correlate but capture different cognitive processes.
**Confidence**: 90%

#### 3.2.4 `sentiment_volatility_within_window` -> `affective_volatility_within_window`

**Old**: Stddev of per-message sentiment polarity via VADER (English lexicon with ~7,500 predetermined words + punctuation/capitalization rules).

**New**: Per-message affective valence via embedding-space affect proxy:
1. Define positive/negative affect anchor clusters in Nomic 256D space (~10 prototypical emotional expressions each)
2. For each message embedding: `affect_score = cos_sim(msg, positive_anchor) - cos_sim(msg, negative_anchor)`
3. Per-window metric = stddev of `affect_score` across messages in window

**Tier change**: 2 -> 1 (a tier UPGRADE)
**Advantages**: Language-agnostic, no sentiment model maintenance, captures affect from context not just word valence
**Calibration**: Validate against human affect ratings
**Confidence**: 85%

#### 3.2.5 Proposed additions — also replaced before adding

**`discourse_connective_density` -> `discourse_coherence_embedding`**:
- Old (proposed): Word-list count of connectives (but, however, therefore, because)
- New: Cosine similarity of consecutive message pairs. High local coherence = smooth embedding transitions; low = abrupt topic shifts. Per-window = mean pairwise cosine sim of consecutive messages.
- Captures whether ideas ARE linked (semantic continuity) rather than whether the writer SIGNALS the link with a connective word
- Tier: 1. Confidence: 80%

**`hedging_certainty_markers` -> `epistemic_stance_embedding`**:
- Old (proposed): Regex + POS patterns ("I think", "maybe", "definitely")
- New: Cosine similarity to "certainty" vs "uncertainty" anchor clusters. Per-message score = `cos_sim(msg, certainty) - cos_sim(msg, uncertainty)`. Per-window = mean score (positive = settled, negative = exploratory).
- Captures epistemic stance from full context — "I think this is definitely wrong" would confuse keyword matcher but not embedding model
- Tier: 1. Confidence: 80%

### 3.3 Metrics Confirmed NOT Keyword-Based

These were reviewed and confirmed model-based or algorithmic:
- **`lexical_diversity_mtld`** (4.7) — algorithmic (type-token computation). No word lists.
- **`lexical_diversity_hdd`** (4.8) — algorithmic (hypergeometric distribution). No word lists.
- **`syntactic_depth`** (4.10) — spaCy neural dependency parser. Model-based.
- **`mean_sentence_length`** (4.9) — structural measurement. Sentence boundary detection mandated to use spaCy sentencizer (model-based) instead of regex.
- **`integrative_complexity_score`** (4.30) — if implemented via trained classifier (not keyword rules). Needs verification at implementation time; if AutoIC follows keyword-based coding rules, implement via embedding-space measurement of differentiation and integration instead.

### 3.4 New Metrics to Add (13)

| # | Metric | Family | Tier | Source |
|---|---|---|---|---|
| 1 | `flickering_detection` | criticality | 0 | Alternation between two prior states before commitment |
| 2 | `ml_transition_detector` | criticality | 0-1 | CNN-LSTM on Mycelium trajectory data (Comms Physics 2025) |
| 3 | `entity_grid_coherence` | coherence | 2 | Barzilay & Lapata 2008; discourse structure via NER |
| 4 | `discourse_coherence_embedding` | coherence | 1 | Replaces keyword-based connective density (see 3.2.5) |
| 5 | `metaphor_density` | linguistic-structural | 1 | Cosine distance between literal/contextual embeddings |
| 6 | `epistemic_stance_embedding` | linguistic-structural | 1 | Replaces keyword-based hedging markers (see 3.2.5) |
| 7 | `narrative_arc_shape` | linguistic-structural | 1 | Reagan et al. 2016; emotional arc via embedding trajectory |
| 8 | `emotional_inertia` | affect | 1-2 | AR(1) of affect time series (Kuppens 2010) |
| 9 | `affect_complexity` | affect | 2 | Entropy of emotion distribution (Gruhn 2013; GoEmotions) |
| 10 | `memory_depth_sensitivity` | topology-graph | 0 | Graph metric changes when varying lookback window K |
| 11 | `graph_spectral_gap` | topology-graph | 0 | Algebraic connectivity (Fiedler value) of cofire graph |
| 12 | `diurnal_pattern_metrics` | behavioral-temporal | 0 | Time-of-day writing patterns (volume, topic, affect) |
| 13 | `session_cadence_regularity` | behavioral-temporal | 0 | Entropy of inter-session intervals |

### 3.5 Structural Consequences of Keyword Elimination

**Tier upgrades**: 3 metrics move from Tier 2 -> Tier 1 (insight, reflection, sentiment). This means:
- Less plaintext decryption needed
- Smaller Tier 2 attack surface
- Faster computation (no decrypt-compute-discard cycle)
- Latvian parity from day 1

**Family reorganization**: The `linguistic-lexical` family loses 3 of its 8 members to Tier 1 embedding methods. Remaining members (MTLD, HDD, mean_sentence_length, syntactic_depth, integrative_complexity) are all model-based or algorithmic. **Rename to `linguistic-structural`**.

The `affect` family's primary member (4.13) moves to Tier 1 embedding methods. It absorbs the new `emotional_inertia` and `affect_complexity` additions.

---

# Part III: Implementation Specification

## 4. Implementation Specification — Per Metric

### Information Geometry Family

#### 4.1 `phase_recent` — LIVE

- **Tier**: 0 (territory-only)
- **Algorithm**: `classify_phase(L_K, R_recent)` with `K = max(2, ceil(90/stride))`. `R_recent = D_K / L_K` over rolling-K-window using Bhattacharyya/Hellinger geodesic on categorical simplex (Fisher-Rao).
- **Output**: enum `cycling | exploring | consolidating | breakthrough`
- **Rigor**: `validated-mathematical` (Cencov 1982 uniqueness) + `well-grounded-heuristic` (four-phase classification thresholds)
- **Noise floor**: `i + 1 >= K_recent AND NOT step.low_confidence`
- **Presentation**: MAY: "You've been in {phase} phase for the last {N} weeks." MUST NOT: diagnose or compare to clinical categories.
- **Pipeline**: Shared with 4.20, 4.22, 4.27 — all consume same `p_w(t)` simplex distributions
- **Empirical anchor**: 24 weeks cycling preceding May 5 35.5sigma phase-lock event

#### 4.2 `dominant_territories_recent` — STUB

- **Tier**: 0
- **Algorithm**: Top-N territory IDs by activation share over rolling 90 days
- **Open**: N parameter; minimum activation threshold

#### 4.3 `embedding_stance_shift_within_territory` — STUB, REFINED

- **Tier**: 1
- **Design decision**: Embedding centroid drift only (not LLM-tagged stance). Reproducible + cheap. Centroid drift across a territory's clustering_points across time.
- **Pipeline**: information-geometry family

#### 4.4 `territory_recurrence_interval` — STUB

- **Tier**: 0
- **Algorithm**: Time-since-last-active-window per territory
- **Schema**: `cognitive_metrics_per_territory` table

#### 4.5 `insight_embedding_proximity` (replaces `insight_word_density`)

- **Tier**: 1 (upgraded from 2)
- **Algorithm**: For each message embedding `e_m`, compute `cos_sim(e_m, C_insight)` where `C_insight` is the centroid of the insight anchor cluster (seed phrases: "I just realized", "now I understand", "looking back I see", "it occurred to me", "I finally see", "what I'm noticing", "the connection I'm making", "this changes how I think about", "I hadn't considered", "now it makes sense"). Per-window metric = mean proximity across messages.
- **Rigor**: `well-grounded-heuristic`. Theoretical basis: Garten et al. 2018 "Dictionaries and Distributions"; Pokropek 2026 CFA formalization.
- **Validation path**: Correlate with human-rated insight scores on held-out journal set. CVP mandatory before shipping.
- **Per-language**: Nomic handles multilingual; Latvian works structurally. Low_confidence until Latvian-specific validation.
- **Pipeline**: New embedding-anchor pipeline (shared with 4.12, 4.13 replacements)

#### 4.6 `temporal_frame_shift_density` (replaces `tense_shift_density`)

- **Tier**: 2 (model-based, not regex)
- **Algorithm**: Use spaCy/Stanza morphological analysis to extract verb tense tags (`Token.morph -> Tense=Past|Pres|Fut`) per message. Count tense transitions (past->present, present->future, etc.) within window. Normalize by total verbs.
- **Tier 1 fallback**: Embedding-distance between consecutive messages captures temporal reorientation as geometric signal (messages about past vs future occupy different regions of embedding space).
- **Per-language**: spaCy (English), Stanza (Latvian — adequate coverage).
- **Pipeline**: linguistic-structural family

#### 4.7 `lexical_diversity_mtld` — STUB

- **Tier**: 2
- **Algorithm**: McCarthy & Jarvis (2010) MTLD. Length-robust type-token diversity.
- **Rigor**: `validated-clinical`. Gold standard for length-independent lexical diversity.
- **Pipeline**: linguistic-structural family (shared decrypt-and-tokenize pass)

#### 4.8 `lexical_diversity_hdd` — STUB

- **Tier**: 2
- **Algorithm**: McCarthy & Jarvis (2007) HD-D. Hypergeometric distribution of types.
- **Pipeline**: linguistic-structural family

#### 4.9 `mean_sentence_length` — STUB

- **Tier**: 2
- **Algorithm**: Tokens-per-sentence, mean across window. **Sentence boundary detection via spaCy sentencizer** (model-based `senter` component, NOT regex).
- **Pipeline**: linguistic-structural family

#### 4.10 `syntactic_depth` — STUB

- **Tier**: 2
- **Algorithm**: Dependency-tree depth via spaCy lightweight model (neural, not keyword). Latvian via Stanza.
- **Pipeline**: linguistic-structural family

#### 4.11 `inner_territory_presence` — STUB, REFINED

- **Tier**: 1
- **Design decision**: Auto-derived via embedding-space distance to a "reflection" anchor (not operator-curated lists, not LLM-suggested). Tier 1 compatible.
- **Pipeline**: Shares anchor-cluster infrastructure with 4.5

#### 4.12 `reflective_embedding_density` (replaces `reflective_marker_density`)

- **Tier**: 1 (upgraded from 2)
- **Algorithm**: Cosine similarity of each message embedding to "reflection" anchor cluster. Anchor seeds: "looking back", "I've been thinking about", "what I notice is", "on reflection", "I wonder if", "when I consider", "as I examine this", "stepping back I see", "what strikes me", "the pattern I notice". Per-window metric = fraction of messages above calibrated proximity threshold.
- **Relationship to 4.5**: Distinct construct. Insight = "aha moment" realization. Reflection = deliberate self-examination. Different anchor clusters.
- **Rigor**: `well-grounded-heuristic`. Same validation framework as 4.5.
- **Pipeline**: Embedding-anchor pipeline

#### 4.13 `affective_volatility_within_window` (replaces `sentiment_volatility_within_window`)

- **Tier**: 1 (upgraded from 2)
- **Algorithm**:
  1. Define positive/negative affect anchor clusters in Nomic 256D space (~10 prototypical emotional expressions each)
  2. For each message embedding: `affect_score = cos_sim(msg, positive_anchor) - cos_sim(msg, negative_anchor)`
  3. Per-window metric = stddev of `affect_score` across messages
- **Rigor**: `well-grounded-heuristic`. Less granular than VADER for English, but VADER's English-only limitation disqualifies it for a multilingual system. Tier 1 upgrade alone justifies switch.
- **Validation**: Validate embedding affect proxy against human affect ratings.
- **Pipeline**: Embedding-anchor pipeline

### Topology-Graph Family

#### 4.15 `cofire_new_edge_rate` — STUB

- **Tier**: 0
- **Algorithm**: Count of cofire edges in current window not in prior K windows / total edges.

#### 4.16 `cofire_delta` — STUB

- **Tier**: 0

#### 4.17 `cofire_edge_half_life` — STUB

- **Tier**: 0. Per-edge metric; needs new schema grain.

#### 4.29 `anchor_band_concentration` — STUB

- **Tier**: 0
- **Algorithm**: Count of territories with stable activation share > threshold over rolling 90d. Decreases = identity concentrating; increases = identity diffusing.
- **Empirical anchor**: May 5 event narrowed Martin's territories from 21 -> 15.

### Compression-Novelty Family

#### 4.18 `compression_ratio_lz76_plaintext` — STUB

- **Tier**: 2
- **Algorithm**: True textbook LZ76 implementation on per-window concatenated plaintext. NOT the JS approximation.
- **Rigor**: `validated-mathematical` for LZ76 itself. Carry-over to journaling content not yet validated.
- **Presentation**: MUST NOT translate compressibility to "intelligence" claims about the user.
- **Note**: 4.32 `compression_intelligence_proxy` folded into this metric's prose as a literature reference only.

#### 4.19 `embedding_novelty_ratio` — STUB

- **Tier**: 1
- **Algorithm**: Fraction of embeddings in current window whose nearest-neighbor distance in prior K windows exceeds threshold.
- **Role**: Tier 1 cross-check on compression-novelty signal.

### Information Harmonics Family

#### 4.23 `information_harmonic_amplitude` — STUB

- **Tier**: 1 (pivoted from 2 in v1.1)
- **Algorithm**: For consecutive embedding pairs `(e_t, e_{t+1})`: compute `info_value(t) = cosine_distance(e_t, e_{t+1})`. Aggregate at each band (gamma=raw, beta=10-msg mean, alpha/theta/delta=calendar). Harmonic regression per Tsipidi method on embedding-distance signal. Extract amplitude `A_k = sqrt(beta_1k^2 + beta_2k^2)` per harmonic order k=1..K per band.
- **Bands**: gamma (message), beta (conversation/~10msgs), alpha (day), theta (week), delta (month)
- **Rigor**: `validated-clinical` (Biemann 2024), `validated-mathematical` (arXiv:2406.03707 + harmonic regression), `experimental` for longitudinal personal-journal application
- **Default**: Wavelet decomposition over FFT (handles non-stationarity; WaveletGPT 2024)
- **Latvian**: Structurally works but Nomic Latvian corpus thin; spectral properties unverified. Low_confidence until validated.
- **Pipeline**: Shared with 4.24, 4.33, 4.34 — one embedding-distance stream feeds all four

#### 4.24 `cross_scale_coupling` — STUB

- **Tier**: 1
- **Algorithm**: Three sub-metrics per pair of adjacent bands:
  - `pac_<low>_<high>`: Phase-amplitude coupling (Tort et al. 2010 method)
  - `plv_<low>_<high>`: Phase-locking value `|<exp(i . delta_phi(t))>|`
  - `coh_<low>_<high>`: Spectral coherence `C_xy(f) = |S_xy(f)|^2 / (S_xx(f) . S_yy(f))`
- **Rigor**: `validated-mathematical` for PAC/PLV/coherence (decades of EEG literature). `experimental` for text-derived bands.
- **Presentation**: MAY: "Your day-scale and week-scale information rhythms are more coupled than usual." MUST NOT claim specific psychological meaning ("more coupled" != "better").
- **Risk**: Stationarity assumption. Mitigation: windowed analysis + wavelet decomposition.
- **Schema**: ~10 columns (5 bands choose 2 pairs)

#### 4.33 `bigram_flow_features` — STUB

- **Tier**: 1
- **Algorithm**: Time-domain features on the `info_value(t)` series from 4.23:
  - `mean_crossing_rate` — how often signal crosses its mean
  - `slope_sign_change_rate` — frequency of direction changes (low = rigid, per Biemann schizophrenia finding)
  - `autocorrelation_lag1` — persistence of flow patterns (high = stuck, per Biemann depression finding)
  - `variance` — volatility of information content
  - `total_spectral_energy` — sum of squared signal
- **Rigor**: `validated-clinical` (Biemann 2024 psychiatric conversations). Carry-over caveat applies.
- **Implementation**: ~30 LOC numpy ops. Highest signal-to-effort ratio in the battery.
- **Presentation**: MAY: "Your information flow has been more rigid than usual." MUST NOT: diagnose clinical conditions.

#### 4.34 `topology_persistence_entropy` — STUB, REFINED

- **Tier**: 1
- **Algorithm**: Per window: collect message embeddings -> Vietoris-Rips filtration -> persistence diagram -> persistence entropy `H = -sum (l_i / L) log(l_i / L)`. Libraries: `gudhi` or `ripser`.
- **Addition**: Wasserstein distance between consecutive windows' persistence diagrams for event detection (narrative shift).
- **Rigor**: `validated-mathematical` for TDA. `experimental` for journal application.

### Criticality-Phase-Transitions Family

#### 4.25 `critical_slowing_autocorrelation` — STUB, REFINED

- **Tier**: 0
- **Algorithm**: AR(1) coefficient on rolling K-window of source metric. Threshold calibrated per-user.
- **CRITICAL UPDATE**: Schiepek 89% has NOT replicated.
  - Smit et al. 2025 (prospective, gold-standard EMA): **32.9% sensitivity**, 83.8% specificity
  - Combined approach (multiple variables x methods): ~3x single-method detection
  - ML-augmented (CNN-LSTM on surrogates): outperforms classic in 6/8 systems
- **Presentation**: MAY: "Your reflection patterns have been slowing down for {N} weeks — the literature describes this as an early-warning signature." MUST NOT: predict direction of transition (EWS are direction-blind). MUST NOT: cite 89% sensitivity.
- **Pipeline**: Shared with 4.26, 4.27, 4.28

#### 4.26 `critical_slowing_variance` — STUB, REFINED

- **Tier**: 0
- **Algorithm**: Rolling-K stddev of source metric. Joint flag with 4.25 for "early warning detected."
- **Role**: COMPANION to AR(1), not standalone. Joint detection shows 3x improvement over individual.

#### 4.27 `phase_lock_event_sigma` — STUB

- **Tier**: 0
- **Algorithm**: For each (realm, theme, territory) per-week velocity series, compute z-score against per-user 90d baseline. If all three exceed threshold simultaneously -> emit event row.
- **Thresholds**: >=10sigma joint = "notable", >=30sigma joint = "rare"
- **Rigor**: `well-grounded-heuristic` (standard multivariate anomaly detection). Empirically confirmed: May 5 event (realm 35.5sigma, theme 28.2sigma, territory 31.8sigma).
- **Schema**: `cognitive_events` table (discrete events, not per-window scalars)

#### 4.28 `lyapunov_exponent_trajectory` — STUB, REFINED

- **Tier**: 1
- **Algorithm**: Rosenstein 1993 algorithm (preferred over Wolf 1985 for noisy short series) on embedding-space trajectory points.
- **Refinement**: Require >= 100 trajectory points. Add `low_confidence: true` for windows below threshold. Noise floor is high — needs empirical calibration.

### Coherence Family

#### 4.31 `semantic_coherence_adjacent` — STUB

- **Tier**: 1
- **Algorithm**: Mean cosine similarity of consecutive utterance embedding pairs within window.
- **Rigor**: `validated-clinical` in clinical pre-psychotic cohort (Bedi 2015). **MASSIVE overclaim risk** — predictive validity is for psychosis onset in high-risk individuals, not general journaling.
- **Presentation**: MAY: "Your sentence-to-sentence semantic flow is {higher/lower} than your baseline." MUST REFUSE: anything clinical or diagnostic.

### Linguistic-Structural Family (renamed from linguistic-lexical)

#### 4.30 `integrative_complexity_score` — STUB

- **Tier**: 2
- **Algorithm**: AutoIC scorer or trained classifier on plaintext. **IMPLEMENTATION NOTE**: If AutoIC follows keyword-based coding rules, implement via embedding-space measurement of differentiation (topic spread) and integration (cross-topic bridging) instead.
- **Rigor**: `validated-clinical`. Suedfeld & Tetlock (1977 onward, 30+ years).
- **Presentation**: MAY: "Your integrative complexity is {N}/7 this week — higher than your baseline." MUST NOT: compare to clinical norms.

### Personality-Text Family

#### 4.35 `big_five_text_estimate` — STUB (defaults OUT)

- **Tier**: 2
- **Algorithm**: LLM-as-rater per ICLR 2026 method, calibrated against IPIP-NEO. Ensemble across multiple prompts.
- **Rigor**: `validated-clinical` at population level (r = 0.38-0.64). 0.36-0.62 unexplained variance is honestly acknowledged.
- **Upgrade path**: IRT-based Machine Mindprint (multidimensional) > single Big Five vector.
- **Presentation**: MUST attach qualifier every time. MUST NOT compare to population norms.

### Behavioral-Temporal Family

#### 4.21 `per_language_message_share` — STUB

- **Tier**: 0
- **Open**: Language detection at ingest — needs verification.

### New Metrics (from SOTA comparison)

#### NEW: `flickering_detection`

- **Tier**: 0
- **Family**: criticality-phase-transitions
- **Algorithm**: Detect alternation between two prior states before commitment. Standard CSD companion.
- **Pipeline**: Shared with 4.25, 4.26, 4.27

#### NEW: `ml_transition_detector`

- **Tier**: 0-1
- **Family**: criticality-phase-transitions
- **Algorithm**: CNN-LSTM classifier on surrogate data, trained on Mycelium's own trajectory data. Outperforms classic EWS in 6/8 system comparisons (Communications Physics, 2025).
- **Status**: Requires sufficient trajectory data before training.

#### NEW: `entity_grid_coherence`

- **Tier**: 2
- **Family**: coherence-universal
- **Algorithm**: Barzilay & Lapata (2008) entity-grid model. Measures how entities (people, topics) are introduced and maintained across sentences.
- **Value**: Captures discourse structure that cosine similarity misses.

#### NEW: `discourse_coherence_embedding`

- **Tier**: 1
- **Family**: coherence-universal
- **Algorithm**: Mean pairwise cosine similarity of consecutive message embeddings. Measures semantic continuity (whether ideas are linked) rather than signaling (whether writer uses connective words).

#### NEW: `metaphor_density`

- **Tier**: 1
- **Family**: linguistic-structural
- **Algorithm**: Cosine distance between literal and contextual embeddings of target phrases. High distance = more metaphorical. Per Momen & Zarriess (Day 18).

#### NEW: `epistemic_stance_embedding`

- **Tier**: 1
- **Family**: linguistic-structural
- **Algorithm**: `cos_sim(msg, certainty_anchors) - cos_sim(msg, uncertainty_anchors)`. Certainty seeds: "I'm sure that", "clearly", "without doubt", "I know". Uncertainty seeds: "I'm not sure", "maybe", "it might be", "I wonder". Per-window = mean score.

#### NEW: `narrative_arc_shape`

- **Tier**: 1
- **Family**: linguistic-structural
- **Algorithm**: Per Reagan et al. 2016 — detect 6 fundamental narrative arcs via sentiment/embedding trajectory shape over window or month.

#### NEW: `emotional_inertia`

- **Tier**: 1-2
- **Family**: affect
- **Algorithm**: AR(1) of affect time series (same math as CSD 4.25 but applied to affect instead of territory distributions). Measures how "stuck" emotional states are. Kuppens et al. 2010: predicts depression, maladjustment.

#### NEW: `affect_complexity`

- **Tier**: 2
- **Family**: affect
- **Algorithm**: Entropy over detected emotions per window. Requires multi-label emotion detection (GoEmotions model). Gruhn et al. 2013: multiple simultaneous emotions associated with better health outcomes.

#### NEW: `memory_depth_sensitivity`

- **Tier**: 0
- **Family**: topology-graph
- **Algorithm**: Compute how graph metrics change when varying lookback window K. If behavior reverses at some K, that's a structural insight about cognitive network topology. Per Day 23 finding (arXiv:2606.04197).

#### NEW: `graph_spectral_gap`

- **Tier**: 0
- **Family**: topology-graph
- **Algorithm**: Algebraic connectivity (Fiedler value) of cofire graph. High = well-connected thinking; low = fragmented clusters. Standard graph theory, cheap to compute.

#### NEW: `diurnal_pattern_metrics`

- **Tier**: 0
- **Family**: behavioral-temporal
- **Algorithm**: Time-of-day patterns in writing (volume, topic, affect). Clinically informative — circadian disruption predicts mood episodes. Cheap to compute from timestamps.

#### NEW: `session_cadence_regularity`

- **Tier**: 0
- **Family**: behavioral-temporal
- **Algorithm**: Entropy of inter-session intervals. Regular cadence = routine/stability; irregular = disruption. No content access needed.

---

## 5. Method Families and Pipeline Architecture

### 5.1 Family Table

| Family | Tier | Metrics | Shared Pipeline |
|---|---|---|---|
| **information-geometry** | 0-1 | 4.1, 4.2, 4.3, 4.4, 4.20, 4.22, 4.28 | Fisher-Rao primitives; embedding-space trajectory builders |
| **information-harmonics** | 1 | 4.23, 4.24, 4.33, 4.34 | Sequential Nomic 256D embedding-distance time series; harmonic-regression; wavelet; PAC/PLV/coherence; numpy/scipy/gudhi only — no LLM, no decryption |
| **criticality-phase-transitions** | 0 | 4.25, 4.26, 4.27, flickering, ml_transition_detector | Time-series statistics on existing fisher_trajectory + topology data |
| **coherence-universal** | 1-2 | 4.31, discourse_coherence_embedding, entity_grid_coherence | Coherence-formula primitives |
| **linguistic-structural** (renamed from linguistic-lexical) | 1-2 | 4.6, 4.7, 4.8, 4.9, 4.10, 4.30, metaphor_density, epistemic_stance_embedding, narrative_arc_shape | Decrypt-once + tokenizer + spaCy/Stanza; embedding anchors for Tier 1 members |
| **affect** | 1-2 | 4.13, emotional_inertia, affect_complexity | Embedding-space affect proxy (Tier 1); GoEmotions model (Tier 2) |
| **embedding-anchor** (new shared infrastructure) | 1 | 4.5, 4.11, 4.12, 4.13 | Anchor cluster definitions + cosine similarity computation; one init per construct |
| **topology-graph** | 0 | 4.15, 4.16, 4.17, 4.29, memory_depth_sensitivity, graph_spectral_gap | Cofire computation; topology_metrics table |
| **compression-novelty** | 1-2 | 4.18, 4.19 | LZ76 on plaintext (Tier 2); embedding NN distance (Tier 1) |
| **integrative-complexity** | 2 | 4.30 | AutoIC or trained classifier (verify not keyword-based) |
| **personality-text** | 2 | 4.35 | LLM-as-rater pipeline (defaults OUT) |
| **behavioral-temporal** | 0 | 4.21, diurnal_pattern_metrics, session_cadence_regularity | Ingest-side metadata (timestamps, language detection) |
| **cross-modal-bridge** | 3 (future) | Neural Bridge placeholder | Deferred to post-Phase 6 |

### 5.2 Implementation Sequencing

**Tier 1 families ship FIRST** (no PR0 Tier-2 prerequisites blocking):
1. `information-geometry` (Phase 1 already shipped)
2. `coherence-universal`
3. `information-harmonics` (largest novel-signal payload)
4. `criticality-phase-transitions`
5. `topology-graph`
6. `embedding-anchor` (new — supports 4.5, 4.11, 4.12, 4.13 replacements)

**Tier 2 families ship SECOND** (behind PR0 prerequisites):
1. `compression-novelty` (replaces broken 4.18; Phase 2.2 priority)
2. `linguistic-structural`
3. `affect` (Tier 2 components only; Tier 1 `affective_volatility` ships with embedding-anchor)
4. `integrative-complexity`
5. `personality-text` (defaults OUT)

### 5.3 PR0 — Gating Prerequisites

| PR0 Work | Blocker For | Priority |
|---|---|---|
| Stage-base extraction (env+D1+log+UPSERT scaffolding) | All Phase 6 family PRs | High |
| Per-Tier-2-family AppArmor template + spawn discipline | First Tier-2 family | High |
| Tier-2 audit row migration | First Tier-2 family | Medium |
| View-alias migration precedent | 4.18 compression rebuild | Low |
| Primitive extensions in `@mycelium/metrics` (per I6) | Per-family (just-in-time) | Medium-High |
| Anchor cluster infrastructure (init, versioning, validation) | 4.5, 4.11, 4.12, 4.13 | Medium |

---

## 6. Structural Integrity Invariants

*(10 invariants from the original spec, load-bearing for Phase 6)*

**I1. Method-family = pipeline stage** — one stage per family, not per metric. Stage registration via `pipeline-health.js`.

**I2. Era-mode skip-existing mandatory** — cache key `(user_id, level, window_type, window_start, clustering_run_id)`. Without era-mode, ~63K wasteful UPSERTs per tick.

**I3. One AppArmor profile + one decryption boundary per Tier-2 family** — per-family process spawn, audit row, crypto_local as ONLY plaintext entry point. No plaintext in stdout/stderr/audit/artifacts/errors.

**I4. Schema follows fisher_trajectory grain; WIDE tables; language column from day 1** — `language TEXT NOT NULL DEFAULT 'en'` added now, not retrofitted. Per-territory grain in separate table. Discrete events in `cognitive_events` table.

**I5. Freshness budget per-family** — one budget per family's primary table in both `metric-budgets.js` (canonical) and `metric-budgets.ts` (Worker mirror).

**I6. Canonical primitives via @mycelium/metrics with 1e-12 cross-language fixtures** — new primitives needed: harmonic regression, wavelet decomposition, PAC/PLV/coherence, AR(1)+variance, MTLD+HDD, LZ76.

**I7. Agent + portal freshness-awareness family-grained** — stale families get hedge text prepended. `low_confidence` per-row is orthogonal to family-level staleness.

**I8. Pipeline-health concurrency: accept what exists** — serial within tick, single global lock. No per-family lanes.

**I9. Phase 6 PR0 gates all family work** — structural debt must be closed first.

**I10. Open structural debt named** — D1 binding name (`mycelium-v2` vs `mycelium-db`); Python-side Tier-2 process spawn.

---

## 7. Use-Case Catalog

### Phase / Cognitive Movement
- **U1.** "You've been cycling between work and family territory this week." -> `phase_recent` + `dominant_territories_recent`
- **U2.** "Compared to last cycle through this territory, your framing is more curious / more guarded." -> `embedding_stance_shift_within_territory`
- **U3.** "This is the first time you've written about [territory] in 8 weeks." -> `territory_recurrence_interval`

### Reflective / Linguistic
- **U4.** "Your writing has felt more reflective lately than in March." -> `insight_embedding_proximity` + `temporal_frame_shift_density`
- **U5.** "Your vocabulary has narrowed since [event anchor]." -> `lexical_diversity_mtld` + `lexical_diversity_hdd`
- **U6.** "Your sentences have gotten shorter and more clipped over the last two weeks." -> `mean_sentence_length` + `syntactic_depth`
- **U7.** "You haven't journaled about your inner life in 5 days — only logistics." -> `inner_territory_presence` + `reflective_embedding_density`

### Affect / Emotional
- **U8.** "You're more affectively volatile this week than your usual pattern." -> `affective_volatility_within_window`

### Topology / Graph
- **U10.** "Your cofire graph picked up a new edge between [A] and [B] this week." -> `cofire_new_edge_rate` + `cofire_delta`
- **U11.** "Two territories that used to be tightly bonded have drifted apart." -> `cofire_edge_half_life`

### Compressibility / Novelty
- **U12.** "Your last week of writing was unusually novel." -> `compression_ratio_lz76_plaintext` + `embedding_novelty_ratio`
- **U13.** "Conceptually you're working in a wider space than usual." -> `conceptual_breadth_embedding_entropy`

### Critical Events / Phase Transitions
- **U16.** "Your scales just locked together — first time in your data." -> `phase_lock_event_sigma`
- **U17.** "Something's about to shift — your patterns have been slowing down for 3 weeks." -> `critical_slowing_autocorrelation` + `critical_slowing_variance`
- **U18.** "You've been flickering between two stances on [territory]." -> `flickering_detection`
- **U19.** "Your trajectory has stabilized — whatever was integrating has integrated." -> post-transition return-to-baseline

### Multi-Scale Information Coherence
- **U20.** "Your information rhythm at the paragraph scale is more coherent with your daily rhythm." -> `cross_scale_coupling`
- **U21.** "This week your weekly information density is unusually high while daily is normal." -> harmonic amplitudes per scale
- **U22.** "Your writing has become more compressible at sentence scale and less at paragraph scale — exploring within structure." -> multi-scale compression

### Cross-Modal (Deferred)
- **U24.** Joint text-HRV coherence (requires HRV ingest)
- **U25.** Neural Bridge live mapping (requires EEG hardware + Phase 6 Tier-2)

---

## 8. Open Questions and Future Directions

### Open Structural Questions
- **Q3.** Per-language parity — English-first or full Latvian from day 1?
- **Q5.** Baseline reference defaults — rolling-90d framework or per-metric?
- **Q6.** Presentation contract enforcement — API-level schema validator recommended (~50 LOC)
- **Q7.** Tier 2 stack shape — shared decrypt-once vs per-metric stages
- **Q9.** Spec versioning — backfill vs new column on algorithm change

### Future Research Directions

**4.1 Causal Representation Learning**: If the field produces practical causal disentanglement tools, adopt for metric validation. Watch ICLR 2027.

**4.2 Conversation-Level Foundation Models**: No one has trained on longitudinal conversation data. Would provide direct surprisal signal. Watch arXiv cs.CL.

**4.3 Bayesian Online Change-Point Detection**: Adams & MacKay (2007) BOCPD — alternative to CSD for phase transitions. Doesn't assume bifurcation. Evaluate as companion/replacement for 4.25/4.26.

**4.4 Network Psychometrics**: Borsboom et al. (2021) — constructs as networks, not latent variables. Mycelium's territory graph IS a psychological network. Validated toolkit for interpreting it.

**4.5 Active Inference / Free Energy**: Friston's framework provides theoretical umbrella for novelty-seeking (uncertainty reduction) and consolidation (model updating) that Mycelium implicitly tracks.

**4.6 Potential Landscape Estimation**: simlandr (Li/Xu 2022) — visualize attractor basins in territory space. "Where your thinking tends to settle and what it takes to shift." Highly novel, high user value.

### Deferred Metrics
- **Assembly index** — post-4.18 LZ76 ships; hierarchical composition complexity
- **Neural Bridge / Tier 3** — post-Phase 6 Tier-2 + EEG hardware + legal review

---

## 9. Graveyard

### 4.14 `sentiment_polarity_trend` — graveyarded 2026-05-07 (v1.2)
**Reason**: Redundant with 4.13 + 4.33. Slow-moving polarity-trend averages add no signal beyond what volatility + flow features capture.

### 4.32 `compression_intelligence_proxy` — removed 2026-06-04
**Reason**: Not a separate metric — literature reference folded into 4.18 prose. Same computation, different framing.

### `insight_word_density` (original keyword-based version) — replaced 2026-06-04
**Reason**: Keyword-based (LIWC/Empath word lists). Replaced by `insight_embedding_proximity` (embedding anchors, Tier 1).

### `tense_shift_density` (original regex version) — replaced 2026-06-04
**Reason**: Regex-based (language-specific verb-tense patterns). Replaced by `temporal_frame_shift_density` (spaCy morph, model-based).

### `reflective_marker_density` (original keyword version) — replaced 2026-06-04
**Reason**: Keyword-based (word-list match). Replaced by `reflective_embedding_density` (embedding anchors, Tier 1).

### `sentiment_volatility_within_window` (original VADER version) — replaced 2026-06-04
**Reason**: VADER is rule-based lexicon (~7,500 words, English-only). Replaced by `affective_volatility_within_window` (embedding affect proxy, Tier 1, multilingual).

---

## 10. References

### Foundational
- Cencov, N.N. (1982). *Statistical Decision Rules and Optimal Inference*. Fisher-Rao uniqueness theorem.
- Amari, S. (2016). *Information Geometry and Its Applications*. Springer.
- Pokropek, A. (2026). "From keyword-based text measures to latent variables: CFA with word embeddings." *EPJ Data Science*.
- Li, Z. et al. (2025). "The Proxy Presumption." arXiv:2605.07409. Construct validity for embedding-derived measures.

### Information Harmonics
- Tsipidi, E. et al. (2025). "Harmonic structure in surprisal contours." *ACL 2025*.
- Biemann, T. et al. (2024). "Bigram Semantic Distance as an Index of Continuous Semantic Flow." *Behavior Research Methods*.
- SpecDetect (2025). arXiv:2508.11343. FFT on embedding-distance sequences.
- WaveletGPT (2024). Wavelets for non-stationary text signals.
- arXiv:2406.03707. Autoregressive embeddings encode predictive sufficient statistics.

### Criticality and Phase Transitions
- Schiepek, G. et al. (2014). "Synergetics in psychology." *Frontiers in Psychology*.
- Smit, A. et al. (2025). CSD sensitivity 32.9%. *Clinical Psychological Science*.
- Helmich, M. & Schreuder, M. (2024). "EWS in clinical psychology." *Nature Reviews Psychology*.
- Scheffer, M. et al. (2009). "Early-warning signals for critical transitions." *Nature*.
- Communications Physics (2025). ML outperforms classic EWS in 6/8 systems.

### Coherence
- Bedi, G. et al. (2015). Psychosis prediction from semantic coherence. *Schizophrenia Bulletin*.
- Fries, P. (2015). "Communication Through Coherence." *Neuron*.
- Tort, A. et al. (2010). PAC modulation index. *Journal of Neurophysiology*.

### Linguistic / Lexical
- McCarthy, P.M. & Jarvis, S. (2010). "MTLD, vocd-D, and HD-D." *Behavior Research Methods*.
- Suedfeld, P. & Tetlock, P. (1977 onward). Integrative complexity.
- Garten, J. et al. (2018). "Dictionaries and Distributions." *Behavior Research Methods*.
- Hutto, C.J. & Gilbert, E.E. (2014). "VADER." *AAAI ICWSM*.
- Barzilay, R. & Lapata, M. (2008). Entity-grid coherence.
- Reagan, A. et al. (2016). "The emotional arcs of stories." *EPJ Data Science*.

### Affect
- Kuppens, P. et al. (2010). Emotional inertia and depression.
- Gruhn, D. et al. (2013). Affect complexity and health outcomes.

### Compression and Complexity
- Lempel, A. & Ziv, J. (1976). LZ76 compression.
- Huang, Y. et al. (2024). "Compression Represents Intelligence Linearly." *COLM*.
- Wang, Y. et al. (2025). "Human brain is 96% compressible." *PNAS*.

### Personality
- ICLR (2026). LLM-as-rater Big Five: r = 0.38-0.64.
- ActTraitBench. Knowledge-Decision Gap.

### Embedding Geometry
- Xiao et al. (2026). Efficient coding drives criticality. arXiv:2605.22598.
- FRInGe. arXiv:2605.06404.
- FishBack. arXiv:2605.17231.
- arXiv:2602.16273. Lyapunov spectral analysis of speech embeddings.

### Topology
- arXiv:2506.14836. TDA on embedding trajectories.
- Li/Xu (2022). simlandr — potential landscapes for psychological states.
- Borsboom, D. et al. (2021). Network psychometrics.

### Dynamical Systems
- Rosenstein, M. et al. (1993). Lyapunov exponent estimation.
- Adams, R. & MacKay, D. (2007). Bayesian Online Change-Point Detection.

### Mycelium Empirical Evidence
- May 5, 2026 phase-lock event (realm 35.5sigma, theme 28.2sigma, territory 31.8sigma)
- 24 weeks of cycling preceding phase-lock (predicted by CSD theory)
- HRV jump 28->71ms morning after phase-lock (cross-modal coherence)
- gzip-on-ciphertext ~= 0.70 constant (broken metric, correctly identified)

---

*Compiled from 23 daily research scans (Days 1-23), 56+ research documents, 500+ papers, and the Mycelium cognitive metrics spec v1.2.*