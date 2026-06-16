// verify:pipeline-integrity — the Phase-0 holistic fixes (PIPELINE-INTEGRITY
// design 2026-06-16): null content never enters the pipeline, the embed-backlog
// counter reflects reality (never sticks), the search index skips content-NULL,
// and the index build YIELDS the event loop (no freeze on large vaults).
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
  // mark the imported content row as embedded so it counts as embedded
  raw.prepare(`UPDATE messages SET embedding_768 = 'x' WHERE id = 'imp-ok'`).run();
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

// ── P2.1) the build YIELDS the event loop (no freeze) — behavioral test ──────
{
  // Mock a 300-row message source (> YIELD_EVERY=256). With the cooperative yield,
  // macrotask timers run DURING the load; without it the microtask chain starves them.
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, text: `doc ${i}`, created_at: '2026-01-01T00:00:00.000Z', embedding_768: null }));
  const mockDb = { rawQuery: async (sql) => (/FROM messages/.test(sql) ? { results: rows } : { results: [] }) };
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
