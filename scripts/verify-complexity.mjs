// verify:complexity — T1. Proves pipeline/compute-complexity.js computes
// Lempel-Ziv complexity end-to-end on a seeded vault, that level_name (T1 FIX:
// was plaintext in the canonical) + the metric columns are ENCRYPTED at rest
// (wrapped-DEK envelopes) while structural columns (level enum, level_id,
// window_end) stay plaintext, AND that a read through the adapter returns
// decrypted/usable values (level_name back to a string, metrics to numbers).
// Runs the REAL stage via spawnSync(node …). PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-complexity.db', KCV = 'data/verify-complexity-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};

// ── Seed: 3 territories across 2 realms + ~60 days of points so the daily-
//    activity sequences and territory-transition sequences are long enough for a
//    territory (≥5 pts) AND realm (≥10 pts) AND global (≥10 pts) snapshot. Names
//    are ENCRYPTED by the adapter on write; complexity re-encrypts via level_name. ──
const TERRS = [
  { tid: 1, realm: 10, name: 'Embodiment' },
  { tid: 2, realm: 10, name: 'Somatic Trauma' },
  { tid: 3, realm: 11, name: 'Systems Thinking' },
];
for (const t of TERRS) {
  await db.rawQuery(
    `INSERT INTO territory_profiles (id, user_id, territory_id, realm_id, name, message_count)
     VALUES (?,?,?,?,?,?)`,
    [`tp-${t.tid}`, U, t.tid, t.realm, t.name, 100]);
}
for (const r of [{ rid: 10, name: 'Body' }, { rid: 11, name: 'Mind' }]) {
  await db.rawQuery(
    `INSERT INTO realms (id, user_id, realm_id, name) VALUES (?,?,?,?)`,
    [`r-${r.rid}`, U, r.rid, r.name]);
}
const DAY_MS = 86400000, now = Date.now(), DAYS = 60;
let cpN = 0;
for (let d = DAYS; d >= 1; d--) {
  const iso = new Date(now - d * DAY_MS).toISOString();
  // Varying daily counts + territory mix → non-trivial sequences.
  const perDay = 2 + (d % 4);
  for (let k = 0; k < perDay; k++) {
    const t = TERRS[(d + k) % TERRS.length];
    await db.rawQuery(
      `INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, realm_id, created_at)
       VALUES (?,?,'message',?,?,?,?)`,
      [`cp-${cpN}`, U, `cp-${cpN}`, t.tid, t.realm, iso]);
    cpN++;
  }
}

try {
  // ── C1. compute-complexity.js runs clean ───────────────────────────────────
  const run = spawnSync('node', ['pipeline/compute-complexity.js'], {
    encoding: 'utf8',
    env: { ...process.env, MYCELIUM_DB: DB, MYCELIUM_KCV: KCV, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex },
  });
  rec('C1. compute-complexity.js exits 0 on a seeded vault',
    run.status === 0, run.status !== 0 ? (run.stderr || run.stdout || '').slice(-400) : (run.stdout.match(/\[complexity\] Done.*/)?.[0] || ''));

  // ── C2. complexity_snapshots populated (territory + realm + global) ─────────
  const raw = new Database(DB, { readonly: true });
  const total = raw.prepare(`SELECT COUNT(*) n FROM complexity_snapshots WHERE user_id=?`).get(U).n;
  const levels = raw.prepare(`SELECT level, COUNT(*) n FROM complexity_snapshots WHERE user_id=? GROUP BY level`).all(U);
  const lvlMap = Object.fromEntries(levels.map((l) => [l.level, l.n]));
  rec('C2. complexity_snapshots populated at territory + realm + global levels',
    total > 0 && (lvlMap.territory || 0) > 0 && (lvlMap.realm || 0) > 0 && (lvlMap.global || 0) > 0,
    `total=${total} ${JSON.stringify(lvlMap)}`);

  // ── C3. level_name + metric columns ciphertext at rest (T1 FIX) ─────────────
  const row = raw.prepare(
    `SELECT level_name, lz_complexity, raw_complexity, sequence_length, alphabet_size, point_count,
            level, level_id, window_end
     FROM complexity_snapshots WHERE user_id=? AND level='territory' LIMIT 1`).get(U);
  const encCols = ['level_name', 'lz_complexity', 'raw_complexity', 'sequence_length', 'alphabet_size', 'point_count'];
  const allEnc = row && encCols.every((c) => isEnvelope(row[c]));
  // level_name must NOT be a readable plaintext name at rest.
  const namePlain = row && !isEnvelope(row.level_name) && typeof row.level_name === 'string';
  rec('C3. level_name (T1 FIX) + metric columns are envelopes at rest (no plaintext name/numbers)',
    !!allEnc && !namePlain,
    row ? `enc{${encCols.filter((c) => isEnvelope(row[c])).length}/${encCols.length}}` : 'no row');
  rec('C4. structural columns stay plaintext (level enum / level_id / window_end)',
    row && !isEnvelope(row.level) && ['territory', 'realm', 'global'].includes(row.level)
      && !isEnvelope(String(row.window_end)),
    row ? `level=${row.level} level_id=${row.level_id} window_end=${row.window_end}` : 'no row');
  raw.close();

  // ── C5. adapter read decrypts level_name (string) + coerces metrics (number) ─
  const dec = await db.rawQuery(
    `SELECT level_name, lz_complexity, raw_complexity, level FROM complexity_snapshots WHERE user_id=? AND level='territory' LIMIT 1`, [U]);
  const dr = (Array.isArray(dec) ? dec[0] : dec?.results?.[0]);
  const known = new Set(TERRS.map((t) => t.name));
  rec('C5. adapter auto-decrypts level_name → original name; metrics → finite numbers',
    !!dr && known.has(dr.level_name) && Number.isFinite(Number(dr.lz_complexity)) && Number.isFinite(Number(dr.raw_complexity)),
    dr ? `level_name="${dr.level_name}" lz=${dr.lz_complexity} raw=${dr.raw_complexity}` : 'no row');
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — complexity computes; level_name + metrics encrypted at rest (T1 fix); adapter decrypts; structural keys plaintext' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
