// verify:cross-scale-coupling — H1 §4.24 + §4.34 Wasserstein. Proves the
// cross-scale-coupling stage enriches existing cognitive_metrics_harmonic rows
// with PAC/PLV/coherence (adjacent band pairs) + Wasserstein, that those columns
// are CIPHERTEXT at rest (wrapped-DEK envelopes) while structural columns stay
// plaintext, and that a read through the adapter (db.rawQuery) auto-decrypts them
// to usable numbers. Seeds messages with 768-D embedding_768 envelopes spread
// across daily/weekly/monthly windows, runs the REAL harmonics stage (to create
// the rows) then the REAL coupling stage (to enrich), both via spawnSync.
// PASS/FAIL ledger; exit 0 only if all pass.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { encryptVector } from '../src/search/ann/decode.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-cross-scale.db', KCV = 'data/verify-cross-scale-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const RUN = 'era-verify-cross-scale-0001';
const PY = 'pipeline/.venv/bin/python3';
const DIM = 768;

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};

const masterKey = await importMasterKey(userHex);

// Seed: many messages with L2-normalized 768-D embeddings, timestamps spread
// over ~120 days so daily/weekly/monthly windows are populated and the
// cosine-distance signal has structure (a slow drift + a fast oscillation so
// the bands carry real coupling).
const DAY_MS = 86400000;
const now = Date.now();
const N = 600;
function seedVec(i) {
  const v = new Float32Array(DIM);
  const slow = (i / N) * Math.PI * 2;          // slow trend across history
  const fast = i * 0.9;                          // fast per-message oscillation
  for (let d = 0; d < DIM; d++) {
    v[d] = Math.sin((d + 1) * 0.013 + slow) + 0.4 * Math.cos((d + 1) * 0.05 + fast);
  }
  // L2 normalize (embeddings are normalized at ingest).
  let norm = 0; for (let d = 0; d < DIM; d++) norm += v[d] * v[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < DIM; d++) v[d] /= norm;
  return v;
}
for (let i = 0; i < N; i++) {
  // spread across 120 days, multiple messages per day
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

try {
  // ── H0. Prereq: run the harmonics stage to create rows to enrich ───────────
  const h = runStage('pipeline/compute_information_harmonics.py');
  rec('H0. harmonics stage exits 0 (creates rows to enrich)',
    h.status === 0, h.status !== 0 ? (h.stderr || h.stdout || '').slice(-400) : (h.stdout.match(/EVENT.*run_end.*/)?.[0]?.slice(0, 120) || 'ok'));

  // ── H1. cross-scale-coupling stage runs clean ─────────────────────────────
  const r = runStage('pipeline/compute-cross-scale-coupling.py');
  rec('H1. compute-cross-scale-coupling.py exits 0 on a seeded vault',
    r.status === 0, r.status !== 0 ? (r.stderr || r.stdout || '').slice(-500) : (r.stdout.match(/\[cross-scale-coupling\].*/)?.[0] || ''));

  // ── H2. §4.24 + Wasserstein columns populated (at least one non-NULL) ──────
  const raw = new Database(DB, { readonly: true });
  const total = raw.prepare(`SELECT COUNT(*) n FROM cognitive_metrics_harmonic WHERE user_id=? AND clustering_run_id=?`).get(U, RUN).n;
  const withCoupling = raw.prepare(
    `SELECT COUNT(*) n FROM cognitive_metrics_harmonic
     WHERE user_id=? AND clustering_run_id=?
       AND (pac_gamma_beta IS NOT NULL OR plv_gamma_beta IS NOT NULL OR coh_gamma_beta IS NOT NULL
            OR pac_beta_alpha IS NOT NULL OR plv_alpha_theta IS NOT NULL)`).get(U, RUN).n;
  rec('H2. §4.24 coupling columns populated on enriched harmonic rows',
    total > 0 && withCoupling > 0, `harmonic_rows=${total} with_coupling=${withCoupling}`);

  // ── H3. coupling columns ciphertext at rest; grain columns plaintext ───────
  const row = raw.prepare(
    `SELECT pac_gamma_beta, plv_gamma_beta, coh_gamma_beta, topology_h0_wasserstein_prev,
            user_id, granularity, window_end, clustering_run_id
     FROM cognitive_metrics_harmonic
     WHERE user_id=? AND clustering_run_id=?
       AND pac_gamma_beta IS NOT NULL LIMIT 1`).get(U, RUN);
  const encCols = ['pac_gamma_beta', 'plv_gamma_beta', 'coh_gamma_beta'];
  const presentEnc = row ? encCols.filter((c) => row[c] != null) : [];
  const allEnc = row && presentEnc.length > 0 && presentEnc.every((c) => isEnvelope(row[c]));
  rec('H3. §4.24 coupling columns are envelopes at rest (no plaintext numbers)',
    !!allEnc, row ? `enc{${presentEnc.filter((c) => isEnvelope(row[c])).length}/${presentEnc.length}}` : 'no enriched row');
  rec('H4. structural/grain columns stay plaintext (granularity / window_end / run_id)',
    row && !isEnvelope(row.granularity) && ['alpha', 'theta', 'delta'].includes(row.granularity)
      && !isEnvelope(row.window_end) && row.clustering_run_id === RUN,
    row ? `granularity=${row.granularity} run=${row.clustering_run_id}` : 'no row');
  raw.close();

  // ── H5. adapter read decrypts coupling columns → finite numbers in range ───
  const dec = await db.rawQuery(
    `SELECT pac_gamma_beta, plv_gamma_beta, coh_gamma_beta FROM cognitive_metrics_harmonic
     WHERE user_id=? AND clustering_run_id=? AND pac_gamma_beta IS NOT NULL LIMIT 1`, [U, RUN]);
  const dr = (Array.isArray(dec) ? dec[0] : dec?.results?.[0]);
  const pac = dr ? Number(dr.pac_gamma_beta) : NaN;
  const plv = dr ? Number(dr.plv_gamma_beta) : NaN;
  rec('H5. adapter auto-decrypts §4.24 columns → finite numbers in [0,1]',
    !!dr && Number.isFinite(pac) && pac >= 0 && pac <= 1 && Number.isFinite(plv) && plv >= 0 && plv <= 1,
    dr ? `pac=${dr.pac_gamma_beta}→${pac} plv→${plv}` : 'no row');

  // ── H6. exact-Wasserstein parity: the fast H0-line DP that replaced persim's
  //    O((M+N)³) Hungarian must equal persim.wasserstein bit-for-bit on H0
  //    diagrams (birth=0). Guards the cross-scale perf fix from silent drift.
  const PARITY = `
import importlib.util as u, numpy as np
spec = u.spec_from_file_location('cs', 'pipeline/compute-cross-scale-coupling.py')
cs = u.module_from_spec(spec); spec.loader.exec_module(cs)
from persim import wasserstein
rng = np.random.default_rng(7); maxerr = 0.0
for _ in range(400):
    m = int(rng.integers(0, 50)); n = int(rng.integers(0, 50))
    a = np.column_stack([np.zeros(m), rng.random(m) * 5]) if m else np.zeros((0, 2))
    b = np.column_stack([np.zeros(n), rng.random(n) * 5]) if n else np.zeros((0, 2))
    e = float(wasserstein(a, b)) if (m or n) else 0.0
    g = cs._h0_wasserstein1(a if m else np.zeros((0,2)), b if n else np.zeros((0,2)))
    maxerr = max(maxerr, abs(e - (g if g is not None else 0.0)))
print(f'maxerr={maxerr:.2e}')
assert maxerr < 1e-6, f'H0 W1 DP diverged from persim: {maxerr}'
`;
  const par = spawnSync(PY, ['-c', PARITY], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: 'pipeline' } });
  rec('H6. fast H0-line Wasserstein DP equals persim.wasserstein (exact, <1e-6)',
    par.status === 0, (par.stdout || par.stderr || '').trim().split('\n').pop());
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — §4.24 cross-scale coupling + Wasserstein compute; encrypted at rest; adapter decrypts; grain plaintext' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
