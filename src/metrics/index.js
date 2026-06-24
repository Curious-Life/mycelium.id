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

export {
  runCVP,
  pearson,
  residualize,
  validatePresentation,
  assertNotSurfacedUnlessValidated,
  CVP_THRESHOLDS,
  TIER1_EMBEDDING_FAMILIES,
} from './cvp.js';

// The metric-read chokepoint (audit S1): column→family resolution + the
// throwing/substituting gates the db boundary invokes. @see surface-gate.js.
export {
  metricColumnFamily,
  assertColumnSurfaceable,
  gateAnchorValue,
  ANCHOR_METRIC_COLUMNS,
} from './surface-gate.js';

// Wire the contracts registry into the CVP validator (avoids an import cycle:
// cvp.js holds an optional ref instead of importing contracts.js directly).
import { CONTRACTS as _CONTRACTS } from './contracts.js';
import { _setContractsRef } from './cvp.js';
_setContractsRef(_CONTRACTS);
