/**
 * src/metrics/cvp.js — Construct Validity Protocol (CVP) harness + presentation-
 * contract validator (X1).
 *
 * Spec §2.3 makes CVP a MANDATORY gate before any Tier-1 embedding-geometry
 * metric ships. The three criteria the spec lists:
 *
 *   1. Discriminant validity   — the metric varies with the TARGET construct,
 *                                not with confounds. Operationalized here as:
 *                                |corr(metric, target)| is high AND meaningfully
 *                                exceeds |corr(metric, confound)| for every named
 *                                confound (topic / style / authorship axes).
 *   2. Incremental validity    — the metric adds signal OVER simpler baselines
 *                                (word count, message count). Operationalized as
 *                                a partial-correlation gain: |corr(metric,target)|
 *                                must exceed the best single-baseline
 *                                |corr(baseline,target)| by a margin.
 *   3. Confound neutralization — after residualizing the metric on the confounds
 *                                (linear regression), the residual STILL
 *                                correlates with the target above a floor (the
 *                                construct signal survives confound removal).
 *
 * This module is PURE and synchronous: it takes arrays of numbers (metric values,
 * the target-construct labels, baseline covariates, confound covariates) and
 * returns a per-criterion pass/fail report. It is runnable on SYNTHETIC/fixture
 * data (the verify gate proves the logic). For REAL Mycelium metrics it CANNOT
 * run yet — there is no operator human-labeled held-out data — so the canonical
 * state for the embedding-anchor family is cvp_status='pending' (NOT 'pass').
 *
 * The harness NEVER fabricates a pass: with no labels you get
 * { calibrated:false, status:'pending' }, never a green result.
 *
 * Pairs with the presentation-contract validator (validatePresentation /
 * assertNotSurfacedUnlessValidated) so the surface layer can REFUSE to serve a
 * Tier-1 metric that has not cleared CVP.
 */

// ── thresholds (documented defaults; an operator CVP run may tighten these) ──
export const CVP_THRESHOLDS = Object.freeze({
  discriminant_min_target_abs_corr: 0.3,  // metric must track the target at all
  discriminant_margin_over_confound: 0.1, // and beat each confound by this margin
  incremental_margin_over_baseline: 0.05, // and beat the best simple baseline
  confound_residual_min_abs_corr: 0.2,    // signal survives confound removal
  min_n: 20,                              // below this, correlations are noise
});

// ── pure stats helpers (no deps; mirror primitives.js style) ────────────────
function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

export function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom === 0 ? 0 : sxy / denom;
}

/**
 * Residualize `y` on a set of covariate columns via ordinary least squares
 * (with intercept), returning the residual vector y - ŷ. Small, dependency-free
 * normal-equations solve (covariate count is tiny — topic/style/authorship).
 */
export function residualize(y, covariates) {
  const n = y.length;
  if (!covariates || covariates.length === 0) return y.slice();
  // Design matrix X = [1, c1, c2, ...] (n × p).
  const p = covariates.length + 1;
  const X = [];
  for (let i = 0; i < n; i++) {
    const row = [1];
    for (const c of covariates) row.push(c[i]);
    X.push(row);
  }
  // Normal equations: (XᵀX) b = Xᵀy. Solve via Gauss-Jordan on the p×p system.
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const b = solveLinear(XtX, Xty);
  if (!b) return y.slice(); // singular → no residualization (conservative)
  const resid = new Array(n);
  for (let i = 0; i < n; i++) {
    let yhat = 0;
    for (let a = 0; a < p; a++) yhat += b[a] * X[i][a];
    resid[i] = y[i] - yhat;
  }
  return resid;
}

function solveLinear(A, rhs) {
  const n = rhs.length;
  const M = A.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/**
 * Run the CVP harness for one metric.
 *
 * @param {object} args
 * @param {number[]}            args.metric       per-sample metric values
 * @param {number[]}            args.target       per-sample target-construct label/score
 * @param {Record<string,number[]>} [args.baselines]  simpler baselines (word_count, message_count, …)
 * @param {Record<string,number[]>} [args.confounds]  confound axes (topic, style, authorship, …)
 * @param {object}              [args.thresholds] override CVP_THRESHOLDS
 * @returns {{calibrated:boolean, status:'pass'|'fail'|'pending', criteria:object, reason:string}}
 */
export function runCVP({ metric, target, baselines = {}, confounds = {}, thresholds = {} } = {}) {
  const T = { ...CVP_THRESHOLDS, ...thresholds };

  // No labels → CANNOT calibrate. This is the real-data state today. Never a pass.
  if (!Array.isArray(metric) || !Array.isArray(target) || target.length === 0) {
    return {
      calibrated: false, status: 'pending', criteria: {},
      reason: 'No operator-labeled target data — CVP cannot run. Metric stays cvp_status=pending (spec §2.3).',
    };
  }
  const n = Math.min(metric.length, target.length);
  if (n < T.min_n) {
    return {
      calibrated: false, status: 'pending', criteria: {},
      reason: `Insufficient labeled samples (n=${n} < min_n=${T.min_n}); correlations would be noise.`,
    };
  }

  const m = metric.slice(0, n), t = target.slice(0, n);
  const rTarget = Math.abs(pearson(m, t));

  // (1) Discriminant validity.
  const confoundCorrs = {};
  let beatsAllConfounds = true;
  for (const [name, c] of Object.entries(confounds)) {
    const rc = Math.abs(pearson(m, c.slice(0, n)));
    confoundCorrs[name] = rc;
    if (!(rTarget - rc >= T.discriminant_margin_over_confound)) beatsAllConfounds = false;
  }
  const discriminant = rTarget >= T.discriminant_min_target_abs_corr && beatsAllConfounds;

  // (2) Incremental validity (over the best single simple baseline).
  let bestBaselineCorr = 0; const baselineCorrs = {};
  for (const [name, b] of Object.entries(baselines)) {
    const rb = Math.abs(pearson(b.slice(0, n), t));
    baselineCorrs[name] = rb;
    if (rb > bestBaselineCorr) bestBaselineCorr = rb;
  }
  const incremental = rTarget - bestBaselineCorr >= T.incremental_margin_over_baseline;

  // (3) Confound neutralization — residualize metric on confounds, re-correlate.
  const confoundCols = Object.values(confounds).map((c) => c.slice(0, n));
  const resid = residualize(m, confoundCols);
  const rResidual = Math.abs(pearson(resid, t));
  const confoundNeutralized = rResidual >= T.confound_residual_min_abs_corr;

  const criteria = {
    discriminant_validity: {
      pass: discriminant, target_abs_corr: rTarget, confound_abs_corrs: confoundCorrs,
    },
    incremental_validity: {
      pass: incremental, target_abs_corr: rTarget, best_baseline_abs_corr: bestBaselineCorr, baseline_abs_corrs: baselineCorrs,
    },
    confound_neutralization: {
      pass: confoundNeutralized, residual_abs_corr: rResidual,
    },
  };
  const allPass = discriminant && incremental && confoundNeutralized;
  return {
    calibrated: true,
    status: allPass ? 'pass' : 'fail',
    criteria,
    reason: allPass
      ? 'All three CVP criteria pass on the provided labeled data.'
      : 'One or more CVP criteria failed — metric is NOT construct-valid on this data.',
  };
}

// ── Presentation-contract validator ─────────────────────────────────────────
//
// Tier-1 embedding-geometry metric families (spec §4.5/4.11/4.12/4.13) and the
// CVP status they currently hold. cvp_status='pending' is the spec-mandated
// honest state (no operator labels). NONE may be served as validated while
// pending.

export const TIER1_EMBEDDING_FAMILIES = Object.freeze({
  insight_embedding_proximity:       { section: '§4.5',  tier: 1, cvp_status: 'pending' },
  reflective_embedding_density:      { section: '§4.12', tier: 1, cvp_status: 'pending' },
  inner_territory_presence:          { section: '§4.11', tier: 1, cvp_status: 'pending' },
  affective_volatility_within_window:{ section: '§4.13', tier: 1, cvp_status: 'pending' },
  // E2 bipolar inner-state axes — signed lean cos(msg,+pole) − cos(msg,−pole).
  // Same CVP gate: pending until operator-labeled validation. `edges_lean` also
  // abstains at the instrument level (cognitive_axis_separability.measurable=0).
  tone_lean:         { section: '§E2.tone',         tier: 1, cvp_status: 'pending' },
  charge_lean:       { section: '§E2.charge',       tier: 1, cvp_status: 'pending' },
  warmth_lean:       { section: '§E2.warmth',       tier: 1, cvp_status: 'pending' },
  gatheredness_lean: { section: '§E2.gatheredness', tier: 1, cvp_status: 'pending' },
  holding_lean:      { section: '§E2.holding',      tier: 1, cvp_status: 'pending' },
  noticing_lean:     { section: '§E2.noticing',     tier: 1, cvp_status: 'pending' },
  edges_lean:        { section: '§E2.edges',        tier: 1, cvp_status: 'pending' },
  kusala_lean:       { section: '§E2.kusala',       tier: 1, cvp_status: 'pending' },
});

/**
 * Validate that a metric is allowed to be SURFACED to the human as a measured
 * construct. A Tier-1 embedding metric requires BOTH a presentation contract AND
 * cvp_status==='pass'. Anything else must be refused or labeled honestly.
 *
 * @param {object} args
 * @param {string} args.family            metric/family id
 * @param {number} [args.tier]            tier (defaults from the Tier-1 registry if known)
 * @param {string} [args.cvp_status]      'pass' | 'fail' | 'pending'
 * @param {object} [args.contracts]       contract registry (defaults to CONTRACTS)
 * @returns {{ surfaceable:boolean, reason:string, hasContract:boolean, requiresCVP:boolean }}
 */
export function validatePresentation({ family, tier, cvp_status, contracts } = {}) {
  // Lazy import to avoid a hard cycle; callers may pass contracts explicitly.
  const registry = contracts || _contractsRef;
  const known = TIER1_EMBEDDING_FAMILIES[family];
  const effTier = tier ?? known?.tier ?? null;
  const effCvp = cvp_status ?? known?.cvp_status ?? null;
  const requiresCVP = effTier === 1;
  const hasContract = !!(registry && registry[family]);

  if (requiresCVP) {
    if (!hasContract) {
      return { surfaceable: false, requiresCVP, hasContract, reason: `Tier-1 metric "${family}" has no presentation contract — refuse to surface (spec §2.2 field 7).` };
    }
    if (effCvp !== 'pass') {
      return { surfaceable: false, requiresCVP, hasContract, reason: `Tier-1 metric "${family}" has cvp_status="${effCvp ?? 'unknown'}" (not "pass") — refuse to surface as validated (spec §2.3 mandatory gate).` };
    }
    return { surfaceable: true, requiresCVP, hasContract, reason: 'Tier-1 metric has a contract and cleared CVP.' };
  }

  // Non-Tier-1 (e.g. the harmonic family) still needs a contract to be served.
  if (!hasContract) {
    return { surfaceable: false, requiresCVP, hasContract, reason: `Metric "${family}" has no presentation contract — refuse to surface (spec §2.2 field 7).` };
  }
  return { surfaceable: true, requiresCVP, hasContract, reason: 'Metric has a presentation contract.' };
}

/**
 * Throwing guard for the surface layer: throws if a metric would be served
 * without having passed its required gates. Use at the REST/tool boundary.
 */
export function assertNotSurfacedUnlessValidated(args) {
  const v = validatePresentation(args);
  if (!v.surfaceable) {
    const err = new Error(`PresentationContractViolation: ${v.reason}`);
    err.code = 'CVP_NOT_VALIDATED';
    throw err;
  }
  return v;
}

// Optional contracts reference, set by the barrel to avoid an import cycle.
let _contractsRef = null;
export function _setContractsRef(c) { _contractsRef = c; }
