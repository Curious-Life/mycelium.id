# Curious Life — Metrics Catalog

Every metric the cognitive-measurement plane computes, in plain language, with an
honest rigor label. This is the human-readable mirror of
[`portal-app/src/lib/curious/metricsCatalog.ts`](../portal-app/src/lib/curious/metricsCatalog.ts)
(the on-page "What we measure" glossary reads from that module). **Edit the module
and this doc together.**

All metrics are computed locally from your own messages and stored encrypted at
rest. "Bands" (`gamma…delta`) are *temporal aggregation scales* (per-message →
monthly), **not** EEG frequencies. Granularities (`alpha/theta/delta`) are
*window sizes* (daily/weekly/monthly) — a different axis from bands.

## Rigor labels

| Label | Meaning |
|---|---|
| **validated math** | A mathematical quantity computed by a canonical, well-defined method. |
| **validated (clinical)** | Validated in clinical studies — journaling use is an extrapolation. |
| **heuristic** | Literature-grounded but not validated for this use. A sensible signal, not a verdict. |
| **experimental** | A novel, unvalidated application. Suggestive only — never a diagnosis or prediction. |

---

## Vitality — *heuristic* · `territory_vitality`
*How alive your territories are.*

| Metric | Plain meaning |
|---|---|
| Vitality | A blend of the five signals below — overall aliveness of a territory. |
| Diversification (`entropy_diversification`) | How varied a territory's connections are, rather than clustered in one place. |
| Connection growth (`connection_growth_rate`) | How quickly a territory is forming new links. |
| Reach | How far across your mindscape a territory connects. |
| Partner diversity (`cofire_partner_diversity`) | The variety of other territories that light up alongside it. |
| Engagement depth (`engagement_depth_normalized`) | How deeply you engage with a territory, not just how often. |

## Movement — *validated math* · `fisher_trajectory`
*How far and fast your focus travels between ideas.* Built on the Fisher-Rao metric (information geometry).

| Metric | Plain meaning |
|---|---|
| Velocity (`fisher_velocity`) | Speed of change in what you're focused on, week to week. |
| Displacement (`fisher_displacement`) | How far your focus has moved from where it started. |
| Path length (`fisher_trajectory_length`) | Total distance travelled, including back-and-forth. |
| Exploration ratio (`exploration_ratio`) | Displacement ÷ path length — near 1 you strike out in a direction; near 0 you circle. |
| Activation entropy (`activation_entropy`) | Whether your focus is concentrated on a few territories or spread across many. |
| Phase | A four-state read: stable, cycling, exploring, or transforming. |

## Rhythm — *heuristic* (amplitude & topology parts are validated math) · `cognitive_metrics_harmonic`
*The cadence of your thinking, from per-message to monthly.* 41 metrics across 5 time-scale bands.

| Metric | Plain meaning |
|---|---|
| Harmonic amplitude (`harmonic_amplitude`) | Strength of repeating patterns in your message-to-message signal, at each time-scale (Fourier regression — validated math). |
| Crossing rate (`mean_crossing_rate`) | How often the signal swings across its own average. |
| Slope changes (`slope_sign_change_rate`) | How jagged vs smooth the signal is. |
| Autocorrelation (`autocorrelation_lag1`) | How much each step resembles the one before — inertia. |
| Variance | How volatile the signal is within a time-scale. |
| Spectral energy (`total_spectral_energy`) | Overall amount of structure across all frequencies. |
| Persistence entropy (`topology_h0_persistence_entropy`) | How uniform vs hierarchical a window's ideas are (TDA — validated math). |

## Complexity — *validated math* · `complexity_snapshots`
*How varied, vs repetitive, the path of your thinking is.* Lempel-Ziv 76.

| Metric | Plain meaning |
|---|---|
| LZ complexity (`lz_complexity`) | How compressible the sequence of territories is — higher = less repetitive. |
| Distinct patterns (`raw_complexity`) | Count of distinct sub-patterns in the sequence. |
| Steps (`sequence_length`) | How many moves are in the measured sequence. |
| Territories in play (`alphabet_size`) | How many distinct territories appear. |

## Growth — *heuristic* · `frequency_snapshots`
*How your thinking consolidates and changes.*

| Metric | Plain meaning |
|---|---|
| Coherence | How aligned your active territories are right now. |
| Spread (`entropy`) | How evenly attention is distributed across territories. |
| Compressibility (`compression`) | How structured vs novel your text is. |
| Learning rate (`learning_rate`) | How much focus changed from the previous window (JSD²). |
| Drift (`gradient_signal`) | How far focus has drifted from where the window began. |

## Mindscape — *heuristic* · `topology_audit_snapshots` + `territory_cofire`
*The shape of your inner world.*

| Metric | Plain meaning |
|---|---|
| Territories (`total_territories`) | Number of distinct idea-regions. |
| Connections (`total_connections`) | How many links join them. |
| Spread (`m2_entropy`) | How evenly structure is distributed vs concentrated. |
| Concentration (`degree_gini`) | Whether a few territories dominate the connections. |
| Mean degree (`mean_degree`) | Average connections per territory. |
| Orphans (`orphan_count`) | Territories with no connections. |
| Bridges (`bridge_count`) | Territories linking otherwise-separate regions. |
| Co-firing (`cofire`) | Which territories light up together across four timescales (hour → week). |

## Milestones — *heuristic* · `fisher_milestones`
*Moments your mind turned.*

| Metric | Plain meaning |
|---|---|
| Phase shift | A week your movement phase changed decisively. |
| Velocity spike | An unusually fast move through idea-space. |

## Routine — *heuristic* · `cognitive_metrics_behavioral`
*When you write, and how regular your sessions are.* From timestamps only (Tier-0, no decryption of content). **Newly surfaced** — computed all along, not shown until now.

| Metric | Plain meaning |
|---|---|
| Peak hour (`diurnal_peak_hour`) | The hour of day you write most. |
| Time concentration (`diurnal_concentration`) | How concentrated around that peak vs spread through the day. |
| Time spread (`diurnal_entropy`) | How evenly writing is distributed across 24 hours. |
| Sessions (`session_count`) | Distinct writing sessions (gaps over 30 min split them). |
| Cadence regularity (`intersession_entropy`) | How regular vs erratic the gaps between sessions are. |
| Cadence variation (`intersession_cv`) | Variability of those gaps. |

## Early signals — *experimental* · `cognitive_metrics_criticality` + `cognitive_events`
*Faint hints a shift may be near — advisory, never a prediction.* Every row is `low_confidence=1` by design; real-world sensitivity is LOW (~33% per Smit 2025). **Newly surfaced.** Always framed as a hint, never a warning of crisis or a forecast.

| Metric | Plain meaning |
|---|---|
| Critical slowing (`ar1_autocorrelation`) | Whether movement is becoming more self-similar — a textbook (low-sensitivity) early-warning sign. |
| Rolling variance (`rolling_variance`) | Whether variability of movement is rising — the companion signal. |
| Joint signal (`early_warning_joint`) | Fires only when slowing and rising variance appear together. |
| Flickering (`flickering_score`) | Back-and-forth alternation between two phases before one settles. |
| Phase-lock / events (`cognitive_events`) | Rare moments all scales move together; surfaced as discrete events with a headline. |

---

## Computed but NOT surfaced — *experimental, CVP-pending*

These embedding-anchor metrics exist (`src/metrics/contracts.js`) but have **not** cleared the Construct Validity Protocol (no operator-labeled data). They are listed here for completeness and **must never be presented as validated** — not as cards on the page.

| Metric | Plain meaning |
|---|---|
| Insight proximity (`insight_embedding_proximity`) | How close messages sit to an "insight" seed-phrase. A heuristic, not measured insight. |
| Reflective density (`reflective_embedding_density`) | How often messages lean toward a "reflection" anchor. |
| Inner presence (`inner_territory_presence`) | Average proximity to the reflection anchor. |
| Affective variation (`affective_volatility_within_window`) | Spread of an embedding-based positive-minus-negative proxy. **Not** a clinical or diagnostic affect measure. |

---

## Known data issue (as of 2026-06-19)

See [`BUG-vitality-territory-count-inflation-2026-06-19.md`](BUG-vitality-territory-count-inflation-2026-06-19.md): the Vitality snapshot currently over-counts territories ~52× because `territory_vitality` is append-only across clustering runs and the snapshot doesn't dedupe to the latest row per territory. Handed to the metric-audit session.
