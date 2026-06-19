/**
 * Per-family metric contracts — display/copy strings for the cognitive-metrics
 * tool surface (src/tools/metrics.js).
 *
 * These are NOT data. Each entry is honest, human-readable copy that the metrics
 * tools surface when a metric window has no row yet (the enrichment pipeline,
 * compute_information_harmonics.py, has not written a window for this user ×
 * granularity). The tools read `CONTRACTS.<id>.refusal_mode` and show it in
 * place of numbers so the agent gets the *reason* there's nothing to report
 * rather than a crash or a wall of em-dashes.
 *
 * `refusal_mode` answers two questions in one string: (1) why is this empty
 * right now, and (2) what has to happen for it to fill in. No numeric thresholds
 * are invented here beyond the ones already named in the tool's own descriptions
 * and the data layer (N<20 for topology persistence; per-window aggregation for
 * the harmonic/flow families).
 *
 * Keyed by metric family id (matches the keys read in src/tools/metrics.js):
 *   information_harmonic_amplitude  — §4.23 harmonic_amplitude_<band>_k<n>
 *   bigram_flow_features            — §4.33 within-window flow features
 *   topology_persistence_entropy    — §4.34 topology_h0_persistence_entropy
 *
 * @typedef {object} MetricContract
 * @property {string} family          — the §-numbered family this id covers
 * @property {string} preferred_vocab — voice words the tool output should favour
 * @property {string} refusal_mode    — copy shown when the window has no data
 */

/** @type {Record<string, MetricContract>} */
export const CONTRACTS = {
  information_harmonic_amplitude: {
    family: '§4.23 information harmonic amplitude',
    preferred_vocab: 'rhythm / pattern / movement',
    refusal_mode:
      'No cognitive-rhythm window has been computed for this granularity yet. '
      + 'Harmonic amplitudes are derived by the enrichment pipeline from your '
      + 'message embeddings, aggregated per temporal band over a completed '
      + 'window — so there is nothing to read until at least one window has been '
      + 'recorded for you. Keep writing; the rhythm fills in once a window closes '
      + 'and the pipeline runs. (Bands are temporal aggregation scales, not EEG '
      + 'frequencies in Hz.)',
  },

  bigram_flow_features: {
    family: '§4.33 bigram flow features',
    preferred_vocab: 'flow / thread / movement',
    refusal_mode:
      'No flow-shape window has been computed for this granularity yet. '
      + 'Flow features (continuity, reversal rate, variance, spectral energy) '
      + 'describe how consecutive messages move relative to each other, so they '
      + 'need a window with enough messages for the pipeline to measure '
      + 'within-window structure. Until a window has been recorded and enriched, '
      + 'there is no flow to report. (These features are validated for clinical '
      + 'populations; the journaling application is methodological extrapolation, '
      + 'not clinical validity.)',
  },

  topology_persistence_entropy: {
    family: '§4.34 topology persistence entropy',
    preferred_vocab: 'shape / spread / ground',
    refusal_mode:
      'No activity-shape window has been computed for this granularity yet. '
      + 'Topology persistence entropy (H0 of a Vietoris-Rips complex on a 256D '
      + 'matryoshka projection of the window\'s embeddings) needs a recorded '
      + 'window with enough messages to be stable — it stays null below the N<20 '
      + 'threshold. Until a window is recorded and clears that threshold, the '
      + 'shape cannot be read.',
  },

  // ── Tier-1 embedding-anchor family (E1, spec §4.5/4.11/4.12/4.13) ───────────
  // These metrics EXIST and are computed, but they are Tier-1 embedding-geometry
  // metrics that have NOT cleared the mandatory Construct Validity Protocol (spec
  // §2.3) — real CVP needs operator human-labeled held-out data, which is not
  // available. Every row carries cvp_status='pending' + low_confidence=1. The
  // presentation-contract validator (src/metrics/cvp.js) REFUSES to surface these
  // as validated while pending; the refusal_mode below is the honest copy.
  insight_embedding_proximity: {
    family: '§4.5 insight embedding proximity (Tier-1, CVP-pending)',
    tier: 1,
    cvp_status: 'pending',
    preferred_vocab: 'proximity / resonance (NOT "insight detected")',
    refusal_mode:
      'This is a Tier-1 embedding-anchor metric that has NOT been validated. It '
      + 'measures geometric proximity of your messages to an "insight" seed-phrase '
      + 'anchor — a heuristic, not a measured construct. It has not cleared the '
      + 'Construct Validity Protocol (no operator-labeled data), so it is reported '
      + 'as cvp_status=pending and MUST NOT be presented as detecting insight.',
  },
  reflective_embedding_density: {
    family: '§4.12 reflective embedding density (Tier-1, CVP-pending)',
    tier: 1,
    cvp_status: 'pending',
    preferred_vocab: 'proximity / leaning (NOT "reflection measured")',
    refusal_mode:
      'Tier-1 embedding-anchor metric, NOT validated. Fraction of messages near a '
      + '"reflection" anchor above a PROVISIONAL (un-calibrated) threshold. CVP '
      + 'pending (no operator labels) → not surfaced as a validated construct.',
  },
  inner_territory_presence: {
    family: '§4.11 inner territory presence (Tier-1, CVP-pending)',
    tier: 1,
    cvp_status: 'pending',
    preferred_vocab: 'proximity / leaning',
    refusal_mode:
      'Tier-1 embedding-anchor metric, NOT validated. Mean proximity to the '
      + 'reflection anchor. CVP pending → not surfaced as a validated construct.',
  },
  affective_volatility_within_window: {
    family: '§4.13 affective volatility within window (Tier-1, CVP-pending)',
    tier: 1,
    cvp_status: 'pending',
    preferred_vocab: 'variation / spread (NOT "mood swings", NOT clinical affect)',
    refusal_mode:
      'Tier-1 embedding-anchor metric, NOT validated. Spread of an embedding-based '
      + 'positive-minus-negative affect proxy across a window. CVP pending (no '
      + 'operator labels) → not surfaced as a validated construct, and never as a '
      + 'clinical or diagnostic affect measure.',
  },
};

export default CONTRACTS;
