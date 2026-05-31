// Verify the D7 enrichment service (embed-on-write half) end-to-end.
//
// Tier-1 (this script): boot the REAL encrypting db, seed pending messages, run
// the service's drainOnce with a DETERMINISTIC 768-d STUB embedder — proves the
// queue-drain + envelope-write + state machine work WITHOUT the embed-service
// (sibling Tier-2). Asserts:
//   N1 pending rows get embedded + flip nlp_processed 0→2
//   N2 the stored embedding_768 is a CIPHERTEXT envelope (not the raw vector)
//   N3 it decrypts back to the exact stub vector via the canonical read path
//      (decryptVector, no userId) — write/read key-derivation parity
//   N4 an already-embedded row (nlp_processed=2) is NOT re-touched
//   N5 a poison row (embed throws) is isolated → nlp_processed=-1 + nlp_error,
//      and the batch still drains the healthy rows around it
//   N6 fail-closed: a locked vault (getMasterKey→null) refuses to write
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>; process.exit reflects pass/fail.

import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

import { applyMigrations } from '../src/db/migrate.js';
import { boot } from '../src/index.js';
import { getMasterKey } from '../src/crypto/crypto-local.js';
import { createEnrichmentService } from '../src/enrich/service.js';
import { startEnrichmentServer } from '../src/enrich/server.js';
import { createEnqueueEnrichment } from '../src/ingest/enqueue.js';
import { decryptVector } from '../src/search/ann/decode.js';
import { EMBED_DIM } from '../src/embed/client.js';

const DB = 'data/verify-enrich.db';
const KCV = 'data/verify-enrich-kcv.json';
const USER = 'local-user';
const hex = () => crypto.randomBytes(32).toString('hex');

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

// Deterministic 768-d "embedding" from text, so N3 can recompute the exact
// vector and assert round-trip parity. Float32 round-trips losslessly through
// encodeVector's byte→base64→byte path, so equality is exact.
function stubVec(text) {
  const seed = [...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const v = new Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) {
    v[i] = Math.sin((seed % 1000) + i * 0.013);
  }
  return v;
}
const FAIL_SENTINEL = '__FAIL_ME__';
const stubEmbed = {
  async embed(text) {
    if (text === FAIL_SENTINEL) throw new Error('stub: forced embed failure');
    return stubVec(text);
  },
};

function freshDb() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  applyMigrations(new Database(DB));
}

// Read raw (unencrypted-adapter) state for assertions on the state machine +
// the at-rest envelope. nlp_processed / scope are plain columns; embedding_768
// is the raw vector envelope (NEVER_AUTO_DECRYPT) — exactly what's on disk.
function rawState(id) {
  const raw = new Database(DB, { readonly: true });
  try {
    return raw.prepare(
      'SELECT id, nlp_processed, nlp_error, embedding_768, content, scope FROM messages WHERE id = ?',
    ).get(id);
  } finally {
    raw.close();
  }
}

async function main() {
  freshDb();

  // Seed: 3 healthy pending (nlp_processed defaults to 0), 1 already-embedded
  // (skip), 1 poison (forced embed failure). Insert via a raw connection with
  // PLAINTEXT content — the read path will encrypt-compare at SQL level and
  // auto-decrypt on the way out; for the drain we only need content to be
  // embeddable, and stubEmbed reads whatever selectPendingEnrichment returns.
  // To keep content readable by the encrypting adapter we seed through boot's
  // db namespace below instead of raw, so encryption matches.
  const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), embedder: undefined });

  const pendingContents = {
    'e-1': 'the mycelium network spreads beneath the forest floor',
    'e-2': 'quarterly revenue and the household budget ledger',
    'e-3': 'a long walk along the coast at dawn, thinking of nothing',
  };
  // Healthy pending rows (nlp_processed omitted → schema default 0).
  for (const [id, content] of Object.entries(pendingContents)) {
    await db.messages.insert({ id, user_id: USER, role: 'user', content, source: 'verify', agent_id: 'personal-agent', scope: 'org' });
  }
  // Already-embedded row — must be skipped by the drain.
  await db.messages.insert({ id: 'e-done', user_id: USER, role: 'user', content: 'already embedded, leave me alone', source: 'verify', agent_id: 'personal-agent', scope: 'org', nlp_processed: 2 });
  // Poison row — embed throws on this content.
  await db.messages.insert({ id: 'e-poison', user_id: USER, role: 'user', content: FAIL_SENTINEL, source: 'verify', agent_id: 'personal-agent', scope: 'org' });

  const svc = createEnrichmentService({ messages: db.messages, embed: stubEmbed, getMasterKey });

  // ── drain ──────────────────────────────────────────────────────────────
  const result = await svc.drainOnce({ userId: USER, batchSize: 50 });
  rec('N1a. drainOnce scans the 4 pending rows (3 healthy + 1 poison), skips the embedded one',
    result.scanned === 4, `scanned=${result.scanned} embedded=${result.embedded} failed=${result.failed}`);
  rec('N1b. 3 healthy rows embedded, 1 poison failed',
    result.embedded === 3 && result.failed === 1,
    `embedded=${result.embedded} failed=${result.failed}`);

  // N1: state flips 0→2 for healthy rows
  const flipped = Object.keys(pendingContents).every((id) => rawState(id).nlp_processed === 2);
  rec('N1c. healthy rows flipped nlp_processed 0→2', flipped,
    Object.keys(pendingContents).map((id) => `${id}=${rawState(id).nlp_processed}`).join(' '));

  // N2: stored embedding_768 is a ciphertext envelope, not the raw vector
  const s1 = rawState('e-1');
  const looksEncrypted = typeof s1.embedding_768 === 'string'
    && s1.embedding_768.length > 0
    && !s1.embedding_768.includes('0.')          // not a JSON number dump
    && !s1.embedding_768.startsWith('[');        // not a raw array
  rec('N2. embedding_768 stored as a ciphertext envelope (not raw vector)',
    looksEncrypted, `len=${s1.embedding_768?.length} head=${String(s1.embedding_768).slice(0, 24)}`);

  // N3: decrypts back to the exact stub vector via the canonical read path
  const masterKey = await getMasterKey();
  const back = await decryptVector(s1.embedding_768, masterKey, [s1.scope], EMBED_DIM);
  const expected = stubVec(pendingContents['e-1']);
  let maxErr = 0;
  for (let i = 0; i < EMBED_DIM; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - expected[i]));
  rec('N3. decryptVector (no userId) recovers the exact 768-d vector — write/read key parity',
    back.length === EMBED_DIM && maxErr < 1e-5, `dim=${back.length} maxAbsErr=${maxErr.toExponential(2)}`);

  // N4: already-embedded row untouched (still has no embedding_768, still =2)
  const done = rawState('e-done');
  rec('N4. already-embedded row (nlp_processed=2) not re-touched by the drain',
    done.nlp_processed === 2 && (done.embedding_768 === null || done.embedding_768 === undefined),
    `nlp_processed=${done.nlp_processed} embedding_768=${done.embedding_768 === null ? 'null' : 'set'}`);

  // N5: poison row isolated → -1 + nlp_error, no embedding written
  const poison = rawState('e-poison');
  rec('N5. poison row isolated → nlp_processed=-1 + nlp_error, no embedding',
    poison.nlp_processed === -1 && typeof poison.nlp_error === 'string' && poison.nlp_error.length > 0
      && (poison.embedding_768 === null || poison.embedding_768 === undefined),
    `nlp_processed=${poison.nlp_processed} nlp_error="${String(poison.nlp_error).slice(0, 40)}"`);

  // N5b: a second drain finds nothing left pending (idempotent — no re-embed)
  const again = await svc.drainOnce({ userId: USER, batchSize: 50 });
  rec('N5b. re-drain finds 0 pending (embedded rows are no longer queued)',
    again.scanned === 0, `scanned=${again.scanned}`);

  close();

  // ── N6: fail-closed on a locked vault ────────────────────────────────────
  {
    freshDb();
    const { db: db2, close: close2 } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
    await db2.messages.insert({ id: 'e-locked', user_id: USER, role: 'user', content: 'should not be written', source: 'verify', agent_id: 'personal-agent', scope: 'org' });
    const lockedSvc = createEnrichmentService({
      messages: db2.messages,
      embed: stubEmbed,
      getMasterKey: async () => null, // simulate locked vault
    });
    let threw = false;
    try { await lockedSvc.drainOnce({ userId: USER }); } catch { threw = true; }
    const st = rawState('e-locked');
    rec('N6. locked vault (getMasterKey→null) refuses to write — throws + row left pending',
      threw && (st.nlp_processed === 0 || st.nlp_processed === null) && (st.embedding_768 === null || st.embedding_768 === undefined),
      `threw=${threw} nlp_processed=${st.nlp_processed} embedding_768=${st.embedding_768 === null ? 'null' : 'set'}`);
    close2();
  }

  // ── Layer 2: the :8095 HTTP listener (the enqueue nudge target) ───────────
  {
    freshDb();
    const { db: sdb, url, close: closeSrv } = await startEnrichmentServer({
      dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(),
      port: 0, embed: stubEmbed, userId: USER,
    });

    // H1: health
    const health = await fetch(`${url}/health`).then((r) => r.json());
    rec('H1. GET /health → { ok:true, dim:768 }',
      health.ok === true && health.dim === EMBED_DIM, JSON.stringify(health));

    // H2: POST /enrich-all drains pending rows over HTTP
    await sdb.messages.insert({ id: 'h-1', user_id: USER, role: 'user', content: 'http drain one', source: 'verify', agent_id: 'personal-agent', scope: 'org' });
    await sdb.messages.insert({ id: 'h-2', user_id: USER, role: 'user', content: 'http drain two', source: 'verify', agent_id: 'personal-agent', scope: 'org' });
    const drainRes = await fetch(`${url}/enrich-all`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: USER }),
    });
    const drainBody = await drainRes.json();
    rec('H2. POST /enrich-all → 200 { embedded:2 }',
      drainRes.status === 200 && drainBody.embedded === 2 && drainBody.scanned === 2,
      `status=${drainRes.status} body=${JSON.stringify(drainBody)}`);
    rec('H2b. rows embedded over HTTP (nlp_processed 0→2)',
      rawState('h-1').nlp_processed === 2 && rawState('h-2').nlp_processed === 2);

    // H3: malformed JSON → 400 (honest reject, no crash)
    const bad = await fetch(`${url}/enrich-all`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    rec('H3. malformed JSON body → 400', bad.status === 400, `status=${bad.status}`);

    // H4: unknown route → 404
    const nf = await fetch(`${url}/nope`);
    rec('H4. unknown route → 404', nf.status === 404, `status=${nf.status}`);

    // H5: the full ingestion loop — fire the REAL fire-and-forget enqueue nudge
    // at the live :8095 server and confirm it drains the queued row.
    await sdb.messages.insert({ id: 'h-loop', user_id: USER, role: 'user', content: 'the end to end nudge loop', source: 'verify', agent_id: 'personal-agent', scope: 'org' });
    createEnqueueEnrichment({ userId: USER, url })('h-loop');
    let looped = false;
    for (let i = 0; i < 40 && !looped; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (rawState('h-loop').nlp_processed === 2) looped = true;
    }
    rec('H5. full loop: enqueueEnrichment nudge → :8095 /enrich-all → row embedded',
      looped, `nlp_processed=${rawState('h-loop').nlp_processed}`);

    closeSrv();
  }

  // ── Layer 3: the `--enrich` entry point actually launches the listener ────
  // Spawn the real process (npm run start:enrich path) against a temp db on a
  // random port and confirm GET /health answers — proves the CLI dispatch +
  // MYCELIUM_ENRICH_PORT knob wire up, not just the in-process factory.
  {
    const SDB = 'data/verify-enrich-smoke.db';
    const SKCV = 'data/verify-enrich-smoke-kcv.json';
    for (const f of [SDB, SKCV, `${SDB}-shm`, `${SDB}-wal`]) { try { rmSync(f); } catch {} }
    const d = new Database(SDB); applyMigrations(d); d.close();
    const SMOKE_PORT = 20000 + Math.floor(Math.random() * 15000);

    let stderr = '';
    const child = spawn(process.execPath, ['src/index.js', '--enrich'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MYCELIUM_DB: SDB,
        MYCELIUM_KCV: SKCV,
        USER_MASTER_KEY: hex(),
        SYSTEM_KEY: hex(),
        MYCELIUM_ENRICH_PORT: String(SMOKE_PORT),
        ENCRYPTION_MASTER_KEY: '', // force the child to use USER_MASTER_KEY, not a leaked parent key
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    let up = null;
    for (let i = 0; i < 100 && up === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        const r = await fetch(`http://127.0.0.1:${SMOKE_PORT}/health`);
        if (r.ok) up = await r.json();
      } catch { /* not listening yet */ }
    }
    rec('L1. `node src/index.js --enrich` boots + GET /health → { ok, dim:768 }',
      up && up.ok === true && up.dim === EMBED_DIM,
      up ? JSON.stringify(up) : `no /health after 5s; stderr="${stderr.slice(0, 200)}"`);

    child.kill('SIGTERM');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 1000); });
    for (const f of [SDB, SKCV, `${SDB}-shm`, `${SDB}-wal`]) { try { rmSync(f); } catch {} }
  }

  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }

  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO — D7 enrichment: drainOnce writes decryptable vector envelopes + isolates poison rows + fails closed; the :8095 listener drains over HTTP, closes the ingestion→enrich loop, and launches from `node src/index.js --enrich`' : 'NO-GO — see FAIL rows'}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-enrich threw:', e); process.exit(1); });
