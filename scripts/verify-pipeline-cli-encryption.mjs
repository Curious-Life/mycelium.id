// verify:pipeline-cli-encryption — regression guard for the SEC-2 CLI-write bug.
// The pipeline spawns the JS metric stages as child processes (jobs.js →
// `node pipeline/<stage>.js` with hex keys in env). A stage that opened the vault
// via getDb({userKey:<hex>}) could NOT encrypt — autoEncryptParams → subtle.deriveBits
// needs a CryptoKey, so every ENCRYPTED_FIELDS write threw and was swallowed by the
// stage's per-row catch → territory_cofire / territory_neighbors came out EMPTY in
// production (the in-process verify gates booted properly, so they missed it). Fixed
// by switching those CLI wrappers to boot() (runs unlock() → real CryptoKeys). This
// gate reproduces the production path: seed → spawn the REAL stage as `node …` →
// assert the table is populated AND the encrypted column is an envelope at rest.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-cli-enc.db', KCV = 'data/verify-cli-enc-kcv.json';
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
// Similar (non-orthogonal) centroids so neighbor cosine clears the min-sim threshold.
const centroid = (seed) => {
  const v = new Array(256).fill(0).map((_, i) => Math.sin((i + 1) * 0.02) + seed * 0.001 * Math.cos(i * 0.05));
  return JSON.stringify(v);
};

// ── Seed: 4 territories (centroid_256 encrypted by the adapter on write) +
//    clustering_points co-occurring in shared daily windows (so cofire edges form). ──
const TIDS = [1, 2, 3, 4];
for (const t of TIDS) {
  await db.rawQuery(
    `INSERT INTO territory_profiles (id, user_id, territory_id, realm_id, semantic_theme_id, message_count, centroid_256, is_catchall, dissolved_at)
     VALUES (?,?,?,?,?,?,?,0,NULL)`,
    [`tp-${t}`, U, t, 10 + (t % 2), 100 + t, 50 * t, centroid(t)]);
}
const DAY_MS = 86400000, now = Date.now();
let cpN = 0;
for (let d = 20; d >= 1; d--) {
  const iso = new Date(now - d * DAY_MS).toISOString().replace('Z', '+00:00');
  for (const t of TIDS) { // all 4 territories active each day → dense co-firing
    await db.rawQuery(
      `INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, created_at) VALUES (?,?,'message',?,?,?)`,
      [`cp-${cpN}`, U, `cp-${cpN}`, t, iso]);
    cpN++;
  }
}
close();

const spawnStage = (file, label) => spawnSync('node', [`pipeline/${file}`], {
  encoding: 'utf8',
  env: { ...process.env, MYCELIUM_DB: DB, MYCELIUM_KCV: KCV, MYCELIUM_USER_ID: U,
    USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: 'era-cli-enc-0001' },
});

try {
  // ── CLI1. compute-cofire.js (spawned) populates encrypted territory_cofire ──
  const r1 = spawnStage('compute-cofire.js');
  const raw1 = new Database(DB, { readonly: true });
  const cof = raw1.prepare(`SELECT cofire_immediate, cofire_daily FROM territory_cofire WHERE user_id=? LIMIT 1`).get(U);
  const cofN = raw1.prepare(`SELECT COUNT(*) n FROM territory_cofire WHERE user_id=?`).get(U).n;
  raw1.close();
  rec('CLI1. spawned compute-cofire.js populates territory_cofire with ENCRYPTED strengths',
    r1.status === 0 && cofN > 0 && cof && isEnvelope(cof.cofire_immediate),
    r1.status !== 0 ? (r1.stderr || '').slice(-300) : `rows=${cofN} cofire_immediate_enc=${cof ? isEnvelope(cof.cofire_immediate) : 'n/a'}`);

  // ── CLI2. compute-territory-neighbors.js (spawned) populates encrypted distance ──
  const r2 = spawnStage('compute-territory-neighbors.js');
  const raw2 = new Database(DB, { readonly: true });
  const nb = raw2.prepare(`SELECT distance FROM territory_neighbors WHERE user_id=? LIMIT 1`).get(U);
  const nbN = raw2.prepare(`SELECT COUNT(*) n FROM territory_neighbors WHERE user_id=?`).get(U).n;
  raw2.close();
  rec('CLI2. spawned compute-territory-neighbors.js populates territory_neighbors with ENCRYPTED distance',
    r2.status === 0 && nbN > 0 && nb && isEnvelope(nb.distance),
    r2.status !== 0 ? (r2.stderr || '').slice(-300) : `rows=${nbN} distance_enc=${nb ? isEnvelope(nb.distance) : 'n/a'}`);

  // ── CLI3. round-trip through the adapter → decrypted numbers ────────────────
  const { db: db2, close: close2 } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
  const cofRows = await db2.rawQuery(`SELECT cofire_immediate FROM territory_cofire WHERE user_id=? LIMIT 1`, [U]);
  const cr = (Array.isArray(cofRows) ? cofRows[0] : cofRows?.results?.[0]);
  close2();
  rec('CLI3. adapter decrypts the CLI-written cofire strength → finite number',
    !!cr && Number.isFinite(Number(cr.cofire_immediate)),
    cr ? `cofire_immediate=${cr.cofire_immediate} → ${Number(cr.cofire_immediate)}` : 'no row');
} finally {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — spawned-CLI metric stages encrypt + write (SEC-2 CLI regression guarded)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
