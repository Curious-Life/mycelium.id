#!/usr/bin/env node
// verify:transcribe-drain-pause — D-133: the background transcription drain has an
// authoritative disable, re-checked every cycle.
//
// THE DEFECT (2026-07-30): the operator could not stop this loop. Env throttles were
// ignored, killing :8093 made the supervisor respawn it, and the only thing that worked
// was nulling the transcriber model. Embed and categorize both have persisted pauses;
// this drain had NONE — and its log line ("transcribed 2, 0 advanced") read as a stuck
// loop while it legitimately drained a large backlog 2 files per cycle.
//
// CHECKS (driven — the real startTranscribeRetry with injected collaborators):
//   P1  settings.transcribeDrainPaused=true → no decode work, re-checked per cycle
//   P2  clearing the persisted pause mid-run resumes WITHOUT a restart (the D-047-era
//       latch lesson: a pause read once is no pause)
//   P3  MYCELIUM_TRANSCRIBE_RETRY_DISABLED=1 → no decode work
//   P4  a THROWING settings read fails soft to RUNNING (a broken read must not silently
//       kill transcription forever)
//   P5  the log line says "completed N of M pending" — the stuck-loop misread is gone
//
// MUTATION-TESTED: (D-133, 2026-08-03) the per-cycle settings consult removed from
// transcribe-retry.js → P1 and P2 RED (work runs under the persisted pause) while
// P3/P4 stay GREEN. Restored → GO.
// MUTATION-TESTED: (D-133, 2026-08-03) the env consult removed → P3 REDs. Restored → GO.
// P5b (review F5) added with the honest "+"-marked LIMITed count; driven with 5 pending
// against a working limit of 2, asserting the truncation marker appears.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTranscribeRetry } from '../src/enrich/transcribe-retry.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nD-133 — the transcription drain can be stopped');

function drive({ settings, settingsThrow = false, pendingIds = ['a1', 'a2'] } = {}) {
  const state = { calls: 0, settings };
  state.handle = startTranscribeRetry({
    db: {
      attachments: { listPendingTranscription: async () => pendingIds },
      users: { getSettings: async () => { if (settingsThrow) throw new Error('read failed'); return state.settings; } },
    },
    userId: 'u1',
    intervalMs: 10_000_000,
    transcribe: async () => { state.calls++; return { ok: true }; },
    getHealth: async () => ({ status: 'ok' }),
    log: (m) => { state.lastLog = m; },
  });
  return state;
}

await t('P1: persisted transcribeDrainPaused → zero decode work', async () => {
  const s = drive({ settings: { transcribeDrainPaused: true } });
  try {
    s.handle.nudge(); await sleep(60);
    assert.equal(s.calls, 0, 'must not decode under the persisted pause');
  } finally { s.handle.stop(); }
});

await t('P2: clearing the pause mid-run resumes WITHOUT a restart', async () => {
  const s = drive({ settings: { transcribeDrainPaused: true } });
  try {
    s.handle.nudge(); await sleep(60);
    assert.equal(s.calls, 0, 'paused first');
    s.settings = { transcribeDrainPaused: false }; // flip the persisted value — no restart
    s.handle.nudge(); await sleep(60);
    assert.ok(s.calls >= 1, 'the very next cycle must see the cleared pause (re-read per cycle, not latched)');
  } finally { s.handle.stop(); }
});

await t('P3: MYCELIUM_TRANSCRIBE_RETRY_DISABLED=1 → zero decode work', async () => {
  process.env.MYCELIUM_TRANSCRIBE_RETRY_DISABLED = '1';
  const s = drive({ settings: {} });
  try {
    s.handle.nudge(); await sleep(60);
    assert.equal(s.calls, 0, 'env disable must hold');
  } finally { s.handle.stop(); delete process.env.MYCELIUM_TRANSCRIBE_RETRY_DISABLED; }
});

await t('P4: a THROWING settings read fails soft to RUNNING', async () => {
  const s = drive({ settingsThrow: true });
  try {
    s.handle.nudge(); await sleep(60);
    assert.ok(s.calls >= 1, 'a broken settings read must not silently kill transcription');
  } finally { s.handle.stop(); }
});

await t('P5: the log names completed-of-pending, not the stuck-loop phrasing', async () => {
  const s = drive({ settings: {} });
  try {
    s.handle.nudge(); await sleep(60);
    assert.ok(/completed \d+ of \d+\+? pending/.test(String(s.lastLog || '')),
      `log must read "completed N of M pending" (got: ${s.lastLog})`);
    const src = readFileSync('src/enrich/transcribe-retry.js', 'utf8');
    assert.ok(!src.includes('advanced (partial, resuming)'), 'the old misreadable phrasing is gone from the source');
  } finally { s.handle.stop(); }
});

await t('P5b: a LIMITed count is marked "+" — never printed as the whole backlog (review F5)', async () => {
  // 5 pending against a working limit of 2: the old line claimed "of 2 pending" about a
  // backlog it had only LIMIT-2 visibility into — a stronger version of the misleading
  // message D-133 is about. The honest line reads "of 2+ pending".
  const s = drive({ settings: {}, pendingIds: ['a1', 'a2', 'a3', 'a4', 'a5'] });
  try {
    s.handle.nudge(); await sleep(60);
    assert.ok(/of \d+\+ pending/.test(String(s.lastLog || '')),
      `a truncated count must carry the "+" (got: ${s.lastLog})`);
  } finally { s.handle.stop(); }
});

console.log(`\nVERDICT: ${fail === 0 ? 'GO — the transcription drain honors a persisted pause and an env disable, re-checked every cycle, fails soft on a broken read, and its log can no longer read as a stuck loop' : 'NO-GO'} — ${pass} passed, ${fail} failed\nEXIT=${fail === 0 ? 0 : 1}`);
process.exit(fail === 0 ? 0 : 1);
