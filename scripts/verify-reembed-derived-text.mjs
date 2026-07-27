// verify:reembed-derived-text — a message RE-EMBEDS when its attachment's derived text
// arrives after the message was already embedded (2026-07-26).
//
// THE DEFECT THIS GATE OWNS
// -------------------------
// `messages.embedding_768` was computed by the enrich drain from `messages.content`
// ALONE. On the import path a voice note's content is "File: memo.ogg" — the spoken
// words are written LATER onto `attachments.transcript` (portal Transcribe button ·
// import's fire-and-forget call · the background retry drain), and nothing touched the
// message row. So the transcript was BM25-searchable immediately and NEVER semantically
// searchable: the vector described a filename. RRF fusion still surfaced the keyword
// hit, which is exactly why this survived — a quality gap looks like a working feature.
//
// ⚠️ WHAT THIS GATE ASSERTS, AND WHY IT IS NOT A SEARCH TEST
// ----------------------------------------------------------
// It asserts the STRING HANDED TO THE EMBEDDER (a recording stub) and the ROW STATE the
// drain leaves behind. It deliberately does NOT ask "does a paraphrase retrieve the
// note?" — a stub embedder returns nearest neighbours for ANY query, so a retrieval
// assertion over a stub has no teeth (recorded as mutation M7 in
// verify-transcript-context.mjs, which is BM25-only ON PURPOSE for that reason). The
// falsifiable claim here is narrower and stronger: the derived text reaches the
// embedder, and the row is put back in the queue that gets it there.
//
// SECTIONS
//   D*  embedTextOf composition (pure) — content + derived text, containment dedup
//   M*  markForReembed against a REAL booted vault — the guard, and everything it must
//       NOT touch (pending rows, capped rows, other users, forgotten rows)
//   E*  end to end: mark → the drain re-embeds over content + transcript → D-047 holds
//   W*  wiring, driven for REAL: the live /internal/attachment-context route (complete vs
//       budget-cut) and transcribeAttachment itself (complete vs D-076 partial resume);
//       only the portal PATCH, which sits behind the portal auth stack, is source-pinned
//   X*  the (user_id, attachment_id) index exists — markForReembed is a per-attachment
//       UPDATE and without it every late transcript full-scans `messages`
//
// ⚠️ EVERY RECORD BELOW WAS RE-RUN AFTER THE D-076 MERGE, not carried over. That merge moved
// the transcription mark into `persist()` and gave the live route its own coverage-aware
// write, so the pre-merge records described code that no longer exists — and a stale record
// is the M-001 pattern with extra steps. Fourteen mutations, each watched RED:
//
// MUTATION-TESTED: src/enrich/service.js `embedBatch(texts)` → `embedBatch(chunk.map((r) => r.content))` (the exact pre-fix behaviour) → E2 REDs, embedded="File: dawn-memo.ogg" with no transcript
// MUTATION-TESTED: src/db/messages.js markForReembed drops `SET embedding_768 = NULL` (flip nlp_processed only) → M1 + M8 + E4a (D-047: the un-embedded row IS offered to categorize) + W1a + W1c + W2 all RED
// MUTATION-TESTED: src/db/messages.js markForReembed drops the `AND embedding_768 IS NOT NULL` guard → M2 (a pending row's 'embed-retry:3' budget is wiped) + M3 (a capped row is resurrected outside its recovery contract) + M7 + M8 RED
// MUTATION-TESTED: src/db/messages.js markForReembed `WHERE user_id = ?` → `WHERE (user_id = ? OR 1=1)` (scoping defeated, param count kept) → M4 + M7 RED
// MUTATION-TESTED: src/db/messages.js markForReembed drops `AND forgotten_at IS NULL` → M5 + M7 RED
// MUTATION-TESTED: src/db/messages.js selectPendingEnrichment reverted to the un-joined SELECT → E1 (no attachment_transcript on the row) + E2 RED
// MUTATION-TESTED: src/enrich/derived-text.js embedTextOf drops the `content.includes(t)` containment check → D2 REDs (the channel path's transcript is embedded twice)
// MUTATION-TESTED: src/enrich/transcribe-attachment.js persist() drops its markMessagesForReembed call → W2 REDs
// MUTATION-TESTED: src/enrich/transcribe-attachment.js persist() marks on EVERY save (`complete &&` guard removed) → W3 REDs — the D-076 resume thrash
// MUTATION-TESTED: src/internal-router.js audio branch drops its markMessagesForReembed call → W1a REDs
// MUTATION-TESTED: src/internal-router.js audio branch marks unconditionally (`liveCoverage?.complete === true` removed) → W1b REDs — a budget-cut live turn re-queues text about to change
// MUTATION-TESTED: src/internal-router.js persistDerived (caption/document seam) drops its call → W1c REDs
// MUTATION-TESTED: src/portal-attachments.js PATCH drops its markMessagesForReembed call → W4 REDs
// MUTATION-TESTED: migrations/0058_messages_attachment_index.sql deleted → X1 (index absent) + X2 (planner falls back to SCAN messages) RED
//
// ── E5/E6/E7 + the D2 and X2 hardening: added by an independent adversarial review ──────────
// 2026-07-27. The review found a HIGH the first fourteen mutations could not have caught,
// because no check exercised the state: `markForReembed` nulled the vector of an ALREADY-TAGGED
// row without resetting the categorize stage, minting `tagged > embedded` straight from the DAL
// — the state updateContent (C17b) and restoreTable (C17c) were each fixed to stop producing.
// Reproduced as `tagged=2 embedded=1`. Four more mutations, each watched RED:
//
// MUTATION-TESTED: src/db/messages.js MARK_FOR_REEMBED_SQL drops `categories_processed = 0, categorized_at = NULL` (the reviewed HIGH, restored) → E5a + E5b + E5c RED, 29/32
// MUTATION-TESTED: src/db/messages.js MARK_FOR_REEMBED_SQL also nulls `domain` (updateContent's rule, which is WRONG here — the body did not change) → E5c REDs
// MUTATION-TESTED: src/db/messages.js markForReembed drops the clustering_points DELETE → E6 REDs (the note keeps its filename-derived mindscape point forever)
// MUTATION-TESTED: src/db/messages.js MARK_FOR_REEMBED_SQL drops `AND content != ''` (drain-predicate parity) → E7 REDs (a content-empty row is stranded outside every backlog counter)
// MUTATION-TESTED: src/enrich/derived-text.js reverts alreadyCarries() to a raw `content.includes(t)` → D2 REDs (a body differing only in whitespace/case embeds the transcript twice)
// MUTATION-TESTED: MARK_FOR_REEMBED_SQL `WHERE user_id = ?` → `(user_id = ? OR 1=1)` → M4 + M7 + **X2** RED — X2 tracks the SHIPPING statement, so defeating the scoping also defeats the index it plans against
//
// ⚠️ E5b ITSELF FAILED ITS FIRST MUTATION TEST, and the fix is recorded rather than quietly
// applied: run against the SHARED fixture, the corpus-wide `tagged <= embedded` count stayed
// true under the N1 mutation (the other rows keep `embedded` far above `tagged`), so the check
// was decoration — green whether or not the invariant held for the row under test. It now runs
// against an ISOLATED user where the arithmetic is decisive (1 <= 0 is false). This is the M-001
// pattern caught inside the fix for a review finding — exactly where the skill warns it hides.
// All restored afterwards; the suite returns GREEN (32/32) on the restored tree.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout

process.env.MYCELIUM_UPLOADS_ROOT = 'data/verify-reembed-uploads';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { internalRouter } from '../src/internal-router.js';
import { uploadAttachment } from '../src/ingest/upload.js';
import { transcribeAttachment } from '../src/enrich/transcribe-attachment.js';
import { embedTextOf } from '../src/enrich/derived-text.js';
import { MARK_FOR_REEMBED_SQL } from '../src/db/messages.js';
import { createEnrichmentService } from '../src/enrich/service.js';
import { EMBED_DIM } from '../src/embed/client.js';

const DB = 'data/verify-reembed.db';
const KCV = 'data/verify-reembed-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync('data/verify-reembed-uploads', { recursive: true }); } catch { /* */ }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'local-user';
const OTHER = 'someone-else';

// ── D: embedTextOf — the composition, as a pure unit ─────────────────────────
{
  const both = embedTextOf({ content: 'File: memo.ogg', attachment_transcript: 'remind me to water the plants' });
  rec('D1. content + transcript → BOTH are embedded (the whole point)',
    both.includes('File: memo.ogg') && both.includes('water the plants'), JSON.stringify(both));

  // The CHANNEL path folds the transcript into content at capture time; appending it
  // again would embed the same sentences twice and skew the vector toward them.
  // ⚠️ THE FIXTURE DIFFERS IN WHITESPACE AND CASE ON PURPOSE. The channel path folds a
  // RENDERED transcript line into the body, which re-wraps and re-cases it — so byte-identical
  // containment is the RARE case. A fixture that manufactures an exact match cannot tell a
  // normalised check from a raw `includes()`, which is how the raw one survived review once.
  const carried = 'Voice note:  Remind me to water\n  the plants';
  const dedup = embedTextOf({ content: carried, attachment_transcript: 'remind me to water the plants' });
  rec('D2. content that ALREADY carries the transcript (differing whitespace/case) does not duplicate it',
    dedup === carried, JSON.stringify(dedup));

  // …but only on FULL containment: the channel path stores a 500-char SLICE, so a
  // partial overlap must still append or the tail is lost.
  const partial = embedTextOf({ content: 'Voice note: remind me to', attachment_transcript: 'remind me to water the plants at dawn' });
  rec('D3. a PARTIAL overlap still appends (a sliced body must not suppress the tail)',
    partial.includes('at dawn'), JSON.stringify(partial));

  rec('D4. whitespace-only body + a transcript → the transcript IS the text (not a blank skip)',
    embedTextOf({ content: '   ', attachment_transcript: 'the spoken words' }) === 'the spoken words');
  rec('D5. neither → empty string (the drain\'s terminal blank-skip is preserved)',
    embedTextOf({ content: '  ', attachment_transcript: null, attachment_description: '' }) === '');
  rec('D6. a DESCRIPTION composes the same way (image caption / extracted document text)',
    embedTextOf({ content: 'File: photo.jpg', attachment_description: 'a red bicycle by a canal' })
      .includes('red bicycle'));
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const VEC = () => Buffer.from(Float32Array.from(Array.from({ length: EMBED_DIM }, () => 0.01)).buffer);
let seq = 0;
async function addAttachment(owner = userId) {
  const id = `att-${++seq}`;
  await db.attachments.insert({ id, user_id: owner, file_name: `memo${seq}.ogg`, file_type: 'audio/ogg' });
  return id;
}
async function addMessage({ owner = userId, attachmentId = null, content = 'File: memo.ogg', nlp = 2, vec = VEC(), nlpError = null, cats = 0, forgotten = null }) {
  const id = `msg-${++seq}`;
  await db.rawQuery(
    `INSERT INTO messages (id, user_id, role, content, attachment_id, nlp_processed, nlp_error, embedding_768, categories_processed, forgotten_at, created_at)
     VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, owner, content, attachmentId, nlp, nlpError, vec, cats, forgotten, `2026-07-26T00:00:${String(seq % 60).padStart(2, '0')}.000Z`],
  );
  return id;
}
const state = async (id) => (await db.rawQuery(
  'SELECT nlp_processed, nlp_error, embedding_768, categories_processed FROM messages WHERE id = ?', [id],
)).results[0];

// ── M: markForReembed — what it marks, and everything it must NOT touch ──────
{
  const att = await addAttachment();
  const embedded = await addMessage({ attachmentId: att });
  // A row the drain has not reached yet needs nothing — it will pick the transcript up
  // via the JOIN — and re-queueing it would WIPE its counted-attempt budget.
  const pending = await addMessage({ attachmentId: att, nlp: 0, vec: null, nlpError: 'embed-retry:3' });
  // A capped row's recovery contract is the boot reclaim + /retry-failed, not this path.
  const capped = await addMessage({ attachmentId: att, nlp: -1, vec: null, nlpError: 'embed-capped:5' });
  const forgotten = await addMessage({ attachmentId: att, forgotten: '2026-07-25T00:00:00.000Z' });
  const foreign = await addMessage({ owner: OTHER, attachmentId: att });
  const unrelated = await addMessage({ attachmentId: await addAttachment() });

  const n = await db.messages.markForReembed(userId, att);

  const e = await state(embedded);
  rec('M1. an ALREADY-EMBEDDED owner is re-queued: vector NULL + nlp_processed 0 + error cleared',
    e.embedding_768 === null && e.nlp_processed === 0 && e.nlp_error === null,
    `vec=${e.embedding_768 === null ? 'null' : 'present'} state=${e.nlp_processed} err=${e.nlp_error}`);
  const p = await state(pending);
  rec('M2. a still-PENDING row is UNTOUCHED — its counted-attempt budget survives',
    p.nlp_processed === 0 && p.nlp_error === 'embed-retry:3', `err=${p.nlp_error}`);
  const c = await state(capped);
  rec('M3. an attempt-CAPPED row stays capped (boot reclaim / retry-failed own it)',
    c.nlp_processed === -1 && c.nlp_error === 'embed-capped:5', `state=${c.nlp_processed} err=${c.nlp_error}`);
  const f = await state(foreign);
  rec('M4. ANOTHER USER\'s message on the same attachment id is UNTOUCHED (tenant floor)',
    f.nlp_processed === 2 && f.embedding_768 !== null, `state=${f.nlp_processed}`);
  const g = await state(forgotten);
  rec('M5. a FORGOTTEN message is never resurrected into the embed queue',
    g.nlp_processed === 2 && g.embedding_768 !== null, `state=${g.nlp_processed}`);
  const u = await state(unrelated);
  rec('M6. a message owning a DIFFERENT attachment is untouched',
    u.nlp_processed === 2 && u.embedding_768 !== null);
  rec('M7. the returned count is honest (exactly the one row it re-queued)', n === 1, `n=${n}`);

  // Idempotent: the second call has nothing left to do — a progressive/retried write
  // must not thrash the queue.
  rec('M8. a SECOND mark for the same attachment re-queues nothing (idempotent)',
    (await db.messages.markForReembed(userId, att)) === 0);
}

// ── E: end to end — the drain re-embeds over content + transcript ────────────
{
  const att = await addAttachment();
  await db.attachments.update(att, { transcript: 'remind me to water the plants at dawn' });
  // A DISTINCT body: the M-block rows above are still pending with the default
  // "File: memo.ogg" content and drain in the same batch, so the assertion below needs
  // to identify THIS row's embed text unambiguously.
  const msg = await addMessage({ attachmentId: att, content: 'File: dawn-memo.ogg' });
  await db.messages.markForReembed(userId, att);

  const rows = await db.messages.selectPendingEnrichment(userId, { limit: 50 });
  const row = rows.find((r) => r.id === msg);
  rec('E1. the re-queued row is re-selected WITH its attachment\'s transcript joined in',
    Boolean(row) && row.attachment_transcript === 'remind me to water the plants at dawn',
    `joined=${JSON.stringify(row?.attachment_transcript)}`);

  // D-047 (↻1): while it awaits re-embedding it must NOT be offered to categorize.
  const cats = await db.messages.selectPendingCategories(userId, { limit: 50 });
  rec('E4a. D-047: a row awaiting re-embed is HELD BACK from categorize (embedding_768 IS NULL)',
    !cats.some((r) => r.id === msg), `offered=${cats.map((r) => r.id).join(',') || 'none'}`);

  // The teeth: record what the embedder was ASKED to embed. Not a retrieval assertion —
  // see the header note on M7 in verify-transcript-context.mjs.
  const seen = [];
  const embed = {
    async embed(text) { seen.push(text); return Array.from({ length: EMBED_DIM }, () => 0.02); },
    async embedBatch(texts) { seen.push(...texts); return texts.map(() => Array.from({ length: EMBED_DIM }, () => 0.02)); },
  };
  // getMasterKey is only truthiness-checked by drainOnce (the vector is stored RAW, Stage A),
  // so a present-but-opaque value is the honest stub here — this gate is not about crypto.
  const svc = createEnrichmentService({ messages: db.messages, embed, getMasterKey: async () => 'present' });
  await svc.drainOnce({ userId, batchSize: 50 });

  const forThisMsg = seen.filter((t) => String(t).includes('File: dawn-memo.ogg'));
  rec('E2. the embedder was handed content + THE TRANSCRIPT (the defect: content alone)',
    forThisMsg.length === 1 && forThisMsg[0].includes('water the plants at dawn'),
    `embedded=${JSON.stringify(forThisMsg[0] ?? null)}`);

  const after = await state(msg);
  rec('E3. after the drain the row is embedded again (vector present, nlp_processed 2)',
    after.embedding_768 !== null && after.nlp_processed === 2, `state=${after.nlp_processed}`);

  const cats2 = await db.messages.selectPendingCategories(userId, { limit: 50 });
  rec('E4b. …and categorize is released for it only NOW (D-047 ordering, not a deadlock)',
    cats2.some((r) => r.id === msg));
}

// ── E5: an ALREADY-TAGGED row — the D-047 hole the drain query cannot see ────
// `selectPendingCategories` enforces the ordering only for UNTAGGED rows: a row at
// `categories_processed = 1` is never re-selected, so nulling its vector alone mints a row
// counted as `tagged` and NOT as `embedded`. That is `tagged > embedded` straight from the DAL —
// the state updateContent (C17b) and restoreTable (C17c) were both fixed to stop producing, and
// this writer would have been the FOURTH path into it. Found by adversarial review, 2026-07-27,
// reproduced as `tagged=2 embedded=1`. E4a/E4b could not see it: their fixture is untagged.
{
  // ⚠️ AN ISOLATED USER, BECAUSE THE COUNTED INVARIANT IS CORPUS-WIDE. Run against the shared
  // fixture, E5b passes vacuously: the other rows keep `embedded` far above `tagged`, so it
  // stays green even with the categorize reset removed. Verified — the first version of this
  // check did NOT red under that mutation, which made it decoration. One user, one message,
  // and the arithmetic becomes decisive (1 <= 0 is false).
  const E5U = 'e5-isolated-user';
  const att = await addAttachment(E5U);
  await db.attachments.update(att, { transcript: 'the words on an already-labelled note' });
  const tagged = await addMessage({ owner: E5U, attachmentId: att, content: 'File: tagged.ogg', cats: 1 });
  await db.rawQuery("UPDATE messages SET domain = 'work', register = 'note', categorized_at = '2026-07-01T00:00:00.000Z' WHERE id = ?", [tagged]);

  await db.messages.markForReembed(E5U, att);
  const row = (await db.rawQuery('SELECT nlp_processed, embedding_768, categories_processed, categorized_at, domain FROM messages WHERE id = ?', [tagged])).results[0];

  rec('E5a. a TAGGED row is re-queued for categorize too — `tagged > embedded` is never minted',
    row.embedding_768 === null && row.nlp_processed === 0 && row.categories_processed === 0,
    `vec=${row.embedding_768 === null ? 'null' : 'present'} nlp=${row.nlp_processed} cats=${row.categories_processed}`);
  // The counted invariant itself, not just the row's columns.
  const c = (await db.rawQuery(
    `SELECT COALESCE(SUM(CASE WHEN embedding_768 IS NOT NULL THEN 1 ELSE 0 END),0) AS embedded,
            COALESCE(SUM(CASE WHEN categories_processed = 1 THEN 1 ELSE 0 END),0) AS tagged
       FROM messages WHERE user_id = ? AND forgotten_at IS NULL AND content IS NOT NULL AND content != ''`,
    [E5U],
  )).results[0];
  rec('E5b. …so the counted invariant `tagged <= embedded` survives a re-queue (C17b/C17c parity)',
    Number(c.tagged) <= Number(c.embedded), `tagged=${c.tagged} embedded=${c.embedded}`);
  // The label VALUES ride until L1 overwrites them — deliberately unlike updateContent, where the
  // BODY changed. Here the body is untouched and L1 reads content alone, so blanking a still-correct
  // label would only leave the note unlabelled in the UI until the re-run reproduced it.
  rec('E5c. …while the label VALUES survive (the body did not change) and the stamp is cleared',
    row.domain === 'work' && row.categorized_at === null, `domain=${row.domain} at=${row.categorized_at}`);
}

// ── E6: the stale MINDSCAPE point must go with the stale vector ──────────────
// `clustering_points.nomic_embedding` is a 256D projection of the vector just deleted — on the
// import path, of the filename. `sync-clustering-points.js` only INSERTs where no point exists,
// so a surviving point pins the note in the territory its FILENAME chose, forever, while search
// quietly gets it right. `updateContent` already deletes it; this writer did not (adversarial
// review, 2026-07-27, reproduced as `before=1 after=1`).
{
  const att = await addAttachment();
  await db.attachments.update(att, { transcript: 'words that belong in a different territory' });
  const msg = await addMessage({ attachmentId: att, content: 'File: clustered.ogg' });
  await db.rawQuery(
    `INSERT INTO clustering_points (user_id, source_type, source_id, nomic_embedding, created_at)
     VALUES (?, 'message', ?, ?, '2026-07-01T00:00:00.000Z')`,
    [userId, msg, 'stale-projection-of-the-filename'],
  );
  const pointsBefore = (await db.rawQuery("SELECT COUNT(*) AS n FROM clustering_points WHERE source_type = 'message' AND source_id = ?", [msg])).results[0].n;
  await db.messages.markForReembed(userId, att);
  const pointsAfter = (await db.rawQuery("SELECT COUNT(*) AS n FROM clustering_points WHERE source_type = 'message' AND source_id = ?", [msg])).results[0].n;
  rec('E6. the stale clustering point is deleted so the sync re-adds it from the NEW vector',
    Number(pointsBefore) === 1 && Number(pointsAfter) === 0, `before=${pointsBefore} after=${pointsAfter}`);
}

// ── E7: predicate parity with the drain — a content-empty row is NOT stranded ─
// `selectPendingEnrichment` requires non-empty content, so nulling a content-empty row's vector
// would leave it un-embedded, never re-selected, AND invisible to all three backlog counters
// (which carry the same clause). Such rows are real: local-files-import writes `content: ''` for
// media files, and full-export-import's vector pass can land a vector on one.
{
  const att = await addAttachment();
  await db.attachments.update(att, { transcript: 'derived text for a body-less row' });
  const empty = await addMessage({ attachmentId: att, content: '' });
  await db.messages.markForReembed(userId, att);
  const row = (await db.rawQuery('SELECT nlp_processed, embedding_768 FROM messages WHERE id = ?', [empty])).results[0];
  rec('E7. a CONTENT-EMPTY row is left alone — re-queueing it would strand it outside every counter',
    row.embedding_768 !== null && row.nlp_processed === 2, `vec=${row.embedding_768 === null ? 'null' : 'present'} nlp=${row.nlp_processed}`);
}

// ── W1: the LIVE /internal/attachment-context route marks the owning message ──
// The live turn is BOUNDED (LIVE_DECODE_BUDGET_MS), so it reports its own D-076 coverage
// and a long recording routinely ends here PARTIAL — finished later by the background
// drain. Same rule as the drain: only a COMPLETE pass marks (W1a vs W1b).
let liveComplete = true;
const app = express();
app.use(internalRouter({
  db,
  userId,
  enrich: {
    describeImage: async () => 'a red square on white',
    transcribeAudio: async ({ onCoverage }) => {
      onCoverage?.({ complete: liveComplete, coveredSec: liveComplete ? 60 : 240, durationSec: liveComplete ? 60 : 1800, segments: 1, gaps: [], engine: 'live-turn' });
      return 'the words that were actually spoken';
    },
  },
}));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const callRoute = async (attachmentId) => {
  const res = await fetch(`${base}/api/v1/internal/attachment-context`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attachmentId }),
  });
  return res.json();
};
{
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('OGGBYTES'), fileName: 'note.ogg', fileType: 'audio/ogg' });
  const msg = await addMessage({ attachmentId, content: 'File: note.ogg' });
  liveComplete = true;
  const body = await callRoute(attachmentId);
  const s = await state(msg);
  rec('W1a. a COMPLETE live turn re-queues the message that owns the attachment',
    body?.contextText === 'the words that were actually spoken' && s.embedding_768 === null && s.nlp_processed === 0,
    `ctx=${JSON.stringify(body?.contextText)} state=${s.nlp_processed}`);
}
{
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('OGGBYTES'), fileName: 'cut.ogg', fileType: 'audio/ogg' });
  const msg = await addMessage({ attachmentId, content: 'File: cut.ogg' });
  liveComplete = false;
  await callRoute(attachmentId);
  const s = await state(msg);
  rec('W1b. a BUDGET-CUT live turn does NOT re-queue — the drain will finish it and mark then',
    s.embedding_768 !== null && s.nlp_processed === 2, `state=${s.nlp_processed}`);
}
{
  // The route's OTHER derived-text writes (image caption · extracted document text) go
  // through the `persistDerived` seam, which has no partial state to reason about.
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('PNG'), fileName: 'square.png', fileType: 'image/png' });
  const msg = await addMessage({ attachmentId, content: 'File: square.png' });
  const body = await callRoute(attachmentId);
  const s = await state(msg);
  rec('W1c. an image CAPTION re-queues too (the persistDerived seam, single-shot writes)',
    body?.contextText === 'a red square on white' && s.embedding_768 === null && s.nlp_processed === 0,
    `ctx=${JSON.stringify(body?.contextText)} state=${s.nlp_processed}`);
}

// ── W2/W3: transcribeAttachment — the path a LATE transcript actually takes ───
// Driven for REAL, offline: `getBlob` and the whisper transport are injectable seams
// (added by D-076), so the whole job runs — governor ticket included — against a fake
// streaming service. This is the chokepoint for the portal Transcribe button, import,
// and the background retry drain, so these two checks cover all three.
//
// ⚠️ W3 IS THE ONE D-076 MADE ROUTINE. A long recording is now transcribed across
// SEVERAL resumed passes, each persisting a longer partial. If the mark were not gated
// on `complete`, every one of those passes would re-queue the same message and the BULK
// embed lane would re-embed text that is about to change.
function streamingFetch(chunks) {
  const enc = new TextEncoder();
  return async () => {
    let i = 0;
    return { ok: true, body: { getReader: () => ({ async read() {
      return i >= chunks.length ? { done: true, value: undefined } : { done: false, value: enc.encode(chunks[i++]) };
    } }) } };
  };
}
const healthOk = () => ({ status: 'ok', model: 'large-v3-turbo' });
const fakeBlob = async () => Buffer.from('OggS-not-real-audio');
{
  // A COMPLETE pass: meta → one segment covering the whole file → done.
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('OGG'), fileName: 'whole.ogg', fileType: 'audio/ogg' });
  const msg = await addMessage({ attachmentId, content: 'File: whole.ogg' });
  const r = await transcribeAttachment(db, userId, attachmentId, {
    getHealth: healthOk, getBlob: fakeBlob,
    fetchImpl: streamingFetch([
      `${JSON.stringify({ type: 'meta', duration: 60 })}\n`,
      `${JSON.stringify({ type: 'segment', start: 0, end: 60, text: 'the whole recording in one go' })}\n`,
      `${JSON.stringify({ type: 'done', segments: 1 })}\n`,
    ]),
  });
  const s = await state(msg);
  rec('W2. a COMPLETE transcription re-queues its message (portal button · import · retry drain)',
    r.ok === true && s.embedding_768 === null && s.nlp_processed === 0,
    `ok=${r.ok} reason=${r.reason ?? '-'} state=${s.nlp_processed}`);
}
{
  // A TRUNCATED pass: the stream dies mid-file. Real progress is persisted, the drain
  // will resume it — and the message must NOT be re-queued yet.
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('OGG'), fileName: 'long.ogg', fileType: 'audio/ogg' });
  const msg = await addMessage({ attachmentId, content: 'File: long.ogg' });
  const r = await transcribeAttachment(db, userId, attachmentId, {
    getHealth: healthOk, getBlob: fakeBlob,
    fetchImpl: streamingFetch([
      `${JSON.stringify({ type: 'meta', duration: 1800 })}\n`,
      `${JSON.stringify({ type: 'segment', start: 0, end: 240, text: 'four minutes of a thirty minute file' })}\n`,
    ]),
  });
  const stored = await db.attachments.getById(attachmentId, userId);
  const s = await state(msg);
  rec('W3. a PARTIAL pass persists its text but does NOT re-queue (no thrash across D-076 resumes)',
    r.ok === false && r.partial === true
      && String(stored?.transcript || '').includes('four minutes')
      && s.embedding_768 !== null && s.nlp_processed === 2,
    `ok=${r.ok} partial=${r.partial} stored=${Boolean(stored?.transcript)} state=${s.nlp_processed}`);
}
// ── W4: the portal PATCH — SOURCE-PINNED (it sits behind the portal auth stack) ──
// ⚠️ AN HONEST CLAIM ONLY: this proves the call is present at the right place, NOT that
// it runs — the behaviour it triggers is what M* and E* prove. Deleting it still REDs,
// which is the failure that actually happens.
{
  const portal = readFileSync('src/portal-attachments.js', 'utf8');
  rec('W4. the portal description PATCH marks too (a hand-written caption is derived text)',
    /await db\.attachments\.update\(row\.id, \{ description \}\);\s*(?:\/\/[^\n]*\n\s*)*await markMessagesForReembed\(db, userId, row\.id\);/.test(portal));
}

// ── X: the index markForReembed depends on ───────────────────────────────────
{
  const q = new Database(DB, { readonly: true });
  const idx = q.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_user_attachment'").get();
  // ⚠️ PLAN THE STATEMENT THAT SHIPS. This used to EXPLAIN a hand-written lookalike, which
  // would stay green through any future edit to the real WHERE — including one that drops
  // `user_id` and full-scans — while claiming to prove the opposite (adversarial review,
  // 2026-07-27). MARK_FOR_REEMBED_SQL is imported from the DAL; there is no second copy.
  const plan = q.prepare(`EXPLAIN QUERY PLAN ${MARK_FOR_REEMBED_SQL}`).all('u', 'a');
  q.close();
  rec('X1. (user_id, attachment_id) is indexed — a late transcript must not full-scan `messages`',
    Boolean(idx), `idx=${idx?.name || 'MISSING'}`);
  rec('X2. …and the planner actually USES it for markForReembed\'s statement',
    plan.some((r) => /idx_messages_user_attachment/.test(String(r.detail || ''))),
    plan.map((r) => r.detail).join(' | '));
}

server.close();
await close?.();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync('data/verify-reembed-uploads', { recursive: true }); } catch { /* */ }

const failed = ledger.filter((p) => !p).length;
console.log(`\n${ledger.length - failed}/${ledger.length} checks passed`);
console.log(failed ? 'VERDICT: NO-GO' : 'VERDICT: GO');
process.exit(failed ? 1 : 0);
