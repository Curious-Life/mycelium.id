// verify:search-rehydrate — proves the cold-start fix.
//
// The mind-search in-RAM index is built once, lazily, on the first query
// (src/search/index.js ensureBuilt → loadFromDb). Before this fix, loadFromDb
// dropped the stored embedding_768 vector and RE-EMBEDDED every message via the
// injected embedder (:8091) — N serial network round-trips, ~81s on a populated
// vault, blocking the single-threaded server for the whole build.
//
// The fix: loadFromDb now decrypts the stored embedding_768 envelope (written by
// enrichment via encryptVector) and hands the precomputed vector to backend.add,
// which reuses it instead of calling the embedder. This proof seeds one message
// WITH a stored vector and one WITHOUT, loads with a SPY embedder, and asserts:
//   R1 the stored vector is decrypted + loaded,
//   R2 the stored-vector row triggers NO embed call (only the fresh row does),
//   R3 the decrypted vector lands in the ANN cache,
//   R4 without a master key the loader fails soft to the prior behavior.
//
// Per CLAUDE.md §1: no vector bytes are ever logged — only counts.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createLocalBackend } from '../src/search/backend/local.js';
import { loadFromDb } from '../src/search/d1-loader.js';
import { encryptVector } from '../src/search/ann/decode.js';
import { getMasterKey } from '../src/crypto/crypto-local.js';
import { EMBED_DIM } from '../src/embed/client.js';

const DB = 'data/verify-search-rehydrate.db';
const KCV = 'data/verify-search-rehydrate-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* ignore */ } }
mkdirSync('data', { recursive: true });

// Pin the master key BEFORE seeding so the seeded embedding_768 envelope and the
// loader's decrypt share one key. boot() below pins the SAME userHex, so
// getMasterKey() stays consistent for the loader's decrypt path.
const userHex = hex(), systemHex = hex();
process.env.ENCRYPTION_MASTER_KEY = userHex;
const masterKey = await getMasterKey();

// A 768-d unit vector standing in for an "already enriched" message's embedding.
const vecA = new Float32Array(EMBED_DIM); vecA[0] = 1;
const envelopeA = await encryptVector(vecA, 'org', masterKey);

// Seed: m-stored carries a stored embedding_768; m-fresh does not.
const raw = new Database(DB);
applyMigrations(raw);
const ins = raw.prepare('INSERT INTO messages (id, user_id, role, content, source, agent_id, created_at, embedding_768) VALUES (?,?,?,?,?,?,?,?)');
ins.run('m-stored', 'local-user', 'user', 'forest mycelium roots already embedded', 'chat', 'personal-agent', '2026-05-01 10:00:00', envelopeA);
ins.run('m-fresh', 'local-user', 'user', 'fresh capture not yet embedded', 'chat', 'personal-agent', '2026-05-02 10:00:00', null);
raw.close();

// Open the encrypting db namespace over the seeded file (same userHex → key matches).
// embedder:null on boot — this proof drives loadFromDb directly with its own spy.
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });

function makeSpy() {
  let total = 0;          // every embed() call, regardless of the task arg shape
  const tasks = [];
  const embedder = {
    unit: true,
    // safeEmbed calls embed(text, { task }) — the 2nd arg is an OBJECT, not a
    // bare string (src/search/embedder.js:42). Count unconditionally so the
    // assertion can't be fooled by the arg shape.
    async embed(_text, opts = {}) { total += 1; tasks.push(opts && opts.task); const v = new Float32Array(EMBED_DIM); v[1] = 1; return v; },
    async health() { return true; },
  };
  return { embedder, count: () => total, tasks };
}

// R1/R2/R3 — with the key, decrypt + reuse; only the fresh row hits the embedder.
const { embedder: spy, count, tasks } = makeSpy();
const backend = createLocalBackend({ embedder: spy, userId: 'local-user' });
const res = await loadFromDb({ backend, db, userId: 'local-user', getMasterKey });
rec('R1. stored embedding_768 decrypted + loaded (vectorsLoaded=1, 0 failed)',
  res.vectorsLoaded === 1 && res.vectorsFailed === 0,
  `vectorsLoaded=${res.vectorsLoaded} vectorsFailed=${res.vectorsFailed} added=${res.added}`);
rec('R2. stored-vector row did NOT re-embed (embedder asked only for the fresh row)',
  count() === 1,
  `embedder calls=${count()} tasks=${JSON.stringify(tasks)} (expected 1: only m-fresh)`);
const vectors = backend._internal().vectors;
rec('R3. decrypted vector cached in the ANN map under the stored row id',
  vectors.has('m-stored'),
  `cached vector ids=[${[...vectors.keys()].join(', ')}]`);

// R4 — without a key the loader cannot decrypt → falls back to the prior
// behavior (both rows re-embedded; no throw). Proves fail-soft.
const { embedder: spy2, count: count2 } = makeSpy();
const backend2 = createLocalBackend({ embedder: spy2, userId: 'local-user' });
const res2 = await loadFromDb({ backend: backend2, db, userId: 'local-user' /* no getMasterKey */ });
rec('R4. no key → fail-soft: 0 vectors loaded, both rows re-embedded (old behavior)',
  res2.vectorsLoaded === 0 && count2() === 2,
  `vectorsLoaded=${res2.vectorsLoaded} embedder-calls=${count2()}`);

close();

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — loader reuses stored embedding_768; no re-embed; fail-soft without key' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
