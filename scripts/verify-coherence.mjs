// verify:coherence — coherence-universal. Proves the stage computes per-window
// semantic_coherence_adjacent (§4.31) + discourse_coherence_embedding (§3.2.5)
// = mean pairwise cosine of consecutive message embeddings, that those columns
// are CIPHERTEXT at rest while structural columns stay plaintext, and that a
// read through the adapter auto-decrypts them to usable numbers in [-1,1].
// Honest-stub check: entity_grid_coherence (Tier-2 NER) is always NULL. Runs
// the REAL stage via spawnSync. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { encryptVector } from '../src/search/ann/decode.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-coherence.db', KCV = 'data/verify-coherence-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const RUN = 'era-verify-coherence-0001';
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

// Seed: messages across ~90 days. Within each day the embeddings are HIGHLY
// similar (smooth, coherent flow) so the consecutive cosine sim is high and
// well-defined per window. Each day slowly drifts in a base direction.
const DAY_MS = 86400000;
const now = Date.now();
const DAYS = 90, PER_DAY = 8;
function vecFor(day, k) {
  const v = new Float32Array(DIM);
  const base = day * 0.02;            // slow daily drift
  const jitter = k * 0.001;           // small within-day variation → high coherence
  for (let d = 0; d < DIM; d++) v[d] = Math.sin((d + 1) * 0.011 + base + jitter);
  let norm = 0; for (let d = 0; d < DIM; d++) norm += v[d] * v[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < DIM; d++) v[d] /= norm;
  return v;
}
let mi = 0;
for (let day = 0; day < DAYS; day++) {
  for (let k = 0; k < PER_DAY; k++) {
    const ts = new Date(now - (DAYS - day) * DAY_MS + k * 3600000);
    const iso = ts.toISOString().replace('Z', '+00:00');
    const env = await encryptVector(vecFor(day, k), 'personal', masterKey);
    await db.rawQuery(
      `INSERT INTO messages (id, user_id, role, content, embedding_768, created_at)
       VALUES (?,?,'user',NULL,?,?)`,
      [`m-${mi++}`, U, env, iso]);
  }
}

function runStage() {
  return spawnSync(PY, ['pipeline/compute-coherence.py'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: RUN },
  });
}

try {
  // ── CO1. stage runs clean ──────────────────────────────────────────────────
  const r = runStage();
  rec('CO1. compute-coherence.py exits 0 on a seeded vault',
    r.status === 0, r.status !== 0 ? (r.stderr || r.stdout || '').slice(-500) : (r.stdout.match(/\[coherence\].*/)?.[0] || ''));

  const raw = new Database(DB, { readonly: true });
  // ── CO2. cognitive_metrics_coherence populated ─────────────────────────────
  const rows = raw.prepare(`SELECT COUNT(*) n FROM cognitive_metrics_coherence WHERE user_id=? AND era_id=?`).get(U, RUN).n;
  rec('CO2. cognitive_metrics_coherence populated (per-window coherence rows)',
    rows > 0, `rows=${rows}`);

  // ── CO3. metric columns ciphertext at rest; structural plaintext ───────────
  const row = raw.prepare(
    `SELECT semantic_coherence_adjacent, coherence_stddev, discourse_coherence_embedding,
            entity_grid_coherence, notes, granularity, window_end, era_id, low_confidence, pair_count
     FROM cognitive_metrics_coherence
     WHERE user_id=? AND era_id=? AND semantic_coherence_adjacent IS NOT NULL LIMIT 1`).get(U, RUN);
  const enc = row && isEnvelope(row.semantic_coherence_adjacent) && isEnvelope(row.discourse_coherence_embedding);
  rec('CO3. coherence metric columns are envelopes at rest (no plaintext numbers)',
    !!enc, row ? `sca_enc=${isEnvelope(row.semantic_coherence_adjacent)} disc_enc=${isEnvelope(row.discourse_coherence_embedding)}` : 'no row');
  rec('CO4. structural columns plaintext (granularity / window_end / era / pair_count / low_confidence=1)',
    row && !isEnvelope(row.granularity) && ['alpha', 'theta', 'delta'].includes(row.granularity)
      && row.era_id === RUN && Number.isInteger(row.pair_count) && row.low_confidence === 1,
    row ? `granularity=${row.granularity} pair_count=${row.pair_count} low_conf=${row.low_confidence}` : 'no row');

  // ── CO5. honest stub: entity_grid_coherence always NULL ────────────────────
  const egNonNull = raw.prepare(`SELECT COUNT(*) n FROM cognitive_metrics_coherence WHERE user_id=? AND era_id=? AND entity_grid_coherence IS NOT NULL`).get(U, RUN).n;
  raw.close();
  rec('CO5. entity_grid_coherence is an HONEST STUB (always NULL; needs NER)',
    egNonNull === 0, `non_null_entity_grid=${egNonNull} (expected 0)`);

  // ── CO6. adapter read decrypts → finite cosine sim in [-1,1] ───────────────
  const dec = await db.rawQuery(
    `SELECT semantic_coherence_adjacent, discourse_coherence_embedding FROM cognitive_metrics_coherence
     WHERE user_id=? AND era_id=? AND semantic_coherence_adjacent IS NOT NULL LIMIT 1`, [U, RUN]);
  const dr = (Array.isArray(dec) ? dec[0] : dec?.results?.[0]);
  const sca = dr ? Number(dr.semantic_coherence_adjacent) : NaN;
  const disc = dr ? Number(dr.discourse_coherence_embedding) : NaN;
  rec('CO6. adapter auto-decrypts coherence columns → finite cosine sim in [-1,1] (= discourse)',
    !!dr && Number.isFinite(sca) && sca >= -1 && sca <= 1 && Math.abs(sca - disc) < 1e-9,
    dr ? `semantic=${sca} discourse=${disc}` : 'no row');
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — coherence computes consecutive-pair cosine; encrypted at rest; adapter decrypts; entity_grid is an honest stub' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
