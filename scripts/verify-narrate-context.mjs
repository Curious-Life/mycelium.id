// verify:narrate-context — the narration Context Capsule (pipeline/lib/narrate-context.js).
// Proves, against a REAL seeded vault (boot + adapter), that a narration is handed:
//   C1 covered span (prior description's basis) vs. NEW span (this pass), from the seen ledger
//   C2 the stored described_period_* takes precedence over the ledger-derived covered span
//   C3 a month activity histogram + sparkline across the WHOLE timeline
//   C4 connected-BY-NAME neighbours via centroid cosine — present even with EMPTY cofire tables
//   C5 parent realm name + lineage ("descended from") by name
//   C6 the rendered prompt block carries all of the above (the strings the model sees)
//   C7 described_period_* columns exist (migration 0021) and round-trip persist
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { loadMembers, getSeenIds, recordSeen } from '../pipeline/lib/narrate-sample.js';
import { buildContextCapsule, renderCapsule } from '../pipeline/lib/narrate-context.js';

const DB = 'data/verify-narrate-context.db', KCV = 'data/verify-narrate-context-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const U = 'local-user';
const T = 1, REALM = 5;

{ const d0 = new Database(DB); applyMigrations(d0); d0.close(); }
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const query = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);

// ── Seed ──────────────────────────────────────────────────────────────────────
// Realm 5 "Inner weather" (parent of T1).
await query(`INSERT INTO realms (user_id, realm_id, name, essence) VALUES (?,?,?,?)`,
  [U, REALM, 'Inner weather', 'the shifting moods of an inner life']);
// T1 "Grief & repair" — seed centroid so it has semantic neighbours.
const vec = (a) => JSON.stringify(a);
await query(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, essence, message_count, centroid_256) VALUES (?,?,?,?,?,?,?)`,
  [U, T, REALM, 'Grief & repair', 'where loss is metabolized into care', 18, vec([1, 0, 0, 0])]);
// Two semantic neighbours (near centroid), non-catchall, with points.
await query(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, essence, message_count, centroid_256) VALUES (?,?,?,?,?,?,?)`,
  [U, 2, REALM, 'Caretaking', 'tending to others', 15, vec([0.95, 0.05, 0, 0])]);
await query(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, essence, message_count, centroid_256) VALUES (?,?,?,?,?,?,?)`,
  [U, 3, REALM, 'Endings', 'how things conclude', 12, vec([0.9, 0.1, 0, 0])]);
// Dissolved ancestor "Loss" + lineage T9 → T1 (descended-from by name).
await query(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, message_count, dissolved_at) VALUES (?,?,?,?,?,?)`,
  [U, 9, REALM, 'Loss', 8, '2024-01-01T00:00:00Z']);
await query(`INSERT INTO territory_lineage (id, user_id, old_territory_id, new_territory_id, message_count, transfer_strength, is_dominant, cluster_version, recorded_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
  [`lin-9-1`, U, 9, T, 8, 0.8, 1, 'v2']);

// T1 members: OLD band (2023, will be marked SEEN) + NEW band (2024, unseen).
const mk = async (id, ts) => {
  await query(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?,?,?,?)`,
    [id, U, `a reflection ${id} about loss and care and repair`, ts]);
  await query(`INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, realm_id, created_at) VALUES (?,?,?,?,?,?,?)`,
    [`cp-${id}`, U, 'message', id, T, REALM, ts]);
};
const oldIds = [];
for (let i = 0; i < 10; i++) { const id = `old${i}`; await mk(id, `2023-0${1 + (i % 9)}-15T10:00:00Z`); oldIds.push(`old${i}`); }
for (let i = 0; i < 8; i++) { const id = `new${i}`; await mk(id, `2024-0${1 + (i % 8)}-15T10:00:00Z`); }
// Neighbours need no points — getOrphanGaps ranks by centroid cosine + the
// (plaintext) territory_profiles.message_count, both already seeded above.

// Mark the OLD band as already-seen → it becomes the "prior covered" span.
await recordSeen(query, U, T, oldIds, 1);

const members = await loadMembers(query, U, 'territory_id', T);
const seenIds = await getSeenIds(query, U, T);

// ── Capsule (ledger-derived covered span; no stored described_period yet) ──
const stored0 = (await query(`SELECT name, essence, described_period_start, described_period_end FROM territory_profiles WHERE user_id=? AND territory_id=?`, [U, T]))[0];
const cap = await buildContextCapsule({ query, db, userId: U, kind: 'territory', id: T, members, seenIds, stored: stored0 });

// C1 — covered = old band (2023), new = new band (2024)
rec('C1. covered span = prior (2023) · new span = this pass (2024), from the seen ledger',
  cap.temporal.coveredRange?.start?.startsWith('2023') && cap.temporal.coveredRange?.end?.startsWith('2023')
  && cap.temporal.newRange?.start?.startsWith('2024') && cap.temporal.newRange?.points === 8,
  `covered=${cap.temporal.coveredRange?.start?.slice(0,7)}..${cap.temporal.coveredRange?.end?.slice(0,7)} new=${cap.temporal.newRange?.start?.slice(0,7)}..${cap.temporal.newRange?.end?.slice(0,7)}(${cap.temporal.newRange?.points}) explored=${cap.temporal.exploredPercent}%`);

// C3 — activity histogram + sparkline
const months = new Set(cap.activity.histogram.map((h) => h.period));
rec('C3. month activity histogram across the whole timeline + non-empty sparkline',
  cap.activity.histogram.length >= 10 && months.has('2023-01') && months.has('2024-08') && cap.activity.sparkline.length === cap.activity.histogram.length && cap.activity.sparkline.length > 0,
  `buckets=${cap.activity.histogram.length} spark="${cap.activity.sparkline}" peak=${cap.activity.peak}`);

// C4 — connected BY NAME via centroid cosine, with cofire tables EMPTY
const nm = (cap.neighbourhood.nearest || []).map((x) => x.name);
rec('C4. nearest-by-meaning resolves NAMES with EMPTY cofire tables (degrades to centroid cosine)',
  nm.includes('Caretaking') && nm.includes('Endings') && (cap.neighbourhood.cofiring || []).length === 0,
  `nearest=[${nm.join(', ')}] cofiring=${(cap.neighbourhood.cofiring || []).length}`);

// C5 — parent realm + lineage by name
rec('C5. parent realm name + lineage "descended from" by name',
  cap.neighbourhood.parentRealm?.name === 'Inner weather'
  && (cap.neighbourhood.descendedFrom || []).some((x) => x.name === 'Loss'),
  `realm=${cap.neighbourhood.parentRealm?.name} descended=[${(cap.neighbourhood.descendedFrom || []).map((x) => x.name).join(', ')}]`);

// C6 — the rendered block carries it all (what the model actually sees)
const block = renderCapsule(cap);
rec('C6. rendered prompt block carries covered/new spans, sparkline, and named connections',
  /PRIOR DESCRIPTION covered 2023/.test(block) && /NOW FOLDING IN 2024/.test(block)
  && /Inner weather/.test(block) && /Caretaking/.test(block) && /Loss/.test(block)
  && new RegExp(`[${'▁▂▃▄▅▆▇█'}]`).test(block),
  block.split('\n').map((l) => `      | ${l}`).join('\n').slice(0, 600));

// C2 — stored described_period_* takes precedence over the ledger-derived covered span
await query(`UPDATE territory_profiles SET described_period_start=?, described_period_end=? WHERE user_id=? AND territory_id=?`,
  ['2020-01-01T00:00:00Z', '2020-12-31T00:00:00Z', U, T]);
const stored1 = (await query(`SELECT name, essence, described_period_start, described_period_end FROM territory_profiles WHERE user_id=? AND territory_id=?`, [U, T]))[0];
const cap2 = await buildContextCapsule({ query, db, userId: U, kind: 'territory', id: T, members, seenIds, stored: stored1 });
rec('C2. stored described_period_* is authoritative for the covered span; new = content after it',
  cap2.temporal.coveredRange?.start?.startsWith('2020') && cap2.temporal.newRange?.start && cap2.temporal.newRange.start > '2020-12-31',
  `covered=${cap2.temporal.coveredRange?.start?.slice(0,10)}..${cap2.temporal.coveredRange?.end?.slice(0,10)} new.start=${cap2.temporal.newRange?.start?.slice(0,10)} new.points=${cap2.temporal.newRange?.points}`);

// C7 — columns exist (migration 0021) + round-trip persist on realms too
await query(`UPDATE realms SET described_period_start=?, described_period_end=?, activity_timeline=? WHERE user_id=? AND realm_id=?`,
  ['2023-01-01', '2024-08-01', JSON.stringify([{ period: '2023-01', count: 3 }]), U, REALM]);
const r = (await query(`SELECT described_period_start, described_period_end, activity_timeline FROM realms WHERE user_id=? AND realm_id=?`, [U, REALM]))[0];
rec('C7. described_period_* + activity_timeline persist on territory_profiles AND realms (migration 0021)',
  r?.described_period_start === '2023-01-01' && r?.described_period_end === '2024-08-01' && /2023-01/.test(r?.activity_timeline || ''),
  `realm.described=${r?.described_period_start}..${r?.described_period_end} timeline=${r?.activity_timeline}`);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — Context Capsule: temporal coverage · activity timeline · connected-by-name (cofire-independent) · rendered + persisted' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
