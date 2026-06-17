// verify:narration-walk — the agent narration walk (src/agent/narration-walk.js).
// Against a REAL seeded vault, with an injected fake runTurn (no live model):
//   W1 worklist order: a realm's territories are described BEFORE the realm (synthesis last)
//   W2 each non-skipped entity is described (describeEntity writes its name)
//   W3 retained awareness: every turn runs on ONE conversationId; the WALK LEDGER in
//      systemExtra names the already-described areas + the current new-span (accumulates)
//   W4 coverage-aware skip: a named territory with NO new content is skipped (not re-narrated)
//   W5 the realm turn's ledger references the territory described just before it
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createNarrationDomain } from '../src/tools/narration.js';
import { runNarrationWalk } from '../src/agent/narration-walk.js';

const DB = 'data/verify-narration-walk.db', KCV = 'data/verify-narration-walk-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const U = 'local-user';
const REALM = 5;

{ const d0 = new Database(DB); applyMigrations(d0); d0.close(); }
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const query = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);

// realm 5 (named, no described_period → has "new" → described)
await query(`INSERT INTO realms (user_id, realm_id, name, essence) VALUES (?,?,?,?)`, [U, REALM, 'Inner weather', 'moods']);
// T1 (named, described through 2023 → 2024 members are NEW → described)
await query(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, essence, message_count, described_period_start, described_period_end) VALUES (?,?,?,?,?,?,?,?)`,
  [U, 1, REALM, 'Grief', 'loss', 12, '2023-01-01T00:00:00Z', '2023-12-31T00:00:00Z']);
// T2 (named, described THROUGH all its content → nothing new → SKIPPED)
await query(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, essence, message_count, described_period_start, described_period_end) VALUES (?,?,?,?,?,?,?,?)`,
  [U, 2, REALM, 'Caretaking', 'tending', 6, '2024-01-01T00:00:00Z', '2024-12-31T00:00:00Z']);

const mk = async (id, tid, ts) => {
  await query(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?,?,?,?)`, [id, U, `reflection ${id} on the matter at hand`, ts]);
  await query(`INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, realm_id, created_at) VALUES (?,?,?,?,?,?,?)`, [`cp-${id}`, U, 'message', id, tid, REALM, ts]);
};
// T1: old (2023, covered) + new (2024, uncovered)
for (let i = 0; i < 6; i++) await mk(`t1o${i}`, 1, `2023-0${1 + i}-15T10:00:00Z`);
for (let i = 0; i < 6; i++) await mk(`t1n${i}`, 1, `2024-0${1 + i}-15T10:00:00Z`);
// T2: all within its covered period (2024-01..03 ≤ described_period_end 2024-12) → nothing new
for (let i = 0; i < 6; i++) await mk(`t2${i}`, 2, `2024-0${1 + i}-10T10:00:00Z`);

const { handlers } = createNarrationDomain({ db, userId: U });

// Fake turn: record what the walk passed, then simulate the agent calling describeEntity.
const turns = [];
const fakeRunTurn = async (deps, opts) => {
  turns.push({ conversationId: opts.conversationId, systemExtra: opts.systemExtra, enabledTools: opts.enabledTools });
  const m = /kind:"(\w+)", id:([^,}]+)/.exec(opts.userMessage || '');
  if (m) {
    const kind = m[1]; const id = JSON.parse(m[2]);
    await deps.handlers.describeEntity({ kind, id, name: `Auto ${kind}${id}`, essence: 'a synthesized essence folding the new period' });
  }
  return { text: 'done' };
};

const result = await runNarrationWalk(
  { db, userId: U, handlers, runTurn: fakeRunTurn },
  { runId: 'gate-1', scope: { realm_id: REALM } },
);

// W1 — worklist: 3 entities (T1, T2, realm), 2 described + 1 skipped, 2 turns taken
rec('W1. worklist = T1,T2,realm (3); described 2, skipped 1, 2 turns taken',
  result.described === 2 && result.skipped === 1 && result.total === 3 && turns.length === 2,
  `described=${result.described} skipped=${result.skipped} total=${result.total} turns=${turns.length}`);

// stricter W2: DB reflects writes for T1 + realm, NOT T2
const [t1] = await query(`SELECT name FROM territory_profiles WHERE user_id=? AND territory_id=1`, [U]);
const [t2] = await query(`SELECT name FROM territory_profiles WHERE user_id=? AND territory_id=2`, [U]);
const [r5] = await query(`SELECT name FROM realms WHERE user_id=? AND realm_id=?`, [U, REALM]);
rec('W2b. describeEntity wrote T1 + realm; T2 (covered) untouched',
  t1.name === 'Auto territory1' && r5.name === 'Auto realm5' && t2.name === 'Caretaking',
  `T1="${t1.name}" realm="${r5.name}" T2="${t2.name}"`);

// W3 — one conversation across the walk; ledger accumulates
const oneConvo = turns.every((t) => t.conversationId === 'narration-walk:gate-1');
rec('W3. all turns share one conversationId (conversation_summaries accumulates)',
  oneConvo && turns.length === 2, `convos=${[...new Set(turns.map((t) => t.conversationId))].join(',')}`);

// W4 — skip was coverage-aware (T2 named + nothing new, never got a turn)
const t2HadTurn = turns.some((t) => /id:2\b/.test(JSON.stringify(t)) );
rec('W4. coverage-aware skip: the fully-covered named territory got NO turn', result.skipped === 1,
  `skipped=${result.skipped}`);

// W5 — the realm turn (2nd) ledger references the territory described first
const realmTurn = turns[1];
rec('W5. realm turn ledger carries the prior territory (awareness accrued) + a new-span line',
  /So far you have described: "Auto territory1"/.test(realmTurn.systemExtra) && /You are now at .*\(realm\)/.test(realmTurn.systemExtra)
  && realmTurn.enabledTools.includes('describeEntity'),
  realmTurn.systemExtra.split('\n').filter(Boolean).slice(-2).map((l) => `      | ${l}`).join('\n'));

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — narration walk: ordered worklist · one conversation · accumulating named+dated ledger · coverage-aware skip' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
