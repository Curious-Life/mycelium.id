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
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
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
import { applyAxisCVP } from '../src/metrics/axis-cvp.js';
import {
  assertColumnSurfaceable, gateAnchorValue, metricColumnFamily, ANCHOR_METRIC_COLUMNS,
  _HARMONIC_COLUMN_FAMILY,
} from '../src/metrics/surface-gate.js';
import { METRIC_COLUMNS } from '../src/db/metrics.js';

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

// ── 4. Surface-gate chokepoint (audit S1) — the gate is now WIRED ────────────
// 4a. assertColumnSurfaceable PASSES a non-Tier-1 harmonic column (has contract).
let harmonicOk = false;
try { const v = assertColumnSurfaceable('harmonic_amplitude_gamma_k1'); harmonicOk = v.surfaceable === true && v.requiresCVP === false; }
catch { harmonicOk = false; }
rec('4a. assertColumnSurfaceable ALLOWS a harmonic column (non-Tier-1, contracted)', harmonicOk);

// 4b. assertColumnSurfaceable THROWS for every Tier-1 anchor column (cvp pending).
// 12 = 4 original construct metrics (§4.5/4.11/4.12/4.13) + 8 E2 bipolar axis leans.
let anchorThrows = ANCHOR_METRIC_COLUMNS.length === 12;
for (const c of ANCHOR_METRIC_COLUMNS) {
  let threwHere = false;
  try { assertColumnSurfaceable(c); } catch (e) { threwHere = e.code === 'CVP_NOT_VALIDATED'; }
  if (!threwHere) anchorThrows = false;
}
rec('4b. assertColumnSurfaceable THROWS CVP_NOT_VALIDATED for all 12 Tier-1 anchor columns', anchorThrows,
  `anchor_cols=${ANCHOR_METRIC_COLUMNS.join(',')}`);

// 4c. An UNKNOWN column fails closed (never silently surfaced).
let unknownThrows = false;
try { assertColumnSurfaceable('totally_made_up_column'); } catch (e) { unknownThrows = e.code === 'CVP_UNKNOWN_COLUMN'; }
rec('4c. assertColumnSurfaceable FAILS CLOSED (CVP_UNKNOWN_COLUMN) on an unclassifiable column', unknownThrows);

// 4d. gateAnchorValue REPLACES a pending Tier-1 number with its refusal copy (never the raw value).
const g = gateAnchorValue('insight_embedding_proximity', 0.4242, { cvp_status: 'pending' });
rec('4d. gateAnchorValue drops the raw number + substitutes refusal copy for a pending Tier-1 metric',
  g.surfaceable === false && g.value === null && typeof g.refusal === 'string'
    && g.refusal === CONTRACTS.insight_embedding_proximity.refusal_mode,
  `surfaceable=${g.surfaceable} value=${g.value}`);

// 4e. gateAnchorValue surfaces the number once a metric is cvp_status='pass' (operator-calibrated).
const gp = gateAnchorValue('insight_embedding_proximity', 0.4242, { cvp_status: 'pass' });
rec('4e. gateAnchorValue surfaces the number once cvp_status=pass', gp.surfaceable === true && gp.value === 0.4242);

// 4f. DRIFT GUARD — surface-gate's harmonic column→family map covers EXACTLY the
// 41 columns db.metrics reads (so the two lists can never silently diverge).
const gateHarmonic = new Set(Object.keys(_HARMONIC_COLUMN_FAMILY));
const dbCols = new Set(METRIC_COLUMNS);
const missingInGate = [...dbCols].filter((c) => !gateHarmonic.has(c));
const extraInGate = [...gateHarmonic].filter((c) => !dbCols.has(c));
rec('4f. surface-gate harmonic family map == db.metrics METRIC_COLUMNS (no drift)',
  missingInGate.length === 0 && extraInGate.length === 0 && gateHarmonic.size === dbCols.size,
  `db=${dbCols.size} gate=${gateHarmonic.size} missing=[${missingInGate.join(',')}] extra=[${extraInGate.join(',')}]`);

// 4g. anchor columns resolve to Tier-1; harmonic columns to non-Tier-1.
const tierOk = ANCHOR_METRIC_COLUMNS.every((c) => metricColumnFamily(c)?.tier === 1)
  && metricColumnFamily('autocorrelation_lag1_gamma')?.tier === 0;
rec('4g. metricColumnFamily classifies anchor cols Tier-1 and harmonic cols non-Tier-1', tierOk);

// 4h. db/metrics.js INVOKES the gate on both read paths (structural — the live
// chokepoint, not just the helper existing). getCurrentWindow + getSeries both
// call checkSurfaceable.
const dbMetricsSrc = readFileSync('src/db/metrics.js', 'utf8');
const invokesGate = /checkSurfaceable\s*\(/.test(dbMetricsSrc)
  && /assertColumnSurfaceable/.test(dbMetricsSrc)
  && (dbMetricsSrc.match(/checkSurfaceable\(/g) || []).length >= 2; // def + ≥1 call site (loop counts once textually)
rec('4h. src/db/metrics.js wires the gate (checkSurfaceable → assertColumnSurfaceable) into its reads', invokesGate);

// 4i. NO UNGATED READER — the only src/packages file that queries the anchor
// table is the sanctioned gated reader src/db/anchor.js. Preserves the invariant
// the audit flagged: the day a reader is wired, it must go through the gate.
// Match an actual SQL access (FROM/JOIN/INTO/UPDATE <table>), not a prose mention
// in a comment — so the doc references in surface-gate.js/db/index.js don't trip it.
const grep = spawnSync('grep', ['-rlEi', '(from|join|into|update)[[:space:]]+cognitive_metrics_anchor',
  '--include=*.js', '--include=*.mjs', '--include=*.ts', 'src', 'packages'], { encoding: 'utf8' });
const readers = (grep.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
  .map((p) => p.replace(/^\.\//, ''));
const allowed = new Set(['src/db/anchor.js']);
const ungated = readers.filter((p) => !allowed.has(p));
rec('4i. NO ungated reader of cognitive_metrics_anchor outside src/db/anchor.js (the gated reader)',
  ungated.length === 0, `readers=[${readers.join(', ') || 'none'}] ungated=[${ungated.join(', ') || 'none'}]`);

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

  // 3d. The GATED reader (db.anchor) — wired into the assembled db — returns the
  // honest refusal copy and NEVER the raw decrypted number for these pending rows.
  // This is the chokepoint the audit asked for: a number cannot reach a consumer.
  let probed = null;
  for (const gr of ['alpha', 'theta', 'delta']) {
    const w = await db.anchor.getCurrentWindow(U, { granularity: gr });
    if (w.window_end) { probed = w; break; }
  }
  const noRawNumbers = !!probed && Object.values(probed.values).every((v) => v === null);
  const allRefused = !!probed && ANCHOR_METRIC_COLUMNS.every((c) => typeof probed.refusals[c] === 'string' && probed.refusals[c].length > 0);
  rec('3d. db.anchor (gated reader) returns refusal copy + ZERO raw numbers for pending anchor rows',
    !!probed && probed.surfaceable === false && probed.cvp_status === 'pending' && noRawNumbers && allRefused,
    probed ? `granularity=${probed.granularity} cvp=${probed.cvp_status} nonNullValues=${Object.values(probed.values).filter((v) => v !== null).length}` : 'no anchor window found via db.anchor');

  // ── 5. PER-AXIS CVP surfacing (E2): bipolar axes flip independently ──────────
  const av = new Database(DB, { readonly: true });
  const AV = av.prepare('SELECT anchor_version FROM cognitive_axis_separability LIMIT 1').get()?.anchor_version;
  av.close();
  const probeWindow = async () => {
    for (const gr of ['alpha', 'theta', 'delta']) {
      const w = await db.anchor.getCurrentWindow(U, { granularity: gr });
      if (w.window_end) return w;
    }
    return null;
  };

  // 5a. Flip ONE axis to pass via per-axis status; a pending sibling still refuses.
  await db.rawQuery("UPDATE cognitive_axis_separability SET cvp_status='pass' WHERE axis='tone' AND anchor_version=?", [AV]);
  const w5a = await probeWindow();
  rec('5a. per-axis: a CVP-passed axis (tone) SURFACES while a pending sibling (charge) REFUSES',
    !!w5a && w5a.refusals.tone_lean === undefined && typeof w5a.refusals.charge_lean === 'string',
    w5a ? `tone_refused=${w5a.refusals.tone_lean !== undefined} charge_refused=${w5a.refusals.charge_lean !== undefined}` : 'no window');

  // 5b. Fail-closed: a *_lean with NO separability row → status absent → REFUSED.
  await db.rawQuery("DELETE FROM cognitive_axis_separability WHERE axis='kusala' AND anchor_version=?", [AV]);
  const w5b = await probeWindow();
  rec('5b. per-axis FAIL-CLOSED: a *_lean with no separability row is REFUSED (default pending)',
    !!w5b && typeof w5b.refusals.kusala_lean === 'string',
    w5b ? `kusala_refused=${w5b.refusals.kusala_lean !== undefined}` : 'no window');

  // 5c. applyAxisCVP: genuine signal → 'pass' (persisted); noise → NOT pass.
  const N = 30;
  const target = Array.from({ length: N }, (_, i) => Math.sin(i * 0.6));
  const genuine = target.map((t, i) => t + 0.04 * Math.cos(i * 7));
  const noise = Array.from({ length: N }, (_, i) => Math.cos(i * 11.3));
  const baselines = { word_count: Array.from({ length: N }, (_, i) => i % 5) };
  const confounds = { topic: Array.from({ length: N }, (_, i) => Math.cos(i * 3.1)) };
  const repGood = await applyAxisCVP(db.rawQuery, { axis: 'noticing', anchorVersion: AV, metric: genuine, target, baselines, confounds });
  const repBad = await applyAxisCVP(db.rawQuery, { axis: 'holding', anchorVersion: AV, metric: noise, target, baselines, confounds });
  const chk = new Database(DB, { readonly: true });
  const nStatus = chk.prepare("SELECT cvp_status FROM cognitive_axis_separability WHERE axis='noticing' AND anchor_version=?").get(AV)?.cvp_status;
  const hStatus = chk.prepare("SELECT cvp_status FROM cognitive_axis_separability WHERE axis='holding' AND anchor_version=?").get(AV)?.cvp_status;
  chk.close();
  rec('5c. applyAxisCVP flips a genuine axis to PASS and a noise axis to NOT-pass (persisted)',
    repGood.status === 'pass' && nStatus === 'pass' && repBad.status !== 'pass' && hStatus !== 'pass',
    `noticing=${repGood.status}/${nStatus} holding=${repBad.status}/${hStatus}`);
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — CVP harness criteria correct on fixtures; validator refuses un-contracted/un-validated Tier-1; anchor metrics cvp_status=pending' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
