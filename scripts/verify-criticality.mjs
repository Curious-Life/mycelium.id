// verify:criticality — C1 criticality-phase-transitions. Proves the stage
// computes per-window CSD scalars (AR(1)/variance/flickering) over a seeded
// fisher_trajectory series and emits discrete cognitive_events (phase_lock /
// flickering), that the sensitive metric columns + event magnitude/detail/
// headline are CIPHERTEXT at rest while structural columns (level/window/era/
// event_type/severity) stay plaintext, and that a read through the adapter
// auto-decrypts them to usable numbers. Runs the REAL stage via spawnSync.
// Honest-stub check: ml_transition_score is always NULL. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-criticality.db', KCV = 'data/verify-criticality-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const RUN = 'era-verify-criticality-0001';
const PY = 'pipeline/.venv/bin/python3';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};

// ── Seed: weekly_step fisher_trajectory rows for all 3 levels over ~20 weeks.
//    Velocity rises slowly then SPIKES in the same week across all three levels
//    (→ phase_lock). One level also alternates its phase enum A/B (→ flickering).
const LEVELS = ['realm', 'theme', 'territory'];
const WEEK_MS = 7 * 86400000;
const now = Date.now();
const WEEKS = 20;
const SPIKE_WEEK = 16;
// Base velocities are small + stable; the spike is a huge multiple → high z on all levels.
for (const level of LEVELS) {
  for (let w = 0; w < WEEKS; w++) {
    const start = new Date(now - (WEEKS - w) * WEEK_MS);
    const end = new Date(start.getTime() + WEEK_MS);
    let vel = 0.10 + 0.002 * w + (w % 2 === 0 ? 0.005 : -0.005); // small wobble
    if (w === SPIKE_WEEK) vel = 2.5; // synchronized spike across all three levels
    // Flickering: territory phase alternates cycling/exploring over weeks 8..13.
    let phase = 'stable';
    if (level === 'territory' && w >= 8 && w <= 13) phase = (w % 2 === 0) ? 'cycling' : 'exploring';
    await db.rawQuery(
      `INSERT INTO fisher_trajectory
         (id, user_id, level, window_type, window_start, window_end, activation_vector,
          fisher_velocity, phase, message_count, active_territory_count, clustering_run_id, low_confidence)
       VALUES (?,?,?,'weekly_step',?,?,?, ?,?, 20, 3, ?, 0)`,
      [`ft-${level}-${w}`, U, level, start.toISOString(), end.toISOString(),
       JSON.stringify({ a: 0.5, b: 0.5 }), vel, phase, RUN]);
  }
}

function runStage() {
  return spawnSync(PY, ['pipeline/compute-criticality.py'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: RUN },
  });
}

try {
  // ── C1. stage runs clean ───────────────────────────────────────────────────
  const r = runStage();
  rec('C1. compute-criticality.py exits 0 on a seeded fisher_trajectory',
    r.status === 0, r.status !== 0 ? (r.stderr || r.stdout || '').slice(-500) : (r.stdout.match(/\[criticality\].*/)?.[0] || ''));

  const raw = new Database(DB, { readonly: true });

  // ── C2. cognitive_metrics_criticality populated (one row per source window) ─
  const critRows = raw.prepare(`SELECT COUNT(*) n FROM cognitive_metrics_criticality WHERE user_id=? AND era_id=?`).get(U, RUN).n;
  rec('C2. cognitive_metrics_criticality populated (CSD per window per level)',
    critRows >= WEEKS, `crit_rows=${critRows} (expected >= ${WEEKS})`);

  // ── C3. metric columns ciphertext at rest; structural columns plaintext ─────
  const crow = raw.prepare(
    `SELECT ar1_autocorrelation, rolling_variance, flickering_score, ml_transition_score, notes,
            level, window_type, era_id, low_confidence
     FROM cognitive_metrics_criticality
     WHERE user_id=? AND era_id=? AND ar1_autocorrelation IS NOT NULL LIMIT 1`).get(U, RUN);
  // SQLCipher collapse (Stage B/C cut 5): CSD metric columns are PLAINTEXT-in-cipher —
  // at-rest = whole-file SQLCipher (verify:at-rest), not per-field envelopes.
  const allPlain = crow && !isEnvelope(crow.ar1_autocorrelation) && !isEnvelope(crow.rolling_variance) && !isEnvelope(crow.flickering_score);
  rec('C3. CSD metric columns PLAINTEXT-in-cipher (collapse cut 5; verify:at-rest)',
    !!allPlain, crow ? `ar1_plain=${!isEnvelope(crow.ar1_autocorrelation)} var_plain=${!isEnvelope(crow.rolling_variance)}` : 'no row');
  rec('C4. structural columns plaintext (level / window_type / era / low_confidence=1)',
    crow && !isEnvelope(crow.level) && LEVELS.includes(crow.level) && crow.window_type === 'weekly_step'
      && crow.era_id === RUN && crow.low_confidence === 1,
    crow ? `level=${crow.level} wt=${crow.window_type} low_conf=${crow.low_confidence}` : 'no row');

  // ── C5. honest stub: ml_transition_score is ALWAYS NULL ─────────────────────
  const mlNonNull = raw.prepare(`SELECT COUNT(*) n FROM cognitive_metrics_criticality WHERE user_id=? AND era_id=? AND ml_transition_score IS NOT NULL`).get(U, RUN).n;
  rec('C5. ml_transition_detector is an HONEST STUB (ml_transition_score always NULL)',
    mlNonNull === 0, `non_null_ml=${mlNonNull} (expected 0)`);

  // ── C6. discrete events: phase_lock + flickering emitted to cognitive_events ─
  const phaseLock = raw.prepare(`SELECT COUNT(*) n FROM cognitive_events WHERE user_id=? AND era_id=? AND event_type='phase_lock'`).get(U, RUN).n;
  const flicker = raw.prepare(`SELECT COUNT(*) n FROM cognitive_events WHERE user_id=? AND era_id=? AND event_type='flickering'`).get(U, RUN).n;
  rec('C6. phase_lock + flickering events emitted to cognitive_events',
    phaseLock > 0 && flicker > 0, `phase_lock=${phaseLock} flickering=${flicker}`);

  // ── C7. event magnitude/detail/headline ciphertext; event_type/severity plaintext ─
  const ev = raw.prepare(
    `SELECT magnitude, detail, headline, event_type, severity FROM cognitive_events
     WHERE user_id=? AND era_id=? AND event_type='phase_lock' LIMIT 1`).get(U, RUN);
  raw.close();
  rec('C7. event magnitude/detail/headline PLAINTEXT-in-cipher (collapse cut 5; verify:at-rest); event_type/severity plaintext',
    ev && !isEnvelope(ev.magnitude) && !isEnvelope(ev.detail) && !isEnvelope(ev.headline)
      && !isEnvelope(ev.event_type) && ev.event_type === 'phase_lock' && ['notable', 'rare'].includes(ev.severity),
    ev ? `mag_plain=${!isEnvelope(ev.magnitude)} type=${ev.event_type} sev=${ev.severity}` : 'no event');

  // ── C8. adapter read decrypts CSD + event magnitude → finite numbers ────────
  const dcrit = await db.rawQuery(
    `SELECT ar1_autocorrelation, rolling_variance FROM cognitive_metrics_criticality
     WHERE user_id=? AND era_id=? AND ar1_autocorrelation IS NOT NULL LIMIT 1`, [U, RUN]);
  const dc = (Array.isArray(dcrit) ? dcrit[0] : dcrit?.results?.[0]);
  const devs = await db.rawQuery(
    `SELECT magnitude FROM cognitive_events WHERE user_id=? AND era_id=? AND event_type='phase_lock' LIMIT 1`, [U, RUN]);
  const de = (Array.isArray(devs) ? devs[0] : devs?.results?.[0]);
  const ar1 = dc ? Number(dc.ar1_autocorrelation) : NaN;
  const mag = de ? Number(de.magnitude) : NaN;
  rec('C8. adapter auto-decrypts CSD + event magnitude → finite numbers (σ >= 10 for phase_lock)',
    !!dc && Number.isFinite(ar1) && ar1 >= -1 && ar1 <= 1 && !!de && Number.isFinite(mag) && mag >= 10,
    dc && de ? `ar1=${ar1} joint_sigma=${mag}` : 'missing row');
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — criticality computes CSD + events; encrypted at rest; adapter decrypts; ml_transition is an honest stub' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
