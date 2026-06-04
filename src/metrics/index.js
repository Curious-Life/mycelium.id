/**
 * src/metrics — the measurement-layer shared module (JS side).
 *
 * Barrel for the one-place-only primitives + the per-family presentation
 * contracts. Stages and tools import from here (or the specific submodule),
 * never re-implement. See docs/MEASUREMENT-LAYER-BUILDOUT-PLAN-2026-06-04.md.
 *
 * Deferred (ported with their consumer, to avoid dead surface): era.js +
 * stage-template.js (the era-skip / stage coordinator) land with the
 * pipeline-health coordinator if/when V1 adopts it; today the Python stages use
 * pipeline/stage_base.py + era_skip.py and run via run-clustering.sh.
 */

export {
  l2Normalize,
  cosineSim,
  countsToProbs,
  entropyNats,
  entropyBits,
  entropyNormalized,
  lzComplexity,
  lz76Complexity,
  variance,
  gini,
} from './primitives.js';

export { CONTRACTS, default as contracts } from './contracts.js';
