// verify:pipeline-runs-through — the gate that did not exist.
//
// WHY THIS GATE EXISTS
// --------------------
// Until 2026-07-27, NO gate in this repo had ever executed the pipeline. Three claimed to:
//   · verify:generate       spawns a FAKE script via MYCELIUM_CLUSTER_SCRIPT (its own header, :3-5)
//   · verify:measure-only   readFileSync + indexOf on the bash TEXT, asserting the MEASURE_ONLY
//                           guard sits between two string offsets (:19-27)
//   · verify:stage-accounting  unit test of the helper — "no vault, no spawn" (:4)
// verify-generate.mjs:5 states the gap outright: "the REAL run-clustering.sh needs the Tier-2
// Python stack on the host." Known, documented, never closed.
//
// That is why an operator hits "step 5/16 failed exit 1" on a build where every gate is green.
// It is not a gate that went green for the wrong reason — it is worse: there was never a baseline,
// so there was no regression to catch. See the pipeline-sprint design Part 0a/0b.
//
// WHAT IT DOES
// ------------
// Builds a REAL vault (scripts/lib/pipeline-fixture.mjs — genuine 768-f32 L2-normalised vectors in
// K separated clusters, spread over time), then runs EVERY stage as its own child, in dependency
// order, and reports a per-stage table.
//
// ⚠️ THE THREE-WAY DISTINCTION IS THE WHOLE POINT. A stage is exactly one of:
//   OK           it ran and exited 0
//   FAILED       it ran and exited non-zero            → NO-GO
//   SKIPPED      an upstream dependency did not succeed → NO-GO (something failed)
//   UNAVAILABLE  its interpreter/deps are absent on this host → NOT a pass, NOT a failure
//
// UNAVAILABLE exists because CI installs Tier-1 Python deps ONLY (.github/workflows/verify.yml:79-85
// deliberately excludes faiss / igraph / leidenalg / umap as heavy native wheels), so cluster.py
// cannot run there. Collapsing UNAVAILABLE into "pass" would rebuild the exact silence this gate
// replaces — a green verdict over a pipeline nobody ran. So the VERDICT always prints the executed
// count, and says in words that unexecuted stages are NOT verified.
//
// A run where cluster.py is UNAVAILABLE still has real value: the stages that need no Tier-2 deps
// (harmonics, embedding-trajectory, coherence, behavioral, sync) do execute against a real vault.
//
// COVERAGE NOTE (no silent caps): stage 'anchors' needs the embed-service on MYCELIUM_EMBED_PORT
// (default 8091) and takes ~4.5 min against it; it is UNAVAILABLE unless PIPELINE_E2E_ANCHORS=1.
// That is a declared exclusion, printed in the table, never hidden.
//
// MUTATION-TESTED: broke compute-cofire.js's SQL (renamed a column in its INSERT) → cofire FAILED
//   and audit/vitality/gravity SKIPPED, verdict NO-GO, and the failing stage was named. Restored → GO.
// MUTATION-TESTED: pointed the runner at the FAKE pipeline script the way verify:generate does
//   (MYCELIUM_CLUSTER_SCRIPT) → the gate ignores it and still runs the real stage binaries, so a
//   stub CANNOT satisfy this gate. That is the specific evasion that made the three gates above
//   worthless, and it must stay impossible here.
// MUTATION-TESTED: ran with MYCELIUM_PYTHON=/usr/bin/python3 (no deps at all) → 19 UNAVAILABLE,
//   0 FAILED, verdict "GO (PARTIAL — 1/20 stages executed)" naming all 19 unverified stages.
//   An absent dependency must never be reported as a failure, and a partial run must never be
//   readable as a full one.
//
// ⚠️ THE CI SIMULATION ALSO CAUGHT A BUG IN THIS GATE. The first version tagged only cluster.py as
//   python-dependent, so on a Tier-1 host the metric stages RAN and died with
//   `ModuleNotFoundError: numpy` — and the gate reported FOUR FAILURES for dependencies that were
//   simply absent. Inventing failures is the same dishonesty as hiding them. There are now TWO
//   tiers: Tier-1 (numpy/scipy/cryptography/dotenv — what verify.yml:83-85 installs) and Tier-2
//   (+ the heavy faiss/igraph/leidenalg/sklearn/umap wheels CI deliberately excludes, needed only
//   by cluster.py).
// MUTATION-TESTED: made the fixture write 'x' strings instead of real f32 vectors (the shape
//   verify-pipeline-integrity uses) → NO-GO. ⚠️ RE-MEASURED after sync-clustering-points gained
//   stage accounting: this mutation now REDs EARLIER and BETTER than it used to. It previously
//   passed every stage and was caught only by W1 at the end ("0 points / 0 territories / 0
//   realms"); today sync itself exits 1 with
//     "sync-clustering-points: incomplete — 0/240 written, 240 failed (embedding_768 did not
//      decode to a 256d vector)"
//   and 13 dependents correctly skip. The record is updated rather than left claiming the old
//   path, because a mutation record nobody re-measures is exactly the rot /gate-teeth exists to
//   prevent. W1 remains as the orchestrator-level backstop for a stage that has NO accounting.
//
// ⚠️ THAT LAST MUTATION EXPOSED A REAL HOLE IN THIS GATE, AND IS WHY W1 EXISTS. On its first
//   version the mock-fixture run went **GREEN**: 19/20 stages OK, verdict GO — with cluster.py
//   finishing in 178ms instead of 13s. Nothing was wrong with any exit code. sync found no
//   DECODABLE embeddings, wrote zero clustering_points, and every downstream stage then correctly
//   no-opped over a legitimately empty input and exited 0. "Every stage exited 0" does NOT mean
//   "the pipeline ran" — a pipeline that processes NOTHING passes that test perfectly. It is the
//   silent-no-op class stage-result.js catches INSIDE a stage, reappearing at the ORCHESTRATOR.
//   W1 asserts the vault actually gained topology (points >= fixture size, and >0 mapped points,
//   territories and realms). Baseline on the real fixture: 240 points · 240 mapped · 24
//   territories · 3 realms.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { buildPipelineFixture } from './lib/pipeline-fixture.mjs';

const PY = process.env.MYCELIUM_PYTHON
  || (existsSync('pipeline/.venv/bin/python3') ? 'pipeline/.venv/bin/python3' : 'python3');
const DB = 'data/verify-pipeline-e2e.db';
const KCV = 'data/verify-pipeline-e2e-kcv.json';
const RUN_ANCHORS = process.env.PIPELINE_E2E_ANCHORS === '1';

// ── The stage manifest + its dependency DAG ──────────────────────────────────
// The edges are NOT invented here: they are the ones run-clustering.sh states in its own comments
// (:196-201 "all four depend on cluster.py output + the co-firing graph (Step 4)", :226-229
// novelty "UPDATEs the complexity rows just written", :239-242 coupling "runs AFTER harmonics
// because it ENRICHES those rows" / criticality "reads the trajectory series").
// `py` marks a stage that needs the Tier-2 Python stack.
const STAGES = [
  { name: 'sync',        cmd: ['node', 'pipeline/sync-clustering-points.js'],        needs: [] },
  { name: 'cluster',     cmd: [PY,     'pipeline/cluster.py'],       py: 2,          needs: ['sync'] },
  { name: 'describe',    cmd: ['node', 'pipeline/describe-clusters.js'],             needs: ['cluster'] },
  { name: 'snapshot',    cmd: ['node', 'pipeline/snapshot-entities.js'],             needs: ['describe'] },
  { name: 'cofire',      cmd: ['node', 'pipeline/compute-cofire.js'],                needs: ['cluster'] },
  { name: 'neighbors',   cmd: ['node', 'pipeline/compute-territory-neighbors.js'],   needs: ['cluster'] },
  { name: 'harmonics',   cmd: [PY,     'pipeline/compute_information_harmonics.py'], py: 1, needs: [] },
  { name: 'fisher',      cmd: [PY,     'pipeline/compute-fisher.py'], py: 1,                needs: ['cluster'] },
  { name: 'emb-traj',    cmd: [PY,     'pipeline/compute-embedding-trajectory.py'], py: 1,  needs: [] },
  { name: 'audit',       cmd: ['node', 'pipeline/topology-audit.js'],                needs: ['cofire'] },
  { name: 'vitality',    cmd: ['node', 'pipeline/compute-vitality.js'],              needs: ['cofire'] },
  { name: 'gravity',     cmd: ['node', 'pipeline/compute-gravity.js'],               needs: ['cofire'] },
  { name: 'complexity',  cmd: ['node', 'pipeline/compute-complexity.js'],            needs: ['cluster'] },
  { name: 'novelty',     cmd: [PY,     'pipeline/compute-embedding-novelty.py'], py: 1,     needs: ['complexity'] },
  { name: 'frequency',   cmd: [PY,     'pipeline/compute-frequency.py'], py: 1,             needs: ['cluster'] },
  { name: 'coupling',    cmd: [PY,     'pipeline/compute-cross-scale-coupling.py'], py: 1,  needs: ['harmonics'] },
  { name: 'criticality', cmd: [PY,     'pipeline/compute-criticality.py'], py: 1,           needs: ['fisher'] },
  { name: 'coherence',   cmd: [PY,     'pipeline/compute-coherence.py'], py: 1,             needs: [] },
  { name: 'behavioral',  cmd: [PY,     'pipeline/compute-behavioral.py'], py: 1,            needs: [] },
  { name: 'anchors',     cmd: [PY,     'pipeline/compute-anchors.py'], py: 1,               needs: [],
    env: { ANCHOR_EMBEDDER: 'http' }, optIn: 'PIPELINE_E2E_ANCHORS' },
];

// ── Host capability probe (decides UNAVAILABLE, never silently) ──────────────
// The SAME import list run-clustering.sh:78 probes, plus the version floor cluster.py needs.
const probe = (args) => spawnSync(PY, ['-c', args], { encoding: 'utf8', timeout: 60_000 });
// TWO TIERS, because CI has one and not the other. Tier-1 = the metric stages' imports
// (numpy/scipy/cryptography/dotenv) — what .github/workflows/verify.yml:83-85 installs. Tier-2 adds
// the heavy native ML wheels (faiss/igraph/leidenalg/sklearn/umap) that only cluster.py needs and
// that CI deliberately excludes as too heavy.
// ⚠️ Tagging every python stage with one flag was WRONG and the CI simulation caught it: on a
// Tier-1 host the metric stages RAN and died with `ModuleNotFoundError: numpy`, and the gate
// reported four FAILURES for deps that were simply absent. An absent dependency is UNAVAILABLE,
// never a failure — inventing failures is the same dishonesty as hiding them.
const tier1 = probe('import numpy,scipy,cryptography,dotenv').status === 0;
const tier2 = probe('import numpy,dotenv,cryptography,faiss,igraph,leidenalg,scipy,sklearn,umap').status === 0;
const pyOk = probe('import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)').status === 0;
const haveTier = (n) => pyOk && (n === 2 ? tier2 : tier1);

const HEX = (c) => c.repeat(64);
const fx = buildPipelineFixture({ dbPath: DB, userId: 'local-user' });
if (existsSync(KCV)) rmSync(KCV); // a KCV from a prior fixture holds DIFFERENT keys → every
                                  // src/index.js-booting stage would die "USER_MASTER KCV failed"
const ENV = {
  ...process.env,
  USER_MASTER: HEX('a'), SYSTEM_KEY: HEX('b'),
  MYCELIUM_DB: `./${DB}`,
  // paths.js:54 defaults kcvPath to the SHARED data/kcv.json — without our own, this fixture
  // unlocks against whatever other vault last wrote that file.
  MYCELIUM_KCV: `./${KCV}`,
  MYCELIUM_USER_ID: fx.userId,
  MINDSCAPE_OWNER_ID: fx.userId,
  MYCELIUM_DESCRIBE_PRESERVE: '1',
  PYTHONPATH: 'pipeline',
};

const state = new Map();
const rows = [];

for (const st of STAGES) {
  if (st.optIn && process.env[st.optIn] !== '1') {
    state.set(st.name, 'unavailable');
    rows.push({ name: st.name, status: 'UNAVAILABLE', ms: 0, detail: `opt-in: set ${st.optIn}=1` });
    continue;
  }
  if (st.py && !haveTier(st.py)) {
    state.set(st.name, 'unavailable');
    rows.push({ name: st.name, status: 'UNAVAILABLE', ms: 0,
      detail: !pyOk ? 'python < 3.10' : `Tier-${st.py} python deps absent` });
    continue;
  }
  const blocked = st.needs.filter((d) => state.get(d) !== 'ok');
  if (blocked.length) {
    // An upstream that is UNAVAILABLE propagates as UNAVAILABLE (nothing is broken); an upstream
    // that FAILED propagates as SKIPPED (something is). Conflating them would let a dep-less CI
    // host report failures it never actually observed.
    const anyFailed = blocked.some((d) => state.get(d) === 'failed' || state.get(d) === 'skipped');
    state.set(st.name, anyFailed ? 'skipped' : 'unavailable');
    rows.push({ name: st.name, status: anyFailed ? 'SKIPPED' : 'UNAVAILABLE', ms: 0,
      detail: `upstream ${blocked.join(',')} ${anyFailed ? 'failed' : 'unavailable'}` });
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(st.cmd[0], st.cmd.slice(1), {
    env: { ...ENV, ...(st.env || {}) }, encoding: 'utf8',
    timeout: Number(process.env.PIPELINE_E2E_STAGE_TIMEOUT_MS || 600_000),
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  // A harness TIMEOUT is reported as its own thing, never as a stage failure — the first run of
  // this probe killed a healthy 268s stage at 60s and I reported the killer as the defect.
  if (r.error && r.error.code === 'ETIMEDOUT') {
    state.set(st.name, 'failed');
    rows.push({ name: st.name, status: 'TIMEOUT', ms, detail: 'harness cap — raise PIPELINE_E2E_STAGE_TIMEOUT_MS' });
    continue;
  }
  const ok = r.status === 0;
  state.set(st.name, ok ? 'ok' : 'failed');
  const tail = (r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  rows.push({ name: st.name, status: ok ? 'OK' : `EXIT ${r.status}`, ms, detail: ok ? '' : tail.slice(0, 150) });
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`fixture: ${fx.messages} messages · ${fx.clusters} latent clusters · real 768-f32 embeddings`);
console.log(`host: python=${PY} py>=3.10=${pyOk} tier1-deps=${tier1} tier2-deps=${tier2}`);
console.log('');
console.log('STAGE          STATUS        TIME      DETAIL');
console.log('-'.repeat(96));
for (const r of rows) console.log(`${r.name.padEnd(14)} ${String(r.status).padEnd(13)} ${String(r.ms + 'ms').padEnd(9)} ${r.detail}`);
console.log('-'.repeat(96));

// ── W1: DID IT ACTUALLY DO WORK? ─────────────────────────────────────────────
// ⚠️ THIS CHECK EXISTS BECAUSE THE GATE WAS GREEN FOR THE WRONG REASON, AND THE MUTATION ROUND
// CAUGHT IT. Replacing the fixture's real f32 vectors with the `'x'` placeholder that
// verify-pipeline-integrity uses produced: 19/20 stages OK, verdict GO — with `cluster` finishing
// in 178ms instead of 13s. Nothing was wrong with the exit codes. sync found no DECODABLE
// embeddings, wrote zero clustering_points, and every downstream stage then correctly no-opped over
// a legitimately empty input and exited 0.
//
// So "every stage exited 0" does NOT mean "the pipeline ran". A pipeline that processes nothing
// passes that test perfectly — the silent-no-op class stage-result.js was built to catch INSIDE a
// stage, reappearing one level up at the ORCHESTRATOR. Assert the vault actually gained topology.
let work = null;
try {
  const { default: Database } = await import('better-sqlite3');
  const d = new Database(DB, { readonly: true });
  const one = (sql) => { try { return Number(d.prepare(sql).get()?.c ?? 0); } catch { return 0; } };
  work = {
    points: one('SELECT COUNT(*) c FROM clustering_points'),
    mapped: one('SELECT COUNT(*) c FROM clustering_points WHERE landscape_x IS NOT NULL'),
    territories: one('SELECT COUNT(*) c FROM territory_profiles'),
    realms: one('SELECT COUNT(*) c FROM realms'),
  };
  d.close();
} catch (e) {
  work = { error: String(e?.message || e) };
}
// Only meaningful when the clustering stage actually ran; on a Tier-1 host it is UNAVAILABLE and
// there is no topology to expect.
const clusterRan = state.get('cluster') === 'ok';
const didWork = !clusterRan || (work && !work.error
  && work.points >= fx.messages && work.mapped > 0 && work.territories > 0 && work.realms > 0);

const executed = rows.filter((r) => r.status === 'OK').length;
const failed = rows.filter((r) => String(r.status).startsWith('EXIT') || r.status === 'TIMEOUT');
const skipped = rows.filter((r) => r.status === 'SKIPPED');
const unavailable = rows.filter((r) => r.status === 'UNAVAILABLE');
console.log(`${executed} executed · ${failed.length} failed · ${skipped.length} skipped-upstream · ${unavailable.length} unavailable · of ${rows.length}`);

// GO requires: nothing failed, nothing skipped-because-of-a-failure, AND at least one stage
// actually ran. `executed === 0` is the trap this guard exists for — a host with no deps would
// otherwise report "0 failed" and go green over a pipeline it never touched.
const allRan = failed.length === 0 && skipped.length === 0 && executed > 0 && didWork;
console.log(clusterRan
  ? `W1 work done: ${work.error ? `UNREADABLE (${work.error})` : `${work.points} points · ${work.mapped} on the map · ${work.territories} territories · ${work.realms} realms`}`
  : 'W1 work done: n/a (clustering did not run on this host)');
console.log('');
if (!allRan) {
  console.log('VERDICT: NO-GO — '
    + (executed === 0 ? 'ZERO stages executed on this host: this run proves nothing about the pipeline.'
      : failed.length || skipped.length
        ? `${failed.length} stage(s) failed${failed.length ? ` (${failed.map((f) => f.name).join(', ')})` : ''}`
          + `${skipped.length ? `, ${skipped.length} skipped behind them (${skipped.map((s) => s.name).join(', ')})` : ''}.`
        : `every stage exited 0 but the pipeline produced NO TOPOLOGY (${work?.error ? `vault unreadable: ${work.error}` : `${work.points} points, ${work.mapped} mapped, ${work.territories} territories, ${work.realms} realms — expected >= ${fx.messages} points and >0 of each`}).\n`
          + '        A pipeline that processes nothing exits 0 at every stage. Exit codes alone cannot tell\n'
          + '        the difference between "it worked" and "there was nothing to work on".'));
} else {
  // ⚠️ The VERDICT WORD itself carries the qualification. A bare "GO" over a host that executed
  // 1 of 20 stages is read at a glance as "the pipeline is verified" — which is the precise
  // misreading this gate exists to end. PARTIAL is unmissable in a CI log; the detail below is for
  // whoever stops to read.
  console.log(unavailable.length
    ? `VERDICT: GO (PARTIAL — ${executed}/${rows.length} stages executed on this host) — every stage that COULD`
      + ` run did, end to end against a real vault, and exited 0.`
    : `VERDICT: GO — all ${executed} pipeline stages ran end to end against a real vault and exited 0.`);
  if (unavailable.length) {
    console.log(`        ⚠️ ${unavailable.length} stage(s) were NOT executed on this host and are therefore NOT VERIFIED`);
    console.log(`           by this run: ${unavailable.map((u) => u.name).join(', ')}.`);
    console.log('           An unexecuted stage is not a passing stage. For full coverage run on a host with the');
    console.log('           Tier-2 python stack (bash pipeline/setup.sh) and PIPELINE_E2E_ANCHORS=1.');
  }
  console.log('        NOT PROVEN: that any stage produced CORRECT output — only that it ran to completion');
  console.log('        on real data. Per-stage correctness is what the individual metric gates own.');
}
process.exit(allRan ? 0 : 1);
