#!/usr/bin/env node
// verify-enrich-backlog-parity.mjs — the activity indicator must count EXACTLY the work
// the drainer can actually do, and no row may stay pending forever.
//
// WHY THIS GATE EXISTS (found live 2026-07-15). The indicator computed
// `pending = total - embedded` where embedded = `embedding_768 IS NOT NULL`, while the
// drainer selected on `nlp_processed`. Any row TERMINAL for the drainer but without a
// vector — a blank-content skip (nlp_processed = 1) or an attempt-capped row (-1) — was
// counted pending FOREVER. That is not cosmetic:
//
//   pending > 0  →  embedBacklogCached TTL = 8s  →  a multi-second SQLCipher full-table
//   decrypt every 8s  →  and better-sqlite3 is SYNCHRONOUS, so each one blocks the whole
//   event loop.
//
// Measured on the live app in that state: GET /health — a static file, no DB, no auth —
// took 8.34s instead of 1ms, server-rest sat at 99% CPU, and enrichment made zero
// progress for 25 minutes. The progress bar was the load it was reporting on.
//
// The invariant, in one line:
//     pending(indicator) === |selectPendingEnrichment|   — in EVERY row state.
//
// Runs the REAL SQL against a REAL better-sqlite3 vault built from the REAL migrations.
// No mocks: the bug WAS the SQL, so a mock would have proved nothing and caught nothing.

import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { applyMigrations } from '../src/db/migrate.js';
import { createMessagesNamespace } from '../src/db/messages.js';
import { createEnrichmentService } from '../src/enrich/service.js';
import { EMBED_MAX_ATTEMPTS, EMBED_CAPPED_MARK, embedAttemptsOf } from '../src/enrich/service.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }

const U = 'u1';

// A real vault on the real schema, wired exactly like the app wires it.
function freshVault() {
  const raw = new Database(':memory:');
  applyMigrations(raw);
  const d1Query = async (sql, params = []) => {
    const stmt = raw.prepare(sql);
    if (/^\s*(insert|update|delete)/i.test(sql) && !/returning/i.test(sql)) {
      stmt.run(...params);
      return { results: [] };
    }
    return { results: stmt.all(...params) };
  };
  const d1Batch = async (stmts) => { for (const s of stmts) await d1Query(s.sql, s.params); return []; };
  const firstRow = (r) => (r?.results || [])[0] || null;
  const messages = createMessagesNamespace({ d1Query, d1Batch, firstRow });
  return { raw, messages, d1Query };
}

// A vault whose d1Query COUNTS the embed-backlog scans, so a test can prove whether an
// embedBacklogCached() call revalidated (issued the multi-second SQLCipher scan) or served
// a cached snapshot. Returns { raw, messages, scans:() }.
function countingVault() {
  const raw = new Database(':memory:');
  applyMigrations(raw);
  let scans = 0;
  const d1Query = async (sql, params = []) => {
    // The embed-backlog scan is the only SELECT that COUNTs total AND touches embedding_768.
    if (/COUNT\(\*\)\s+AS\s+total/i.test(sql) && /embedding_768/i.test(sql)) scans++;
    const stmt = raw.prepare(sql);
    if (/^\s*(insert|update|delete)/i.test(sql) && !/returning/i.test(sql)) { stmt.run(...params); return { results: [] }; }
    return { results: stmt.all(...params) };
  };
  const d1Batch = async (stmts) => { for (const s of stmts) await d1Query(s.sql, s.params); return []; };
  const firstRow = (r) => (r?.results || [])[0] || null;
  const messages = createMessagesNamespace({ d1Query, d1Batch, firstRow });
  return { raw, messages, scans: () => scans };
}

let seq = 0;
function addRow(raw, { content, nlp = 0, vec = null, nlpError = null, forgotten = null }) {
  const id = `m${++seq}`;
  raw.prepare(
    `INSERT INTO messages (id, user_id, role, content, nlp_processed, nlp_error, embedding_768, forgotten_at, created_at)
     VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
  ).run(id, U, content, nlp, nlpError, vec, forgotten, `2026-07-15T00:00:${String(seq % 60).padStart(2, '0')}.000Z`);
  return id;
}

// The invariant: whatever the drainer can select is exactly what the indicator reports.
async function assertParity(messages, label) {
  const { pending } = await messages.embedBacklog(U);
  // Ask for far more than exists so the LIMIT can never mask a mismatch.
  const selectable = await messages.selectPendingEnrichment(U, { limit: 10_000 });
  assert.equal(
    pending, selectable.length,
    `${label}: indicator says pending=${pending} but the drainer can select ${selectable.length}`,
  );
  return pending;
}

console.log('\nenrich backlog parity (indicator === drainer)');

await t('parity holds across EVERY nlp_processed state (0/NULL/1/2/-1 × vector/none)', async () => {
  const { raw, messages } = freshVault();
  addRow(raw, { content: 'plain pending', nlp: 0 });
  addRow(raw, { content: 'null-state pending', nlp: null });
  addRow(raw, { content: 'blank-skipped', nlp: 1, vec: null });        // terminal, NO vector
  addRow(raw, { content: 'embedded ok', nlp: 2, vec: Buffer.alloc(8) });
  addRow(raw, { content: 'poisoned', nlp: -1, vec: null });            // terminal, NO vector
  addRow(raw, { content: 'capped', nlp: -1, vec: null, nlpError: `${EMBED_CAPPED_MARK}:5` });
  addRow(raw, { content: 'forgotten', nlp: 0, forgotten: '2026-07-01' });
  const pending = await assertParity(messages, 'mixed states');
  assert.equal(pending, 2, 'only the two genuinely-drainable rows are pending');
});

await t('TEETH: the pre-fix formula (total - embedded) would FAIL this exact case', async () => {
  // This is the regression, isolated. Two rows are terminal-with-no-vector; the old
  // `total - embedded` counted BOTH as pending forever → the 8s-TTL scan loop.
  const { raw, messages } = freshVault();
  addRow(raw, { content: 'blank-skipped', nlp: 1, vec: null });
  addRow(raw, { content: 'capped', nlp: -1, vec: null, nlpError: `${EMBED_CAPPED_MARK}:5` });
  const { embedded, total, pending } = await messages.embedBacklog(U);
  const oldFormula = Math.max(0, total - embedded);
  assert.equal(oldFormula, 2, 'sanity: the OLD formula really did report a permanent floor');
  assert.equal(pending, 0, 'the drainer has nothing to do → pending MUST be 0 so the TTL can relax');
  assert.notEqual(pending, oldFormula, 'the fix must differ from the formula that caused the bug');
});

await t('`embedded` still means HAS-A-VECTOR (shouldAutoGenerate gates clustering on it)', async () => {
  // jobs.js:423 shouldAutoGenerate({embedded}) — clustering needs REAL vectors. If a
  // future "simplification" makes `embedded` mirror `pending`, clustering would fire on
  // rows that have no vector. Pin the semantics.
  const { raw, messages } = freshVault();
  addRow(raw, { content: 'has vector', nlp: 2, vec: Buffer.alloc(8) });
  addRow(raw, { content: 'terminal, no vector', nlp: 1, vec: null });
  const { embedded, pending } = await messages.embedBacklog(U);
  assert.equal(embedded, 1, 'exactly one row has a vector');
  assert.equal(pending, 0, 'and nothing is drainable');
});

console.log('\nunembeddable rows must not pin pending > 0 forever');

// A bad row among healthy siblings: the service is provably up, so this row IS at fault.
const badAmongHealthy = (badContent) => ({
  embedBatch: async (texts) => texts.map((tx) => (tx === badContent ? null : new Array(768).fill(0.1))),
  embed: async (tx) => (tx === badContent ? null : new Array(768).fill(0.1)),
});

await t('a row that is genuinely unembeddable is CAPPED and leaves the backlog', async () => {
  const { raw, messages } = freshVault();
  addRow(raw, { content: 'never embeds', nlp: 0 });
  addRow(raw, { content: 'healthy sibling', nlp: 0 });          // proves the service is up
  const svc = createEnrichmentService({ messages, embed: badAmongHealthy('never embeds'), getMasterKey: async () => 'k' });
  for (let i = 0; i < EMBED_MAX_ATTEMPTS + 2; i++) {
    await svc.drainOnce({ userId: U, attemptedThisCycle: new Set() });  // a fresh CYCLE each time
    if ((await messages.embedBacklog(U)).pending === 0) break;
  }
  const { pending } = await messages.embedBacklog(U);
  assert.equal(pending, 0, `pending must reach 0 after ${EMBED_MAX_ATTEMPTS} attempts (was: retried forever)`);
  const row = raw.prepare("SELECT nlp_processed, nlp_error FROM messages WHERE content = 'never embeds'").get();
  assert.equal(row.nlp_processed, -1, 'capped row is terminal');
  assert.match(String(row.nlp_error), new RegExp(`^${EMBED_CAPPED_MARK}:`), 'and is marked as capped');
  await assertParity(messages, 'after cap');
});

await t('REVIEW BLOCKER 1a: the budget must NOT burn inside a single cycle', async () => {
  // The drainer runs drainOnce up to 200× per cycle and only stops when a pass moves
  // nothing — healthy siblings keep it going, and the failing row (oldest → always
  // re-selected) was retried EVERY pass. Review measured 8 passes in one 15s cycle: a
  // single slow message permanently retired in seconds. One cycle must cost ONE attempt.
  const { raw, messages } = freshVault();
  addRow(raw, { content: 'never embeds', nlp: 0 });
  for (let i = 0; i < 40; i++) addRow(raw, { content: `healthy ${i}`, nlp: 0 });
  const svc = createEnrichmentService({ messages, embed: badAmongHealthy('never embeds'), getMasterKey: async () => 'k' });
  // Simulate ONE drainer cycle: the same Set across many passes, exactly as drainer.js does.
  const attemptedThisCycle = new Set();
  for (let i = 0; i < 30; i++) {
    const e = await svc.drainOnce({ userId: U, attemptedThisCycle });
    if ((e?.scanned ?? 0) === 0) break;
    if (((e?.embedded ?? 0) + (e?.failed ?? 0) + (e?.skipped ?? 0)) === 0) break;
  }
  const row = raw.prepare("SELECT nlp_processed, nlp_error FROM messages WHERE content = 'never embeds'").get();
  assert.equal(row.nlp_processed, 0, 'ONE cycle must NEVER retire a row, however many passes it runs');
  assert.equal(embedAttemptsOf(row.nlp_error), 1, `exactly ONE attempt per cycle (got ${row.nlp_error})`);
});

await t('REVIEW BLOCKER 1b: a SERVICE OUTAGE must burn no attempts (no mass data loss)', async () => {
  // If the embedder is down, NOTHING is at fault. The old cap would have marched the whole
  // backlog to terminal and erased it from search during one bad afternoon.
  const { raw, messages } = freshVault();
  for (let i = 0; i < 5; i++) addRow(raw, { content: `row ${i}`, nlp: 0 });
  const svc = createEnrichmentService({
    messages,
    embed: { embedBatch: async (texts) => texts.map(() => null), embed: async () => null }, // total outage
    getMasterKey: async () => 'k',
  });
  for (let i = 0; i < EMBED_MAX_ATTEMPTS * 3; i++) await svc.drainOnce({ userId: U, attemptedThisCycle: new Set() });
  const capped = raw.prepare(`SELECT count(*) c FROM messages WHERE nlp_error LIKE '${EMBED_CAPPED_MARK}:%'`).get().c;
  assert.equal(capped, 0, 'an outage must NEVER retire rows — they must all survive to retry');
  const { pending } = await messages.embedBacklog(U);
  assert.equal(pending, 5, 'every row stays pending through the outage');
});

await t('a LONG row gets a slow last-chance retry before it is ever retired', async () => {
  // The documented failure is a long message exceeding the 30s client abort. Capping it
  // would drop it from search forever — so it must get one genuinely longer attempt.
  const { raw, messages } = freshVault();
  addRow(raw, { content: 'slow but valid', nlp: 0 });
  addRow(raw, { content: 'healthy sibling', nlp: 0 });
  let slowCallOpts = null;
  const embed = {
    embedBatch: async (texts) => texts.map((tx) => (tx === 'slow but valid' ? null : new Array(768).fill(0.1))),
    // Only succeeds when given a longer per-call budget — i.e. the retry must really pass one.
    embed: async (tx, _task, opts) => {
      if (tx !== 'slow but valid') return new Array(768).fill(0.1);
      slowCallOpts = opts;
      return opts?.timeoutMs > 30_000 ? new Array(768).fill(0.2) : null;
    },
  };
  const svc = createEnrichmentService({ messages, embed, getMasterKey: async () => 'k' });
  for (let i = 0; i < EMBED_MAX_ATTEMPTS + 2; i++) await svc.drainOnce({ userId: U, attemptedThisCycle: new Set() });
  const row = raw.prepare("SELECT nlp_processed, embedding_768 FROM messages WHERE content = 'slow but valid'").get();
  assert.ok(slowCallOpts?.timeoutMs > 30_000, 'the last-chance retry must pass a LONGER per-call timeout');
  assert.equal(row.nlp_processed, 2, 'a slow-but-valid row must be RESCUED, never retired');
  assert.ok(row.embedding_768 != null, 'and it must end up with a vector');
});

await t('REVIEW BLOCKER 2: capping is REPORTED by drainOnce (never silent)', async () => {
  const { raw, messages } = freshVault();
  addRow(raw, { content: 'never embeds', nlp: 0 });
  addRow(raw, { content: 'healthy sibling', nlp: 0 });
  const svc = createEnrichmentService({ messages, embed: badAmongHealthy('never embeds'), getMasterKey: async () => 'k' });
  let sawCapped = 0;
  for (let i = 0; i < EMBED_MAX_ATTEMPTS + 2; i++) {
    const e = await svc.drainOnce({ userId: U, attemptedThisCycle: new Set() });
    sawCapped += e?.capped ?? 0;
  }
  assert.equal(sawCapped, 1, 'drainOnce MUST report the retired row so the drainer can log it — pending now hides it');
});

await t('a capped row is RECOVERABLE — the boot reclaim restores it', async () => {
  // Capped is set-aside, not deleted. drainer.js clears these marks once per boot.
  const { raw, messages } = freshVault();
  addRow(raw, { content: 'was capped', nlp: -1, vec: null, nlpError: `${EMBED_CAPPED_MARK}:5` });
  raw.prepare(
    "UPDATE messages SET nlp_processed = 0, nlp_error = NULL WHERE user_id = ?"
    + " AND nlp_processed = -1 AND embedding_768 IS NULL AND nlp_error LIKE 'embed-capped:%'",
  ).run(U);
  const row = raw.prepare('SELECT nlp_processed, nlp_error FROM messages').get();
  assert.equal(row.nlp_processed, 0, 'the boot reclaim must give a set-aside row a fresh chance');
  assert.equal(row.nlp_error, null, 'and reset its attempt counter');
  assert.equal((await messages.embedBacklog(U)).pending, 1, 'so it is pending again');
});

await t('a TRANSIENT outage still recovers (the cap must not poison a good row)', async () => {
  const { raw, messages } = freshVault();
  addRow(raw, { content: 'flaky then fine', nlp: 0 });
  let fail2 = 2;
  const svc = createEnrichmentService({
    messages,
    embed: {
      embedBatch: async (texts) => texts.map(() => (fail2-- > 0 ? null : new Array(768).fill(0.1))),
      embed: async () => null,
    },
    getMasterKey: async () => 'k',
  });
  for (let i = 0; i < 4; i++) await svc.drainOnce({ userId: U });
  const row = raw.prepare('SELECT nlp_processed, nlp_error, embedding_768 FROM messages').get();
  assert.equal(row.nlp_processed, 2, 'a row that recovers within the cap must embed normally');
  assert.equal(row.nlp_error, null, 'and its attempt counter must be cleared');
  assert.ok(row.embedding_768 != null, 'and it must have a vector');
});

await t('the drainer self-heal must NOT resurrect a capped row (heal→fail→heal loop)', async () => {
  const { raw } = freshVault();
  addRow(raw, { content: 'capped', nlp: -1, vec: null, nlpError: `${EMBED_CAPPED_MARK}:5` });
  addRow(raw, { content: 'genuinely transient poison', nlp: -1, vec: null, nlpError: 'some other error' });
  // The EXACT self-heal statement from src/enrich/drainer.js.
  raw.prepare(
    "UPDATE messages SET nlp_processed = 0, nlp_error = NULL WHERE user_id = ?"
    + " AND nlp_processed = -1 AND embedding_768 IS NULL"
    + " AND (nlp_error IS NULL OR nlp_error NOT LIKE 'embed-capped:%')",
  ).run(U);
  const capped = raw.prepare(`SELECT nlp_processed FROM messages WHERE nlp_error LIKE '${EMBED_CAPPED_MARK}:%'`).get();
  assert.equal(capped?.nlp_processed, -1, 'capped row must STAY terminal — else pending never settles');
  const healed = raw.prepare(`SELECT nlp_processed FROM messages WHERE id = 'm' || (SELECT max(CAST(substr(id,2) AS INT)) FROM messages)`).get();
  assert.equal(healed?.nlp_processed, 0, 'a non-capped poisoned row IS still reclaimed');
});

await t('attempt parser is content-free and total (never throws on junk)', async () => {
  assert.equal(embedAttemptsOf(null), 0);
  assert.equal(embedAttemptsOf(''), 0);
  assert.equal(embedAttemptsOf('embed-retry:3'), 3);
  assert.equal(embedAttemptsOf(`${EMBED_CAPPED_MARK}:5`), 5);
  assert.equal(embedAttemptsOf('a real error message'), 0, 'unrelated errors must not read as attempts');
});

console.log('\nembedBacklogCached SWR TTL — total:0 is TRANSIENT, not a settled backlog (QA P1-C, the SWR half)');

await t('a total:0 snapshot revalidates on the SHORT 8s TTL — an import within 60s is picked up fast, never the false-empty', async () => {
  // THE P1-C SWR HALF. readiness.warm() primes {total:0} at boot; nothing busts _backlog on import.
  // With the old TTL rule ({total:0,pending:0} → 60s), a user who imported within that minute kept
  // reading total:0, and generate.ts's 12s empty-vault clock fired the false "Import some
  // conversations first" AFTER the import populated the vault. total:0 must be SHORT-TTL so the poll
  // revalidates well inside that 12s window. Driven over a REAL vault with a mock clock.
  const { raw, messages, scans } = countingVault();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    // 1. Empty vault → cold scan caches {total:0}.
    const v0 = await messages.embedBacklogCached(U);
    assert.equal(v0.total, 0, 'a fresh vault reads total:0');
    assert.equal(scans(), 1, 'the cold read scanned once');

    // 2. The import lands AFTER the total:0 snapshot was cached (rows now exist).
    for (let i = 0; i < 500; i++) addRow(raw, { content: `imported ${i}`, nlp: 0 });

    // 3. 9s later — PAST the 8s short TTL, WELL WITHIN the old 60s long TTL. With the fix this poll
    //    MUST revalidate (serve stale now, fresh next); with the old rule it would not scan at all.
    now += 9_000;
    const v1 = await messages.embedBacklogCached(U);
    assert.equal(v1.total, 0, 'serve-stale returns the last snapshot instantly (still 0 on THIS call)');
    assert.equal(scans(), 2,
      'a total:0 snapshot past 8s MUST revalidate — with the old 60s TTL it would NOT (the P1-C SWR bug)');

    // 4. Let the background revalidate settle → the real import count is now served, one short-TTL
    //    revalidate away (well inside generate.ts EMPTY_CONFIRM_MS 12s), so the false-empty never fires.
    await new Promise((r) => setTimeout(r, 0));
    const v2 = await messages.embedBacklogCached(U);
    assert.equal(v2.total, 500, 'after one short-TTL revalidate the real import count is served — never a stale false-empty');
  } finally {
    Date.now = realNow;
  }
});

await t('CONTROL: a SETTLED backlog (pending 0, total>0) keeps the LONG 60s TTL — the fix is total:0-specific, not "always scan"', async () => {
  // TEETH + no-cost-regression: the short TTL must apply ONLY to the transient total:0, never to a
  // mature caught-up vault (which would re-introduce the 8s full-table decrypt loop this file's own
  // header warns about). A settled snapshot at 9s must NOT revalidate.
  const { raw, messages, scans } = countingVault();
  const realNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  try {
    for (let i = 0; i < 3; i++) addRow(raw, { content: `done ${i}`, nlp: 2, vec: Buffer.alloc(8) });
    const s0 = await messages.embedBacklogCached(U);
    assert.equal(s0.total, 3);
    assert.equal(s0.pending, 0, 'a fully-embedded vault is settled');
    assert.equal(scans(), 1, 'one cold scan');
    now += 9_000;   // inside the 60s long TTL
    await messages.embedBacklogCached(U);
    assert.equal(scans(), 1,
      'a settled backlog must NOT revalidate at 9s — it keeps the 60s TTL (the fix must not make every poll a scan)');
  } finally {
    Date.now = realNow;
  }
});

console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
