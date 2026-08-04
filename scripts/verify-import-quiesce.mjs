#!/usr/bin/env node
// verify:import-quiesce — D-128: while a bulk import owns the vault, every background
// writer stands down.
//
// THE DEFECT (2026-07-30): a full-export restore of 67k messages ran its mass raw writes
// — FK enforcement OFF, on the app's long-lived SHARED connection — while the enrich
// drainer kept writing the same rows and a DETACHED snapshot worker could VACUUM the same
// file. SQLITE_CORRUPT mid-import, vault HALTED, the import's writes never landed. The
// only "coordination" was busy_timeout. D-108's halt latch stopped the amplification;
// this latch closes the ingress.
//
// WHAT THIS GATE PROVES:
//   Q1  latch semantics: nesting, idempotent release, clears when the last holder leaves
//   Q2  the REAL importFullExport holds the latch across every db write it issues and
//       releases it after the restore returns (observed from inside rawQuery — the same
//       vantage the drainer's writes would have)
//   Q2b release lives in the SAME `finally` that restores FK enforcement (source), so a
//       mid-restore throw cannot strand the latch
//   Q3  the REAL transcribe-retry drain does no work under the latch and resumes after
//       release (driven, injected collaborators)
//   Q4  the snapshot schedule refuses to spawn its VACUUM worker under the latch
//       (reason 'import-quiesced'), and schedules again once released
//   Q5  the ENRICH DRAINER cycle stands down under the latch, resumes after (DRIVEN —
//       rewritten after gate-integrity review: the source-presence version survived
//       consult-neutering)
//   Q5b the AGENT SCHEDULER tick likewise (driven)
//   Q5c the CONNECTOR sync scheduler likewise (driven; security review F3 named it
//       uncovered — it writes up to 500 items/sync through captureMessage)
//   Q5d the FEDERATION pull loop likewise (driven; the other F3 writer)
//   Q3-CTRL / Q4-CTRL: the same drives WITHOUT the latch do work / do proceed past the
//       quiesce check — proves Q3/Q4 are non-vacuous
//
// MUTATION-TESTED: (D-128, 2026-08-03) the acquire in full-export-import.js was removed
// (releaseQuiesce bound to a no-op) → Q2 REDs (rawQuery observes quiesced:false during the
// restore). Restored → GREEN.
// MUTATION-TESTED: (D-128, 2026-08-03) releaseQuiesce() deleted from the importer's
// `finally` → Q2b REDs, and Q2's released-after assertion REDs. Restored → GREEN.
// MUTATION-TESTED: (D-128, 2026-08-03) the transcribe-retry consult removed → Q3 REDs
// (work runs under the latch) while Q3-CTRL stays GREEN. Restored → GREEN.
// MUTATION-TESTED: (D-128, 2026-08-03) the snapshot-schedule consult removed → Q4 REDs
// (reason is 'not-app-vault', not 'import-quiesced' — the check is gone). Restored → GREEN.
// MUTATION-TESTED: (D-128, 2026-08-03) the drainer cycle consult removed → Q5 REDs.
// Restored → GREEN.
// MUTATION-TESTED: (D-128, 2026-08-03, post-review) the gate-integrity review's two
// SURVIVING neutering mutations, re-run against the DRIVEN Q5-series: drainer guard
// `if (isImportQuiesced() && false)` → Q5 REDs (settings read under the latch);
// scheduler branch emptied `{ /* noted */ }` → Q5b REDs (dueTasks queried under the
// latch). Both survived the old source-presence check; neither survives the drive.
// MUTATION-TESTED: (D-128, 2026-08-03) the connectors consult removed → Q5c REDs;
// the federation pull-loop consult removed → Q5d REDs. Restored → 9/9 GREEN.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { acquireImportQuiesce, isImportQuiesced, importQuiesceStatus } from '../src/db/import-quiesce.js';
import { startTranscribeRetry } from '../src/enrich/transcribe-retry.js';
import { maybeScheduleSnapshot } from '../src/db/snapshot-schedule.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nD-128 — bulk import quiesces every background writer');

await t('Q1: latch semantics — nesting, idempotent release, clears on last holder', async () => {
  assert.equal(isImportQuiesced(), false, 'starts clear');
  const r1 = acquireImportQuiesce('a');
  const r2 = acquireImportQuiesce('b');
  assert.equal(isImportQuiesced(), true);
  assert.equal(importQuiesceStatus().holders, 2);
  r1(); r1(); // idempotent
  assert.equal(isImportQuiesced(), true, 'still held by b');
  r2();
  assert.equal(isImportQuiesced(), false, 'clears when the last holder leaves');
});

// ── Q2: the REAL importer holds the latch, observed from the write path itself ──
await t('Q2: importFullExport holds the latch across its writes and releases after', async () => {
  const { importMasterKey } = await import('../src/crypto/crypto-local.js');
  importMasterKey(crypto.randomBytes(32).toString('hex'));
  const { importFullExport } = await import('../src/ingest/full-export-import.js');
  const root = mkdtempSync(join(tmpdir(), 'myc-quiesce-'));
  mkdirSync(join(root, 'db'), { recursive: true });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ format: 'mycelium-full-export', version: 1, exportedAt: '2026-06-15T00:00:00.000Z' }));
  // one table file so the restore issues real INSERT traffic through rawQuery
  writeFileSync(join(root, 'db', 'messages.ndjson'), JSON.stringify({ id: 'q1', role: 'user', content: 'x', created_at: '2024-01-01T00:00:00.000Z' }) + '\n');
  const observed = []; // isImportQuiesced() at the moment of each db write — the drainer's vantage
  const db = {
    rawQuery: async (sql) => { observed.push({ q: isImportQuiesced(), sql: String(sql).slice(0, 30) }); return { results: [], meta: { changes: 1 } }; },
  };
  const before = isImportQuiesced();
  await importFullExport({ db, userId: 'u1', dirPath: root });
  assert.equal(before, false, 'clear before');
  assert.equal(isImportQuiesced(), false, 'released after the restore returns');
  assert.ok(observed.length >= 2, `importer issued writes (${observed.length})`);
  const unquiesced = observed.filter((o) => !o.q);
  assert.equal(unquiesced.length, 0,
    `every write must happen UNDER the latch — ${unquiesced.length} escaped (first: ${unquiesced[0]?.sql})`);
  rmSync(root, { recursive: true, force: true });
});

await t("Q2b: release sits in the importer's FK-restoring `finally` (a throw cannot strand the latch)", async () => {
  const src = readFileSync('src/ingest/full-export-import.js', 'utf8');
  const fin = src.slice(src.lastIndexOf('} finally {'));
  assert.ok(/foreign_keys = ON/.test(fin), 'the finally restores FKs');
  assert.ok(/releaseQuiesce\(\)/.test(fin), 'the SAME finally releases the quiesce latch');
});

// ── Q3: a real background writer, driven ─────────────────────────────────────
await t('Q3 + Q3-CTRL: the transcribe drain does NOTHING under the latch, works without it', async () => {
  let calls = 0;
  // Acquire BEFORE start: startTranscribeRetry fires an immediate cycle, and the whole
  // point is that a cycle landing while an import is mid-restore must do nothing.
  const release = acquireImportQuiesce('gate');
  const handle = startTranscribeRetry({
    db: { attachments: { listPendingTranscription: async () => ['att1'] } },
    userId: 'u1',
    intervalMs: 10_000_000, // we drive it by nudge only
    transcribe: async () => { calls++; return { ok: true }; },
    getHealth: async () => ({ status: 'ok' }),
    log: () => {},
  });
  try {
    handle.nudge(); await sleep(60);
    assert.equal(calls, 0, 'no decode work while the latch is held (incl. the start-time cycle)');
    release();
    handle.nudge(); await sleep(60);
    assert.ok(calls >= 1, 'CONTROL: the same drive without the latch does work — the check is non-vacuous');
  } finally { handle.stop(); release(); }
});

// ── Q4: the snapshot spawn decision ──────────────────────────────────────────
await t('Q4 + Q4-CTRL: no VACUUM worker spawns under the latch; the check is reachable without it', async () => {
  const release = acquireImportQuiesce('gate');
  const under = maybeScheduleSnapshot({ dbPath: '/tmp/some-vault.db', isCanonical: true });
  release();
  assert.equal(under.reason, 'import-quiesced', `must refuse for the RIGHT reason (got ${under.reason})`);
  const after = maybeScheduleSnapshot({ dbPath: '/tmp/some-vault.db', isCanonical: true });
  assert.notEqual(after.reason, 'import-quiesced', `CONTROL: released latch must fall through to the later checks (got ${after.reason})`);
});

// ── Q5: the two heavy consumers that need a live model stack — source wiring ──
await t('Q5: the ENRICH DRAINER cycle does nothing under the latch, resumes after release (driven)', async () => {
  // ⚠️ Rewritten after independent gate-integrity review (2026-08-03): the first version
  // matched mere source PRESENCE of `isImportQuiesced()`, and two neutering mutations
  // SURVIVED (`&& false` rider; a block with no return). Regex cannot brace-match, so this
  // is now DRIVEN: the quiesce guard sits before the drainer's first DB read
  // (restorePauseOnce → db.users.getSettings), so a cycle under the latch must touch
  // users NOT AT ALL, and a cycle after release must.
  const { startEnrichDrainer } = await import('../src/enrich/drainer.js');
  let settingsReads = 0;
  const noop = async () => [];
  const db = {
    // the shape createEnrichmentService validates at construction
    messages: { selectPendingEnrichment: noop, updateEnrichment: noop, selectPendingNlp: noop, updateNlp: noop },
    activityFeed: null,
    users: { getSettings: async () => { settingsReads++; return {}; } },
  };
  const release = acquireImportQuiesce('gate');
  let d = null;
  try {
    // construction INSIDE the try — a throw here must still release the latch, or it
    // strands into the next check (that exact leak produced a false Q5b failure once)
    d = startEnrichDrainer({ db, userId: 'u1', embed: { embed: async () => [] }, log: () => {} });
    await d.nudge();
    assert.equal(settingsReads, 0, 'under the latch the cycle must return before its FIRST db read');
    release();
    await d.nudge();
    assert.ok(settingsReads >= 1, 'CONTROL: the released cycle reads settings — the stand-down is a gate, not a dead drainer');
  } finally { d?.stop?.(); release(); }
});

await t('Q5b: the AGENT SCHEDULER tick does nothing under the latch, resumes after release (driven)', async () => {
  const { createScheduler } = await import('../src/agent/scheduler.js');
  let dueCalls = 0;
  const s = createScheduler({
    db: { harness: { dueTasks: async () => { dueCalls++; return []; } } },
    userId: 'u1', deliver: async () => {}, logger: () => {},
  });
  const release = acquireImportQuiesce('gate');
  try {
    await s.tickOnce();
    assert.equal(dueCalls, 0, 'under the latch the tick must not even query due tasks');
    release();
    await s.tickOnce();
    assert.ok(dueCalls >= 1, 'CONTROL: the released tick queries due tasks');
  } finally { s.stop?.(); release(); }
});

await t('Q5c: the CONNECTOR sync scheduler does nothing under the latch, resumes after release (driven)', async () => {
  // Named uncovered by the independent security review (F3): connector pulls write up to
  // 500 items/sync through captureMessage on the shared connection.
  const { startConnectorScheduler } = await import('../src/connectors/scheduler.js');
  let listCalls = 0;
  const s = startConnectorScheduler({ runner: { store: { listIds: async () => { listCalls++; return []; } } }, intervalMs: 10_000_000 });
  const release = acquireImportQuiesce('gate');
  try {
    await s.cycle();
    assert.equal(listCalls, 0, 'under the latch the connector cycle must not even list connectors');
    release();
    await s.cycle();
    assert.ok(listCalls >= 1, 'CONTROL: the released cycle lists connectors');
  } finally { s.stop?.(); release(); }
});

await t('Q5d: the FEDERATION pull loop does nothing under the latch, resumes after release (driven)', async () => {
  // The other F3 writer: INSERTs into federation_seen / connections.receive* mid-restore.
  const { createFederationPullLoop } = await import('../src/federation/pull-loop.js');
  let pulls = 0;
  const loop = createFederationPullLoop({
    db: {}, userId: 'u1', identity: {}, selfDid: 'did:web:x', resolvePeerKey: async () => null,
    client: { pull: async () => { pulls++; return []; }, ack: async () => {} },
    logger: () => {},
  });
  const release = acquireImportQuiesce('gate');
  try {
    await loop.tick();
    assert.equal(pulls, 0, 'under the latch the pull loop must not touch the relay/db');
    release();
    await loop.tick();
    assert.ok(pulls >= 1, 'CONTROL: the released tick pulls');
  } finally { loop.stop?.(); release(); }
});

console.log(`\nVERDICT: ${fail === 0 ? `GO — a bulk full-export restore holds a process-wide quiesce latch; the transcribe
        drain and snapshot spawn are PROVEN to stand down under it (driven), the drainer and
        scheduler consult it each cycle (source), and the latch cannot be stranded by a throw.
        NOT PROVEN: the drainer/scheduler stand-down end-to-end (needs the live model stack) —
        their consult sites are pinned by Q5 and mutation-tested.` : 'NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
