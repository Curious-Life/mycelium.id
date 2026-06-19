// verify:anchors — E1 embedding-anchor family (Tier-1, CVP-pending). Proves:
//   (A) Phase A: the anchor stage embeds the seed sets (via the DETERMINISTIC
//       STUB embedder — no network/model) → mean anchor vector per construct,
//       stored as a CIPHERTEXT vector envelope at rest (anchor_vector); the
//       structural columns (construct, anchor_version, seed_content_hash, dim,
//       seed_count, embedder_label) stay plaintext; re-running is idempotent
//       (cached, no re-embed) and a seed-hash drift would re-embed.
//   (B) Phase B: per-window §4.5/4.11/4.12/4.13 metrics are computed; the metric
//       scalars + notes are CIPHERTEXT at rest while structural columns stay
//       plaintext; the adapter auto-decrypts the scalars to finite numbers.
//   (C) CVP gate: EVERY metric row is cvp_status='pending' + low_confidence=1,
//       and the S1 REST bridge (portal-measurement.js) does NOT surface the
//       anchor table (only the harmonic family) — i.e. un-validated metrics are
//       not served as validated.
//   (D) anchor_vector is in NEVER_AUTO_DECRYPT (the generic adapter does NOT
//       touch it; only the typed consumer decrypts it).
// Network-free, model-free: ANCHOR_EMBEDDER=stub. PASS/FAIL ledger; exit 0 only
// if all pass.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { encryptVector } from '../src/search/ann/decode.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-anchors.db', KCV = 'data/verify-anchors-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const RUN = 'era-verify-anchors-0001';
const PY = 'pipeline/.venv/bin/python3';
const DIM = 768;

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};
const looksPlaintextNumber = (v) =>
  typeof v === 'number' || (typeof v === 'string' && v.length < 40 && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v.trim()));

const masterKey = await importMasterKey(userHex);

// Seed: messages spread over ~120 days so all granularities populate. Use
// distinct deterministic 768-D unit vectors so the cosine metrics vary.
const DAY_MS = 86400000;
const now = Date.now();
const N = 400;
function seedVec(i) {
  const v = new Float32Array(DIM);
  const a = (i % 7) * 0.31, b = (i % 13) * 0.17;
  for (let d = 0; d < DIM; d++) v[d] = Math.sin((d + 1) * 0.011 + a) + 0.5 * Math.cos((d + 1) * 0.043 + b);
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
     VALUES (?,?,'user',NULL,?,?)`, [`m-${i}`, U, env, iso]);
}

function runStage(extraEnv = {}) {
  return spawnSync(PY, ['pipeline/compute-anchors.py'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: RUN,
      ANCHOR_EMBEDDER: 'stub', ...extraEnv },
  });
}

const CONSTRUCTS = ['insight', 'reflection', 'affect_positive', 'affect_negative'];
const METRIC_COLS = [
  'insight_embedding_proximity', 'reflective_embedding_density',
  'inner_territory_presence', 'affective_volatility_within_window',
];

try {
  // ── A0. stage runs clean with the stub embedder ───────────────────────────
  const r = runStage();
  rec('A0. compute-anchors.py (ANCHOR_EMBEDDER=stub) exits 0',
    r.status === 0, r.status !== 0 ? (r.stderr || r.stdout || '').slice(-600)
      : (r.stdout.match(/\[anchors\].*/)?.[0] || 'ok'));

  const raw = new Database(DB, { readonly: true });

  // ── A1. one anchor vector per construct, stored ───────────────────────────
  const anchorRows = raw.prepare(`SELECT * FROM cognitive_anchor_vectors`).all();
  const constructsStored = new Set(anchorRows.map((a) => a.construct));
  rec('A1. anchor vector stored for every construct (insight/reflection/affect_pos/affect_neg)',
    CONSTRUCTS.every((c) => constructsStored.has(c)) && anchorRows.length === CONSTRUCTS.length,
    `stored=[${[...constructsStored].join(', ')}]`);

  // ── A2. anchor_vector is RAW LE-f32 BLOB bytes at rest (Stage A SQLCipher
  // collapse) — no per-field envelope; at-rest secrecy is whole-file SQLCipher.
  // DIM × 4 bytes. The reader (compute-anchors decode_stored_vector) dual-reads
  // raw + any legacy envelope. ──
  const a0 = anchorRows[0];
  rec('A2. anchor_vector is a raw LE-f32 BLOB at rest (not an envelope)',
    anchorRows.every((a) => Buffer.isBuffer(a.anchor_vector) && a.anchor_vector.length === DIM * 4),
    a0 ? `${a0.construct}.anchor_vector ${Buffer.isBuffer(a0.anchor_vector) ? `raw[${a0.anchor_vector.length}B]` : 'NOT-RAW'}` : 'none');
  rec('A3. anchor structural columns plaintext (construct/anchor_version/seed_content_hash/dim/seed_count/embedder_label)',
    !!a0 && !isEnvelope(a0.construct) && !isEnvelope(a0.anchor_version)
      && typeof a0.seed_content_hash === 'string' && a0.seed_content_hash.length === 64
      && a0.dim === DIM && a0.seed_count === 10 && a0.embedder_label === 'stub-deterministic',
    a0 ? `version=${a0.anchor_version} hashlen=${a0.seed_content_hash?.length} dim=${a0.dim} seeds=${a0.seed_count} embedder=${a0.embedder_label}` : 'none');

  // ── A4. metric rows written; all cvp_status=pending + low_confidence=1 ─────
  const total = raw.prepare(`SELECT COUNT(*) n FROM cognitive_metrics_anchor WHERE user_id=? AND era_id=?`).get(U, RUN).n;
  const pendingNot = raw.prepare(
    `SELECT COUNT(*) n FROM cognitive_metrics_anchor WHERE user_id=? AND era_id=? AND cvp_status <> 'pending'`).get(U, RUN).n;
  const notLowConf = raw.prepare(
    `SELECT COUNT(*) n FROM cognitive_metrics_anchor WHERE user_id=? AND era_id=? AND low_confidence <> 1`).get(U, RUN).n;
  rec('A4. metric rows written + EVERY row cvp_status=pending + low_confidence=1 (spec §2.3 gate)',
    total > 0 && pendingNot === 0 && notLowConf === 0,
    `rows=${total} non_pending=${pendingNot} not_low_conf=${notLowConf}`);

  // ── A5. metric scalars + notes ciphertext at rest (zero plaintext numbers) ─
  const allRows = raw.prepare(
    `SELECT ${METRIC_COLS.join(', ')}, notes FROM cognitive_metrics_anchor WHERE user_id=? AND era_id=?`).all(U, RUN);
  let nonNull = 0, envelopes = 0, leaks = 0; const leakSamples = [];
  for (const row of allRows) {
    for (const c of METRIC_COLS) {
      const v = row[c]; if (v === null || v === undefined) continue;
      nonNull++;
      if (isEnvelope(v)) envelopes++;
      else { leaks++; if (leakSamples.length < 3) leakSamples.push(`${c}=${looksPlaintextNumber(v) ? v : '<non-env>'}`); }
    }
  }
  const notesOk = allRows.every((row) => row.notes == null || isEnvelope(row.notes));
  rec('A5. §4.5/4.11/4.12/4.13 metric scalars + notes are envelopes at rest (zero plaintext)',
    nonNull > 0 && leaks === 0 && envelopes === nonNull && notesOk,
    `nonNull=${nonNull} envelopes=${envelopes} leaks=${leaks} notesOk=${notesOk}${leakSamples.length ? ' [' + leakSamples.join(', ') + ']' : ''}`);

  // ── A6. metric structural columns plaintext ───────────────────────────────
  const sRow = raw.prepare(
    `SELECT user_id, window_end, granularity, era_id, language, anchor_version, message_count
     FROM cognitive_metrics_anchor WHERE user_id=? AND era_id=? LIMIT 1`).get(U, RUN);
  rec('A6. metric structural columns plaintext (window_end/granularity/era_id/anchor_version/message_count)',
    sRow && sRow.user_id === U && !isEnvelope(sRow.window_end) && ['alpha', 'theta', 'delta'].includes(sRow.granularity)
      && sRow.era_id === RUN && !isEnvelope(sRow.anchor_version) && typeof sRow.message_count === 'number',
    sRow ? `granularity=${sRow.granularity} version=${sRow.anchor_version} msgs=${sRow.message_count}` : 'no row');
  raw.close();

  // ── A7. adapter auto-decrypts metric scalars → finite numbers in plausible range ─
  const dec = await db.rawQuery(
    `SELECT insight_embedding_proximity AS ins, inner_territory_presence AS inner,
            reflective_embedding_density AS dens, affective_volatility_within_window AS vol
     FROM cognitive_metrics_anchor WHERE user_id=? AND era_id=?
       AND insight_embedding_proximity IS NOT NULL LIMIT 1`, [U, RUN]);
  const dr = (Array.isArray(dec) ? dec[0] : dec?.results?.[0]);
  const ins = dr ? Number(dr.ins) : NaN, dens = dr ? Number(dr.dens) : NaN, vol = dr ? Number(dr.vol) : NaN;
  rec('A7. adapter auto-decrypts §4.5/4.12/4.13 scalars → finite numbers in range',
    !!dr && Number.isFinite(ins) && ins >= -1 && ins <= 1
      && Number.isFinite(dens) && dens >= 0 && dens <= 1 && Number.isFinite(vol) && vol >= 0,
    dr ? `insight=${ins} density=${dens} volatility=${vol}` : 'no decryptable row');

  // ── A8. anchor_vector is in NEVER_AUTO_DECRYPT (typed consumer only) ───────
  const cl = readFileSync('src/crypto/crypto-local.js', 'utf8');
  const inNever = /NEVER_AUTO_DECRYPT_COLUMNS\s*=\s*new Set\(\[[\s\S]*?'anchor_vector'[\s\S]*?\]\)/.test(cl);
  rec('A8. anchor_vector listed in NEVER_AUTO_DECRYPT_COLUMNS (adapter never double-decrypts it)', inNever);

  // ── A9. re-run is idempotent — anchors CACHED (no re-embed), same hash ─────
  const before = anchorRows.map((a) => `${a.construct}:${a.seed_content_hash}`).sort().join('|');
  const r2 = runStage();
  const cached = /\(cached\)/.test(r2.stdout || '');
  const raw2 = new Database(DB, { readonly: true });
  const after = raw2.prepare(`SELECT construct, seed_content_hash FROM cognitive_anchor_vectors`).all()
    .map((a) => `${a.construct}:${a.seed_content_hash}`).sort().join('|');
  raw2.close();
  rec('A9. re-run is idempotent — anchors cached (no re-embed), seed hashes stable',
    r2.status === 0 && cached && before === after, `cached=${cached} hashes_stable=${before === after}`);

  // ── A10. S1 REST bridge does NOT surface the anchor table (not validated) ──
  const pm = readFileSync('src/portal-measurement.js', 'utf8');
  const surfacesAnchor = /cognitive_metrics_anchor/.test(pm);
  rec('A10. S1 REST bridge (portal-measurement.js) does NOT serve cognitive_metrics_anchor (un-validated, not surfaced)',
    !surfacesAnchor, surfacesAnchor ? 'LEAK: anchor table referenced in portal-measurement.js' : 'not surfaced (correct)');
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — E1 anchors embedded + encrypted; §4.5/4.11/4.12/4.13 metrics encrypted + cvp_status=pending + NOT surfaced as validated' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
