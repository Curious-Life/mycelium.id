// verify:embedding-trajectory — proves pipeline/compute-embedding-trajectory.py computes the
// basis-free GLOBAL centroid-drift series end-to-end on a seeded vault: a week whose semantic
// center ROTATED shows large angular drift while same-direction weeks show ~0; a DIFFUSE week
// (no common direction) is flagged low_confidence by the R̄·√n floor (not by count); the two
// scalars are ENCRYPTED at rest (and the adapter decrypts them); and a re-run is idempotent
// (era-skip). Network-free (real 768-D envelopes; no model). PASS/FAIL ledger; exit 0 iff GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { encryptVector } from '../src/search/ann/decode.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-embtraj.db', KCV = 'data/verify-embtraj-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const PY = 'pipeline/.venv/bin/python3';
const DIM = 768;

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => { if (typeof v !== 'string') return false; try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); } catch { return false; } };
const masterKey = await importMasterKey(userHex);

// Deterministic unit vector from a seed (a "direction"). Distinct seeds → ~orthogonal in 768D.
function dir(seed) {
  const v = new Float32Array(DIM);
  let s = seed * 2654435761 >>> 0;
  for (let d = 0; d < DIM; d++) { s = (s * 1103515245 + 12345) >>> 0; v[d] = (s / 0xffffffff) - 0.5; }
  let nrm = 0; for (let d = 0; d < DIM; d++) nrm += v[d] * v[d]; nrm = Math.sqrt(nrm) || 1;
  for (let d = 0; d < DIM; d++) v[d] /= nrm;
  return v;
}

// ISO-Monday of a date, then step weeks. Seed 7 CONTIGUOUS weeks ending well in the past
// (weekly_step only emits windows that ended ≥7d ago).
const mondayOf = (ms) => { const d = new Date(ms); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
const base = mondayOf(Date.now() - 11 * 7 * 86400000); // ~11 weeks back, Monday
const weekTs = (i) => base + i * 7 * 86400000 + 3 * 86400000 + 12 * 3600000; // Thursday noon of week i

let mid = 0;
async function seedWeek(i, vecFor, count = 6) {
  for (let k = 0; k < count; k++) {
    const id = `m-${mid++}`;
    const iso = new Date(weekTs(i) + k * 60000).toISOString().replace('Z', '+00:00');
    const env = await encryptVector(vecFor(k), 'personal', masterKey);
    await db.rawQuery(`INSERT INTO messages (id, user_id, role, content, embedding_768, created_at) VALUES (?,?,'user',NULL,?,?)`, [id, U, env, iso]);
  }
}
// 7 contiguous weeks. dirA for 0-2 (flat), dirB for 3-4 (week 3 = big rotation vs week 2),
// week 5 DIFFUSE (each message its own direction → low R̄), week 6 back to dirB.
const A = dir(11), B = dir(97);
await seedWeek(0, () => A); await seedWeek(1, () => A); await seedWeek(2, () => A);
await seedWeek(3, () => B); await seedWeek(4, () => B);
await seedWeek(5, (k) => dir(1000 + k));      // diffuse
await seedWeek(6, () => B);

const env0 = { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_KCV: KCV, MYCELIUM_USER_ID: U, USER_MASTER: userHex, SYSTEM_KEY: systemHex };
const run = () => spawnSync(PY, ['pipeline/compute-embedding-trajectory.py'], { encoding: 'utf8', env: env0 });
const r1 = run();
rec('T1. stage exits 0 on a seeded vault', r1.status === 0,
  r1.status !== 0 ? (r1.stderr || r1.stdout || '').slice(-400) : (r1.stdout.match(/\[emb-traj\].*windows written.*/)?.[0] || ''));

try {
  const rowsRes = await db.rawQuery(`SELECT window_start, centroid_drift, dispersion, message_count, low_confidence FROM embedding_trajectory WHERE user_id=? AND window_type='weekly_step' ORDER BY window_start`, [U]);
  const rows = rowsRes.results || rowsRes || [];
  rec('T2. one row per non-empty weekly window (≥6 of the 7 seeded weeks)', rows.length >= 6, `rows=${rows.length}`);

  // Map: row order = week order. Week 3 rotated from week 2 (dirA→dirB) → big drift; week 1/2 ~0.
  const drift = rows.map((r) => (r.centroid_drift == null ? null : Number(r.centroid_drift)));
  const disp = rows.map((r) => Number(r.dispersion));
  const lowc = rows.map((r) => Number(r.low_confidence));
  const w3 = drift[3], wFlat = drift[2];
  rec('T3. rotated week drifts far (≈π/2) while same-direction week stays ~0',
    Number.isFinite(w3) && Number.isFinite(wFlat) && w3 > 0.8 && wFlat < 0.2,
    `drift[flat w2]=${wFlat?.toFixed(3)} drift[rotated w3]=${w3?.toFixed(3)}`);

  // Week 5 is DIFFUSE → high dispersion + low_confidence by the R̄·√n floor (count is fine, n=6).
  rec('T4. diffuse week → high dispersion + low_confidence (R̄ floor, not count)',
    disp[5] > disp[2] && lowc[5] === 1 && rows[5].message_count === 6,
    `disp[tight w2]=${disp[2]?.toFixed(3)} disp[diffuse w5]=${disp[5]?.toFixed(3)} lowConf[w5]=${lowc[5]} n=${rows[5].message_count}`);

  // Encrypted at rest; flags/structure plaintext.
  const raw = new Database(DB, { readonly: true });
  const rawRow = raw.prepare(`SELECT centroid_drift, dispersion, low_confidence, window_start FROM embedding_trajectory WHERE user_id=? ORDER BY window_start LIMIT 1 OFFSET 3`).get(U);
  raw.close();
  // SQLCipher collapse (Stage B/C cut 5): centroid_drift + dispersion are PLAINTEXT-in-
  // cipher — at-rest = whole-file SQLCipher (verify:at-rest), not per-field envelopes.
  rec('T5. centroid_drift + dispersion PLAINTEXT-in-cipher (collapse cut 5; verify:at-rest); flag + window plaintext',
    !isEnvelope(rawRow?.centroid_drift) && !isEnvelope(rawRow?.dispersion)
      && (rawRow.low_confidence === 0 || rawRow.low_confidence === 1) && typeof rawRow.window_start === 'string',
    `drift_plain=${!isEnvelope(rawRow?.centroid_drift)} disp_plain=${!isEnvelope(rawRow?.dispersion)}`);

  // Idempotent re-run (era-skip): same run_id → no new rows.
  const before = rows.length;
  const r2 = run();
  const after = ((await db.rawQuery(`SELECT COUNT(*) AS c FROM embedding_trajectory WHERE user_id=?`, [U])).results || [])[0]?.c
    ?? (await db.rawQuery(`SELECT COUNT(*) AS c FROM embedding_trajectory WHERE user_id=?`, [U]))[0]?.c;
  rec('T6. era-skip: re-run is idempotent (no new rows for the same run)', r2.status === 0 && Number(after) === before,
    `before=${before} after=${after}`);
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const ok = ledger.every(Boolean);
console.log(`\n${'='.repeat(64)}\nVERDICT: ${ok ? 'GO — basis-free centroid-drift computes; rotation discriminates; diffuse→low_confidence (R̄ floor); encrypted at rest; era-skip' : 'NO-GO — see FAIL rows'}  EXIT=${ok ? 0 : 1}\n${'='.repeat(64)}`);
process.exit(ok ? 0 : 1);
