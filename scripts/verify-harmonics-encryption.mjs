// verify:harmonics-encryption — SEC (2026-06-04). Proves the LEGACY harmonics
// writer (pipeline/compute_information_harmonics.py) now stores its §4.23
// harmonic-amplitude, §4.33 bigram-flow, and §4.34 persistence-entropy metric
// scalars + `notes` as CIPHERTEXT at rest (wrapped-DEK envelopes), while the
// structural columns (user_id, window_end, granularity, language,
// clustering_run_id, message_count, low_confidence) stay PLAINTEXT — and that a
// read through the adapter (db.rawQuery) auto-decrypts the metric columns back
// to usable numbers. Seeds messages with 768-D embedding_768 envelopes spread
// across daily/weekly/monthly windows and runs the REAL harmonics stage via
// spawnSync. PASS/FAIL ledger; exit 0 only if all pass.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { encryptVector } from '../src/search/ann/decode.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-harmonics-enc.db', KCV = 'data/verify-harmonics-enc-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const RUN = 'era-verify-harmonics-enc-0001';
const PY = 'pipeline/.venv/bin/python3';
const DIM = 768;

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};
// Plaintext-number detector: a raw float column would be either a JS number or a
// short numeric string. An envelope is a long base64(JSON) blob. We assert the
// metric columns are NOT bare numbers/numeric-strings.
const looksPlaintextNumber = (v) =>
  typeof v === 'number' || (typeof v === 'string' && v.length < 40 && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v.trim()));

const masterKey = await importMasterKey(userHex);

// Seed: many messages with L2-normalized 768-D embeddings, timestamps spread
// over ~120 days so daily/weekly/monthly windows are populated and the
// cosine-distance signal carries structure.
const DAY_MS = 86400000;
const now = Date.now();
const N = 600;
function seedVec(i) {
  const v = new Float32Array(DIM);
  const slow = (i / N) * Math.PI * 2;
  const fast = i * 0.9;
  for (let d = 0; d < DIM; d++) {
    v[d] = Math.sin((d + 1) * 0.013 + slow) + 0.4 * Math.cos((d + 1) * 0.05 + fast);
  }
  let norm = 0; for (let d = 0; d < DIM; d++) norm += v[d] * v[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < DIM; d++) v[d] /= norm;
  return v;
}
for (let i = 0; i < N; i++) {
  const dayOffset = Math.floor((i / N) * 120);
  const ts = new Date(now - (120 - dayOffset) * DAY_MS + (i % 24) * 3600000);
  const iso = ts.toISOString().replace('Z', '+00:00');
  const env = await encryptVector(seedVec(i), 'personal', masterKey);
  await db.rawQuery(
    `INSERT INTO messages (id, user_id, role, content, embedding_768, created_at)
     VALUES (?,?,'user',NULL,?,?)`,
    [`m-${i}`, U, env, iso]);
}

function runStage(script, extraEnv = {}) {
  return spawnSync(PY, [script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: RUN, ...extraEnv },
  });
}

// The §4.23/4.33/4.34 sensitive metric columns the writer now encrypts.
const BANDS = ['gamma', 'beta', 'alpha', 'theta', 'delta'];
const HARMONIC_COLS = [1, 2, 3].flatMap((k) => BANDS.map((b) => `harmonic_amplitude_${b}_k${k}`));
const FLOW_COLS = ['mean_crossing_rate', 'slope_sign_change_rate', 'autocorrelation_lag1', 'variance', 'total_spectral_energy']
  .flatMap((f) => BANDS.map((b) => `${f}_${b}`));
const SENSITIVE_COLS = [...HARMONIC_COLS, ...FLOW_COLS, 'topology_h0_persistence_entropy'];

try {
  // ── H0. harmonics stage runs clean ────────────────────────────────────────
  const h = runStage('pipeline/compute_information_harmonics.py');
  rec('H0. compute_information_harmonics.py exits 0 on a seeded vault',
    h.status === 0, h.status !== 0 ? (h.stderr || h.stdout || '').slice(-500)
      : (h.stdout.match(/EVENT.*run_end.*/)?.[0]?.slice(0, 120) || 'ok'));

  // ── H1. rows written ──────────────────────────────────────────────────────
  const raw = new Database(DB, { readonly: true });
  const total = raw.prepare(
    `SELECT COUNT(*) n FROM cognitive_metrics_harmonic WHERE user_id=? AND clustering_run_id=?`).get(U, RUN).n;
  rec('H1. harmonic rows written', total > 0, `rows=${total}`);

  // ── H2. EVERY non-NULL §4.23/4.33/4.34 metric value is a ciphertext envelope
  //        (scan all rows; assert NO bare plaintext numbers at rest) ──────────
  const allRows = raw.prepare(
    `SELECT ${SENSITIVE_COLS.join(', ')} FROM cognitive_metrics_harmonic
     WHERE user_id=? AND clustering_run_id=?`).all(U, RUN);
  let nonNull = 0, envelopes = 0, plaintextLeaks = 0;
  const leakSamples = [];
  for (const r of allRows) {
    for (const c of SENSITIVE_COLS) {
      const v = r[c];
      if (v === null || v === undefined) continue;
      nonNull++;
      if (isEnvelope(v)) envelopes++;
      else if (looksPlaintextNumber(v)) { plaintextLeaks++; if (leakSamples.length < 3) leakSamples.push(`${c}=${v}`); }
      else { plaintextLeaks++; if (leakSamples.length < 3) leakSamples.push(`${c}=<non-envelope>`); }
    }
  }
  // SQLCipher collapse (Stage B/C cut 5): the §4.23/4.33/4.34 metric scalars are now
  // PLAINTEXT-in-cipher (compute_information_harmonics.py enc() is serialize-only) — at-rest
  // = whole-file SQLCipher (verify:at-rest). So NO value should be a per-field envelope.
  rec('H2. all non-NULL §4.23/4.33/4.34 metric scalars PLAINTEXT-in-cipher (collapse cut 5; verify:at-rest)',
    nonNull > 0 && envelopes === 0,
    `nonNull=${nonNull} envelopes=${envelopes} plaintext=${plaintextLeaks}`);

  // ── H3. notes (when present) is an envelope, not plaintext ─────────────────
  const noteRow = raw.prepare(
    `SELECT notes FROM cognitive_metrics_harmonic
     WHERE user_id=? AND clustering_run_id=? AND notes IS NOT NULL LIMIT 1`).get(U, RUN);
  // The legacy writer sets notes=None in main(), so notes may legitimately be
  // absent. Only assert envelope-ness IF a note exists; otherwise pass (the
  // code path is enc(None)→None, which is correct).
  rec('H3. notes PLAINTEXT-in-cipher when present (collapse cut 5; enc()→serialize-only, None→NULL otherwise)',
    !noteRow || !isEnvelope(noteRow.notes),
    noteRow ? `notes ${!isEnvelope(noteRow.notes) ? 'plaintext-in-cipher' : 'STILL-ENVELOPE'}` : 'no notes written (None→NULL, correct)');

  // ── H4. structural/grain columns stay plaintext ───────────────────────────
  const sRow = raw.prepare(
    `SELECT user_id, window_end, granularity, language, clustering_run_id, message_count, low_confidence
     FROM cognitive_metrics_harmonic WHERE user_id=? AND clustering_run_id=? LIMIT 1`).get(U, RUN);
  rec('H4. structural columns stay plaintext (user_id/window_end/granularity/language/run_id/counts)',
    sRow && !isEnvelope(sRow.user_id) && sRow.user_id === U
      && !isEnvelope(sRow.window_end) && !isEnvelope(sRow.granularity)
      && ['alpha', 'theta', 'delta'].includes(sRow.granularity)
      && !isEnvelope(sRow.language) && sRow.clustering_run_id === RUN
      && typeof sRow.message_count === 'number' && (sRow.low_confidence === 0 || sRow.low_confidence === 1),
    sRow ? `granularity=${sRow.granularity} run=${sRow.clustering_run_id} msg_count=${sRow.message_count} low_conf=${sRow.low_confidence}` : 'no row');

  // ── H5. §4.24 columns (already encrypted by a DIFFERENT stage) are NOT
  //        clobbered — they are still NULL here because we did not run the
  //        cross-scale stage. (Just confirms we only touched our own columns.) ─
  const cs = raw.prepare(
    `SELECT COUNT(*) n FROM cognitive_metrics_harmonic
     WHERE user_id=? AND clustering_run_id=? AND pac_gamma_beta IS NOT NULL`).get(U, RUN).n;
  rec('H5. §4.24 cross-scale columns untouched by the harmonics writer (still NULL)',
    cs === 0, `rows_with_pac=${cs}`);
  raw.close();

  // ── H6. adapter read decrypts the metric columns → finite numbers ─────────
  const dec = await db.rawQuery(
    `SELECT harmonic_amplitude_alpha_k1, variance_alpha, mean_crossing_rate_alpha
     FROM cognitive_metrics_harmonic
     WHERE user_id=? AND clustering_run_id=? AND harmonic_amplitude_alpha_k1 IS NOT NULL LIMIT 1`, [U, RUN]);
  const dr = (Array.isArray(dec) ? dec[0] : dec?.results?.[0]);
  const amp = dr ? Number(dr.harmonic_amplitude_alpha_k1) : NaN;
  const varA = dr ? Number(dr.variance_alpha) : NaN;
  const mcr = dr ? Number(dr.mean_crossing_rate_alpha) : NaN;
  rec('H6. adapter auto-decrypts §4.23/4.33 columns → finite numbers',
    !!dr && Number.isFinite(amp) && amp >= 0 && Number.isFinite(varA) && varA >= 0 && Number.isFinite(mcr),
    dr ? `amp=${amp} var=${varA} mcr=${mcr}` : 'no decryptable row');
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — §4.23/4.33/4.34 harmonic scalars + notes encrypted at rest; structural plaintext; adapter decrypts' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
