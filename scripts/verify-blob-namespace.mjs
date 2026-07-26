// verify:blob-namespace — the multi-tenant floor for attachment blob paths
// (the blob-namespace hardening design). The reference-counted
// blob GC keys on local_path ALONE, unscoped by user_id — safe ONLY while every
// stored path is provably namespaced under its owner (`<userId>/<uuid>.enc`).
// These checks prove no import/restore path can persist a foreign-prefixed key.
//
//   N1 helper truth table (owned true; foreign/traversal/bare/null/absolute false)
//   N2 putBlob output always passes the guard
//   N3 restoreTable REFUSES a foreign-prefixed attachments row (row absent,
//      failed=1) while inserting an owned one (inserted=1) — "a restored bundle
//      can't set a foreign-prefixed local_path"
//   N4 db.attachments.insert throws on a foreign-prefixed local_path
//   N5 null local_path (legacy r2-only row) inserts fine (no false positive)
//   N6 db.attachments.update refuses local_path (insert-only) but allows other fields
//
// Boots a temp vault; no network; CWD-independent; never logs blob contents.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { restoreTable } from '../src/ingest/vault-import.js';
import { putBlob, isUserNamespacedBlobPath, assertUserNamespacedBlobPath } from '../src/ingest/blob-store.js';

const DB = 'data/verify-blob-namespace.db';
const KCV = 'data/verify-blob-namespace-kcv.json';
const ROOT = 'data/verify-blob-namespace-uploads';
process.env.MYCELIUM_UPLOADS_ROOT = ROOT;
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync(ROOT, { recursive: true }); } catch { /* */ }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

const { db, close, userId } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const OTHER = 'attacker-tenant';

// ── N1: helper truth table ───────────────────────────────────────────────────
{
  const cases = [
    [`${userId}/abc.enc`,        true,  'owned key'],
    [`${OTHER}/abc.enc`,         false, 'foreign prefix'],
    [`${userId}/../${OTHER}/x`,  false, 'traversal out of own dir'],
    [userId,                     false, 'bare userId, no file segment'],
    [`/${userId}/abc.enc`,       false, 'absolute path (empty first segment)'],
    ['abc.enc',                  false, 'no prefix at all'],
    [null,                       false, 'null'],
    ['',                         false, 'empty string'],
  ];
  const bad = cases.filter(([rel, want]) => isUserNamespacedBlobPath(rel, userId) !== want);
  rec('N1. isUserNamespacedBlobPath truth table', bad.length === 0,
    bad.length ? `mismatches: ${bad.map(([r, w, why]) => `${JSON.stringify(r)}(${why}) wanted ${w}`).join('; ')}` : `${cases.length}/${cases.length} correct`);
}

// ── N2: putBlob output always passes the guard ───────────────────────────────
{
  const { path } = await putBlob(Buffer.from('hello'), { userId, ext: '.txt', root: ROOT });
  let assertErr = await threw(() => assertUserNamespacedBlobPath(path, userId));
  rec('N2. putBlob output is user-namespaced', isUserNamespacedBlobPath(path, userId) && assertErr === null,
    `path=${path.split('/')[0]}/… assertThrew=${assertErr !== null}`);
}

// ── N3: restoreTable refuses a foreign-prefixed attachments row ──────────────
{
  const foreignId = 'att-foreign-0001';
  const ownedId = 'att-owned-0001';
  // Foreign-prefixed local_path (simulates a bundle/reuse that escaped upstream
  // guards). restoreTable forces r.user_id = userId, so this path is NOT owned.
  const foreign = await restoreTable(db, 'attachments',
    [{ id: foreignId, file_name: 'x', file_type: 'file', file_size: 1, local_path: `${OTHER}/evil.enc` }], { userId });
  const owned = await restoreTable(db, 'attachments',
    [{ id: ownedId, file_name: 'y', file_type: 'file', file_size: 1, local_path: `${userId}/ok.enc` }], { userId });
  const present = (id) => (db.rawQuery('SELECT COUNT(*) AS c FROM attachments WHERE id = ?', [id]))
    .then((r) => (r?.results?.[0]?.c ?? 0) > 0);
  const foreignAbsent = !(await present(foreignId));
  const ownedPresent = await present(ownedId);
  rec('N3. restoreTable refuses foreign-prefixed local_path, keeps owned',
    foreign.failed === 1 && foreign.inserted === 0 && foreignAbsent && owned.inserted === 1 && ownedPresent,
    `foreign{failed:${foreign.failed},inserted:${foreign.inserted},absent:${foreignAbsent}} owned{inserted:${owned.inserted},present:${ownedPresent}}`);
}

// ── N4: db.attachments.insert throws on a foreign-prefixed local_path ─────────
{
  const err = await threw(() => db.attachments.insert({
    user_id: userId, file_name: 'z', file_type: 'file', file_size: 1, local_path: `${OTHER}/evil2.enc`,
  }));
  rec('N4. db.attachments.insert rejects foreign-prefixed local_path', err !== null,
    err ? `threw: ${err.message.slice(0, 48)}…` : 'DID NOT THROW (BAD)');
}

// ── N5: null local_path (legacy r2-only) inserts fine ────────────────────────
{
  const err = await threw(() => db.attachments.insert({
    user_id: userId, file_name: 'legacy', file_type: 'file', file_size: 1, local_path: null,
  }));
  rec('N5. null local_path (legacy r2-only) is allowed', err === null,
    err ? `unexpected throw: ${err.message.slice(0, 48)}` : 'inserted with local_path=null');
}

// ── N6: update() refuses local_path (insert-only), allows other fields ───────
{
  // Seed an owned row to update.
  await db.attachments.insert({ id: 'att-upd-0001', user_id: userId, file_name: 'u', file_type: 'file', file_size: 1, local_path: `${userId}/upd.enc` });
  const rejected = await threw(() => db.attachments.update('att-upd-0001', { local_path: `${OTHER}/moved.enc` }));
  const allowed = await threw(() => db.attachments.update('att-upd-0001', { description: 'a caption' }));
  rec('N6. attachments.update rejects local_path (insert-only), allows other fields',
    rejected !== null && allowed === null,
    `local_path→${rejected ? 'threw' : 'ACCEPTED (BAD)'} description→${allowed ? 'threw (BAD): ' + allowed.message.slice(0, 30) : 'ok'}`);
}

await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — attachment blob paths are fail-closed namespaced per user' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
