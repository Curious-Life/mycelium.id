// verify:cvp — X1 Construct Validity Protocol harness + presentation-contract
// validator. Proves:
//   (1) the CVP harness computes its three §2.3 criteria CORRECTLY on fixtures:
//       a construct-valid synthetic metric PASSES; a confounded/noise metric
//       FAILS; no-labels and too-few-samples → status='pending' (never a fake pass).
//   (2) the presentation-contract validator REJECTS (a) an un-contracted Tier-1
//       metric and (b) an un-validated (cvp_status=pending) Tier-1 metric, while
//       ACCEPTING a contracted Tier-1 metric that has cleared CVP, and a
//       contracted non-Tier-1 metric.
//   (3) the embedding-anchor metrics are marked cvp_status='pending' — both in
//       the JS registry (TIER1_EMBEDDING_FAMILIES + CONTRACTS) AND in the rows
//       the REAL compute-anchors.py stage writes (stub embedder, no network).
// PASS/FAIL ledger; exit 0 only if all pass.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { encryptVector } from '../src/search/ann/decode.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';
import {
  runCVP, validatePresentation, assertNotSurfacedUnlessValidated,
  TIER1_EMBEDDING_FAMILIES,
} from '../src/metrics/cvp.js';
import { CONTRACTS } from '../src/metrics/contracts.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// ── Fixtures ────────────────────────────────────────────────────────────────
const N = 120;
const rng = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
const noise = (k) => Array.from({ length: N }, () => (rng() - 0.5) * k);

// Target construct score, plus confounds (topic/style) and baselines (word_count).
const target = Array.from({ length: N }, (_, i) => Math.sin(i * 0.21) + (rng() - 0.5) * 0.2);
const topic = Array.from({ length: N }, (_, i) => Math.cos(i * 0.5) + (rng() - 0.5) * 0.2);
const style = noise(2);
const word_count = Array.from({ length: N }, (_, i) => 10 + (i % 7) + (rng() - 0.5) * 2); // weakly related to nothing

// (a) A construct-VALID metric: tracks target strongly, barely tracks confounds,
//     beats the word-count baseline, survives confound residualization.
const validMetric = target.map((t, i) => t * 1.0 + topic[i] * 0.05 + (rng() - 0.5) * 0.15);
// (b) A confounded metric: it's basically the topic confound, NOT the target.
const confoundedMetric = topic.map((c, i) => c * 1.0 + (rng() - 0.5) * 0.1);
// (c) Pure noise metric.
const noiseMetric = noise(2);

// ── 1. Harness correctness on fixtures ───────────────────────────────────────
const rValid = runCVP({ metric: validMetric, target, baselines: { word_count }, confounds: { topic, style } });
rec('1a. CVP harness PASSES a construct-valid synthetic metric (all 3 criteria)',
  rValid.calibrated && rValid.status === 'pass'
    && rValid.criteria.discriminant_validity.pass
    && rValid.criteria.incremental_validity.pass
    && rValid.criteria.confound_neutralization.pass,
  `status=${rValid.status} disc=${rValid.criteria?.discriminant_validity?.pass} inc=${rValid.criteria?.incremental_validity?.pass} conf=${rValid.criteria?.confound_neutralization?.pass}`);

const rConf = runCVP({ metric: confoundedMetric, target, baselines: { word_count }, confounds: { topic, style } });
rec('1b. CVP harness FAILS a confounded metric (discriminant and/or confound-neutralization fail)',
  rConf.calibrated && rConf.status === 'fail'
    && (!rConf.criteria.discriminant_validity.pass || !rConf.criteria.confound_neutralization.pass),
  `status=${rConf.status} disc=${rConf.criteria?.discriminant_validity?.pass} conf=${rConf.criteria?.confound_neutralization?.pass} resid_r=${rConf.criteria?.confound_neutralization?.residual_abs_corr?.toFixed(3)}`);

const rNoise = runCVP({ metric: noiseMetric, target, baselines: { word_count }, confounds: { topic, style } });
rec('1c. CVP harness FAILS a pure-noise metric (low target correlation)',
  rNoise.calibrated && rNoise.status === 'fail',
  `status=${rNoise.status} target_r=${rNoise.criteria?.discriminant_validity?.target_abs_corr?.toFixed(3)}`);

const rNoLabels = runCVP({ metric: validMetric, target: [] });
rec('1d. CVP harness returns PENDING (never pass) with no operator labels',
  !rNoLabels.calibrated && rNoLabels.status === 'pending', `status=${rNoLabels.status}`);

const rFew = runCVP({ metric: validMetric.slice(0, 5), target: target.slice(0, 5), confounds: { topic: topic.slice(0, 5) } });
rec('1e. CVP harness returns PENDING with too few samples (n < min_n)',
  !rFew.calibrated && rFew.status === 'pending', `status=${rFew.status}`);

// ── 2. Presentation-contract validator ───────────────────────────────────────
// (a) Un-contracted Tier-1 metric → refuse.
const vNoContract = validatePresentation({ family: 'made_up_tier1_metric', tier: 1, cvp_status: 'pass', contracts: CONTRACTS });
rec('2a. validator REFUSES an un-contracted Tier-1 metric',
  vNoContract.surfaceable === false, vNoContract.reason);

// (b) Contracted Tier-1 metric that is CVP-pending → refuse (this is the real
//     state of the anchor families).
const vPending = validatePresentation({ family: 'insight_embedding_proximity', contracts: CONTRACTS });
rec('2b. validator REFUSES a contracted Tier-1 metric with cvp_status=pending (insight_embedding_proximity)',
  vPending.surfaceable === false && vPending.hasContract === true && vPending.requiresCVP === true,
  vPending.reason);

// (c) Contracted Tier-1 metric that has cleared CVP → allow.
const vPass = validatePresentation({ family: 'insight_embedding_proximity', cvp_status: 'pass', contracts: CONTRACTS });
rec('2c. validator ALLOWS a contracted Tier-1 metric once cvp_status=pass',
  vPass.surfaceable === true, vPass.reason);

// (d) Contracted non-Tier-1 metric (the harmonic family) → allow (no CVP gate).
const vHarmonic = validatePresentation({ family: 'information_harmonic_amplitude', contracts: CONTRACTS });
rec('2d. validator ALLOWS a contracted non-Tier-1 metric (information_harmonic_amplitude)',
  vHarmonic.surfaceable === true && vHarmonic.requiresCVP === false, vHarmonic.reason);

// (e) The throwing guard throws for the pending anchor metric.
let threw = false;
try { assertNotSurfacedUnlessValidated({ family: 'affective_volatility_within_window', contracts: CONTRACTS }); }
catch (e) { threw = e.code === 'CVP_NOT_VALIDATED'; }
rec('2e. assertNotSurfacedUnlessValidated THROWS CVP_NOT_VALIDATED for a pending Tier-1 metric', threw);

// ── 3. Anchor metrics are registered + stored as cvp_status=pending ──────────
const allAnchorFamiliesPending = Object.values(TIER1_EMBEDDING_FAMILIES).every((f) => f.cvp_status === 'pending' && f.tier === 1);
const allHaveContracts = Object.keys(TIER1_EMBEDDING_FAMILIES).every((k) => !!CONTRACTS[k] && CONTRACTS[k].cvp_status === 'pending');
rec('3a. all 4 Tier-1 anchor families are registered cvp_status=pending + have a contract',
  allAnchorFamiliesPending && allHaveContracts,
  `families=${Object.keys(TIER1_EMBEDDING_FAMILIES).length} pending=${allAnchorFamiliesPending} contracts=${allHaveContracts}`);

// Run the REAL anchor stage (stub embedder) and confirm the DB rows are pending.
const DB = 'data/verify-cvp.db', KCV = 'data/verify-cvp-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user', RUN = 'era-verify-cvp-0001', DIM = 768;
const masterKey = await importMasterKey(userHex);
const DAY_MS = 86400000, now = Date.now(), M = 120;
function vec(i) { const v = new Float32Array(DIM); for (let d = 0; d < DIM; d++) v[d] = Math.sin((d + 1) * 0.01 + i * 0.07); let nn = 0; for (let d = 0; d < DIM; d++) nn += v[d] * v[d]; nn = Math.sqrt(nn) || 1; for (let d = 0; d < DIM; d++) v[d] /= nn; return v; }
for (let i = 0; i < M; i++) {
  const ts = new Date(now - (60 - Math.floor((i / M) * 60)) * DAY_MS + (i % 24) * 3600000).toISOString().replace('Z', '+00:00');
  await db.rawQuery(`INSERT INTO messages (id, user_id, role, content, embedding_768, created_at) VALUES (?,?,'user',NULL,?,?)`,
    [`m-${i}`, U, await encryptVector(vec(i), 'personal', masterKey), ts]);
}
try {
  const r = spawnSync('pipeline/.venv/bin/python3', ['pipeline/compute-anchors.py'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: RUN, ANCHOR_EMBEDDER: 'stub' },
  });
  rec('3b. compute-anchors.py runs (stub) for the CVP-state check', r.status === 0, r.status !== 0 ? (r.stderr || '').slice(-400) : 'ok');
  const raw = new Database(DB, { readonly: true });
  const total = raw.prepare(`SELECT COUNT(*) n FROM cognitive_metrics_anchor WHERE user_id=? AND era_id=?`).get(U, RUN).n;
  const nonPending = raw.prepare(`SELECT COUNT(*) n FROM cognitive_metrics_anchor WHERE user_id=? AND era_id=? AND cvp_status<>'pending'`).get(U, RUN).n;
  raw.close();
  rec('3c. EVERY stored anchor metric row has cvp_status=pending (not surfaced as validated)',
    total > 0 && nonPending === 0, `rows=${total} non_pending=${nonPending}`);
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — CVP harness criteria correct on fixtures; validator refuses un-contracted/un-validated Tier-1; anchor metrics cvp_status=pending' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
