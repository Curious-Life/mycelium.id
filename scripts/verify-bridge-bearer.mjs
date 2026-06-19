// verify:bridge-bearer — the memory-bridge resolves its bearer from the local
// app's auth.db when MYCELIUM_MCP_BEARER isn't in env (PR #177 client side), so the
// hooks need ZERO env setup. Asserts: auth.db fallback, env-first precedence, and
// graceful no-op when neither is available. Each scenario runs in a fresh node
// subprocess (the bridge caches the resolved bearer per-process).
import http from 'node:http';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// stub server records the last Authorization header it saw
let lastAuth = null, hits = 0;
const server = http.createServer((req, res) => {
  hits += 1; lastAuth = req.headers.authorization || null;
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: 'ok' })); });
});
const base = await new Promise((r) => { const s = server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)); });

const dir = mkdtempSync(join(tmpdir(), 'brb-'));
// an auth.db with a provisioned bearer (as resolveMcpBearer would persist)
const DBP = join(dir, 'auth.db');
const AUTHDB_BEARER = 'authdb-bearer-' + 'a'.repeat(40);
const db = new Database(DBP);
db.exec('CREATE TABLE mycelium_mcp_bearer (id INTEGER PRIMARY KEY CHECK (id=1), bearer TEXT NOT NULL)');
db.prepare('INSERT INTO mycelium_mcp_bearer (id, bearer) VALUES (1, ?)').run(AUTHDB_BEARER);
db.close();

const BRIDGE = join(process.cwd(), 'tools/memory-bridge/bridge.mjs');
// run capture() once in a fresh node with the given env; return the Authorization the stub saw
async function runCapture(extraEnv) {
  lastAuth = null; const before = hits;
  const env = { ...process.env, MYCELIUM_BASE_URL: base, ...extraEnv };
  delete env.MYCELIUM_MCP_BEARER; // start clean; scenarios re-add if needed
  if (extraEnv.MYCELIUM_MCP_BEARER) env.MYCELIUM_MCP_BEARER = extraEnv.MYCELIUM_MCP_BEARER;
  const driver = `import('${BRIDGE}').then(async (b) => { await b.capture({ content: 'x', role: 'user', source: 'claude-code', id: 't' }); process.exit(0); }).catch(() => process.exit(0));`;
  await new Promise((resolve) => {
    const cp = spawn('node', ['--input-type=module', '-e', driver], { env });
    cp.on('close', () => resolve());
  });
  return { auth: lastAuth, requested: hits > before };
}

// 1 — auth.db fallback (no env bearer)
let r = await runCapture({ MYCELIUM_AUTH_DB: DBP });
rec('B1. no env bearer → reads auth.db bearer', r.auth === `Bearer ${AUTHDB_BEARER}`, r.auth || '(no request)');

// 2 — env-first precedence (env wins over auth.db)
const ENVTOK = 'env-wins-' + 'e'.repeat(30);
r = await runCapture({ MYCELIUM_AUTH_DB: DBP, MYCELIUM_MCP_BEARER: ENVTOK });
rec('B2. env MYCELIUM_MCP_BEARER wins over auth.db', r.auth === `Bearer ${ENVTOK}`, r.auth || '(no request)');

// 3 — graceful: neither env nor a readable auth.db → no request, no throw
r = await runCapture({ MYCELIUM_AUTH_DB: join(dir, 'does-not-exist.db') });
rec('B3. no env + no auth.db → no-op (no request, no crash)', r.requested === false, r.requested ? 'made a request' : 'silent');

server.close();
try { rmSync(dir, { recursive: true, force: true }); } catch {}
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(66));
console.log(`VERDICT: ${allPass ? 'GO — bridge bearer: auth.db fallback (zero-setup hooks) · env-first · graceful no-op' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(66));
process.exit(allPass ? 0 : 1);
