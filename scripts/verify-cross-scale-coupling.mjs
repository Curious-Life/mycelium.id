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
  // SQLCipher collapse (Stage B/C cut 5): §4.24 coupling columns are PLAINTEXT-in-cipher
  // — at-rest = whole-file SQLCipher (verify:at-rest), not per-field envelopes.
  const allPlain = row && presentEnc.length > 0 && presentEnc.every((c) => !isEnvelope(row[c]));
  rec('H3. §4.24 coupling columns PLAINTEXT-in-cipher (collapse cut 5; verify:at-rest)',
    !!allPlain, row ? `plain{${presentEnc.filter((c) => !isEnvelope(row[c])).length}/${presentEnc.length}}` : 'no enriched row');
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

  // ── H7. effective-N stored PLAINTEXT per pair (audit S3 item e) ────────────
  //    Counts are not metric scalars → they must NOT be encrypted, so the read
  //    layer can suppress near-floor estimates without decrypting.
  const raw2 = new Database(DB, { readonly: true });
  // Pick the most-populated row so the ledger shows real per-pair counts.
  const effRow = raw2.prepare(
    `SELECT couple_eff_n_gamma_beta g, couple_eff_n_beta_alpha b,
            couple_eff_n_alpha_theta a, couple_eff_n_theta_delta t
     FROM cognitive_metrics_harmonic
     WHERE user_id=? AND clustering_run_id=? AND couple_eff_n_gamma_beta IS NOT NULL
     ORDER BY couple_eff_n_gamma_beta DESC LIMIT 1`).get(U, RUN);
  const effPlain = effRow && [effRow.g, effRow.b, effRow.a, effRow.t]
    .every((v) => v === null || (Number.isInteger(v) && !isEnvelope(String(v))));
  // And prove the column carries genuine sample counts (not just 0s): at least
  // one row must record an above-floor N — the rows that DID get an estimate.
  const maxEff = raw2.prepare(
    `SELECT MAX(couple_eff_n_gamma_beta) m FROM cognitive_metrics_harmonic
     WHERE user_id=? AND clustering_run_id=?`).get(U, RUN).m;
  rec('H7. couple_eff_n_* stored as plaintext integer counts (not encrypted)',
    !!effRow && effPlain && Number.isInteger(maxEff) && maxEff >= 24,
    effRow ? `eff_n{γβ=${effRow.g} βα=${effRow.b} αθ=${effRow.a} θδ=${effRow.t}} max(γβ)=${maxEff}` : 'no eff_n row');

  // ── H8. low-N gate fires: no estimate is written below the raw-N floor, and
  //    the slow band pairs ARE suppressed (proves the gate is reached, not a
  //    no-op). The floor (MIN_COUPLE_N) is read from the module so the gate
  //    tracks the source.
  const FLOOR = `
import importlib.util as u
spec = u.spec_from_file_location('cs', 'pipeline/compute-cross-scale-coupling.py')
cs = u.module_from_spec(spec); spec.loader.exec_module(cs)
print(cs.MIN_COUPLE_N, cs.PAC_MIN_N)
`;
  const fl = spawnSync(PY, ['-c', FLOOR], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: 'pipeline' } });
  const [MIN_N, PAC_N] = (fl.stdout || '24 36').trim().split(/\s+/).map(Number);
  // Invariant: any pair with a (non-NULL) PLV/PAC estimate had raw-N >= floor.
  const pairs = [['gamma', 'beta'], ['beta', 'alpha'], ['alpha', 'theta'], ['theta', 'delta']];
  let viol = 0, suppressedSlow = 0, totalSlow = 0;
  for (const [lo, hi] of pairs) {
    const rows = raw2.prepare(
      `SELECT couple_eff_n_${lo}_${hi} n, plv_${lo}_${hi} plv, pac_${lo}_${hi} pac
       FROM cognitive_metrics_harmonic WHERE user_id=? AND clustering_run_id=?`).all(U, RUN);
    for (const r of rows) {
      if (r.plv != null && (r.n == null || r.n < MIN_N)) viol++;
      if (r.pac != null && (r.n == null || r.n < PAC_N)) viol++;
      if (lo === 'alpha' || lo === 'theta') {   // slow pairs: alpha_theta, theta_delta
        totalSlow++;
        if (r.n != null && r.n < MIN_N && r.plv == null && r.pac == null) suppressedSlow++;
      }
    }
  }
  rec('H8. no estimate written below the raw-N floor; slow pairs suppressed',
    viol === 0 && suppressedSlow > 0,
    `floor=${MIN_N}/${PAC_N} below-floor-estimates=${viol} slow-pairs-suppressed=${suppressedSlow}/${totalSlow}`);
  raw2.close();

  // ── H9. demean-before-Hilbert (S3 item c) + surrogate-debiased PLV (S3 item b)
  //    are correct: a DC offset must not change the envelope, and an UNCOUPLED
  //    smooth pair must debias to ~0 even though raw PLV is inflated at low N.
  const STAT = `
import numpy as np
from harmonics import hilbert_amplitude, phase_locking_value, phase_locking_value_debiased
# (c) demean-before-Hilbert: the envelope is invariant to a large DC pedestal —
#     exactly the cosine-distance offset that distorted phase/amplitude before.
t = np.linspace(0, 8*np.pi, 40); base = np.sin(t)
demean_ok = float(np.max(np.abs(hilbert_amplitude(base) - hilbert_amplitude(base + 5.0)))) < 1e-9
# (b) population test at N=24 (the floor): two INDEPENDENT smooth band-like
#     signals carry a LARGE raw-PLV bias; the surrogate null debiases it toward 0.
def smooth(seed, n=24):
    x = np.random.default_rng(seed).standard_normal(n)
    return np.convolve(x, np.ones(5)/5.0, mode='same')
raws, debs = [], []
for k in range(80):
    lo, hi = smooth(2*k+1), smooth(2*k+2)
    raws.append(phase_locking_value(lo, hi))
    debs.append(phase_locking_value_debiased(lo, hi, n_surrogates=300, seed=k)['debiased'])
mean_raw, mean_deb = float(np.mean(raws)), float(np.mean(debs))
# a genuinely coupled pair must survive the debiasing far above the null residue.
phi = np.cumsum(np.ones(24)) * 0.4
deb_co = phase_locking_value_debiased(np.sin(phi), np.sin(phi + 0.3), n_surrogates=300, seed=1)['debiased']
print(f'demean_ok={demean_ok} mean_raw={mean_raw:.3f} mean_deb={mean_deb:.3f} deb_coupled={deb_co:.3f}')
assert demean_ok, 'demean changed the Hilbert envelope'
assert mean_raw > 0.25, f'expected large finite-sample PLV bias at N=24, got {mean_raw}'
assert mean_deb < 0.15, f'surrogate debiasing should pull uncoupled PLV to ~0, got {mean_deb}'
assert mean_deb < mean_raw * 0.5, 'debiasing should remove most of the bias'
assert deb_co > 0.6, f'coupled pair should debias high, got {deb_co}'
`;
  const st = spawnSync(PY, ['-c', STAT], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: 'pipeline' } });
  rec('H9. demean-before-Hilbert invariant + surrogate-debiased PLV (b,c)',
    st.status === 0, (st.stdout || st.stderr || '').trim().split('\n').pop());
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — §4.24 cross-scale coupling + Wasserstein compute; encrypted at rest; adapter decrypts; grain plaintext' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
