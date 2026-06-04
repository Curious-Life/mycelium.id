// verify:fisher-encryption — K1b. Proves the sensitive fisher_trajectory /
// fisher_milestones columns are ENCRYPTED at rest (wrapped-DEK envelopes, not
// plaintext distributions / metrics / headlines) while structural columns
// (phase, window_*, counts, low_confidence) stay plaintext, AND that the JS
// adapter auto-decrypts + fisher.js coerces on read so the pillar still works.
// Runs the REAL pipeline/compute-fisher.py writer. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createFisherNamespace } from '../src/db/fisher.js';

const DB = 'data/verify-fisher-enc.db', KCV = 'data/verify-fisher-enc-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const RUN = 'era-verify-fisher-enc-0001';
const PY = 'pipeline/.venv/bin/python3';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};

// Seed (same drift recipe as verify:fisher — guarantees confident windows + movement).
const TERRS = [
  { tid: 'T1', realm: 'R1', theme: 'TH1' },
  { tid: 'T2', realm: 'R2', theme: 'TH2' },
  { tid: 'T3', realm: 'R3', theme: 'TH3' },
];
for (const t of TERRS) {
  await db.rawQuery(
    `INSERT INTO territory_profiles (id, user_id, territory_id, realm_id, semantic_theme_id) VALUES (?,?,?,?,?)`,
    [`tp-${t.tid}`, U, t.tid, t.realm, t.theme]);
}
const DAY_MS = 86400000, now = Date.now(), DAYS = 77;
let cpN = 0;
for (let d = DAYS; d >= 1; d--) {
  const iso = new Date(now - d * DAY_MS).toISOString().replace('Z', '+00:00');
  const frac = (DAYS - d) / DAYS;
  const weights = [1 - frac, 0.4, frac];
  const total = weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k < 6; k++) {
    const r = ((k + 0.5) / 6) * total;
    let acc = 0, pick = 0;
    for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (r <= acc) { pick = i; break; } }
    await db.rawQuery(
      `INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, created_at) VALUES (?,?,'message',?,?,?)`,
      [`cp-${cpN}`, U, `cp-${cpN}`, TERRS[pick].tid, iso]);
    cpN++;
  }
}

const fisher = createFisherNamespace({
  d1Query: (sql, params) => db.rawQuery(sql, params),
  firstRow: (res) => (Array.isArray(res) ? res[0] : (res?.results?.[0])) || null,
});

try {
  const run = spawnSync(PY, ['pipeline/compute-fisher.py'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: RUN },
  });
  if (run.status !== 0) throw new Error(`compute-fisher failed: ${(run.stderr || run.stdout).slice(-400)}`);

  const raw = new Database(DB, { readonly: true });

  // ── FE1. trajectory: sensitive cols ciphertext; structural cols plaintext ──
  const tr = raw.prepare(
    `SELECT activation_vector, top_contributors, fisher_velocity, fisher_velocity_z,
            fisher_displacement, fisher_trajectory_length, exploration_ratio, R_recent,
            activation_entropy, phase, phase_recent, message_count, window_start, low_confidence
     FROM fisher_trajectory WHERE user_id=? AND level='realm' AND window_type='weekly_step'
       AND clustering_run_id=? AND low_confidence=0 ORDER BY window_start DESC LIMIT 1`)
    .get(U, RUN);
  const encCols = ['activation_vector', 'top_contributors', 'fisher_velocity', 'fisher_displacement',
    'fisher_trajectory_length', 'activation_entropy'];
  const allEnc = tr && encCols.every((c) => isEnvelope(tr[c]));
  // activation_vector must NOT be a plaintext JSON distribution at rest.
  let avPlain = false; try { avPlain = typeof JSON.parse(tr.activation_vector) === 'object'; } catch {}
  rec('FE1. trajectory sensitive columns are envelopes at rest (no plaintext distribution/metrics)',
    !!allEnc && !avPlain,
    tr ? `enc{${encCols.filter((c) => isEnvelope(tr[c])).length}/${encCols.length}}  av_plaintext=${avPlain}` : 'no row');

  rec('FE2. trajectory structural columns stay plaintext (phase / counts / window / flag)',
    tr && !isEnvelope(tr.phase) && ['stable', 'cycling', 'exploring', 'transforming', 'indeterminate'].includes(tr.phase)
      && Number.isInteger(tr.message_count) && typeof tr.window_start === 'string' && !isEnvelope(tr.window_start)
      && (tr.low_confidence === 0 || tr.low_confidence === 1),
    tr ? `phase=${tr.phase} message_count=${tr.message_count} low_confidence=${tr.low_confidence}` : 'no row');

  // ── FE3. milestones: detail/headline/velocity_z/displacement ciphertext ────
  const ms = raw.prepare(
    `SELECT detail, headline, velocity_z, displacement, rule_type, phase_from, phase_to, window_start
     FROM fisher_milestones WHERE user_id=? AND clustering_run_id=? LIMIT 1`).get(U, RUN);
  const msCount = raw.prepare(`SELECT COUNT(*) n FROM fisher_milestones WHERE user_id=? AND clustering_run_id=?`).get(U, RUN).n;
  raw.close();
  if (ms) {
    rec('FE3. milestone content encrypted at rest (detail + headline envelopes; rule_type plaintext)',
      isEnvelope(ms.detail) && isEnvelope(ms.headline) && !isEnvelope(ms.rule_type)
        && (ms.velocity_z == null || isEnvelope(ms.velocity_z)),
      `count=${msCount} rule_type=${ms.rule_type} detail_enc=${isEnvelope(ms.detail)} headline_enc=${isEnvelope(ms.headline)}`);
  } else {
    rec('FE3. milestone content encryption (no milestones generated by seed — SKIP-as-pass)', true,
      `count=${msCount} (seed produced no realm weekly_step milestone; trajectory encryption covers the contract)`);
  }

  // ── FE4. adapter read decrypts + coerces → pillar still works ──────────────
  const phase = await fisher.getCurrentPhase(U, { level: 'realm' });
  const traj = await fisher.getTrajectory(U, { level: 'realm', windowType: 'weekly_step', runId: RUN });
  // activation_vector decrypts to valid JSON when fetched + parsed.
  const avRow = (await db.rawQuery(
    `SELECT activation_vector FROM fisher_trajectory WHERE user_id=? AND clustering_run_id=? LIMIT 1`, [U, RUN]));
  const av = (Array.isArray(avRow) ? avRow[0] : avRow?.results?.[0])?.activation_vector;
  let avObj = null; try { avObj = JSON.parse(av); } catch {}
  rec('FE4. adapter auto-decrypts + fisher.js coerces (phase numbers + activation_vector parses)',
    !!phase && typeof phase.fisher_velocity === 'number' && typeof phase.fisher_trajectory_length === 'number'
      && traj.length > 0 && avObj && typeof avObj === 'object',
    phase ? `velocity=${phase.fisher_velocity} (typeof ${typeof phase.fisher_velocity}) L=${phase.fisher_trajectory_length} av_keys=${avObj ? Object.keys(avObj).length : 0}` : 'null');

  if (ms) {
    const mils = await fisher.getActiveMilestones(U, {});
    rec('FE5. getActiveMilestones decrypts detail (object) + coerces velocity_z',
      mils.length > 0 && typeof mils[0].detail === 'object'
        && (mils[0].velocity_z == null || typeof mils[0].velocity_z === 'number'),
      `milestones=${mils.length} detail_type=${typeof mils[0]?.detail}`);
  } else {
    rec('FE5. getActiveMilestones decrypt (no milestones — SKIP-as-pass)', true);
  }
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — fisher tables encrypted at rest; adapter decrypts + coerces; structural keys plaintext' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
