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

// Fake turn: record what the walk passed. The agent WRITES for a territory (new
// content worth folding) but REFLECTS for the realm (returns no toolsUsed → the
// walk must count it as reflected, not described, and the realm name must NOT change).
const turns = [];
const fakeRunTurn = async (deps, opts) => {
  turns.push({ conversationId: opts.conversationId, systemExtra: opts.systemExtra, enabledTools: opts.enabledTools });
  const m = /kind:"(\w+)", id:([^,}]+)/.exec(opts.userMessage || '');
  if (m && m[1] === 'territory') {
    const id = JSON.parse(m[2]);
    await deps.handlers.describeEntity({ kind: 'territory', id, name: `Auto territory${id}`, essence: 'a synthesized essence folding the new period' });
    return { text: 'done', toolsUsed: ['describeEntity'] };
  }
  return { text: 'Nothing new changes the picture; leaving it unchanged.' }; // reflected (realm)
};

const result = await runNarrationWalk(
  { db, userId: U, handlers, runTurn: fakeRunTurn },
  { runId: 'gate-1', scope: { realm_id: REALM } },
);

// W1 — worklist: 3 entities (T1, T2, realm); T1 written, realm reflected, T2 skipped
rec('W1. worklist=3 → described 1 (T1), reflected 1 (realm), skipped 1 (T2); 2 turns taken',
  result.described === 1 && result.reflected === 1 && result.skipped === 1 && result.total === 3 && turns.length === 2,
  `described=${result.described} reflected=${result.reflected} skipped=${result.skipped} total=${result.total} turns=${turns.length}`);

// W2 — DB: T1 written; realm UNCHANGED (agent reflected, didn't rewrite); T2 untouched
const [t1] = await query(`SELECT name FROM territory_profiles WHERE user_id=? AND territory_id=1`, [U]);
const [t2] = await query(`SELECT name FROM territory_profiles WHERE user_id=? AND territory_id=2`, [U]);
const [r5] = await query(`SELECT name FROM realms WHERE user_id=? AND realm_id=?`, [U, REALM]);
rec('W2. T1 written; realm left unchanged (reflected, not rewritten); T2 (covered) untouched',
  t1.name === 'Auto territory1' && r5.name === 'Inner weather' && t2.name === 'Caretaking',
  `T1="${t1.name}" realm="${r5.name}" T2="${t2.name}"`);

// W3 — one conversation across the walk; ledger accumulates
const oneConvo = turns.every((t) => t.conversationId === 'narration-walk:gate-1');
rec('W3. all turns share one conversationId (conversation_summaries accumulates)',
  oneConvo && turns.length === 2, `convos=${[...new Set(turns.map((t) => t.conversationId))].join(',')}`);

// W4 — skip was coverage-aware (T2 named + nothing new, never got a turn)
rec('W4. coverage-aware skip: the fully-covered named territory got NO turn', result.skipped === 1,
  `skipped=${result.skipped}`);

// W5 — the realm turn (2nd) ledger references the territory described first
const realmTurn = turns[1];
rec('W5. realm turn ledger carries the prior territory (awareness accrued) + a new-span line',
  /So far you have described: "Auto territory1"/.test(realmTurn.systemExtra) && /You are now at .*\(realm\)/.test(realmTurn.systemExtra)
  && realmTurn.enabledTools.includes('describeEntity'),
  realmTurn.systemExtra.split('\n').filter(Boolean).slice(-2).map((l) => `      | ${l}`).join('\n'));



// ── W7-W10 run against their OWN realm ──────────────────────────────────────
// ⚠️ W1-W6 EXHAUST realm 5 — covering every entity is precisely what they assert — so re-using
// it here gives the walk an empty worklist and nothing to classify. That went unnoticed because
// these checks were sitting AFTER close()+rmSync and running against a CLOSED, DELETED database:
// buildWorklist hardcodes {kind:'realm', id:scope.realm_id} (needs no DB) and every read is
// `.catch(() => [])`, so a dead vault looks like an empty one and the gates "passed" on nothing.
// I then explained the symptom with an invented fixture story and wrote it into a comment as
// fact. Both were wrong; the second was worse (independent review, 2026-07-16).
// ⚠️ ONE FRESH REALM PER CHECK — order-independent by construction. These walks MUTATE the
// vault (W10 writes a description), so sharing a realm means each block covers it for the next
// and the later ones get an empty worklist with nothing to classify. That is not hypothetical:
// it is what W7/W8 did, and it went unnoticed because they were running AFTER close()+rmSync
// against a CLOSED, DELETED database — buildWorklist hardcodes {kind:'realm', id} (needs no DB)
// and every read is `.catch(() => [])`, so a dead vault is indistinguishable from an empty one
// and they "passed" on nothing at all. I then explained the symptom with an INVENTED fixture
// story and wrote it into a comment as fact (independent review, 2026-07-16).
//
// The worklist comes from clustering_points, NOT territory_profiles (territoriesOf) — a
// territory row with no members is invisible to the walk. Seeded via the same shape the fixture
// above uses, and NOTHING is error-swallowed: a first draft `.catch(() => {})`'d the message
// insert, which is the same silent-swallow that produced the dead-DB pass.
let _realmSeq = 6;
async function seedRealm() {
  const rid = _realmSeq++;
  const tid = rid * 10;
  await query(`INSERT INTO realms (user_id, realm_id, name, essence) VALUES (?,?,?,?)`, [U, rid, `Realm ${rid}`, 'moods']);
  await query(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, essence, message_count, described_period_start, described_period_end) VALUES (?,?,?,?,?,?,?,?)`,
    [U, tid, rid, `Untold ${rid}`, 'unnarrated', 6, null, null]);
  for (let i = 0; i < 6; i++) {
    const id = `m-${rid}-${i}`;
    await query(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?,?,?,?)`, [id, U, `reflection ${id} on the matter at hand`, `2024-0${1 + i}-15T10:00:00Z`]);
    await query(`INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, realm_id, created_at) VALUES (?,?,?,?,?,?,?)`, [`cp-${id}`, U, 'message', id, tid, rid, `2024-0${1 + i}-15T10:00:00Z`]);
  }
  return rid;
}

// ── W9/W10 ⭐ A PARTIAL TURN IS NOT A FAILURE ────────────────────────────────
// loop.js DELIBERATELY keeps text that streamed before an error ("Once any text streams, keep
// it — no retry"), so a mid-stream ECONNRESET returns a REAL answer alongside `lastErr`. A
// first draft of the classifier tested lastErr FIRST and called both of these failures — the
// MIRROR of the bug it fixes: a flaky wire made a walk that narrated everything report `error`
// and withhold the checkpoint, so the resume re-did finished work (independent review,
// 2026-07-16).
{
  const flakyReflect = async () => ({ text: 'This region is about grief and rebuilding.', toolsUsed: [], lastErr: 'socket hang up' });
  const r = await runNarrationWalk(
    { db, userId: U, handlers, runTurn: flakyReflect },
    { runId: 'gate-flaky-1', scope: { realm_id: await seedRealm() } },
  );
  rec('W9. text streamed THEN the wire died ⇒ reflected, NOT failed (loop.js kept the answer on purpose)',
    r.reflected > 0 && r.failed === 0,
    `reflected=${r.reflected} failed=${r.failed} — lastErr must not override what the turn PRODUCED`);
}
{
  // The worse half: the write ALREADY COMMITTED, then the wire died.
  // Write for WHATEVER entity the walk hands us — the walk decides the order, and this check is
  // about the CLASSIFIER, not about which entity comes first.
  const flakyWrite = async (deps, opts) => {
    const m = /kind:"(\w+)", id:([^,}]+)/.exec(opts.userMessage || '');
    if (!m) return { text: 'no target', toolsUsed: [] };
    await deps.handlers.describeEntity({ kind: m[1], id: JSON.parse(m[2]), name: 'Flaky-written', essence: 'written before the wire died' });
    return { text: '', toolsUsed: ['describeEntity'], lastErr: 'socket hang up' };
  };
  const r = await runNarrationWalk(
    { db, userId: U, handlers, runTurn: flakyWrite },
    { runId: 'gate-flaky-2', scope: { realm_id: await seedRealm() } },
  );
  // "described" here means the WALK counted it described — the handler's own success is
  // W2's job, not this one's. (An earlier version claimed "the work landed"; against the
  // closed DB describeEntity had actually returned a failure string. Say what you check.)
  rec('W10. describeEntity was CALLED then the wire died ⇒ described, NOT failed',
    r.described > 0 && r.failed === 0,
    `described=${r.described} failed=${r.failed} — counting this failed would re-narrate finished work on resume`);
}

// ── W7 ⭐ A TURN THAT PRODUCED NOTHING IS NOT A REFLECTION ────────────────────
// `if (wrote) described++; else reflected++` could not tell "the agent read this and chose not
// to rewrite" (real, valuable) from "the turn never happened" — so a walk in which NOTHING ran
// reported SUCCESS. loop.run NEVER THROWS: a dead Ollama is swallowed into `lastErr` and it
// returns `{text:''}`, which sailed straight into `reflected`. An approved-but-unreachable model
// is the NORMAL state of a fresh box, and it survived three §4g review rounds because every
// loop double answered (independent review, 2026-07-16).
{
  // Every turn fails, exactly as the real loop reports it.
  const deadTurns = [];
  const deadRunTurn = async (deps, opts) => {
    deadTurns.push(opts.userMessage);
    return { text: '', toolsUsed: [], lastErr: 'harness: Ollama unreachable at http://127.0.0.1:11434/api/chat' };
  };
  const r = await runNarrationWalk(
    { db, userId: U, handlers, runTurn: deadRunTurn },
    { runId: 'gate-dead', scope: { realm_id: await seedRealm() } },
  );
  // The INVARIANT, not a magic number: assert the RELATIONSHIP (every turn that ran, failed;
  // none counted as a reflection), which holds whatever the worklist size turns out to be.
  // `turns > 0` is load-bearing — without it this passes on an empty worklist, which is exactly
  // how it passed against a closed database.
  rec('W7. ⭐ every turn fails ⇒ failed === turns taken, reflected=0 — a dead wire is NOT a reflection',
    deadTurns.length > 0 && r.failed === deadTurns.length && r.reflected === 0 && r.described === 0,
    `described=${r.described} reflected=${r.reflected} failed=${r.failed} skipped=${r.skipped} turns=${deadTurns.length}`);
  rec('W7b. …and the reason rides the ledger (not just a count)',
    r.ledger.some((l) => l.failed === 'turn-failed'),
    JSON.stringify(r.ledger.map((l) => l.failed ?? l.changed)));
  // A turn that never ran must NOT be checkpointed, or the resume (jobs.js done_ids) records it
  // as handled and the retry skips it forever.
  // A turn that never ran must NOT be checkpointed: jobs.js persists doneKeys as done_ids, so
  // a resume would record it as handled and skip it forever.
  rec('W7c. a failed entity is NOT checkpointed — the retry must see it again',
    !r.doneKeys.some((k) => /realm/.test(k)),
    `doneKeys=${JSON.stringify(r.doneKeys)}`);
}

// W8 — a REFLECTION still counts as one: the agent answered and chose not to rewrite.
{
  const reflectRunTurn = async () => ({ text: 'Nothing new changes the picture; leaving it unchanged.', toolsUsed: [] });
  const r = await runNarrationWalk(
    { db, userId: U, handlers, runTurn: reflectRunTurn },
    { runId: 'gate-reflect', scope: { realm_id: await seedRealm() } },
  );
  rec('W8. a real reflection (text, no write) still counts as reflected — not failed',
    r.reflected > 0 && r.failed === 0,
    `reflected=${r.reflected} failed=${r.failed}`);
}

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — narration walk: ordered worklist · one conversation · accumulating named+dated ledger · coverage-aware skip' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
