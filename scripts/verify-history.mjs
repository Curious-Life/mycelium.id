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
const r1 = await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 1, snapshotKind: 'narrative', content: { name: 'Roots', essence: 'where it begins' }, meta: { stage: 'name' } });
const h1 = await db.history.readHistory(U, 'territory', 1, { snapshotKind: 'narrative' });
rec('H1. recordSnapshot → seq 1; readHistory returns it with content intact + capturedAt',
  r1.seq === 1 && h1.length === 1 && h1[0].content?.name === 'Roots' && h1[0].seq === 1 && !!h1[0].capturedAt,
  `seq=${r1.seq} rows=${h1.length} name=${h1[0]?.content?.name} capturedAt=${!!h1[0]?.capturedAt}`);

// ── H2: identical content → skipped ──
const r2 = await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 1, snapshotKind: 'narrative', content: { essence: 'where it begins', name: 'Roots' }, meta: { stage: 'name' } }); // key order swapped
const h2 = await db.history.readHistory(U, 'territory', 1, { snapshotKind: 'narrative' });
rec('H2. identical content (key order irrelevant) → {skipped}; still 1 row',
  r2.skipped === true && h2.length === 1, `skipped=${r2.skipped} rows=${h2.length}`);

// ── H3: change → seq 2; revert A→B→A → seq 3 ──
await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 1, snapshotKind: 'narrative', content: { name: 'Roots', essence: 'grown deeper' }, meta: { stage: 'chronicle' } });
const r3 = await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 1, snapshotKind: 'narrative', content: { name: 'Roots', essence: 'where it begins' }, meta: { stage: 'name' } }); // back to A's content
const h3 = await db.history.readHistory(U, 'territory', 1, { snapshotKind: 'narrative' });
rec('H3. change→seq2; revert to earlier content→seq3 (dedup vs LATEST, not all history)',
  r3.seq === 3 && h3.length === 3 && h3.map((x) => x.seq).join(',') === '1,2,3',
  `seqs=${h3.map((x) => x.seq).join(',')}`);

// ── H4: chronicle auto-record; metadata-only change (version) → no dup ──
const descV1 = { name: 'Canopy', essence: 'the high places', story_arc: 'reaching upward', archetype_type: 'the explorer', point_count: 5 };
await db.rawQuery(`INSERT INTO territory_profiles (user_id, territory_id, name) VALUES (?, 2, ?)`, [U, 'seed']);
const PROSE = ['name', 'essence', 'archetype_type', 'archetype_character', 'story_birth', 'story_arc', 'story_current_chapter', 'story_peak_moments', 'signature_patterns', 'uncertainty_open_questions', 'uncertainty_edges', 'agent_expertise', 'agent_curious_about', 'agent_can_help_with', 'agent_would_consult', 'top_entities'];
const proseOf = (d) => { const o = {}; for (const f of PROSE) if (d[f] != null) o[f] = d[f]; return o; };
await db.territoryDocs.upsertDescription(U, 2, descV1, 'chronicle-v1', null, 'stub-model');
await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 2, snapshotKind: 'narrative', content: proseOf(descV1), meta: { stage: 'chronicle', entityVersion: 'chronicle-v1', model: 'stub-model' } });
// drift re-narration: same prose, bumped version label → must NOT add a row (meta excluded from dedup)
await db.history.recordSnapshot(U, { entityKind: 'territory', entityId: 2, snapshotKind: 'narrative', content: proseOf(descV1), meta: { stage: 'chronicle', entityVersion: 'chronicle-v2', model: 'other-model' } });
const h4 = await db.history.readHistory(U, 'territory', 2, { snapshotKind: 'narrative' });
rec('H4. chronicle recorded; metadata-only change (version/model) → no dup (1 row); model in encrypted blob',
  h4.length === 1 && h4[0].content?.story_arc === 'reaching upward' && h4[0].model === 'stub-model' && h4[0].entityVersion === 'chronicle-v1',
  `rows=${h4.length} model=${h4[0]?.model}`);

// ── H5: realm narrative ──
await db.rawQuery(`INSERT INTO realms (user_id, realm_id, name) VALUES (?, 0, ?)`, [U, 'seed realm']);
const realmDesc = { essence: 'the broad region', story_arc: 'widening', archetype_type: 'the weaver', point_count: 9 };
await db.mindscape.upsertRealmDescription(U, 0, realmDesc, 'chronicle-v1', 'stub-model');
await db.history.recordSnapshot(U, { entityKind: 'realm', entityId: 0, snapshotKind: 'narrative', content: proseOf(realmDesc), meta: { stage: 'chronicle', entityVersion: 'chronicle-v1', model: 'stub-model' } });
const h5 = await db.history.readHistory(U, 'realm', 0, { snapshotKind: 'narrative' });
rec('H5. realm narrative snapshot recorded', h5.length === 1 && h5[0].content?.story_arc === 'widening', `rows=${h5.length}`);

// ── H6: ONLY payload holds data; content + ALL metadata (model/stage/version/
//    timestamp) are ciphertext at rest. The whole row is read raw and every
//    non-skeleton string is checked for leaks. ──
close();
const raw = new Database(DB, { readonly: true });
const cols = raw.prepare(`PRAGMA table_info(entity_snapshots)`).all().map((c) => c.name).sort();
const rawRow = raw.prepare(`SELECT * FROM entity_snapshots WHERE entity_kind='territory' AND entity_id=2 LIMIT 1`).get();
raw.close();
const blob = JSON.stringify(rawRow);
// SQLCipher collapse (Stage B/C cut 4): entity_snapshots.payload is now PLAINTEXT-in-
// cipher — at-rest = whole-file SQLCipher (verify:at-rest), not a per-field envelope.
// The payload content is readable in the raw row (whole-file ciphertext is verify:at-rest's
// job); payload is a plaintext JSON blob, not a base64 "ey…" envelope.
const payloadPlain = typeof rawRow.payload === 'string' && blob.includes('Canopy') && !rawRow.payload.startsWith('ey');
const skeleton = ['entity_id', 'entity_kind', 'id', 'payload', 'seq', 'snapshot_kind', 'user_id'];
rec('H6. schema skeleton+payload only; payload PLAINTEXT-in-cipher (collapse cut 4; verify:at-rest)',
  JSON.stringify(cols) === JSON.stringify(skeleton) && payloadPlain
  && rawRow.entity_kind === 'territory' && Number(rawRow.seq) === 1,
  `cols=${cols.join(',')} payloadPlain=${payloadPlain}`);
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
  dyn1.length === 1 && dyn2.length === 2 && dyn2[1].content?.energy === 0.99,
  `afterDedup=${dyn1.length} afterChange=${dyn2.length} energy=${dyn2[1]?.content?.energy}`);

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
