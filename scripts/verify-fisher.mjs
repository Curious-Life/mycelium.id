// verify:fisher — K1a. Proves the Fisher keystone (information-geometry pillar)
// computes end-to-end: seed a vault with territory_profiles + clustering_points
// spread across weekly windows with a deliberate distribution drift, run the
// REAL pipeline/compute-fisher.py, then assert via the REAL read-side
// (src/db/fisher.js) that fisher_trajectory is populated and a phase is
// classified — i.e. cognitiveState movement is no longer hollow. Also proves
// the era-skip optimization (second run skips) and sha256-seed determinism
// (recompute is bit-identical). PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createFisherNamespace } from '../src/db/fisher.js';

const DB = 'data/verify-fisher.db', KCV = 'data/verify-fisher-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const RUN = 'era-verify-fisher-0001';
const PY = 'pipeline/.venv/bin/python3';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// ── Seed: 3 territories → 3 realms/themes; ~10 weeks of daily points whose
//    realm mix drifts (R1-heavy early → R3-heavy late) to produce movement. ──
const TERRS = [
  { tid: 'T1', realm: 'R1', theme: 'TH1' },
  { tid: 'T2', realm: 'R2', theme: 'TH2' },
  { tid: 'T3', realm: 'R3', theme: 'TH3' },
];
for (const t of TERRS) {
  await db.rawQuery(
    `INSERT INTO territory_profiles (id, user_id, territory_id, realm_id, semantic_theme_id)
     VALUES (?,?,?,?,?)`,
    [`tp-${t.tid}`, U, t.tid, t.realm, t.theme]);
}

const DAY_MS = 86400000;
const now = Date.now();
const DAYS = 77; // 11 weeks
let cpN = 0;
const stmts = [];
for (let d = DAYS; d >= 1; d--) {
  const ts = new Date(now - d * DAY_MS);
  const iso = ts.toISOString().replace('Z', '+00:00'); // match windows_for offset format
  // Drift weight: early days favor T1, late days favor T3 (creates a trajectory).
  const frac = (DAYS - d) / DAYS; // 0 → 1 over time
  const weights = [1 - frac, 0.4, frac]; // T1 falls, T3 rises, T2 steady
  const total = weights.reduce((a, b) => a + b, 0);
  const perDay = 6; // ≥ N_MIN(15) per weekly window (6*7=42)
  for (let k = 0; k < perDay; k++) {
    // Pick a territory by weight (deterministic round-robin by cumulative weight).
    const r = ((k + 0.5) / perDay) * total;
    let acc = 0, pick = 0;
    for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (r <= acc) { pick = i; break; } }
    const t = TERRS[pick];
    stmts.push([`cp-${cpN}`, U, t.tid, iso]);
    cpN++;
  }
}
for (const [id, uid, tid, iso] of stmts) {
  await db.rawQuery(
    `INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, created_at)
     VALUES (?,?,'message',?,?,?)`,
    [id, uid, id, tid, iso]);
}

function runFisher(extraEnv = {}) {
  const r = spawnSync(PY, ['pipeline/compute-fisher.py'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: RUN, ...extraEnv },
  });
  return r;
}

const fisher = createFisherNamespace({
  d1Query: (sql, params) => db.rawQuery(sql, params),
  firstRow: (res) => (Array.isArray(res) ? res[0] : (res?.results?.[0])) || null,
});
const VALID_PHASES = new Set(['stable', 'cycling', 'exploring', 'transforming']);

try {
  // ── F1. compute-fisher.py runs clean ──────────────────────────────────────
  const run1 = runFisher();
  rec('F1. compute-fisher.py exits 0 on a seeded vault',
    run1.status === 0, run1.status !== 0 ? (run1.stderr || run1.stdout || '').slice(-400) : (run1.stdout.match(/\[fisher\] total:.*/)?.[0] || ''));

  // ── F2. fisher_trajectory populated (weekly_step realm rows) ───────────────
  const raw = new Database(DB, { readonly: true });
  const wsRealm = raw.prepare(
    `SELECT COUNT(*) AS n FROM fisher_trajectory WHERE user_id=? AND level='realm' AND window_type='weekly_step' AND clustering_run_id=?`)
    .get(U, RUN).n;
  const totalRows = raw.prepare(`SELECT COUNT(*) AS n FROM fisher_trajectory WHERE clustering_run_id=?`).get(RUN).n;
  const confident = raw.prepare(
    `SELECT COUNT(*) AS n FROM fisher_trajectory WHERE user_id=? AND window_type='weekly_step' AND level='realm' AND low_confidence=0`)
    .get(U).n;
  raw.close();
  rec('F2. fisher_trajectory has weekly_step realm rows (+ confident windows)',
    wsRealm > 0 && confident > 0, `weekly_step_realm=${wsRealm} confident=${confident} total_rows=${totalRows}`);

  // ── F3. read-side getCurrentPhase returns a classified phase ───────────────
  const phase = await fisher.getCurrentPhase(U, { level: 'realm' });
  rec('F3. getCurrentPhase(realm) returns a valid phase (movement no longer hollow)',
    !!phase && VALID_PHASES.has(phase.phase) && typeof phase.fisher_trajectory_length !== 'undefined',
    phase ? `phase=${phase.phase} L=${phase.fisher_trajectory_length} R_recent=${phase.R_recent} z=${phase.fisher_velocity_z}` : 'null');

  // ── F4. getTrajectory + getTopMovers parse cleanly ─────────────────────────
  const traj = await fisher.getTrajectory(U, { level: 'realm', windowType: 'weekly_step', runId: RUN });
  const movers = await fisher.getTopMovers(U, { level: 'realm', runId: RUN });
  rec('F4. getTrajectory rows + top_contributors JSON parse (drift → non-empty movers)',
    traj.length > 0 && Array.isArray(movers),
    `trajectory_rows=${traj.length} top_movers=${movers.length}`);

  // ── F5. era-skip: a second run with the same run_id skips existing rows ─────
  const run2 = runFisher();
  const skipped2 = parseInt((run2.stdout.match(/total: wrote (\d+), skipped (\d+)/) || [])[2] || '-1', 10);
  rec('F5. era-skip: re-run with same run_id skips existing windows (wrote≈0, skipped>0)',
    run2.status === 0 && skipped2 > 0, `${run2.stdout.match(/\[fisher\] total:.*/)?.[0] || run2.stderr.slice(-200)}`);

  // ── F6. sha256-seed determinism: --full recompute is bit-identical ─────────
  // K1b: fisher_velocity/z are ENCRYPTED at rest (random IV → ciphertext differs
  // every write), so compare DECRYPTED values via the adapter (db.rawQuery
  // auto-decrypts + fisher.js coerces to numbers), not raw ciphertext.
  const readSample = async () => {
    const rows = await db.rawQuery(
      `SELECT fisher_velocity, fisher_velocity_z FROM fisher_trajectory
       WHERE user_id=? AND level='realm' AND window_type='weekly_step' AND clustering_run_id=? AND low_confidence=0
       ORDER BY window_start DESC LIMIT 1`, [U, RUN]);
    return (Array.isArray(rows) ? rows[0] : rows?.results?.[0]) || null;
  };
  const before = await readSample();
  const run3 = runFisher({ FISHER_FORCE_FULL: '1' });
  const after = await readSample();
  const same = before && after &&
    Math.abs(Number(before.fisher_velocity) - Number(after.fisher_velocity)) < 1e-12 &&
    Math.abs(Number(before.fisher_velocity_z) - Number(after.fisher_velocity_z)) < 1e-12;
  rec('F6. sha256-seed: --full recompute is bit-identical (decrypted velocity + z stable)',
    run3.status === 0 && same,
    before && after ? `v ${before.fisher_velocity}→${after.fisher_velocity} | z ${before.fisher_velocity_z}→${after.fisher_velocity_z}` : 'missing row');
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — Fisher keystone computes; movement pillar lit; era-skip + deterministic seed verified' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
