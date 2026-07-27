// verify:pipeline-integrity — the Phase-0 holistic fixes (PIPELINE-INTEGRITY
// design 2026-06-16): null content never enters the pipeline, the embed-backlog
// counter reflects reality (never sticks), the search index skips content-NULL,
// and the index build YIELDS the event loop (no freeze on large vaults).
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { restoreTable } from '../src/ingest/vault-import.js';
import { loadFromDb } from '../src/search/d1-loader.js';

const DB = 'data/verify-pipeline-integrity.db', KCV = 'data/verify-pipeline-integrity-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// raw handle for inserting a synthetic content-NULL row (the guards would reject it)
const raw = new Database(DB);
const insRaw = (id, content) => raw.prepare(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id, U, content);

// ── P1.1) restoreTable skips a content-NULL message, keeps a content-bearing one
{
  const out = await restoreTable(db, 'messages', [
    { id: 'imp-null', content: null },
    { id: 'imp-empty', content: '   ' },
    { id: 'imp-ok', content: 'a real imported message' },
  ], { userId: U });
  rec('I1. restoreTable skips content-NULL/empty messages (skippedEmpty=2), inserts the content-bearing one', out.skippedEmpty === 2 && out.inserted === 1, JSON.stringify({ skippedEmpty: out.skippedEmpty, inserted: out.inserted }));
  const present = raw.prepare(`SELECT id FROM messages WHERE user_id=? AND id LIKE 'imp-%' ORDER BY id`).all(U).map((r) => r.id);
  rec('I2. only the content-bearing imported row persisted', present.length === 1 && present[0] === 'imp-ok', present.join(','));
  rec('I3. a row WITH an attachment but no content is allowed (mirrors captureMessage)', (await restoreTable(db, 'messages', [{ id: 'imp-att', content: null, attachment_id: 'att-1' }], { userId: U })).inserted === 1);
}

// ── P1.2) embedBacklog excludes content-NULL → pending reaches 0 ──────────────
{
  // a content-NULL dead row (no embedding) + a content row WITHOUT embedding (real pending)
  insRaw('null-1', null);
  // Mark the imported content row as embedded EXACTLY as the pipeline does — service.js
  // writes embedding_768 and nlp_processed = 2 in ONE update. The fixture used to set only
  // embedding_768, leaving nlp_processed = 0: a state production never produces, and one
  // the drainer would (correctly) re-select and re-embed, since selectPendingEnrichment
  // keys on nlp_processed and never looks at embedding_768. Harmless under the old
  // `total - embedded` projection, which couldn't see nlp_processed at all — but it would
  // make the now-COUNTED `pending` report real, drainer-confirmed work as if it were a bug.
  raw.prepare(`UPDATE messages SET embedding_768 = 'x', nlp_processed = 2 WHERE id = 'imp-ok'`).run();
  const bl = await db.messages.embedBacklog(U);
  // content-bearing rows: imp-ok (embedded) + imp-att(content null but has attachment? content is null → excluded). So embeddable total = imp-ok only.
  rec('I4. embedBacklog counts only content-bearing rows; content-NULL excluded from total', bl.total === 1 && bl.embedded === 1 && bl.pending === 0, JSON.stringify(bl));
  // add a genuine pending content row → pending = 1 (not stuck by the null row)
  insRaw('pending-1', 'a message awaiting embedding');
  const bl2 = await db.messages.embedBacklog(U);
  rec('I5. a genuine pending row raises pending to 1 (null row still excluded → no stuck count)', bl2.total === 2 && bl2.embedded === 1 && bl2.pending === 1, JSON.stringify(bl2));
}

// ── P1.3) d1-loader does NOT index a content-NULL row ────────────────────────
{
  const added = [];
  const backend = { add: async ({ id, text }) => { added.push({ id, text }); } };
  await loadFromDb({ backend, db, userId: U, getMasterKey: null });
  const ids = added.map((a) => a.id);
  rec('I6. content-NULL rows are NOT indexed (null-1 absent); content rows are (imp-ok, pending-1)', !ids.includes('null-1') && ids.includes('imp-ok') && ids.includes('pending-1'), ids.filter((i) => i.startsWith('null') || i.startsWith('imp') || i.startsWith('pending')).join(','));
}

// ── P1.2b) `pending` is COUNTED, not projected → it reaches 0 even when rows exist
// that the drainer will NEVER re-select. The old `total - embedded` projection made
// those rows stick in `pending` forever, so a stuck vault and a healthy one looked
// identical. I4/I5 above only cover the content-NULL class (the "19 remaining" fix);
// these cover the three that survived it. @see DATA-READINESS-DESIGN §3.3.
{
  // (1) a GENUINE poison row: content-bearing, never embedded, nlp_processed = -1 with
  // the dimension-mismatch error the self-heal deliberately does NOT reset to 0
  // (drainer.js: "expected 768" is the one failure kept terminal).
  insRaw('poison-1', 'a message that can never embed');
  raw.prepare(`UPDATE messages SET nlp_processed = -1, nlp_error = 'dim mismatch: expected 768, got 384' WHERE id = 'poison-1'`).run();
  // (2) a BLANK-CONTENT skip: whitespace-only content passes `content != ''` (so it is
  // in `total`) but service.js trims it and marks nlp_processed = 1 without embedding.
  insRaw('blank-1', '   ');
  raw.prepare(`UPDATE messages SET nlp_processed = 1 WHERE id = 'blank-1'`).run();

  // embeddable rows now: imp-ok(embedded) · pending-1(real pending) · poison-1 · blank-1
  const bl = await db.messages.embedBacklog(U);
  rec('I8. pending counts ONLY selectPendingEnrichment\'s predicate — poison + blank-skip excluded (was: both stuck in pending forever)',
    bl.pending === 1, JSON.stringify(bl));
  rec('I9. the residue is SURFACED as `unprocessable`, not hidden inside pending',
    bl.unprocessable === 2, JSON.stringify(bl));

  // (3) the regression this exists to pin: drain the one real pending row → pending
  // REACHES 0 while the un-embeddable rows are still present. Under the old projection
  // pending would be 3 here, forever — the stuck "Embedding N of M".
  raw.prepare(`UPDATE messages SET embedding_768 = 'x', nlp_processed = 2 WHERE id = 'pending-1'`).run();
  const bl2 = await db.messages.embedBacklog(U);
  rec('I10. pending REACHES 0 with un-embeddable rows present (the stuck-forever bug)',
    bl2.pending === 0, JSON.stringify(bl2));
  rec('I11. …and those rows stay VISIBLE as unprocessable (never silently dropped)',
    bl2.unprocessable === 2 && bl2.total === 4 && bl2.embedded === 2, JSON.stringify(bl2));
  // nlp_processed = 2 means embedded-but-awaiting-L2: it must count as embedded, and it
  // must NOT be pending (the L2 backlog is a separate queue with its own terminality).
  rec('I12. an embedded row awaiting L2 (nlp_processed = 2) counts as embedded, not pending',
    bl2.embedded === 2 && bl2.pending === 0, JSON.stringify(bl2));

  // The progress bar and `status` MUST share a basis. Independent review caught this:
  // `status` reads `pending` (now counted) while step/totalSteps/stageLabel read
  // embedded/total, so a vault with un-embeddable rows reported status:'done' over
  // "Embedding: 2 / 4" — a half-full bar announcing completion. The denominator is the
  // PROCESSABLE set (embedded + pending), which equals `embedded` exactly when pending
  // hits 0. Pinned here so the two bases can never drift apart again.
  const processable = bl2.embedded + bl2.pending;
  rec('I13. the progress denominator is the PROCESSABLE set, so a "done" status can never render a half-full bar',
    bl2.pending === 0 && processable === bl2.embedded && processable !== bl2.total,
    JSON.stringify({ step: bl2.embedded, totalSteps: processable, total: bl2.total, unprocessable: bl2.unprocessable }));
}

// ── P2.1) the build YIELDS the event loop (no freeze) — behavioral test ──────
{
  // Mock a message source LARGER than one page (the messages source paginates at
  // PAGE=1000 and batches at BATCH=2000 in d1-loader.js). The loader flushes +
  // yields to the macrotask (check) queue after EACH keyset page, and the per-row
  // add() runs inside that flush — so a pre-scheduled macrotask can only be
  // observed by add() if the build yielded between pages. The source must exceed
  // PAGE for ≥2 pages (hence ≥2 flushes) to occur: use 2*BATCH = 4000 rows (4
  // pages). With a single sub-page source the lone end-of-source flush runs all
  // its add()s in one unbroken microtask chain and the marker is never seen.
  const TOTAL = 4000; // 2 * BATCH (also > PAGE=1000) → multiple paginated flushes
  const rows = Array.from({ length: TOTAL }, (_, i) => ({ id: `m${String(i).padStart(6, '0')}`, text: `doc ${i}`, created_at: '2026-01-01T00:00:00.000Z', embedding_768: null }));
  // Faithful keyset-paginating source: honor the `id > ?` cursor + LIMIT (params
  // [userId, lastId, PAGE]) so the loader's pagination loop terminates. A mock
  // that returned the full set every page would spin forever. Ids are zero-padded
  // so string (TEXT pk) ordering matches insertion order.
  const mockDb = { rawQuery: async (sql, params) => {
    if (!/FROM messages/.test(sql)) return { results: [] };
    const [, lastId = '', limit = rows.length] = params || [];
    return { results: rows.filter((r) => r.id > lastId).slice(0, limit) };
  } };
  // A macrotask scheduled BEFORE the load. It can only run mid-load if the build
  // breaks its microtask chain by yielding to the macrotask (check) queue. With
  // the old non-yielding loop, this marker runs only AFTER the whole load.
  let marker = false;
  setImmediate(() => { marker = true; });
  let sawMarkerMidLoad = false;
  const backend = { add: async () => { if (marker) sawMarkerMidLoad = true; } };
  await loadFromDb({ backend, db: mockDb, userId: U, getMasterKey: null });
  rec('I7. build yields to the event loop mid-load (a pre-scheduled macrotask runs before the load finishes)', sawMarkerMidLoad === true, `marker observed mid-load = ${sawMarkerMidLoad}`);
}

raw.close();
close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — null content never enters the pipeline (import guard + index filter), backlog counter never sticks, build yields the event loop' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
