// verify:transcript-context — a COMPLETED transcript must reach the AGENT'S context
// for the message it belongs to. (QA 2026-07-22: a voice note was transcribed, the
// transcript WAS in attachments.transcript, and the agent said it could not see it —
// every agent-facing read projected messages.content only and never joined the
// attachment. The work succeeded and was thrown away.)
//
// REAL booted vault, REAL attachments rows, REAL message rows. No models needed —
// the transcript is written the way transcribe-attachment.js writes it (db.attachments.update).
//
//   T1  attachmentContextLine: a stored transcript is rendered as text
//   T2  audio with NO transcript reads PENDING, never "unavailable" (honesty contract)
//   T3  an UNREADABLE attachment tells the agent so — never silence
//   T4  a transcript already folded into content is NOT duplicated
//   T5  getContext RECENT MESSAGES exposes a completed transcript  ← THE BUG
//   T6  channel-turn history (selectByConversation) exposes it     ← THE BUG (Telegram)
//   T7  getDailyMessages exposes it
//   T8  the join is USER-SCOPED (a foreign attachment id yields no text)
//   T9  a message with NO attachment is untouched (no phantom lines)
//   T10 the aggregate transcript budget is BOUNDED (COST) — 40 transcripts stay under a
//       LITERAL char ceiling, exhausted entries POINTER (never silence), recency-first
//   T11 channel-slice honesty (MINOR-1): a transcript past the 500-char content slice
//       still emits, and alreadyCarries suppresses only on FULL containment
//
// MUTATION PROOF (run these by hand; each must turn this gate RED):
//   - src/agent/attachment-context.js: make attachmentContextLine return null when a
//     transcript is present            → T1, T5, T6, T7 FAIL
//   - src/tools/context.js: drop the `${att ? ...}` append                 → T5 FAIL
//   - src/agent/channel-turn.js: drop withAttachmentContext               → T6 FAIL
//   - src/db/messages.js: remove attachment_id from selectPaginated       → T7 FAIL
//   - attachment-context.js: return null instead of the "could not be loaded" line → T3 FAIL
import Database from 'better-sqlite3';
import http from 'node:http';
import express from 'express';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { captureMessage } from '../src/ingest/capture.js';
import { uploadAttachment } from '../src/ingest/upload.js';
import { createChannelTurnRouter } from '../src/agent/channel-turn.js';
import { createContextDomain } from '../src/tools/context.js';
import { createMessagesDomain } from '../src/tools/messages.js';
import {
  attachmentContextLine, attachmentLineResolver, withAttachmentContext,
} from '../src/agent/attachment-context.js';

process.env.MYCELIUM_UPLOADS_ROOT = 'data/verify-transcript-context-uploads';

const DB = 'data/verify-transcript-context.db', KCV = 'data/verify-transcript-context-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync('data/verify-transcript-context-uploads', { recursive: true }); } catch { /* */ }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

const { db, close } = await boot({
  dbPath: DB, kcvPath: KCV,
  userHex: crypto.randomBytes(32).toString('hex'),
  systemHex: crypto.randomBytes(32).toString('hex'),
  embedder: null,
});
const U = 'local-user';
try { await db.users.create(U, U); } catch { /* may exist */ }

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// The transcript text this whole gate hunts for. Distinctive so a false positive
// (e.g. matching the file name) is impossible.
const TRANSCRIPT = 'ZORBLAX pick up the dry cleaning on Thursday and call the roofer';
const CONV = 'channel:telegram:5150';

// ── Seed: an audio attachment WITH a completed transcript, linked to a message
//    whose body says nothing about the content (exactly the live upload path:
//    run-import.js captures "File: memo.m4a" and transcribes fire-and-forget).
const { attachmentId } = await uploadAttachment(db, {
  userId: U, bytes: Buffer.from('OGGBYTES'), fileName: 'memo.ogg', fileType: 'audio/ogg',
});
await db.attachments.update(attachmentId, { transcript: TRANSCRIPT });   // what transcribe-attachment.js does
const voiceMsg = await captureMessage(db, {
  userId: U, role: 'user', content: 'File: memo.ogg', source: 'telegram',
  conversationId: CONV, attachmentId, createdAt: new Date(Date.now() - 5000).toISOString(),
}, () => {});

// A SECOND audio attachment with NO transcript (pending), same conversation.
const { attachmentId: pendingId } = await uploadAttachment(db, {
  userId: U, bytes: Buffer.from('OGGBYTES2'), fileName: 'pending.ogg', fileType: 'audio/ogg',
});
await captureMessage(db, {
  userId: U, role: 'user', content: '[Voice note attached]', source: 'telegram',
  conversationId: CONV, attachmentId: pendingId, createdAt: new Date(Date.now() - 4000).toISOString(),
}, () => {});

// ── T1/T2/T3/T4: the line renderer ───────────────────────────────────────────
{
  const done = attachmentContextLine({ id: 'a', file_type: 'audio/ogg', file_name: 'memo.ogg', transcript: TRANSCRIPT });
  rec('T1 a stored transcript is rendered into the line', typeof done === 'string' && done.includes(TRANSCRIPT), JSON.stringify(done));

  const pend = attachmentContextLine({ id: 'b', file_type: 'audio/ogg', file_name: 'p.ogg', transcript: null });
  rec('T2 audio with no transcript reads PENDING, never "unavailable"',
    typeof pend === 'string' && /no transcript stored yet/i.test(pend) && /in progress|not yet run/i.test(pend) && !/unavailable/i.test(pend),
    JSON.stringify(pend));

  const gone = attachmentContextLine(null);
  rec('T3a an unreadable attachment produces an EXPLICIT line, not silence',
    typeof gone === 'string' && /could not be loaded/i.test(gone), JSON.stringify(gone));

  const dup = attachmentContextLine(
    { id: 'a', file_type: 'audio/ogg', transcript: TRANSCRIPT },
    { content: `[Voice note — transcript: "${TRANSCRIPT}"]` },
  );
  rec('T4 a transcript already carried by content is not duplicated', dup === null, JSON.stringify(dup));
}

// ── T3b: a THROWING attachment read still tells the agent (batch-level honesty) ──
{
  const brokenDb = { attachments: { getByIds: async () => { throw new Error('locked'); } } };
  const lineFor = await attachmentLineResolver([{ attachment_id: attachmentId, content: 'File: memo.ogg' }], { db: brokenDb, userId: U });
  const line = lineFor({ attachment_id: attachmentId, content: 'File: memo.ogg' });
  rec('T3b a failing attachment read degrades to an HONEST line, never silence',
    typeof line === 'string' && /could not be loaded/i.test(line), JSON.stringify(line));
}

// ── T5: getContext RECENT MESSAGES — the preamble every agent turn loads ──────
{
  const { handlers } = createContextDomain({
    getDb: () => db, readMindFile: async () => null, userId: U,
  });
  const out = await handlers.getContext({ include: ['messages'], recentMessages: 10 });
  rec('T5 getContext RECENT MESSAGES carries the completed transcript', out.includes(TRANSCRIPT), out.slice(0, 400));
  rec('T5b getContext marks the still-pending voice note as pending (not unavailable)',
    /no transcript stored yet/i.test(out) && !/unavailable/i.test(out));
}

// ── T6: the channel turn (Telegram voice note) ───────────────────────────────
{
  // 6a — the shared helper over the REAL conversation read.
  const rows = await db.messages.selectByConversation(U, CONV, { limit: 20 });
  const hydrated = await withAttachmentContext(rows, { db, userId: U });
  rec('T6a selectByConversation rows hydrate the transcript',
    hydrated.some((r) => String(r.content).includes(TRANSCRIPT)));

  // 6b — END TO END through the real loopback channel-turn endpoint, with a runTurn
  //      spy: whatever the endpoint puts in `history` is what the model sees.
  let seen = null;
  const app = express();
  app.use(createChannelTurnRouter({
    db, userId: U, tools: [], handlers: {}, logger: () => {},
    runTurn: async (opts) => { seen = opts; return { text: 'ok', toolsUsed: ['reply'] }; },
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/internal/agent/channel-turn`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userMessage: 'what did I say in that voice note?', conversationId: CONV, isDirect: true, senderRole: 'owner' }),
  });
  await res.json().catch(() => null);
  await new Promise((r) => server.close(r));
  const historyText = JSON.stringify(seen?.history || []);
  rec('T6b channel-turn hands the transcript to the model in history', historyText.includes(TRANSCRIPT), historyText.slice(0, 300));
}

// ── T7: getDailyMessages (the day-review tool) ───────────────────────────────
{
  const { handlers } = createMessagesDomain({
    db, userId: U, agentLabels: {}, isScoped: () => false,
  });
  const day = new Date().toISOString().slice(0, 10);
  const out = await handlers.getDailyMessages({ date: day });
  rec('T7 getDailyMessages carries the completed transcript', String(out).includes(TRANSCRIPT), String(out).slice(0, 300));
}

// ── T8: the join is USER-SCOPED (no cross-user transcript bleed) ─────────────
{
  const lineFor = await attachmentLineResolver(
    [{ attachment_id: attachmentId, content: 'x' }],
    { db, userId: 'someone-else' },
  );
  const line = lineFor({ attachment_id: attachmentId, content: 'x' });
  rec('T8 a foreign user never gets the transcript text',
    !String(line || '').includes(TRANSCRIPT), JSON.stringify(line));
}

// ── T9: no attachment → no phantom line ─────────────────────────────────────
{
  const lineFor = await attachmentLineResolver([{ content: 'plain message' }], { db, userId: U });
  rec('T9 a message with no attachment gets no line', lineFor({ content: 'plain message' }) === null);
}

// ── T10: aggregate transcript budget is BOUNDED (a COST gate, not a SHAPE gate) ──
//  Round-2 blocker: MAX_ATTACHMENT_TEXT bounds ONE transcript but a batch had no total,
//  so 40 messages × a 4000-char clamp = ~164KB / ~41k tokens in a single briefing — 8× the
//  pre-PR size, silently evicting claims/reflections/cycles AND the history this PR added.
//  Gates assert SHAPE, never COST: a per-message clamp is SHAPE; the
//  firehose is COST. So we pin a LITERAL ceiling (never import the constant — a gate that
//  follows the mutation can't catch it) and assert the TOTAL length.
//
//  MUTATION PROOF (each must turn this gate RED):
//    - attachment-context.js: delete the `included`/budget loop (everything full) → T10a FAIL
//    - attachment-context.js: remove the finite-guard (`let remaining = budget`)  → T10e FAIL
//      (a NON-finite budget must collapse to the default constant — NOT T10a: the getContext
//       call site passes a finite briefing budget, so removing the guard leaves T10a green.)
//    - attachment-context.js: pointer branch returns null (silent drop)           → T10b FAIL
//    - attachment-context.js: byRecency spends in list order, not created_at desc → T10d FAIL
{
  const BIG = 8000, COUNT = 40, base = Date.now();
  for (let i = 0; i < COUNT; i++) {
    const { attachmentId: aid } = await uploadAttachment(db, {
      userId: U, bytes: Buffer.from('BIG' + i), fileName: `big${i}.ogg`, fileType: 'audio/ogg',
    });
    await db.attachments.update(aid, { transcript: `MSG${String(i).padStart(2, '0')} ${'x'.repeat(BIG)}` });
    await captureMessage(db, {
      userId: U, role: 'user', content: `File: big${i}.ogg`, source: 'telegram',
      conversationId: 'bulk', attachmentId: aid, createdAt: new Date(base + i * 1000).toISOString(),
    }, () => {});
  }
  const { handlers } = createContextDomain({ getDb: () => db, readMindFile: async () => null, userId: U });
  const out = await handlers.getContext({ include: ['messages'], recentMessages: 40 });

  const CEILING = 20000; // LITERAL: measured ~10.9k WITH the budget; ~164k unbounded (8× over).
  rec(`T10a getContext over 40× ${BIG}-char transcripts stays under ${CEILING} chars (COST)`,
    out.length < CEILING, `actual ${out.length} chars / ~${Math.ceil(out.length / 4)} tokens`);

  // The 4th honest state: budget-exhausted transcripts become POINTERS, never silence.
  const pointers = (out.match(/not included here to keep this briefing short/g) || []).length;
  rec('T10b budget-exhausted transcripts degrade to a POINTER line (never silent)',
    pointers >= 30 && /ask me to read it/.test(out), `${pointers} pointer lines`);

  // Recency-first: the NEWEST transcript is rendered in full; the OLDEST is a pointer.
  rec('T10c newest transcript rendered in full, oldest pointed (recency-first)',
    out.includes(`MSG39 ${'x'.repeat(500)}`) && !out.includes(`MSG00 ${'x'.repeat(500)}`),
    'newest full inlined, oldest not');
}

// ── T10d: recency is measured by created_at, NOT array order ─────────────────
//  selectPaginated / selectByConversation hand rows OLDEST-FIRST. If the budget were
//  spent in array order the OLDEST transcript would win the full text and the newest would
//  be pointed — the opposite of what the agent needs. Stub db, budget sized to fit ONE.
{
  const stub = { attachments: { getByIds: async (ids) => ids.map((id) => ({
    id, file_type: 'audio/ogg', file_name: `${id}.ogg`,
    transcript: id === 'att-new' ? `NEW ${'n'.repeat(4000)}` : id === 'att-mid' ? `MID ${'m'.repeat(4000)}` : `OLD ${'o'.repeat(4000)}`,
  })) } };
  const rowsOldestFirst = [
    { attachment_id: 'att-old', content: '.', created_at: '2026-07-20T10:00:00Z' },
    { attachment_id: 'att-mid', content: '.', created_at: '2026-07-21T10:00:00Z' },
    { attachment_id: 'att-new', content: '.', created_at: '2026-07-22T10:00:00Z' },
  ];
  const lineFor = await attachmentLineResolver(rowsOldestFirst, { db: stub, userId: U, budget: 4200 });
  const newLine = lineFor(rowsOldestFirst[2]); // att-new — most recent, LAST in the array
  const oldLine = lineFor(rowsOldestFirst[0]); // att-old — least recent, FIRST in the array
  rec('T10d most-recent-first: the newest gets full text even when it is LAST in the array',
    /NEW n{500}/.test(newLine || '') && /not included here to keep this briefing short/.test(oldLine || ''),
    `new=${(newLine || '').slice(0, 12)}… old=${(oldLine || '').slice(0, 44)}…`);
}

// ── T10e: a NON-FINITE budget FAILS CLOSED to the default constant (never the firehose) ──
//  The ungated bug (QA6 re-review): the resolver takes `budget` from its call sites, and the
//  finite-guard `remaining = Number.isFinite(budget) ? Math.max(0,budget) : DEFAULT` is the ONE
//  thing that stops a mistaken `budget: Infinity` (or NaN) from reopening the unbounded firehose.
//  T10a can't cover it — getContext passes a FINITE briefing budget, so removing the guard leaves
//  T10a green (which is why the old MUTATION-PROOF note above was wrong). Call the resolver DIRECTLY
//  with budget:Infinity over many big transcripts and assert the TOTAL emitted text stays bounded.
//  MUTATION: `let remaining = budget;` (drop the finite-guard) → Infinity admits every transcript
//  full → total blows past the ceiling → this reds.
{
  const N = 40, BIG = 8000;
  const stub = { attachments: { getByIds: async (ids) => ids.map((id) => ({
    id, file_type: 'audio/ogg', file_name: `${id}.ogg`, transcript: `${id} ${'z'.repeat(BIG)}`,
  })) } };
  const rows = Array.from({ length: N }, (_, i) => ({
    attachment_id: `inf-${String(i).padStart(2, '0')}`, content: '.',
    created_at: `2026-07-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const lineFor = await attachmentLineResolver(rows, { db: stub, userId: U, budget: Infinity });
  const total = rows.reduce((n, r) => n + String(lineFor(r) || '').length, 0);
  // LITERAL ceiling (never import the constant): DEFAULT_TRANSCRIPT_BUDGET=12000 admits ≤3 clamped
  // transcripts (~12k) + N pointer lines (~110 chars each). Unbounded = ~N×4000 = ~160k, 8× over.
  const CEILING = 20000;
  rec(`T10e a non-finite budget collapses to the default ceiling (total < ${CEILING}, not the firehose)`,
    total < CEILING, `total ${total} chars over ${N} rows / ~${Math.ceil(total / 4)} tokens`);
}

// ── T11: channel-slice honesty (MINOR-1) — two halves, each reverts to RED alone ──
{
  // (a) getContext RENDERS content sliced to 500 chars; the dedup must compare against the
  //     SAME slice. A transcript that channel-inbound folds PAST char 500 would otherwise be
  //     both cut by the slice AND suppressed as a dup — lost. contentLimit:500 fixes it.
  const tail = 'REMIND ME TO CALL THE ROOFER ON THURSDAY';
  const content = 'p'.repeat(600) + ' ' + tail; // tail lives past char 500
  const stub = { attachments: { getByIds: async () => [{ id: 'z', file_type: 'audio/ogg', file_name: 'v.ogg', transcript: tail }] } };
  const lineFor = await attachmentLineResolver(
    [{ attachment_id: 'z', content, created_at: '2026-07-22T00:00:00Z' }],
    { db: stub, userId: U, budget: 8000, contentLimit: 500 },
  );
  const line = lineFor({ attachment_id: 'z', content });
  rec('T11a a transcript past the 500-char content slice still EMITS (contentLimit dedup)',
    typeof line === 'string' && line.includes(tail), JSON.stringify(line).slice(0, 80));

  // (b) alreadyCarries must suppress ONLY on FULL containment. Content that carries the
  //     transcript's leading chars but not its tail must NOT suppress the line.
  const transcript = 'CALL THE PLUMBER ' + 'and then '.repeat(30) + 'lock the door';
  const partial = transcript.slice(0, 150); // leading 150 chars only (> the old 120-char window)
  const line2 = attachmentContextLine(
    { id: 'q', file_type: 'audio/ogg', file_name: 'v.ogg', transcript },
    { content: partial },
  );
  rec('T11b alreadyCarries suppresses only on FULL containment (partial content still emits)',
    typeof line2 === 'string' && line2.includes('lock the door'), JSON.stringify(line2).slice(0, 80));
}

await close?.();
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');
