#!/usr/bin/env node
// REST-surface proof: boot the shared assembly, serve REST on an ephemeral
// localhost port, and exercise the API end-to-end over real HTTP. PASS/FAIL
// ledger; exits 0 only on full GO.
//
// Setup mirrors verify-mcp.mjs: load the 111-table schema into a fresh db and
// provide two random hex keys, since boot() fails closed without them.
import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-rest.db';
const KCV = 'data/verify-rest-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');

const ledger = [];
let allPass = true;
function check(name, cond) {
  const ok = !!cond;
  allPass = allPass && ok;
  ledger.push(`[${ok ? '✓' : '✗'}] ${name}`);
}

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
new Database(DB).exec(readFileSync('migrations/0001_init.sql', 'utf8'));

let started;
try {
  started = await startRestServer({
    dbPath: DB,
    kcvPath: KCV,
    userHex: hex(),
    systemHex: hex(),
    port: 0,
    host: '127.0.0.1',
  });
  const { url } = started;

  // 1. GET /api/v1/tools — lists registered tools.
  const toolsRes = await fetch(`${url}/api/v1/tools`);
  const toolsBody = await toolsRes.json();
  check('GET /api/v1/tools → 200', toolsRes.status === 200);
  check('tools list ok:true', toolsBody.ok === true);
  check('tools is non-empty array', Array.isArray(toolsBody.tools) && toolsBody.tools.length > 0);
  check(
    'createTask listed with description + inputSchema',
    toolsBody.tools.some(
      (t) => t.name === 'createTask' && typeof t.description === 'string' && typeof t.inputSchema === 'object'
    )
  );

  // 2. POST /api/v1/createTask {content:"rest e2e"} → { ok:true, result:"..." }
  const createRes = await fetch(`${url}/api/v1/createTask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'rest e2e' }),
  });
  const createBody = await createRes.json();
  check('POST createTask → 200', createRes.status === 200);
  check('createTask ok:true', createBody.ok === true);
  check('createTask result is non-empty string', typeof createBody.result === 'string' && createBody.result.length > 0);

  // 3. POST /api/v1/no_such_tool → 404
  const unknownRes = await fetch(`${url}/api/v1/no_such_tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const unknownBody = await unknownRes.json();
  check('POST unknown tool → 404', unknownRes.status === 404);
  check('unknown tool ok:false', unknownBody.ok === false);

  // 4. Non-object body → 400 (body validation).
  const badRes = await fetch(`${url}/api/v1/createTask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(['not', 'an', 'object']),
  });
  const badBody = await badRes.json();
  check('POST non-object body → 400', badRes.status === 400);
  check('non-object body ok:false', badBody.ok === false);

  // 5. Malformed JSON → 400 with safe JSON envelope (no HTML / stack leak).
  const malformedRes = await fetch(`${url}/api/v1/createTask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not valid json',
  });
  const malformedCt = malformedRes.headers.get('content-type') || '';
  const malformedBody = await malformedRes.json();
  check('POST malformed JSON → 400', malformedRes.status === 400);
  check('malformed JSON returns JSON envelope', malformedCt.includes('application/json'));
  check('malformed JSON ok:false', malformedBody.ok === false);
} catch (err) {
  allPass = false;
  ledger.push(`[✗] fatal: ${String(err?.message ?? err)}`);
} finally {
  if (started?.server) await new Promise((r) => started.server.close(r));
  if (typeof started?.close === 'function') started.close();
}

process.stdout.write(ledger.join('\n') + '\n');
process.stdout.write('='.repeat(64) + '\n');
process.stdout.write(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}\n`);
process.exit(allPass ? 0 : 1);
