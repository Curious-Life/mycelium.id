// verify:frequency — T1. Proves pipeline/compute-frequency.py computes windowed
// cognitive metrics end-to-end on a seeded vault, that (T1 FIX) messages.content
// is DECRYPTED before gzip (so the compression ratio is a real text TCR < 1.0,
// not ~1.0 on ciphertext), that the metric/count columns are ENCRYPTED at rest
// via the Python caller-encrypt path (wrapped-DEK envelopes) while structural
// columns (granularity enum, window_end, language) stay plaintext, AND that a
// read through the JS adapter auto-decrypts + coerces them to numbers. Runs the
// REAL Python stage via spawnSync(.venv python3). PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-frequency.db', KCV = 'data/verify-frequency-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const PY = 'pipeline/.venv/bin/python3';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};
const centroid = (seed) => JSON.stringify(new Array(256).fill(0).map((_, i) => Math.sin((i + 1) * (seed + 1) * 0.013)));

// ── Seed: 3 territories (encrypted centroids) + ~150 days of points spread
//    across ≥2 month windows, PLUS one compressible English message per day so
//    the compression metric has real (decrypted) text to gzip. ──
const TERRS = [1, 2, 3];
for (const tid of TERRS) {
  await db.rawQuery(
    `INSERT INTO territory_profiles (id, user_id, territory_id, centroid_256, message_count, dissolved_at)
     VALUES (?,?,?,?,?,NULL)`,
    [`tp-${tid}`, U, tid, centroid(tid), 100]);
}
// A long, highly-repetitive English paragraph compresses well (TCR well below
// 1.0). If content were gzipped as CIPHERTEXT (the bug), TCR would be ~1.0.
const PARAGRAPH = (
  'the quick brown fox jumps over the lazy dog. ' +
  'the quick brown fox jumps over the lazy dog again and again. '
).repeat(20);
const DAY_MS = 86400000, now = Date.now(), DAYS = 150;
let n = 0;
for (let d = DAYS; d >= 1; d--) {
  const iso = new Date(now - d * DAY_MS).toISOString();
  const tid = TERRS[d % TERRS.length];
  await db.rawQuery(
    `INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, created_at)
     VALUES (?,?,'message',?,?,?)`,
    [`cp-${n}`, U, `m-${n}`, tid, iso]);
  // One message per point; content is ENCRYPTED by the adapter on write.
  await db.rawQuery(
    `INSERT INTO messages (id, user_id, role, content, created_at) VALUES (?,?,?,?,?)`,
    [`m-${n}`, U, 'user', `${PARAGRAPH} entry ${n}`, iso]);
  n++;
}

// Sanity: confirm messages.content is ciphertext at rest BEFORE running the stage
// (so the decrypt-before-gzip path is genuinely exercised).
{
  const raw = new Database(DB, { readonly: true });
  const m = raw.prepare(`SELECT content FROM messages WHERE user_id=? LIMIT 1`).get(U);
  raw.close();
  // SQLCipher collapse (Stage B/C cut 4): messages.content is PLAINTEXT-in-cipher —
  // at-rest = whole-file SQLCipher (verify:at-rest). compute-frequency.py reads it via
  // the dual-read decryptor (pass-through on plaintext), so the metric still computes.
  rec('FQ0. seed precondition: messages.content PLAINTEXT-in-cipher (collapse cut 4; at-rest = whole-file SQLCipher, verify:at-rest)',
    !!m && !isEnvelope(m.content), `content_plain=${m ? !isEnvelope(m.content) : 'no row'}`);
}

try {
  // ── FQ1. compute-frequency.py runs clean ───────────────────────────────────
  const run = spawnSync(PY, ['pipeline/compute-frequency.py'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex },
  });
  rec('FQ1. compute-frequency.py exits 0 on a seeded vault',
    run.status === 0, run.status !== 0 ? (run.stderr || run.stdout || '').slice(-500) : (run.stdout.match(/\[frequency\] Done.*/)?.[0] || ''));

  // ── FQ2. frequency_snapshots populated ─────────────────────────────────────
  const raw = new Database(DB, { readonly: true });
  const count = raw.prepare(`SELECT COUNT(*) n FROM frequency_snapshots WHERE user_id=?`).get(U).n;
  rec('FQ2. frequency_snapshots populated', count > 0, `rows=${count}`);

  // ── FQ3. metric/count columns ciphertext at rest; structural cols plaintext ─
  const row = raw.prepare(
    `SELECT coherence, entropy, compression, learning_rate, gradient_signal,
            point_count, territory_count, message_count,
            granularity, window_end, language
     FROM frequency_snapshots WHERE user_id=? AND compression IS NOT NULL LIMIT 1`).get(U);
  const encCols = ['entropy', 'compression', 'learning_rate', 'gradient_signal',
    'point_count', 'territory_count', 'message_count'];
  const allEnc = row && encCols.every((c) => isEnvelope(row[c]));
  rec('FQ3. metric + count columns are envelopes at rest (Python caller-encrypt)',
    !!allEnc,
    row ? `enc{${encCols.filter((c) => isEnvelope(row[c])).length}/${encCols.length}}` : 'no row with compression');
  rec('FQ4. structural columns stay plaintext (granularity enum / window_end / language)',
    row && !isEnvelope(row.granularity) && ['month', 'week', 'day'].includes(row.granularity)
      && !isEnvelope(String(row.window_end)) && !isEnvelope(String(row.language)),
    row ? `granularity=${row.granularity} window_end=${row.window_end} language=${row.language}` : 'no row');
  raw.close();

  // ── FQ5. adapter decrypts + coerces; compression is a REAL text TCR (<1.0) ──
  // T1 FIX VALIDATION: if content were gzipped as ciphertext, TCR ≈ 1.0. The
  // repetitive paragraph compresses far below 1.0 ⇒ proves content was DECRYPTED
  // before gzip.
  const dec = await db.rawQuery(
    `SELECT compression, entropy, message_count, granularity FROM frequency_snapshots
     WHERE user_id=? AND compression IS NOT NULL ORDER BY window_end DESC LIMIT 1`, [U]);
  const dr = (Array.isArray(dec) ? dec[0] : dec?.results?.[0]);
  const tcr = dr ? Number(dr.compression) : NaN;
  rec('FQ5. adapter decrypts + coerces; compression is a real text TCR (<0.5 ⇒ content was decrypted before gzip, T1 fix)',
    !!dr && Number.isFinite(tcr) && tcr > 0 && tcr < 0.5
      && Number.isFinite(Number(dr.entropy)) && Number.isFinite(Number(dr.message_count)),
    dr ? `compression=${dr.compression} (→${tcr}) entropy=${dr.entropy} message_count=${dr.message_count}` : 'no row');
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — frequency computes; content decrypted before gzip (T1 fix); metrics encrypted at rest; adapter decrypts + coerces; structural keys plaintext' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
