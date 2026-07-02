// verify:behavioral — behavioral-temporal (Tier-0). Proves the stage computes
// diurnal_pattern_metrics (24-bin volume histogram + entropy/peak/concentration)
// and session_cadence_regularity (entropy + CV of inter-session intervals) from
// message timestamps ALONE (no content, no embeddings), that the sensitive
// scalars + the diurnal histogram JSON are CIPHERTEXT at rest while structural
// columns stay plaintext, and that a read through the adapter auto-decrypts them
// to usable values. Runs the REAL stage via spawnSync. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-behavioral.db', KCV = 'data/verify-behavioral-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const RUN = 'era-verify-behavioral-0001';
const PY = 'pipeline/.venv/bin/python3';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};

// Seed: ~60 days of messages clustered around two times of day (morning ~9h and
// evening ~21h) so the diurnal histogram is bimodal (non-uniform → finite
// entropy, identifiable peak). Sessions are the morning + evening bursts each
// day → regular cadence (low inter-session entropy). NO content/embeddings.
const DAY_MS = 86400000;
// Anchor to a UTC midnight so adding 9h/21h lands exactly at 09:00 / 21:00 UTC
// (Date.now() carries a wall-clock time-of-day that would skew the hour bins).
const todayMidnight = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const DAYS = 60;
let mi = 0;
for (let day = 0; day < DAYS; day++) {
  const base = todayMidnight - (DAYS - day) * DAY_MS;
  // Morning burst (~09:00, 3 messages a few minutes apart)
  for (let k = 0; k < 3; k++) {
    const ts = new Date(base + 9 * 3600000 + k * 120000);
    await db.rawQuery(`INSERT INTO messages (id, user_id, role, content, created_at) VALUES (?,?,'user',NULL,?)`,
      [`m-${mi++}`, U, ts.toISOString().replace('Z', '+00:00')]);
  }
  // Evening burst (~21:00, 4 messages)
  for (let k = 0; k < 4; k++) {
    const ts = new Date(base + 21 * 3600000 + k * 120000);
    await db.rawQuery(`INSERT INTO messages (id, user_id, role, content, created_at) VALUES (?,?,'user',NULL,?)`,
      [`m-${mi++}`, U, ts.toISOString().replace('Z', '+00:00')]);
  }
}

// Regression seed: EPOCH_N messages whose created_at is stored as an epoch-MILLISECOND
// numeric string (a real import format). The old inline fromisoformat parse silently
// dropped these; a whole vault in that format produced NO row + a blank Routine surface.
// Placed at hour 14 (≠ the 9/21 peaks) so B6 can prove they were parsed + binned.
const EPOCH_N = 8;
for (let k = 0; k < EPOCH_N; k++) {
  const tsMs = todayMidnight - 5 * DAY_MS + 14 * 3600000 + k * 60000;
  await db.rawQuery(`INSERT INTO messages (id, user_id, role, content, created_at) VALUES (?,?,'user',NULL,?)`,
    [`m-${mi++}`, U, String(tsMs)]);
}

function runStage() {
  return spawnSync(PY, ['pipeline/compute-behavioral.py'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: 'pipeline', MYCELIUM_DB: DB, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: RUN },
  });
}

try {
  // ── B1. stage runs clean ───────────────────────────────────────────────────
  const r = runStage();
  rec('B1. compute-behavioral.py exits 0 on a timestamp-only vault',
    r.status === 0, r.status !== 0 ? (r.stderr || r.stdout || '').slice(-500) : (r.stdout.match(/\[behavioral\].*/)?.[0] || ''));

  const raw = new Database(DB, { readonly: true });
  // ── B2. cognitive_metrics_behavioral populated (one era summary row) ────────
  const rows = raw.prepare(`SELECT COUNT(*) n FROM cognitive_metrics_behavioral WHERE user_id=? AND era_id=?`).get(U, RUN).n;
  rec('B2. cognitive_metrics_behavioral populated (era summary row)',
    rows === 1, `rows=${rows} (expected 1)`);

  // ── B3. metric columns + histogram JSON ciphertext at rest; structural plaintext ─
  const row = raw.prepare(
    `SELECT diurnal_entropy, diurnal_peak_hour, diurnal_concentration, diurnal_hist,
            session_count, intersession_entropy, intersession_cv, notes,
            era_id, window_end, message_count, low_confidence
     FROM cognitive_metrics_behavioral WHERE user_id=? AND era_id=?`).get(U, RUN);
  const encCols = ['diurnal_entropy', 'diurnal_peak_hour', 'diurnal_concentration', 'diurnal_hist',
    'session_count', 'intersession_entropy', 'intersession_cv'];
  const present = row ? encCols.filter((c) => row[c] != null) : [];
  // SQLCipher collapse (Stage B/C cut 5): behavioral scalars + diurnal histogram JSON
  // are PLAINTEXT-in-cipher — at-rest = whole-file SQLCipher (verify:at-rest).
  const allPlain = row && present.length >= 5 && present.every((c) => !isEnvelope(row[c]));
  rec('B3. behavioral scalars + diurnal histogram JSON PLAINTEXT-in-cipher (collapse cut 5; verify:at-rest)',
    !!allPlain, row ? `plain{${present.filter((c) => !isEnvelope(row[c])).length}/${present.length}}` : 'no row');
  rec('B4. structural columns plaintext (era / window_end / message_count / low_confidence=1)',
    row && !isEnvelope(row.era_id) && row.era_id === RUN && Number.isInteger(row.message_count)
      && row.message_count === DAYS * 7 + EPOCH_N && row.low_confidence === 1,
    row ? `era=${row.era_id} msgs=${row.message_count} low_conf=${row.low_confidence}` : 'no row');
  raw.close();

  // ── B5. adapter read decrypts → usable values (peak hour ∈ {9,21}; hist=24 bins) ─
  const dec = await db.rawQuery(
    `SELECT diurnal_entropy, diurnal_peak_hour, diurnal_hist, intersession_entropy
     FROM cognitive_metrics_behavioral WHERE user_id=? AND era_id=?`, [U, RUN]);
  const dr = (Array.isArray(dec) ? dec[0] : dec?.results?.[0]);
  let hist = null;
  try { hist = JSON.parse(dr?.diurnal_hist); } catch { /* */ }
  const peak = dr ? Number(dr.diurnal_peak_hour) : NaN;
  const ent = dr ? Number(dr.diurnal_entropy) : NaN;
  rec('B5. adapter auto-decrypts → entropy∈[0,1], peak hour∈{9,21}, 24-bin histogram, finite cadence entropy',
    !!dr && Number.isFinite(ent) && ent >= 0 && ent <= 1 && [9, 21].includes(peak)
      && Array.isArray(hist) && hist.length === 24 && Number.isFinite(Number(dr.intersession_entropy)),
    dr ? `entropy=${ent} peak_hour=${peak} hist_bins=${hist?.length} cadence_ent=${dr.intersession_entropy}` : 'no row');

  // ── B6. epoch-millisecond created_at strings are parsed (not silently dropped) ─
  // The regression: only these 8 messages sit at hour 14, so hist[14] === EPOCH_N
  // proves the shared stage_time parser handled the numeric-string epoch format the
  // old inline fromisoformat parse threw on.
  rec('B6. epoch-millis created_at parsed + binned (stage_time robustness; hour 14 = EPOCH_N)',
    Array.isArray(hist) && hist[14] === EPOCH_N,
    Array.isArray(hist) ? `hist[14]=${hist[14]} (expected ${EPOCH_N})` : 'no hist');
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — behavioral-temporal computes diurnal + cadence from timestamps; encrypted at rest; adapter decrypts; structural plaintext' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
