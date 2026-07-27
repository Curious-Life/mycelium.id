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
//   T10 FULL CONTENT reaches the agent (2026-07-26 decision — the 4000-char clamp and the
//       tiered aggregate rationing are retired): every transcript renders whole, a 30-minute
//       (27k-char) recording arrives verbatim, and only a 1M-char DoS ceiling bounds a
//       pathological batch — degrading OLDEST-first to POINTERS, never to silence
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
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
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

// ── T10: FULL CONTENT reaches the agent; only a DoS ceiling bounds a batch ──────────
//  The 2026-07-26 decision INVERTED this section's contract. It used to assert COST (a
//  4000-char per-message clamp + tiered 6000/8000/24000 aggregate rationing kept a 40-message
//  briefing under ~11k chars). That rationing was sized against LOCAL_DEFAULT's 8192-token
//  window — the FLOOR used only when the Ollama probe fails, not what anyone runs — and its
//  overflow path pointed at a retrieval tool that does not exist. D-076 then made long-audio
//  transcription complete, so the clamp was cutting ~85% of a 30-minute recording.
//
//  The contract now: every stored transcript renders IN FULL. What survives is a DoS ceiling
//  (TRANSCRIPT_DOS_CEILING = 1,000,000 chars) that no real batch reaches and that degrades a
//  pathological one to POINTERS, never silence. So T10a/T10b assert CONTENT ARRIVES, and
//  T10c/T10d/T10e assert the ceiling still has teeth at its SHIPPED value.
//
//  LITERALS, never the imported constants — a gate that follows the mutation cannot catch it.
//
// MUTATION-TESTED: six mutations, 2026-07-26 — RESULTS OBSERVED, not predicted. Each was
// applied to src/agent/attachment-context.js, this gate run, then reverted:
//   M1 `MAX_ATTACHMENT_TEXT = 4000` (restore the content clamp)
//        → T10a, T10b RED (and T10c/T10d too: a 4000-char clamp shrinks 12×200k under the
//          ceiling, so the pointer state never fires either).            15/19, NO-GO
//   M2 `TRANSCRIPT_DOS_CEILING = 6000` (restore the rationing)
//        → T10a, T10b RED (T10b as well as T10a: a 27k transcript exceeds a 6000 aggregate
//          and degrades to a pointer — the exact regression this decision reverses). 17/19
//   M3 neuter the ceiling loop (`included.add(id)` unconditionally)
//        → T10c, T10d, T10e RED.                                        16/19, NO-GO
//   M4 pointer branch returns null (silent drop)
//        → T10c, T10d RED.                                              17/19, NO-GO
//   M5 drop `.sort(created_at desc)` — spend in list order
//        → T10d RED, ALONE (the recency claim is isolated).             18/19, NO-GO
//   M6 drop the finite-guard (`let remaining = budget`)
//        → T10e RED, ALONE — NOT T10a/T10c, whose call sites pass a finite ceiling, which is
//          why T10e must call the resolver directly with Infinity.      18/19, NO-GO
//   M7 src/search/d1-loader.js: messages source indexes content only (`textFrom: r => r.content`)
//        → T12, T13 RED.                                                20/22, NO-GO
//        ⚠️ M7 FIRST RAN GREEN AT 22/22 — recorded because it is the whole reason T12 is
//          shaped the way it is. T12 originally built the search helpers with a STUB EMBEDDER
//          and asserted `messages.length > 0`; a vector backend returns nearest neighbours for
//          any query, so the check passed with the transcript absent from the index. T12 now
//          runs BM25-only (no embedder) and asserts the specific message id from the raw
//          ranked hits. Do not reintroduce an embedder here — it silently removes the teeth.
//   M8 src/search/index.js: formatMessage ignores `_attachmentLine`
//        → T13 RED, ALONE (T12 still green — the corpus match is independent of hydration).
//                                                                       21/22, NO-GO
//   M9 src/search/d1-loader.js: remove the messages source's `fallback` block
//        → T14 RED.                                                     21/22, NO-GO
//   M10 src/agent/attachment-context.js: coverageNote() always returns '' (a partial
//       transcript renders as a complete one — the pre-#386 lie, one layer up)
//        → T15a RED.                                                    24/25, NO-GO
//   M11 src/db/attachments.js: getByIds drops `metadata` from its projection
//        → T15a, T15c RED. This is the structural-blindness case: with metadata unprojected
//          the resolver cannot see coverage AT ALL, and T15a alone would not tell you why.
//                                                                       23/25, NO-GO
//   M13 src/search/index.js formatMessage — the REBASE-CONFLICT pair, tested from BOTH sides:
//        (a) resolve main's way, dropping the attachment line   → T13 RED.   24/25, NO-GO
//        (b) resolve my way, dropping D-040 ↻1's `[msg:…]` ref  → T13 RED.   24/25, NO-GO
//        A conflict resolved by picking a side leaves code that still looks correct; this is
//        the check that makes the silent half-resolution loud.
//   M12 attachment-context.js: absent coverage treated as incomplete (`if (c?.complete)`)
//        → T15b AND T4 RED. T4 is the informative one: smearing legacy rows makes the line
//          emit even when content already carries the transcript, so the dedup breaks too.
//                                                                       23/25, NO-GO
//        ⚠️ M12's first TWO attempts CRASHED the gate instead of failing a check (a null
//          `c` hit `c.durationSec`, then `c.gaps`). A crash is not a RED for the stated
//          reason, so coverageNote() was made null-safe THROUGHOUT and the mutation re-run.
//          Recorded because "the gate went non-zero" is exactly the false comfort M-001 is
//          about — the exit code was right and the reason was wrong.
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

  // EVERY transcript in a realistic batch arrives whole — the OLDEST as well as the newest
  // (under the old tiering the oldest 30+ were pointers), and nothing is marked truncated.
  rec(`T10a all 40× ${BIG}-char transcripts render IN FULL, oldest included, none truncated`,
    out.includes(`MSG39 ${'x'.repeat(BIG)}`) && out.includes(`MSG00 ${'x'.repeat(BIG)}`)
      && !/truncated/i.test(out) && !/aggregate size ceiling/.test(out),
    `${out.length} chars / ~${Math.ceil(out.length / 4)} tokens`);
}

// ── T10b: the literal D-076 case — a 30-MINUTE recording survives verbatim ───────────
//  ~27,000 chars (150 wpm × 30 min × ~6 chars/word). The old 4000-char clamp delivered 15%
//  of this. MUTATION: restore MAX_ATTACHMENT_TEXT = 4000 → the tail never arrives → RED.
{
  const HEAD = 'LONGFORM-OPENING-MARKER', TAIL = 'LONGFORM-CLOSING-MARKER';
  const LONG30 = `${HEAD} ${'y'.repeat(27000)} ${TAIL}`;
  const { attachmentId: aid } = await uploadAttachment(db, {
    userId: U, bytes: Buffer.from('LONG30'), fileName: 'lecture.ogg', fileType: 'audio/ogg',
  });
  await db.attachments.update(aid, { transcript: LONG30 });
  await captureMessage(db, {
    userId: U, role: 'user', content: 'File: lecture.ogg', source: 'telegram',
    conversationId: 'bulk', attachmentId: aid, createdAt: new Date(Date.now() + 60_000).toISOString(),
  }, () => {});
  const { handlers } = createContextDomain({ getDb: () => db, readMindFile: async () => null, userId: U });
  const out = await handlers.getContext({ include: ['messages'], recentMessages: 5 });
  rec('T10b a 30-minute (27k-char) transcript reaches getContext WHOLE — head, body and tail',
    out.includes(LONG30) && out.includes(TAIL),
    `head=${out.includes(HEAD)} tail=${out.includes(TAIL)} whole=${out.includes(LONG30)}`);
}

// ── T10c: the DoS ceiling still has teeth AT ITS SHIPPED VALUE ───────────────────────
//  A batch that is a bomb, not a briefing: 12 × the 200k persistence ceiling = 2.4M chars,
//  well past TRANSCRIPT_DOS_CEILING. The ceiling must bound it AND degrade to pointers.
//  Stub db (no 2.4MB of real encrypted writes). LITERAL bound: 1,000,000 admits 5 × 200k.
{
  const N = 12, BOMB = 200_000;
  const stub = { attachments: { getByIds: async (ids) => ids.map((id) => ({
    id, file_type: 'audio/ogg', file_name: `${id}.ogg`, transcript: `${id} ${'z'.repeat(BOMB)}`,
  })) } };
  const rows = Array.from({ length: N }, (_, i) => ({
    attachment_id: `bomb-${String(i).padStart(2, '0')}`, content: '.',
    created_at: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const lineFor = await attachmentLineResolver(rows, { db: stub, userId: U, budget: 1_000_000 });
  const lines = rows.map((r) => String(lineFor(r) || ''));
  const total = lines.reduce((n, s) => n + s.length, 0);
  const pointers = lines.filter((s) => /aggregate size ceiling/.test(s)).length;
  const silent = lines.filter((s) => !s.length).length;
  rec('T10c a pathological 2.4M-char batch is bounded by the DoS ceiling, degrading to POINTERS',
    total < 1_300_000 && pointers >= 5 && silent === 0,
    `total ${total} chars, ${pointers} pointers, ${silent} silent`);
}

// ── T10d: recency is measured by created_at, NOT array order ─────────────────
//  selectPaginated / selectByConversation hand rows OLDEST-FIRST. When the DoS ceiling DOES
//  bind, whatever it drops must be the OLDEST — if the spend ran in array order the oldest
//  would win the full text and the message the human just sent would be pointed, the exact
//  opposite of what the agent needs. Stub db at the SHIPPED ceiling, bombed past it so the
//  ceiling binds: 8 × 200k = 1.6M, of which 1,000,000 admits the 5 most recent.
{
  const BOMB = 200_000;
  const body = (tag) => `${tag} ${tag[0].toLowerCase().repeat(BOMB)}`;
  const stub = { attachments: { getByIds: async (ids) => ids.map((id) => ({
    id, file_type: 'audio/ogg', file_name: `${id}.ogg`, transcript: body(id === 'att-new' ? 'NEW' : id === 'att-old' ? 'OLD' : 'MID'),
  })) } };
  const rowsOldestFirst = [
    { attachment_id: 'att-old', content: '.', created_at: '2026-07-10T10:00:00Z' },
    ...Array.from({ length: 6 }, (_, i) => ({
      attachment_id: `att-mid-${i}`, content: '.', created_at: `2026-07-1${i + 1}T10:00:00Z`,
    })),
    { attachment_id: 'att-new', content: '.', created_at: '2026-07-22T10:00:00Z' },
  ];
  const lineFor = await attachmentLineResolver(rowsOldestFirst, { db: stub, userId: U, budget: 1_000_000 });
  const newLine = lineFor(rowsOldestFirst[rowsOldestFirst.length - 1]); // most recent, LAST in the array
  const oldLine = lineFor(rowsOldestFirst[0]);                          // least recent, FIRST in the array
  rec('T10d most-recent-first: the newest gets full text even when it is LAST in the array',
    /NEW n{500}/.test(newLine || '') && /aggregate size ceiling/.test(oldLine || ''),
    `new=${(newLine || '').slice(0, 12)}… old=${(oldLine || '').slice(0, 60)}…`);
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
  const N = 12, BOMB = 200_000;
  const stub = { attachments: { getByIds: async (ids) => ids.map((id) => ({
    id, file_type: 'audio/ogg', file_name: `${id}.ogg`, transcript: `${id} ${'z'.repeat(BOMB)}`,
  })) } };
  const rows = Array.from({ length: N }, (_, i) => ({
    attachment_id: `inf-${String(i).padStart(2, '0')}`, content: '.',
    created_at: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const lineFor = await attachmentLineResolver(rows, { db: stub, userId: U, budget: Infinity });
  const total = rows.reduce((n, r) => n + String(lineFor(r) || '').length, 0);
  // LITERAL bound (never import the constant): DEFAULT_TRANSCRIPT_BUDGET=1,000,000 admits 5 of
  // the 12 × 200k transcripts + 7 pointer lines. Unbounded = 12 × 200k = 2.4M, 2× over.
  const CEILING = 1_300_000;
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

// ── T12/T13: a voice note is FINDABLE by what was SAID, and the hit carries it ────────
//  Before this, `attachments` was not a corpus source at all (d1-loader.js SOURCES: messages,
//  territory_profiles, realms, semantic_themes, documents) — so a recording captured by the
//  import path stored content "File: memo.ogg" and searching ANY spoken phrase returned
//  nothing. The transcript was neither retrievable by a tool nor findable by search; the only
//  way it ever reached the agent was landing in a recent window / history / day review.
//
//  ZORBLAX is the proof token: it exists ONLY in attachments.transcript and appears in no
//  message body anywhere in this vault, so a hit on it can ONLY come from the indexed
//  transcript. T13 then proves the HIT ITSELF carries the text — a corpus that matches on the
//  transcript but hydrates content alone would answer the query with "File: memo.ogg".
//
//  ⚠️ NO EMBEDDER, DELIBERATELY — this gate is BM25-only, and that is what gives T12 teeth.
//  The first draft built the helpers with createStubEmbedder() and asserted `messages.length
//  > 0`. It passed even with the transcript REMOVED from the indexed text (mutation M7,
//  observed): a vector backend returns nearest neighbours for ANY query, so "some hit came
//  back" says nothing about what was indexed. Without an embedder the backend is pure BM25,
//  so a hit on ZORBLAX can ONLY come from that token being in the corpus. T12 also asserts
//  the SPECIFIC message id off the raw ranked hits — `search()` is the backend's own output,
//  with no hydration in the path, so T12 cannot be satisfied by the hydrate join T13 covers.
// MUTATION-TESTED: see the records above T10 — M7/M8 cover this pair.
{
  const { createSearchHelpers } = await import('../src/search/index.js');
  const sh = createSearchHelpers({ db, userId: U }); // no embedder → BM25 only
  const hits = await sh.search('ZORBLAX', { limit: 10 });
  rec('T12 a voice note is FINDABLE by a word spoken ONLY in its transcript (corpus join)',
    hits.some((h) => String(h.id) === String(voiceMsg.id)),
    `${hits.length} hit(s): ${hits.map((h) => h.id).join(',').slice(0, 120)}`);

  const found = await sh.bulkSearch({ query: 'ZORBLAX', limit: 5 });
  const msgs = found?.messages || [];
  // BOTH properties, in ONE assertion, because they met as a rebase CONFLICT in formatMessage
  // (D-040 ↻1's addressable `[msg:…]` ref vs this transcript line) and resolving such a
  // conflict by picking a side is silent — the survivor still looks right. A hit must be
  // ADDRESSABLE (ref) *and* TRUTHFUL (what was actually said), or a voice note comes back as
  // "File: memo.ogg" with a ref pointing at a body that says nothing.
  rec('T13 the search hit CARRIES the transcript AND stays addressable (ref + derived text)',
    msgs.some((m) => String(m).includes(TRANSCRIPT) && /\[msg:[^\]]+\]/.test(String(m))),
    JSON.stringify(msgs[0] || null).slice(0, 200));
}

// ── T14: the corpus join is STRICTLY ADDITIVE — losing attachments must not lose messages ──
//  Every catch in loadFromDb's source loop is SILENT ("table absent → skip this source"),
//  which is survivable for a topology profile and an OUTAGE for messages: one missing column
//  would drop the entire message layer out of search with no error anywhere. A db whose
//  attachments table does not exist must still index messages via the fallback query.
//  MUTATION: delete the `fallback` block from the messages source → RED.
{
  const { loadFromDb } = await import('../src/search/d1-loader.js');
  const { createLocalBackend, createStubEmbedder } = await import('../src/search/index.js');
  const backend = createLocalBackend({ embedder: createStubEmbedder(48), userId: U });
  // Throws on the JOIN (no attachments table) exactly as the real adapter does — the verify
  // stubs elsewhere swallow to `{results:[]}`, which cannot exercise the fallback at all.
  const noAttachDb = {
    rawQuery: async (sql) => {
      if (/attachments/.test(sql)) throw new Error('no such table: attachments');
      if (/FROM messages\b/.test(sql) && !/\bid IN \(/.test(sql)) {
        return { results: [{ id: 'fb-1', text: 'PANGOLIN budget review', created_at: '2026-07-01T00:00:00Z' }] };
      }
      return { results: [] };
    },
  };
  const stats = await loadFromDb({ backend, db: noAttachDb, userId: U });
  rec('T14 a vault without an attachments table still indexes MESSAGES (additive, never an outage)',
    (stats?.byKind?.message || 0) > 0, `byKind=${JSON.stringify(stats?.byKind || {})}`);
}

// ── T15: a PARTIAL transcript must not read as a complete one (D-076 / #386) ──────────
//  #386 exists because "a partial transcript had NO representation, so it read as complete".
//  It fixed that in the DB (attachments.metadata.transcription coverage). This gate holds the
//  line at the AGENT boundary, which is where the lie actually lands — and which matters more
//  now that the transcript is rendered in full, because there is no truncation marker left to
//  hint that anything is missing. Three properties, each independently reversible:
//    (a) an INCOMPLETE row says so, in the same line as the text;
//    (b) a COMPLETE row and a LEGACY row (no coverage recorded at all) are UNCHANGED — absence
//        of a marker is not incompleteness, or every pre-#386 transcript would be smeared;
//    (c) getByIds PROJECTS metadata — without it the resolver is structurally blind and (a)
//        silently degrades to (b) with nothing failing.
// MUTATION-TESTED: M10/M11 — see the records above T10.
{
  const { attachmentId: partialId } = await uploadAttachment(db, {
    userId: U, bytes: Buffer.from('PARTIAL'), fileName: 'long.ogg', fileType: 'audio/ogg',
  });
  await db.attachments.update(partialId, {
    transcript: 'the first seven minutes of the lecture',
    metadata: JSON.stringify({ transcription: { incomplete: 1, coveredSec: 440, durationSec: 1800, segments: 61 } }),
  });
  const rows = [{ attachment_id: partialId, content: 'File: long.ogg', created_at: '2026-07-26T12:00:00Z' }];
  const lineFor = await attachmentLineResolver(rows, { db, userId: U });
  const line = String(lineFor(rows[0]) || '');
  rec('T15a an INCOMPLETE transcript is labelled as partial, with what it covers',
    /INCOMPLETE/.test(line) && /7m20s/.test(line) && /30m00s/.test(line)
      && line.includes('the first seven minutes of the lecture'),
    JSON.stringify(line).slice(0, 210));

  // (b) LEGACY row: the original memo.ogg has NO transcription coverage recorded at all.
  const legacyRows = [{ attachment_id: attachmentId, content: 'File: memo.ogg', created_at: '2026-07-26T12:00:00Z' }];
  const legacyFor = await attachmentLineResolver(legacyRows, { db, userId: U });
  const legacyLine = String(legacyFor(legacyRows[0]) || '');
  rec('T15b a LEGACY row (no coverage recorded) is NOT smeared as incomplete',
    legacyLine.includes(TRANSCRIPT) && !/INCOMPLETE/.test(legacyLine), JSON.stringify(legacyLine).slice(0, 140));

  // (c) the projection itself — the silent-blindness guard.
  const [row] = await db.attachments.getByIds([partialId], U);
  rec('T15c getByIds PROJECTS metadata (else the resolver cannot see coverage at all)',
    row && row.metadata != null && /transcription/.test(String(row.metadata)),
    `metadata=${row?.metadata ? 'present' : 'ABSENT'}`);
}

await close?.();
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');
