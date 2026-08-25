import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
// Gate: off-process, resumable search-corpus build (the 2026-08-22 outage fix).
// Design: the search-build off-process note (2026-08-22, dev tree).
//
// What broke, live (operator vault, v0.1.18): warm() ran the full corpus build
// on the serving thread — ~12 min at 100% CPU, event loop starved, every tool
// call timed out, and quitting the app mid-build reset corpus_built so the NEXT
// boot rebuilt from zero (the restart trap). This gate pins the fix:
//   B1  the spawned build-worker builds a real SQLCipher fixture end-to-end
//   B2  a SIGKILLed build RESUMES from its watermark (no restart-from-zero,
//       exact final count — idempotent bulkAdd absorbs the boundary overlap)
//   B3  a live build advertises a FRESH watermark (the cross-process signal a
//       second process reads as "warming — do not start a duplicate build")
//   B4  createSearchHelpers({childBuild}) end-to-end: warm() spawns the child,
//       searches mid-build fail FAST with SearchWarmingError (not a minutes-long
//       block), and after the child exits the corpus is searchable
//   B5  loadFromDb returns a NUMERIC `added` on the async local backend
//       (`added += backend.bulkAdd(...)` unawaited made it NaN)
//   B6  the messages pageSql query PLAN stays on the id index, no TEMP B-TREE
//       (the quadratic-plan guard: one bad plan makes every page a full scan)
//   B7  childBuild without pinned session keys falls back to the in-process
//       build (verify contexts / locked vault) instead of leaving search empty
//
// Fixture-only: temp SQLCipher vault + sidecar under tmpdir, throwaway keys.
// Never logs row text or vectors — counts and timings only (CLAUDE.md §1).
//
// MUTATION-TESTED: removed the `+` from `+m.user_id` in pageSql (d1-loader) → B6a AND B6b RED
//   (plan flips to idx_messages_user_agent + TEMP B-TREE — the quadratic plan reproduced)
// MUTATION-TESTED: resume ignored the persisted watermark (lastId never restored) → B2c RED
//   (second run indexed the whole corpus, added=12006, i.e. restarted from zero)
// MUTATION-TESTED: throwIfChildWarming() disabled (early return) → B4b RED (search blocked
//   through the build, no SearchWarmingError) and B4c RED (status read after the block)
// MUTATION-TESTED: dropped the `await` on backend.bulkAdd in the loader flush → B5 RED
//   (local-backend `added` became a string of concatenated Promises, not a number)
// All four reverted; gate GREEN on restored code (17 pass).

import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { loadFromDb, SOURCES } from '../src/search/d1-loader.js';
import { createLocalBackend, createStubEmbedder, createSearchHelpers } from '../src/search/index.js';
import { openSidecar } from '../src/search/sqlite/sidecar.js';
import { deriveDbKey } from '../src/account/keystore.js';
import { setSessionKeys, clearSessionKeys } from '../src/account/session-keys.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(ROOT, 'src', 'search', 'build-worker.mjs');
const USER_HEX = randomBytes(32).toString('hex');
const SYS_HEX = randomBytes(32).toString('hex');
const DBKEY = deriveDbKey(USER_HEX); // what build-child derives for an encrypted vault
const UID = 'local-user';
const EXTRA = 6; // 2 territories + 1 realm + 1 theme + 2 documents per fixture

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'verify-sbw-'));
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } };

function openKeyed(p, { readonly = false } = {}) {
  const d = new Database(p, readonly ? { readonly: true, fileMustExist: true } : {});
  d.pragma(`cipher='sqlcipher'`);
  d.pragma(`key="x'${DBKEY}'"`);
  return d;
}

function vec(seed) {
  const v = new Float32Array(768);
  let s = seed >>> 0; let n = 0;
  for (let i = 0; i < 768; i++) { s = (s * 1664525 + 1013904223) >>> 0; const x = (s / 4294967296) * 2 - 1; v[i] = x; n += x * x; }
  n = Math.sqrt(n) || 1; for (let i = 0; i < 768; i++) v[i] /= n;
  return Buffer.from(v.buffer);
}

function makeVault(name, nMessages) {
  const p = join(dir, `${name}.db`);
  const d = openKeyed(p);
  d.pragma('journal_mode = WAL');
  d.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT, content TEXT, created_at TEXT, embedding_768 BLOB, forgotten_at TEXT, attachment_id TEXT);
    CREATE INDEX idx_messages_user_agent ON messages(user_id);
    CREATE INDEX idx_messages_created_at ON messages(created_at);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, user_id TEXT, transcript TEXT, description TEXT);
    CREATE TABLE territory_profiles (territory_id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, essence TEXT, created_at TEXT, dissolved_at TEXT);
    CREATE TABLE realms (realm_id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, essence TEXT, created_at TEXT);
    CREATE TABLE semantic_themes (semantic_theme_id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, essence TEXT, created_at TEXT);
    CREATE TABLE documents (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, summary TEXT, content TEXT, created_at TEXT, is_internal INTEGER DEFAULT 0, forgotten_at TEXT);
  `);
  const ins = d.prepare('INSERT INTO messages (id, user_id, content, created_at, embedding_768) VALUES (?, ?, ?, ?, ?)');
  const tx = d.transaction(() => {
    for (let i = 0; i < nMessages; i++) {
      const id = `m${String(i).padStart(8, '0')}`;
      ins.run(id, UID, `note ${i} about kayaking rivers`, new Date(1700000000000 + i * 1000).toISOString(), vec(i));
    }
    d.prepare("INSERT INTO territory_profiles (territory_id, user_id, name, essence, created_at) VALUES (1, ?, 'Rivers', 'moving water', '2026-01-01'), (2, ?, 'Peaks', 'high ground', '2026-01-01')").run(UID, UID);
    d.prepare("INSERT INTO realms (realm_id, user_id, name, essence, created_at) VALUES (1, ?, 'Outdoors', 'open air', '2026-01-01')").run(UID);
    d.prepare("INSERT INTO semantic_themes (semantic_theme_id, user_id, name, essence, created_at) VALUES (1, ?, 'Flow', 'movement', '2026-01-01')").run(UID);
    d.prepare("INSERT INTO documents (id, user_id, title, summary, content, created_at) VALUES ('d1', ?, 'Trip plan', 'kayak trip', 'plan the kayak trip', '2026-01-02'), ('d2', ?, 'Gear list', 'gear', 'paddles and dry bags', '2026-01-03')").run(UID, UID);
  });
  tx();
  d.close();
  return p;
}

function spawnWorker(dbPath, { onEvent = null } = {}) {
  const child = spawn(process.execPath, [WORKER], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      USER_MASTER: USER_HEX, SYSTEM_KEY: SYS_HEX,
      MYCELIUM_DB: dbPath, MYCELIUM_DB_KEY: DBKEY, MYCELIUM_USER_ID: UID,
    },
  });
  const events = [];
  let buf = '';
  child.stderr.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const ev = JSON.parse(line); events.push(ev); onEvent?.(ev, child); } catch { /* noise */ }
    }
  });
  const promise = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(-1));
  });
  return { child, events, promise };
}

const sidecarState = (dbPath, key) => {
  const s = openKeyed(dbPath.replace(/\.db$/, '.search.db'), { readonly: true });
  try {
    const get = (k) => s.prepare('SELECT value FROM search_state WHERE key = ?').get(k)?.value ?? null;
    return { value: get(key), count: s.prepare('SELECT COUNT(*) AS c FROM doc_meta').get().c };
  } finally { s.close(); }
};

async function main() {
  // ── B1: end-to-end child build on a real SQLCipher fixture ────────────────
  const A = makeVault('vault-a', 1200);
  const w1 = spawnWorker(A);
  const code1 = await w1.promise;
  const done1 = w1.events.find((e) => e.ev === 'done');
  const stA = sidecarState(A, 'corpus_built');
  rec('B1a worker exits 0 with a done event', code1 === 0 && !!done1, `code=${code1}`);
  rec('B1b corpus_built=1 and exact doc count', stA.value === '1' && stA.count === 1200 + EXTRA, `count=${stA.count}/${1200 + EXTRA}`);
  rec('B1c done event reports the full corpus', done1?.added === 1200 + EXTRA, `added=${done1?.added}`);

  // ── B2+B3: SIGKILL mid-build → fresh watermark → resume, exact count ──────
  const B = makeVault('vault-b', 12000);
  let killed = false;
  const w2 = spawnWorker(B, { onEvent: (ev, child) => { if (!killed && ev.ev === 'progress') { killed = true; child.kill('SIGKILL'); } } });
  const code2 = await w2.promise;
  if (code2 === 0) {
    rec('B2 kill-resume', false, 'kill raced completion — raise fixture N');
  } else {
    const st = sidecarState(B, 'corpus_built');
    const wmRaw = sidecarState(B, 'build_watermark').value;
    let wm = null; try { wm = JSON.parse(wmRaw); } catch { /* */ }
    rec('B3a killed build left corpus UNBUILT + a watermark', st.value !== '1' && !!wm, `built=${st.value} wm=${wm ? 'yes' : 'no'}`);
    rec('B3b watermark is FRESH (cross-process warming/lease signal)', !!wm && typeof wm.at === 'number' && Date.now() - wm.at < 60_000);
    const before = st.count;
    const w3 = spawnWorker(B);
    const code3 = await w3.promise;
    const done3 = w3.events.find((e) => e.ev === 'done');
    const stB = sidecarState(B, 'corpus_built');
    rec('B2a resumed build completes', code3 === 0 && stB.value === '1', `code=${code3}`);
    rec('B2b EXACT count after resume — no dups, no loss', stB.count === 12000 + EXTRA, `count=${stB.count}/${12000 + EXTRA} (was ${before} at kill)`);
    rec('B2c second run RESUMED (indexed less than the whole corpus)', typeof done3?.added === 'number' && done3.added < 12000, `added=${done3?.added}`);
  }

  // ── B4: helpers orchestration — warm spawns child, warming fails fast ─────
  const C = makeVault('vault-c', 6000);
  const vaultC = openKeyed(C, { readonly: true });
  const sideC = openSidecar({ dbPath: C, dbKeyHex: DBKEY });
  const dbC = {
    rawQuery: async (sql, params = []) => ({ results: vaultC.prepare(sql).all(...params) }),
    _dbPath: C,
    _sqliteSearch: sideC.raw,
  };
  setSessionKeys({ userHex: USER_HEX, systemHex: SYS_HEX });
  try {
    const h = createSearchHelpers({ db: dbC, userId: UID, searchBackend: 'sqlite', childBuild: true });
    const p = h.warm();
    rec('B4a isWarming() true while the child builds', h.isWarming() === true);
    const warmingErr = await h.search('kayaking').then(() => null, (e) => e);
    rec('B4b mid-build search fails FAST with SearchWarmingError', warmingErr?.name === 'SearchWarmingError', String(warmingErr?.message || 'no error').slice(0, 60));
    const status = h.buildStatus();
    rec('B4c buildStatus() says building', status.state === 'building', `state=${status.state}`);
    await p;
    const hits = await h.search('kayaking', { limit: 5 });
    rec('B4d after the child exits: built + searchable', h.isBuilt() === true && Array.isArray(hits) && hits.length > 0, `hits=${hits?.length}`);
    rec('B4e corpus_built persisted by the child', sideC.raw.prepare("SELECT value FROM search_state WHERE key='corpus_built'").get()?.value === '1');
  } finally {
    clearSessionKeys();
  }

  // ── B5: numeric added on the async local backend (the NaN fix) ────────────
  const localBackend = createLocalBackend({ embedder: createStubEmbedder(48), userId: UID });
  const resLocal = await loadFromDb({ backend: localBackend, db: dbC, userId: UID });
  rec('B5 local-backend loadFromDb returns numeric added', Number.isFinite(resLocal.added) && resLocal.added === 6000 + EXTRA, `added=${resLocal.added}`);

  // ── B6: messages pageSql plan stays on the id index (quadratic-plan guard) ─
  const plan = vaultC.prepare(`EXPLAIN QUERY PLAN ${SOURCES[0].pageSql}`).all(UID, '', 1000)
    .map((r) => r.detail || '').join(' | ');
  rec('B6a pageSql walks the messages id index', /SEARCH m USING (COVERING )?INDEX sqlite_autoindex_messages_1/.test(plan), plan.slice(0, 120));
  rec('B6b pageSql plan has no TEMP B-TREE', !/TEMP B-TREE/.test(plan));
  vaultC.close();
  try { sideC.raw.close(); } catch { /* */ }

  // ── B7: childBuild without session keys falls back in-process ─────────────
  const D = makeVault('vault-d', 60);
  const vaultD = openKeyed(D, { readonly: true });
  const sideD = openSidecar({ dbPath: D, dbKeyHex: DBKEY });
  const dbD = {
    rawQuery: async (sql, params = []) => ({ results: vaultD.prepare(sql).all(...params) }),
    _dbPath: D,
    _sqliteSearch: sideD.raw,
  };
  const h7 = createSearchHelpers({ db: dbD, userId: UID, searchBackend: 'sqlite', childBuild: true });
  await h7.warm();
  const st7 = sideD.raw.prepare("SELECT value FROM search_state WHERE key='corpus_built'").get()?.value;
  const cnt7 = sideD.raw.prepare('SELECT COUNT(*) AS c FROM doc_meta').get().c;
  rec('B7 no session keys → in-process fallback still builds', h7.isBuilt() === true && st7 === '1' && cnt7 === 60 + EXTRA, `count=${cnt7}/${60 + EXTRA}`);
  vaultD.close();
  try { sideD.raw.close(); } catch { /* */ }

  const passed = ledger.filter(Boolean).length;
  const failed = ledger.length - passed;
  console.log('================================================================');
  console.log(`VERDICT: ${failed === 0 ? 'GO' : 'NO-GO'} — off-process resumable search build (${passed} pass, ${failed} fail)  EXIT=${failed === 0 ? 0 : 1}`);
  console.log('================================================================');
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('GATE CRASHED:', e);
  cleanup();
  process.exit(1);
});
