// verify:territory-neighbors — proves the "gaps" fix end-to-end.
//
// territory_neighbors had no writer, so db.topology.getGaps always returned
// empty. This verifies pipeline/compute-territory-neighbors.js populates the
// table from centroid_256 cosine, and that getGaps then surfaces a
// semantically-close-but-not-co-firing territory (a real "gap") while excluding
// a close pair that DOES co-fire. Seeds a tiny synthetic topology. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { computeTerritoryNeighbors } from '../pipeline/compute-territory-neighbors.js';

const DB = 'data/verify-territory-neighbors.db', KCV = 'data/verify-territory-neighbors-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// 256-D centroid from a sparse {index: value} spec.
const vec = (spec) => { const v = new Array(256).fill(0); for (const [i, x] of Object.entries(spec)) v[Number(i)] = x; return JSON.stringify(v); };

// T1 = e0; T2 ≈ T1 (sim ~0.97); T4 close to T1 (sim 0.8); T3 orthogonal (sim 0).
const territories = [
  { id: 1, name: 'Alpha',  c: vec({ 0: 1 }) },
  { id: 2, name: 'Beta',   c: vec({ 0: 0.97, 1: 0.2426 }) },
  { id: 3, name: 'Gamma',  c: vec({ 5: 1 }) },
  { id: 4, name: 'Delta',  c: vec({ 0: 0.8, 2: 0.6 }) },
];
for (const t of territories) {
  await db.rawQuery(
    `INSERT INTO territory_profiles (id, user_id, territory_id, name, centroid_256, message_count, is_catchall)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [`tp-${t.id}`, U, t.id, t.name, t.c, 50],
  );
}
// T1 & T2 co-fire (so they are NOT a gap); T1 & T4 do not.
await db.rawQuery(
  `INSERT INTO territory_cofire (id, user_id, territory_a, territory_b, cofire_immediate, cofire_session, cofire_daily, cofire_weekly)
   VALUES (?, ?, 1, 2, 0, 0, 0, 0.8)`,
  [`${U}:1:2`, U],
);

// ── Run the stage ──
const res = await computeTerritoryNeighbors({ db, userId: U, minSim: 0.5, topK: 12, log: () => {} });
rec('TN1. stage wrote neighbor edges', res.written > 0, `territories=${res.territories} pairs=${res.pairs} written=${res.written}`);

// T1's stored neighbors: should include T2 (~0.97) & T4 (0.8), exclude T3 (0 < 0.5).
const n1 = (await db.rawQuery(
  `SELECT neighbor_id, distance FROM territory_neighbors WHERE user_id = ? AND territory_id = 1 ORDER BY distance ASC`, [U],
)).results || [];
const nset = new Set(n1.map((r) => r.neighbor_id));
rec('TN2. T1 neighbors include the two close territories (T2,T4)', nset.has(2) && nset.has(4), `neighbors=${[...nset].join(',') || 'none'}`);
rec('TN3. T1 neighbors exclude the orthogonal one (T3, sim 0 < floor)', !nset.has(3), `neighbors=${[...nset].join(',')}`);
const dT2 = n1.find((r) => r.neighbor_id === 2)?.distance;
rec('TN4. distance = 1 - cosine (T2 ≈ 0.03)', dT2 != null && Math.abs(dT2 - 0.03) < 0.02, `distance(T1→T2)=${dT2}`);

// ── The actual gaps feature: getGaps(T1) ──
const gaps = await db.topology.getGaps({ p_user_id: U, p_territory_id: 1, p_scale: 'weekly', p_max_cofire: 0.05, p_limit: 10 });
const gset = new Set(gaps.map((g) => g.territory_id));
rec('TN5. getGaps(T1) returns the close-but-not-co-firing territory (T4)', gset.has(4), `gaps=${[...gset].join(',') || 'none'}`);
rec('TN6. getGaps(T1) EXCLUDES the close territory that co-fires (T2)', !gset.has(2), `gaps=${[...gset].join(',')}`);
const gT4 = gaps.find((g) => g.territory_id === 4);
rec('TN7. gap carries semantic_similarity ≈ 0.8', gT4 && Math.abs(gT4.semantic_similarity - 0.8) < 0.05, `similarity(T4)=${gT4?.semantic_similarity}`);

// ── Idempotent rebuild (DELETE+INSERT) ──
const res2 = await computeTerritoryNeighbors({ db, userId: U, minSim: 0.5, topK: 12, log: () => {} });
rec('TN8. idempotent — re-run yields the same edge count', res2.written === res.written, `run1=${res.written} run2=${res2.written}`);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — territory_neighbors writer fills the gaps feature (getGaps live)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
