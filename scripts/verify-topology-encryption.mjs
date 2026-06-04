// verify:topology-encryption — SEC-2. Proves co-firing strengths + neighbor
// distances are encrypted at rest, and that the reworked db/topology.js readers
// (which now filter/sort/aggregate in JS over decrypted values, joining only on
// plaintext keys) return correct results. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-topology-encryption.db', KCV = 'data/verify-topology-encryption-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Territories: T1(realm1), T2(realm1), T3(realm2), T4(realm2, orphan).
for (const [tid, name, realm, msgs] of [[1, 'Alpha', 1, 50], [2, 'Beta', 1, 40], [3, 'Gamma', 2, 30], [4, 'Delta', 2, 20]]) {
  await db.rawQuery(
    `INSERT INTO territory_profiles (id, user_id, territory_id, name, realm_id, message_count, is_catchall) VALUES (?,?,?,?,?,?,0)`,
    [`tp-${tid}`, U, tid, name, realm, msgs]);
}
// Cofire (numbers → auto-encrypted): T1-T2 strong, T1-T3 medium. T4 has none → orphan.
for (const [a, b, w] of [[1, 2, 0.8], [1, 3, 0.5]]) {
  await db.rawQuery(
    `INSERT INTO territory_cofire (id, user_id, territory_a, territory_b, cofire_immediate, cofire_session, cofire_daily, cofire_weekly) VALUES (?,?,?,?,0,0,0,?)`,
    [`${U}:${a}:${b}`, U, a, b, w]);
}
// Neighbors (distance → auto-encrypted): T1~T2 (cofiring → not a gap), T1~T4 (no cofire → a gap).
for (const [t, nb, dist] of [[1, 2, 0.1], [1, 4, 0.2]]) {
  await db.rawQuery(
    `INSERT INTO territory_neighbors (id, user_id, territory_id, neighbor_id, connection_type, distance) VALUES (?,?,?,?,'semantic',?)`,
    [`${U}:${t}:${nb}`, U, t, nb, dist]);
}

// TE1 — ciphertext at rest.
const raw = new Database(DB, { readonly: true });
const rawCofire = JSON.stringify(raw.prepare(`SELECT cofire_weekly FROM territory_cofire WHERE user_id=? AND territory_a=1 AND territory_b=2`).all(U));
const rawDist = JSON.stringify(raw.prepare(`SELECT distance FROM territory_neighbors WHERE user_id=? AND territory_id=1 AND neighbor_id=4`).all(U));
raw.close();
rec('TE1. cofire strengths + neighbor distance ENCRYPTED at rest', !rawCofire.includes('0.8') && !rawDist.includes('0.2'), `cofire_raw=${rawCofire.slice(0, 40)}…`);

// TE2 — getCoFiring sorts by decrypted strength.
const cf = await db.topology.getCoFiring({ p_user_id: U, p_territory_id: 1, p_scale: 'weekly', p_min_strength: 0.1, p_limit: 10 });
rec('TE2. getCoFiring returns decrypted strengths, sorted desc (T2=0.8 first, then T3=0.5)',
  cf.length === 2 && cf[0].territory_id === 2 && cf[0].cofire_strength === 0.8 && cf[1].territory_id === 3,
  `→ ${cf.map((c) => `T${c.territory_id}:${c.cofire_strength}`).join(', ')}`);

// TE3 — getOrphans: T4 (0 connections) is an orphan; T1 (2) is not.
const orph = await db.topology.getOrphans({ p_user_id: U, p_scale: 'weekly', p_min_messages: 5, p_max_connections: 0, p_limit: 10 });
const oset = new Set(orph.map((o) => o.territory_id));
rec('TE3. getOrphans counts connections in JS (T4 orphan, T1 not)', oset.has(4) && !oset.has(1), `orphans=${[...oset].join(',')}`);

// TE4 — getBridges: T1 spans realms 1 & 2.
const br = await db.topology.getBridges({ p_user_id: U, p_scale: 'weekly', p_min_cofire: 0.05, p_min_connections: 2, p_limit: 10 });
const t1b = br.find((b) => b.territory_id === 1);
rec('TE4. getBridges aggregates in JS (T1 connects 2 territories across 2 realms)',
  !!t1b && t1b.connection_count === 2 && t1b.connected_realms === 2, `T1=${JSON.stringify(t1b)}`);

// TE5 — getGaps(T1): T4 (similar, not cofiring) is a gap; T2 (cofiring) excluded.
const gaps = await db.topology.getGaps({ p_user_id: U, p_territory_id: 1, p_scale: 'weekly', p_max_cofire: 0.05, p_limit: 10 });
const gset = new Set(gaps.map((g) => g.territory_id));
const g4 = gaps.find((g) => g.territory_id === 4);
rec('TE5. getGaps: T4 gap (sim≈0.8), T2 excluded (co-fires)', gset.has(4) && !gset.has(2) && g4 && Math.abs(g4.semantic_similarity - 0.8) < 0.01, `gaps=${[...gset].join(',')} sim4=${g4?.semantic_similarity}`);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — cofire/distance encrypted; topology readers correct via JS-side filtering' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
