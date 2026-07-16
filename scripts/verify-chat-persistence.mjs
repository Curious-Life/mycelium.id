#!/usr/bin/env node
// verify-chat-persistence.mjs — the user's own words must NEVER be lost.
//
// LIVE DATA LOSS (2026-07-15): portal-chat persisted NOTHING after 2026-07-05. Cause: the
// route only wrote the turn INSIDE the success path, and inside `if (assistantText.trim())`:
//     if (assistantText.trim()) { cap('user', message).then(() => cap('assistant', ...)) }
// So the user's message was dropped whenever
//   (a) the turn threw — which is what happened for ~10 days: a NUL byte from vault
//       corruption reached argv and every turn died at spawn ("args[8] must be a string
//       without null bytes"); or
//   (b) the turn SUCCEEDED with no assistant text (a truncated tool-call turn).
// The model is the unreliable half of this transaction; the human's typed words are not.
// This gate pins the invariant: capture-on-receipt, independent of the model's fate.

import express from 'express';
import { portalChatRouter } from '../src/portal-chat.js';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };

// Minimal db seam: record every captureMessage write.
function makeDb(captured) {
  return {
    messages: {
      // The real captureMessage funnel (src/ingest/capture.js) needs these four.
      async getContentMeta() { return { exists: false }; },  // no dedupe hit → fresh insert
      async insertIgnore(rows) { for (const r of rows) captured.push(r); return { inserted: rows.length }; },
      async updateContent() { return { changes: 1 }; },
      async backfillContentHash() { return { changes: 0 }; },
      async listRecent() { return []; },
      async selectForContext() { return []; },
    },
    users: { async getSettings() { return {}; } },
    activityFeed: { async begin() { return null; }, async finish() {}, async heartbeat() {} },
  };
}

async function turn({ failHow }, captured) {
  const app = express();
  app.use(express.json());
  const router = portalChatRouter({
    db: makeDb(captured),
    userId: 'u1',
    tools: [],
    handlers: {},
    enqueueEnrichment: () => {},
    authenticatePortalRequest: () => true,
    // Make the model fail the way production failed (throw), or succeed with no text.
    fetch: async () => { throw new Error("The argument 'args[8]' must be a string without null bytes"); },
    restPort: 8787,
  });
  app.use('/portal', router);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = srv.address().port;
  try {
    await fetch(`http://127.0.0.1:${port}/portal/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'my precious words', conversationId: 'c1' }),
    }).then((r) => r.text()).catch(() => {});
  } finally { srv.close(); }
}

console.log('\nportal chat persistence (the user\'s words survive a failed turn)');

const captured = [];
try {
  await turn({ failHow: 'throw' }, captured);
  // Give the fire-and-forget write a tick to land.
  await new Promise((r) => setTimeout(r, 300));

  const users = captured.filter((m) => m.role === 'user');
  try {
    assert.ok(users.length >= 1, `expected the user's message to be persisted, got ${JSON.stringify(captured.map((c) => c.role))}`);
    ok('the user\'s message is persisted even though the turn FAILED (the ~10-day data loss)');
  } catch (e) { bad('the user\'s message must survive a failed turn', e); }

  try {
    assert.equal(users[0]?.content, 'my precious words');
    assert.equal(users[0]?.source, 'portal-chat');
    const conv = users[0]?.conversation_id ?? users[0]?.conversationId;
    assert.equal(conv, 'chat:c1', 'thread scoping preserved (RT3 namespace)');
    ok('it is persisted verbatim, with source + conversation thread intact');
  } catch (e) { bad('persisted payload wrong', e); }

  try {
    assert.equal(captured.filter((m) => m.role === 'assistant').length, 0);
    ok('no empty assistant bubble is written when the turn produced no text');
  } catch (e) { bad('assistant bubble should not exist', e); }
} catch (e) {
  bad('harness error', e);
}

console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
