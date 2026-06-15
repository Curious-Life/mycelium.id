// verify:realm-prune — realms lifecycle hygiene (2026-06-10 dead-weight audit).
// Proves (1) describe-clusters maintains realms.territory_count/message_count
// from live clustering_points (insert AND conflict-update paths — they were 0
// forever: no writer), and (2) the cluster.py stale-realm prune deletes realm
// rows with no live points while keeping live ones (ghost rows leaked into the
// search corpus, /mindscape/realms, realm_count and public realm names).
// The prune here executes the SAME two statements cluster.py issues (the Python
// stage needs the full Tier-2 stack; SQL parity is asserted against the source).
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-realm-prune.db', KCV = 'data/verify-realm-prune-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const U = 'local-user';

// ── Seed: live realms 0 (3 pts / 2 territories) + 5 (2 pts / 1 territory);
//    ghost realm 99 (row, no points); pre-existing row for 0 (conflict path). ──
{
  const d0 = new Database(DB);
  applyMigrations(d0);
  d0.close();
}
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const cp = (id, realm, terr) => db.rawQuery(
  `INSERT INTO clustering_points (id, user_id, source_type, source_id, realm_id, territory_id)
   VALUES (?, ?, 'message', ?, ?, ?)`, [id, U, `m-${id}`, realm, terr]);
await cp('p1', 0, 1); await cp('p2', 0, 1); await cp('p3', 0, 2);
await cp('p4', 5, 7); await cp('p5', 5, 7);
// name/essence bound as PARAMS — autoEncryptParams only encrypts params, a SQL
// literal would land plaintext at rest (and the clobber guard now preserves the
// seeded name instead of overwriting it, so the seed must be properly encrypted).
await db.rawQuery(
  `INSERT INTO realms (user_id, realm_id, name, essence) VALUES (?, 0, ?, ?)`, [U, 'Old Name', 'stale essence']);
await db.rawQuery(
  `INSERT INTO realms (user_id, realm_id, name, essence, territory_count, message_count)
   VALUES (?, 99, ?, ?, 0, 0)`, [U, 'Ghost Realm', 'no live points']);
close();

// ── R1: describe-clusters writes real counts (no messages → placeholder names,
//    no narrator/network; counts come from clustering_points alone). ──
const env = {
  ...process.env, USER_MASTER: userHex, SYSTEM_KEY: systemHex,
  MYCELIUM_DB: DB, MYCELIUM_USER_ID: U,
};
const run = spawnSync('node', ['pipeline/describe-clusters.js'], { env, encoding: 'utf8', timeout: 120_000 });
rec('R1. describe-clusters exits 0', run.status === 0, run.status !== 0 ? (run.stderr || run.stdout || '').slice(-300) : '');

const { db: db2, close: close2 } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const rows = async (sql, p = []) => (await db2.rawQuery(sql, p)).results || [];
const realmRow = async (id) => (await rows(
  'SELECT realm_id, name, territory_count, message_count FROM realms WHERE user_id = ? AND realm_id = ?', [U, id]))[0];

const r0 = await realmRow(0);
rec('R2. realm 0 conflict-update: territory_count=2, message_count=3 (was 0/0 on the seeded row)',
  r0 && Number(r0.territory_count) === 2 && Number(r0.message_count) === 3,
  r0 ? `tc=${r0.territory_count} mc=${r0.message_count}` : 'row missing');
const r5 = await realmRow(5);
rec('R3. realm 5 fresh insert: territory_count=1, message_count=2',
  r5 && Number(r5.territory_count) === 1 && Number(r5.message_count) === 2,
  r5 ? `tc=${r5.territory_count} mc=${r5.message_count}` : 'row missing');

// ── R4-R5: the stale-realm prune (cluster.py's exact statements). ──
const src = readFileSync('pipeline/cluster.py', 'utf8');
const hasSelect = src.includes('SELECT realm_id FROM realms WHERE user_id = ? AND realm_id NOT IN');
const hasDelete = src.includes('DELETE FROM realms WHERE user_id = ? AND realm_id NOT IN');
rec('R4. cluster.py contains the prune statements this gate mirrors', hasSelect && hasDelete);

const live = [0, 5];
const ph = live.map(() => '?').join(',');
const stale = await rows(`SELECT realm_id FROM realms WHERE user_id = ? AND realm_id NOT IN (${ph})`, [U, ...live]);
await db2.rawQuery(`DELETE FROM realms WHERE user_id = ? AND realm_id NOT IN (${ph})`, [U, ...live]);
const after = await rows('SELECT realm_id FROM realms WHERE user_id = ? ORDER BY realm_id', [U]);
rec('R5. prune: ghost realm 99 detected + deleted; live realms 0 and 5 kept',
  stale.length === 1 && Number(stale[0].realm_id) === 99
  && after.length === 2 && Number(after[0].realm_id) === 0 && Number(after[1].realm_id) === 5,
  `stale=[${stale.map((r) => r.realm_id)}] after=[${after.map((r) => r.realm_id)}]`);

// ── R6: counts are PLAINTEXT at rest (search SQL-sorts on message_count —
//    realms name/essence stay encrypted, counters must not be envelopes). ──
close2();
const raw = new Database(DB, { readonly: true });
const rawRow = raw.prepare('SELECT name, territory_count, message_count FROM realms WHERE realm_id = 0').get();
raw.close();
rec('R6. territory_count/message_count plaintext integers; name still ciphertext at rest (clobber guard preserved the seeded name)',
  Number(rawRow?.territory_count) === 2 && Number(rawRow?.message_count) === 3
  && typeof rawRow?.name === 'string' && !rawRow.name.includes('Realm') && !rawRow.name.includes('Old Name'),
  `tc=${rawRow?.territory_count} mc=${rawRow?.message_count}`);

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — realm counts maintained + stale realms pruned' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
