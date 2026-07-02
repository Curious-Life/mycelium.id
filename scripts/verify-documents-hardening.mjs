// verify:documents-hardening — Cleanup Phase 1 (docs/DOCUMENTS-LAYER-HARDENING-DESIGN-2026-06-29.md)
//
//   Part A — the withTransaction primitive (createDb directly, plaintext temp DB)
//     A1 busy_timeout pragma is 5000 (concurrent two-process writes wait, not SQLITE_BUSY)
//     A2 withTransaction commits all statements on success
//     A3 withTransaction rolls back ALL statements when the callback throws (atomicity)
//     A4 dev assert: withTransaction refuses an encrypted-field table BEFORE running fn
//
//   Part B — documents-layer behaviour (boot + db.documents)
//     B1 create (no prior) captures NO version row
//     B2 content overwrite → exactly one version (prior content), doc has new content
//     B3 partial update (title only, no content) preserves content (footgun mechanism)
//     B4 version growth is bounded to DOC_VERSION_KEEP (=50), one version per overwrite
//     B5 DRY parity: pin/unpin/setTitle/unpublish/publish each RETURNING a row AND firing afterUpsertHooks
//     B6 computeContentHash is a stable SHA-256 (portal write sets content_hash)
//
// Boots a temp vault; no network; CWD-independent; never logs document content.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto, { createHash } from 'node:crypto';
import { createDb } from '../src/adapter/d1.js';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { computeContentHash } from '../src/core/document-store.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// ── Part A — the primitive, in isolation ─────────────────────────────────────
const ADB = 'data/verify-doc-hardening-prim.db';
for (const f of [ADB, `${ADB}-shm`, `${ADB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
{
  const adapter = createDb({ dbPath: ADB, userKey: null, systemKey: null });
  const { db, withTransaction } = adapter;
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

  // A1 — busy_timeout
  rec('A1. busy_timeout pragma = 5000', db.pragma('busy_timeout', { simple: true }) === 5000);

  // A2 — commit
  withTransaction(() => {
    db.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run(1, 'a');
    db.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run(2, 'b');
  });
  rec('A2. withTransaction commits all statements', db.prepare('SELECT COUNT(*) n FROM t').get().n === 2);

  // A3 — rollback on throw (atomicity): first stmt would insert id=3, then throw → neither persists
  let threw = false;
  try {
    withTransaction(() => {
      db.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run(3, 'c');
      throw new Error('boom');
    });
  } catch { threw = true; }
  const afterRollback = db.prepare('SELECT COUNT(*) n FROM t').get().n;
  rec('A3. withTransaction rolls back the whole tx on throw', threw && afterRollback === 2, `count=${afterRollback}`);

  // A4 — dev assert refuses an encrypted-field table BEFORE running fn.
  // `secrets` is the one table that still has field-level encryption post-collapse
  // (key/value/description) — the exact class the plaintext-only contract must block.
  let assertThrew = false, ranFn = false;
  try {
    withTransaction(() => { ranFn = true; }, { tables: ['secrets'] });
  } catch (e) { assertThrew = e?.message?.includes('encrypted-field'); }
  rec('A4. dev assert blocks an encrypted-field table (secrets) without running fn', assertThrew && !ranFn);

  adapter.close();
}

// ── Part B — documents behaviour ─────────────────────────────────────────────
const DB = 'data/verify-doc-hardening.db', KCV = 'data/verify-doc-hardening-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
applyMigrations(new Database(DB));
const { db, close } = await boot({
  dbPath: DB, kcvPath: KCV,
  userHex: crypto.randomBytes(32).toString('hex'),
  systemHex: crypto.randomBytes(32).toString('hex'),
  embedder: null,
});
const U = 'local-user';
const versionCount = async (path) =>
  (await db.documents.listVersions(U, path, { limit: 200 })).length;

// B1 — create captures no version
{
  const p = 'personal/b1';
  await db.documents.upsert({ user_id: U, path: p, title: 'T', content: 'first' });
  rec('B1. create (no prior) → 0 versions', (await versionCount(p)) === 0);
}

// B2 — content overwrite → one version (prior), doc has new content
{
  const p = 'personal/b2';
  await db.documents.upsert({ user_id: U, path: p, title: 'T', content: 'original' });
  await db.documents.upsert({ user_id: U, path: p, content: 'rewritten' });
  const vers = await db.documents.listVersions(U, p, { limit: 10 });
  const doc = await db.documents.get(U, p);
  rec('B2. overwrite → 1 version (prior content) + doc updated',
    vers.length === 1 && vers[0].content === 'original' && doc.content === 'rewritten',
    `versions=${vers.length} doc.content=${doc.content === 'rewritten' ? 'new' : 'STALE'}`);
}

// B3 — title-only update preserves content (the property the portal footgun fix relies on)
{
  const p = 'personal/b3';
  await db.documents.upsert({ user_id: U, path: p, title: 'Old', content: 'keepme' });
  await db.documents.upsert({ user_id: U, path: p, title: 'New' }); // no content key
  const doc = await db.documents.get(U, p);
  rec('B3. title-only update preserves content', doc.content === 'keepme' && doc.title === 'New',
    `content=${doc.content === 'keepme' ? 'kept' : 'WIPED'}`);
}

// B4 — version growth bounded to 50, one per overwrite
{
  const p = 'personal/b4';
  await db.documents.upsert({ user_id: U, path: p, title: 'T', content: 'v0' });
  for (let i = 1; i <= 55; i++) await db.documents.upsert({ user_id: U, path: p, content: `v${i}` });
  const n = await versionCount(p);
  rec('B4. version count bounded to DOC_VERSION_KEEP (50)', n === 50, `versions=${n}`);
}

// B5 — DRY parity: every mutation RETURNs a row AND fires afterUpsertHooks
{
  const p = 'personal/b5';
  await db.documents.upsert({ user_id: U, path: p, title: 'T', content: 'x' });
  const fired = [];
  const dispose = db.documents.addAfterUpsertHook((row) => { if (row?.path === p) fired.push(row.path); });
  const r1 = await db.documents.pin(U, p);
  const r2 = await db.documents.unpin(U, p);
  const r3 = await db.documents.setTitle(U, p, 'Renamed');
  const slug = await db.documents.publish(U, p, 'b5-slug');
  const r5 = await db.documents.unpublish(U, p);
  // hooks fire on a microtask — let them flush
  await new Promise((r) => setTimeout(r, 30));
  dispose();
  const rowsOk = !!r1 && !!r2 && r3?.title === 'Renamed' && slug === 'b5-slug' && !!r5;
  rec('B5. DRY parity — pin/unpin/setTitle/publish/unpublish return rows + fire hooks',
    rowsOk && fired.length === 5, `rows=${rowsOk} hookFires=${fired.length}/5`);
}

// B6 — content hash is a stable sha256 (portal write sets content_hash)
{
  const h = computeContentHash('hello');
  const expect = createHash('sha256').update('hello', 'utf8').digest('hex');
  rec('B6. computeContentHash = SHA-256(content)', h === expect && computeContentHash(null) === null);
}

await close();

// ── Verdict ──────────────────────────────────────────────────────────────────
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed === ledger.length) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
