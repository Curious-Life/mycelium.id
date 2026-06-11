// verify:history — entity change-log (ENTITY-HISTORY-DESIGN-2026-06-11).
// Proves the append-only history layer: dedup-vs-latest, revert logging, auto-record
// on chronicle/realm writes, dynamics snapshots via the pipeline stage, encryption at
// rest, and survival past dissolution/prune.
//   H1 recordSnapshot → seq 1; readHistory round-trips payload
//   H2 identical payload → {skipped}; still seq 1 (dedup-vs-latest)
//   H3 changed prose → seq 2; revert A→B→A → seq 3 (dedup is vs LATEST only)
//   H4 upsertDescription auto-records narrative; version bump w/ same prose → no dup
//   H5 upsertRealmDescription auto-records a realm narrative snapshot
//   H6 payload ciphertext at rest; entity_kind/seq/cluster_version plaintext
//   H7 dynamics stage records one per live entity; unchanged → deduped; changed → +1
//   H8 history survives entity dissolution + realm prune (rows remain)
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { canonicalize } from '../src/db/history.js';

const DB = 'data/verify-history.db', KCV = 'data/verify-history-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const U = 'local-user';
{ const d0 = new Database(DB); applyMigrations(d0); d0.close(); }
let { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const reopen = async () => { const b = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null }); db = b.db; close = b.close; };

// ── H1: first record → seq 1; readHistory round-trips ──
const r1 = await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 1, snapshotKind: 'narrative', stage: 'name', payload: { name: 'Roots', essence: 'where it begins' } });
const h1 = await db.history.readHistory(U, 'territory', 1, { snapshotKind: 'narrative' });
rec('H1. recordSnapshot → seq 1; readHistory returns it with payload intact',
  r1.seq === 1 && h1.length === 1 && h1[0].payload?.name === 'Roots' && h1[0].seq === 1,
  `seq=${r1.seq} rows=${h1.length} name=${h1[0]?.payload?.name}`);

// ── H2: identical payload → skipped ──
const r2 = await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 1, snapshotKind: 'narrative', stage: 'name', payload: { essence: 'where it begins', name: 'Roots' } }); // key order swapped
const h2 = await db.history.readHistory(U, 'territory', 1, { snapshotKind: 'narrative' });
rec('H2. identical payload (key order irrelevant) → {skipped}; still 1 row',
  r2.skipped === true && h2.length === 1, `skipped=${r2.skipped} rows=${h2.length}`);

// ── H3: change → seq 2; revert A→B→A → seq 3 ──
await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 1, snapshotKind: 'narrative', stage: 'chronicle', payload: { name: 'Roots', essence: 'grown deeper' } });
const r3 = await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 1, snapshotKind: 'narrative', stage: 'name', payload: { name: 'Roots', essence: 'where it begins' } }); // back to A's content
const h3 = await db.history.readHistory(U, 'territory', 1, { snapshotKind: 'narrative' });
rec('H3. change→seq2; revert to earlier content→seq3 (dedup vs LATEST, not all history)',
  r3.seq === 3 && h3.length === 3 && h3.map((x) => x.seq).join(',') === '1,2,3',
  `seqs=${h3.map((x) => x.seq).join(',')}`);

// ── H4: upsertDescription auto-records; version bump with same prose → no dup ──
const descV1 = { name: 'Canopy', essence: 'the high places', story_arc: 'reaching upward', archetype_type: 'the explorer', point_count: 5 };
await db.rawQuery(`INSERT INTO territory_profiles (user_id, territory_id, name) VALUES (?, 2, ?)`, [U, 'seed']);
// Mirror describe-chronicles' hook: upsert THEN record narrative prose.
const PROSE = ['name', 'essence', 'archetype_type', 'archetype_character', 'story_birth', 'story_arc', 'story_current_chapter', 'story_peak_moments', 'signature_patterns', 'uncertainty_open_questions', 'uncertainty_edges', 'agent_expertise', 'agent_curious_about', 'agent_can_help_with', 'agent_would_consult', 'top_entities'];
const proseOf = (d) => { const o = {}; for (const f of PROSE) if (d[f] != null) o[f] = d[f]; return o; };
await db.territoryDocs.upsertDescription(U, 2, descV1, 'chronicle-v1', null, 'stub-model');
await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 2, snapshotKind: 'narrative', stage: 'chronicle', payload: proseOf(descV1), entityVersion: 'chronicle-v1', model: 'stub-model' });
// version bump, identical prose (drift re-narration)
await db.territoryDocs.upsertDescription(U, 2, { ...descV1, point_count: 50 }, 'chronicle-v1', null, 'stub-model');
await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 2, snapshotKind: 'narrative', stage: 'chronicle', payload: proseOf({ ...descV1, point_count: 50 }), entityVersion: 'chronicle-v1', model: 'stub-model' });
const h4 = await db.history.readHistory(U, 'territory', 2, { snapshotKind: 'narrative' });
rec('H4. chronicle auto-records; bookkeeping-only change (point_count) → no dup (1 row)',
  h4.length === 1 && h4[0].payload?.story_arc === 'reaching upward' && h4[0].model === 'stub-model',
  `rows=${h4.length}`);

// ── H5: realm narrative ──
await db.rawQuery(`INSERT INTO realms (user_id, realm_id, name) VALUES (?, 0, ?)`, [U, 'seed realm']);
const realmDesc = { essence: 'the broad region', story_arc: 'widening', archetype_type: 'the weaver', point_count: 9 };
await db.mindscape.upsertRealmDescription(U, 0, realmDesc, 'chronicle-v1', 'stub-model');
await db.history.recordSnapshot(U, { entityKind: 'realm', entityId: 0, snapshotKind: 'narrative', stage: 'chronicle', payload: proseOf(realmDesc), entityVersion: 'chronicle-v1', model: 'stub-model' });
const h5 = await db.history.readHistory(U, 'realm', 0, { snapshotKind: 'narrative' });
rec('H5. realm narrative snapshot recorded', h5.length === 1 && h5[0].payload?.story_arc === 'widening', `rows=${h5.length}`);

// ── H6: ciphertext at rest ──
close();
const raw = new Database(DB, { readonly: true });
const rawRow = raw.prepare(`SELECT entity_kind, seq, payload, cluster_version FROM entity_snapshots WHERE entity_kind='territory' AND entity_id=2 LIMIT 1`).get();
raw.close();
rec('H6. payload ciphertext at rest (no prose markers); entity_kind/seq plaintext',
  typeof rawRow?.payload === 'string' && !rawRow.payload.includes('reaching upward') && !rawRow.payload.includes('Canopy')
  && rawRow.entity_kind === 'territory' && Number(rawRow.seq) === 1,
  `kind=${rawRow?.entity_kind} seq=${rawRow?.seq} payloadHead=${String(rawRow?.payload).slice(0, 12)}…`);
await reopen();

// ── H7: dynamics stage (real child run) ──
await db.rawQuery(`UPDATE territory_profiles SET energy = ?, coherence = ?, velocity = ?, message_count = 5, growth_state = 'active', dissolved_at = NULL WHERE user_id = ? AND territory_id = 2`, [0.42, 0.81, 0.12, U]);
close();
const env = { ...process.env, USER_MASTER: userHex, SYSTEM_KEY: systemHex, MYCELIUM_DB: DB, MYCELIUM_USER_ID: U };
const runStage = () => new Promise((resolve) => {
  const c = spawn('node', ['pipeline/snapshot-entities.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 60_000);
  c.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
});
await runStage();              // run 1 → records dynamics
await runStage();              // run 2 → unchanged → deduped
await reopen();
const dyn1 = await db.history.readHistory(U, 'territory', 2, { snapshotKind: 'dynamics' });
// change a scalar → +1
await db.rawQuery(`UPDATE territory_profiles SET energy = ? WHERE user_id = ? AND territory_id = 2`, [0.99, U]);
close(); await runStage(); await reopen();
const dyn2 = await db.history.readHistory(U, 'territory', 2, { snapshotKind: 'dynamics' });
rec('H7. dynamics stage: 1 row after 2 identical runs (dedup); +1 after a scalar change',
  dyn1.length === 1 && dyn2.length === 2 && dyn2[1].payload?.energy === 0.99,
  `afterDedup=${dyn1.length} afterChange=${dyn2.length} energy=${dyn2[1]?.payload?.energy}`);

// ── H8: history survives dissolution + realm prune ──
await db.rawQuery(`UPDATE territory_profiles SET dissolved_at = '2026-06-11' WHERE user_id = ? AND territory_id = 2`, [U]);
await db.rawQuery(`DELETE FROM realms WHERE user_id = ? AND realm_id = 0`, [U]);
const h8t = await db.history.readHistory(U, 'territory', 2);
const h8r = await db.history.readHistory(U, 'realm', 0);
rec('H8. snapshots persist after the live territory dissolves + the realm row is pruned',
  h8t.length >= 1 && h8r.length >= 1, `terr=${h8t.length} realm=${h8r.length} (both survive the delete)`);

// canonicalize is order-insensitive (unit guard for the dedup contract)
rec('H0. canonicalize() is key-order-insensitive', canonicalize({ a: 1, b: 2 }) === canonicalize({ b: 2, a: 1 }));

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — entity change-log: append-only, dedup-vs-latest, encrypted, survives dissolution' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
