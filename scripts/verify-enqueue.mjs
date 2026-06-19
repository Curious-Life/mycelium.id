// Enrichment hand-off verifier (ingestion Step 5). Proves the enqueue nudge is
// truly fire-and-forget:
//   E1 service ABSENT — enqueueEnrichment(id) never throws / never blocks capture
//   E2 service UP (mock) — receives POST /enrich-all with { userId, messageId }
//   E3 captureMessage completes normally even when the nudge target is down
import { createServer } from 'node:http';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { createEnqueueEnrichment } from '../src/ingest/enqueue.js';

const ledger = [];
const rec = (n, pass, d) => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// E1: service absent (nothing listening on a dead port) → no throw, returns sync.
{
  const enqueue = createEnqueueEnrichment({ userId: 'local-user', url: 'http://127.0.0.1:9' });
  let threw = false;
  const t0 = Date.now();
  try { enqueue('msg-1'); } catch { threw = true; }
  const sync = Date.now() - t0 < 50; // returned immediately, didn't await the fetch
  await sleep(150); // let the detached promise reject internally
  rec('E1. service absent — enqueue is non-throwing + non-blocking', !threw && sync,
    `threw=${threw} returnedSync=${sync}`);
}

// E2: mock service up → receives POST /enrich-all with the expected body.
{
  let received = null;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received = { method: req.method, url: req.url, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => srv.listen(8795, '127.0.0.1', r));
  const enqueue = createEnqueueEnrichment({ userId: 'tester', url: 'http://127.0.0.1:8795' });
  enqueue('msg-42');
  await sleep(200);
  srv.close();
  let parsed = {};
  try { parsed = JSON.parse(received?.body || '{}'); } catch { /* */ }
  rec('E2. service up — receives POST /enrich-all { userId, messageId }',
    received?.method === 'POST' && received?.url === '/enrich-all'
      && parsed.userId === 'tester' && parsed.messageId === 'msg-42',
    `method=${received?.method} url=${received?.url} body=${received?.body}`);
}

// E3: captureMessage completes normally even with the nudge target down.
{
  const DB = 'data/verify-enqueue.db';
  const KCV = 'data/verify-enqueue-kcv.json';
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  applyMigrations(new Database(DB));
  process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const { boot } = await import('../src/index.js');
  const userHex = crypto.randomBytes(32).toString('hex');
  const systemHex = crypto.randomBytes(32).toString('hex');
  // point enqueue at a dead port via env so the nudge fails
  process.env.MYCELIUM_ENRICH_URL = 'http://127.0.0.1:9';
  const { handlers, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex });
  let ok = false, detail = '';
  try {
    const r = await handlers.captureMessage({ content: 'enqueue-e3', source: 'verify' });
    ok = /Captured/.test(r);
    detail = `reply="${r.slice(0, 40)}"`;
  } catch (e) { detail = `THREW: ${e.message}`; }
  await sleep(150);
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  rec('E3. captureMessage succeeds despite a down enrichment service', ok, detail);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — enrichment hand-off is fire-and-forget + non-fatal when absent' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
