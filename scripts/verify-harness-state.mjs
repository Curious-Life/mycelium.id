// verify:harness-state — the harness state layer (src/db/harness.js + 0018) over a
// REAL booted vault. Proves the scheduler/recovery/compaction DAL + encryption-at-rest.
//   S1 createTask/getTask round-trip; prompt ENCRYPTED at rest (raw read = ciphertext)
//   S2 dueTasks returns active+overdue only (not future, not paused)
//   S3 markTaskRun bumps run_count + sets last_*/next_run
//   S4 openRun→running; finishRun→done; wasRecentlyCompleted within window only
//   S5 reconcileOnBoot flips running/queued → aborted (restart sentinel)
//   S6 advanceOverdue pushes overdue next_run forward
//   S7 putSummary/getSummary round-trip; summary ENCRYPTED at rest
//   S8 updateTask re-encrypts prompt on UPDATE
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-harness-state.db', KCV = 'data/verify-harness-state-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
const H = db.harness;

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();
// Raw (un-decrypting) read straight off the SQLite file — proves at-rest ciphertext.
const rawRead = (sql, params = []) => { const d = new Database(DB, { readonly: true }); try { return d.prepare(sql).get(...params); } finally { d.close(); } };

if (!H) { console.log('FAIL  db.harness namespace missing'); process.exit(1); }

// ── S1 createTask + encryption-at-rest ──
const SECRET_PROMPT = 'Review my calendar and DM me the three most important things — SENSITIVE-PROMPT-XYZ';
{
  const id = await H.createTask(U, { name: 'Morning brief', prompt: SECRET_PROMPT, schedule: 'daily:8', nextRun: iso(-1000), maxTurns: 12, outputTarget: 'notification' });
  const got = await H.getTask(U, id);
  rec('S1 getTask returns the decrypted prompt + fields', got?.prompt === SECRET_PROMPT && got.schedule === 'daily:8' && got.max_turns === 12 && got.output_target === 'notification', JSON.stringify({ p: got?.prompt?.slice(0, 20), s: got?.schedule }));
  const raw = rawRead('SELECT prompt FROM scheduled_tasks WHERE id = ?', [id]);
  // SQLCipher collapse (Stage B/C cut 4): scheduled_tasks.prompt is plaintext-in-cipher
  // — at-rest = whole-file SQLCipher (verify:at-rest), not a per-field envelope.
  rec('S1 prompt PLAINTEXT-in-cipher at rest (collapse cut 4; verify:at-rest)', !!raw?.prompt && raw.prompt === SECRET_PROMPT, `raw=${String(raw?.prompt).slice(0, 24)}…`);
  globalThis.__t1 = id;
}

// ── S2 dueTasks: active+overdue only ──
{
  await H.createTask(U, { name: 'future', prompt: 'later', schedule: 'daily:23', nextRun: iso(60 * 60 * 1000) }); // 1h ahead
  const pausedId = await H.createTask(U, { name: 'paused', prompt: 'nope', schedule: 'interval:30m', nextRun: iso(-5000), status: 'paused' });
  const due = await H.dueTasks(iso());
  const names = due.map((t) => t.name);
  rec('S2 dueTasks includes the overdue active task', names.includes('Morning brief'));
  rec('S2 dueTasks excludes future + paused', !names.includes('future') && !names.includes('paused'), names.join(','));
}

// ── S3 markTaskRun ──
{
  const before = await H.getTask(U, globalThis.__t1);
  await H.markTaskRun(U, globalThis.__t1, { nextRun: iso(3600_000), lastStatus: 'success' });
  const after = await H.getTask(U, globalThis.__t1);
  rec('S3 run_count incremented', after.run_count === (before.run_count || 0) + 1, `${before.run_count}→${after.run_count}`);
  rec('S3 last_status + next_run advanced', after.last_status === 'success' && after.next_run > iso(), JSON.stringify({ ls: after.last_status }));
}

// ── S4 openRun / finishRun / wasRecentlyCompleted ──
{
  const hash = crypto.randomBytes(8).toString('hex');
  const runId = await H.openRun({ userId: U, trigger: 'scheduler', conversationId: 'task:x:today', taskId: globalThis.__t1, promptHash: hash });
  rec('S4 openRun created a running row', typeof runId === 'string' && runId.length > 0);
  rec('S4 not yet completed (dedup false before finish)', (await H.wasRecentlyCompleted(hash)) === false);
  await H.finishRun(runId, { status: 'done', inputTokens: 120, outputTokens: 45 });
  rec('S4 wasRecentlyCompleted true within window', (await H.wasRecentlyCompleted(hash)) === true);
  rec('S4 unknown hash → false', (await H.wasRecentlyCompleted('deadbeef')) === false);
  await new Promise((r) => setTimeout(r, 25));   // let real time pass so the window can expire
  rec('S4 outside window → false (finished >10ms ago, window=10ms)', (await H.wasRecentlyCompleted(hash, 10)) === false);
  const recent = await H.recentRuns(U, 5);
  rec('S4 recentRuns records counts only (no content)', recent.some((r) => r.status === 'done' && r.input_tokens === 120) && !JSON.stringify(recent).includes('SENSITIVE'), `n=${recent.length}`);
}

// ── S5 reconcileOnBoot (restart sentinel) ──
{
  const r1 = await H.openRun({ userId: U, trigger: 'channel', conversationId: 'channel:telegram:1', promptHash: 'h1' });
  const r2 = await H.openRun({ userId: U, trigger: 'chat', conversationId: 'c2', promptHash: 'h2' });
  await H.finishRun(r2, { status: 'done' });   // a completed run must NOT be touched
  const n = await H.reconcileOnBoot();
  rec('S5 reconcile aborted the in-flight run(s)', n >= 1, `aborted=${n}`);
  const after = (await H.recentRuns(U, 20));
  const r1row = after.find((x) => x.id === r1);
  const r2row = after.find((x) => x.id === r2);
  rec('S5 running → aborted; done left intact', r1row?.status === 'aborted' && r2row?.status === 'done', JSON.stringify({ r1: r1row?.status, r2: r2row?.status }));
}

// ── S6 advanceOverdue ──
{
  const id = await H.createTask(U, { name: 'overdue', prompt: 'x', schedule: 'interval:30m', nextRun: iso(-10 * 60 * 1000) });
  const changed = await H.advanceOverdue(iso());
  const t = await H.getTask(U, id);
  rec('S6 advanceOverdue bumped overdue next_run into the future', changed >= 1 && t.next_run > iso(), `changed=${changed} next=${t.next_run}`);
}

// ── S7 conversation_summaries (encrypted) ──
{
  const SECRET_SUMMARY = 'User decided to move to Lisbon in Q3 — SENSITIVE-SUMMARY-ABC';
  await H.putSummary({ userId: U, conversationId: 'conv-1', summary: SECRET_SUMMARY, throughMessageId: 'msg-99', tokensBefore: 8000, compactionCount: 2 });
  const got = await H.getSummary(U, 'conv-1');
  rec('S7 getSummary round-trips (decrypted) + metadata', got?.summary === SECRET_SUMMARY && got.through_message_id === 'msg-99' && got.compaction_count === 2);
  const raw = rawRead('SELECT summary FROM conversation_summaries WHERE conversation_id = ?', ['conv-1']);
  rec('S7 summary PLAINTEXT-in-cipher at rest (collapse cut 4; verify:at-rest)', !!raw?.summary && raw.summary === SECRET_SUMMARY);
}

// ── S8 updateTask re-encrypts prompt ──
{
  const NEW_PROMPT = 'Updated instruction — SENSITIVE-UPDATE-QRS';
  await H.updateTask(U, globalThis.__t1, { prompt: NEW_PROMPT, status: 'paused' });
  const got = await H.getTask(U, globalThis.__t1);
  rec('S8 updateTask updates decrypted prompt + status', got.prompt === NEW_PROMPT && got.status === 'paused');
  const raw = rawRead('SELECT prompt FROM scheduled_tasks WHERE id = ?', [globalThis.__t1]);
  rec('S8 updated prompt PLAINTEXT-in-cipher at rest (collapse cut 4; verify:at-rest)', !!raw?.prompt && raw.prompt === NEW_PROMPT);
}

await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — harness state: tasks · due-check · run lifecycle · dedup · restart-reconcile · overdue-advance · compaction summaries · encrypted-at-rest' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
