// verify:mcp-discovery — proves the OAuth/MCP DISCOVERY surface matches what
// Claude's connector requires (RFC 9728 §3.1 + MCP spec 2025-11-25 + the shape
// every production server that works with Claude uses — Sentry/Linear/Notion/
// GitHub): a PATH-SUFFIXED protected-resource-metadata document, a MINIMAL body
// (no openid/scopes/signing-alg), CORS (+ OPTIONS preflight), and a 401
// WWW-Authenticate whose `resource_metadata` points at the SUFFIXED URL. Also
// checks the AS metadata no longer advertises `openid`.
//
// Spawns src/index.js --http on a throwaway in-memory auth db + a migrated
// throwaway vault db (the verify-oauth topology). Never logs a secret.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
process.chdir(ROOT); // applyMigrations() + other relative paths resolve from repo root
const PORT = Number(process.env.MYCELIUM_PORT) || 4798;
const BASE = `http://localhost:${PORT}`;
const VAULT_DB = join(ROOT, 'data', 'verify-mcpdisc.db');
const VAULT_KCV = join(ROOT, 'data', 'verify-mcpdisc-kcv.json');
const hex = () => randomBytes(32).toString('hex');

const log = [];
let allPass = true;
const check = (name, ok, extra = '') => {
  allPass = allPass && ok;
  log.push(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`);
};

function seedVaultDb() {
  for (const f of [VAULT_DB, VAULT_KCV, `${VAULT_DB}-shm`, `${VAULT_DB}-wal`]) {
    try { rmSync(f); } catch { /* ignore */ }
  }
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const db = new Database(VAULT_DB);
  applyMigrations(db);
  db.close();
}

async function startServer() {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js'), '--http'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MYCELIUM_HTTP: '1',
      MYCELIUM_PORT: String(PORT),
      MYCELIUM_BASE_URL: BASE,
      MYCELIUM_AUTH_SECRET: 'verify-secret-not-for-prod-00000000000000',
      MYCELIUM_AUTH_DB: ':memory:',
      MYCELIUM_DB: VAULT_DB,
      MYCELIUM_KCV: VAULT_KCV,
      USER_MASTER_KEY: hex(),
      SYSTEM_KEY: hex(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (/listening on/i.test(out)) return child;
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${out}`);
}

const SUFFIXED = `${BASE}/.well-known/oauth-protected-resource/mcp`;
const ROOTPRM = `${BASE}/.well-known/oauth-protected-resource`;

function assertMinimalPrm(name, body) {
  const ok =
    body && typeof body === 'object' &&
    typeof body.resource === 'string' && body.resource.endsWith('/mcp') &&
    Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0 &&
    Array.isArray(body.bearer_methods_supported) && body.bearer_methods_supported.includes('header') &&
    !('scopes_supported' in body) &&
    !('resource_signing_alg_values_supported' in body) &&
    !('openid' in body);
  check(name, ok, JSON.stringify(body));
}

async function main() {
  seedVaultDb();
  const child = await startServer();
  try {
    // 1. Path-suffixed PRM (what Claude probes first) — 200 + minimal + CORS.
    const r1 = await fetch(SUFFIXED);
    const b1 = await r1.json().catch(() => null);
    check('suffixed PRM 200', r1.status === 200, `status=${r1.status}`);
    assertMinimalPrm('suffixed PRM minimal body (no openid/scopes/signing-alg)', b1);
    check('suffixed PRM CORS ACAO:*', r1.headers.get('access-control-allow-origin') === '*');

    // 2. Root PRM — also served, identical minimal body.
    const r2 = await fetch(ROOTPRM);
    const b2 = await r2.json().catch(() => null);
    check('root PRM 200', r2.status === 200, `status=${r2.status}`);
    assertMinimalPrm('root PRM minimal body', b2);

    // 3. OPTIONS preflight on the suffixed PRM → 204 + ACAO.
    const r3 = await fetch(SUFFIXED, {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.ai', 'access-control-request-method': 'GET' },
    });
    check('OPTIONS suffixed PRM → 204 + ACAO', r3.status === 204 && r3.headers.get('access-control-allow-origin') === '*', `status=${r3.status}`);

    // 4. /mcp 401 with WWW-Authenticate → SUFFIXED resource_metadata.
    const r4 = await fetch(`${BASE}/mcp`, { method: 'GET' });
    const wa = r4.headers.get('www-authenticate') || '';
    check('/mcp (no token) → 401', r4.status === 401, `status=${r4.status}`);
    check('WWW-Authenticate resource_metadata → suffixed URL', wa.includes(`resource_metadata="${SUFFIXED}"`), wa);

    // 5. AS metadata still served, and scopes_supported no longer advertises openid.
    const r5 = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    const b5 = await r5.json().catch(() => ({}));
    const scopes = b5.scopes_supported || [];
    check('AS metadata 200', r5.status === 200, `status=${r5.status}`);
    check('AS metadata advertises NO openid', Array.isArray(scopes) && !scopes.includes('openid'), JSON.stringify(scopes));

    // 6. OPTIONS /mcp preflight → 204.
    const r6 = await fetch(`${BASE}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://claude.ai' } });
    check('OPTIONS /mcp → 204', r6.status === 204, `status=${r6.status}`);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 1500))]);
    for (const f of [VAULT_DB, VAULT_KCV, `${VAULT_DB}-shm`, `${VAULT_DB}-wal`]) {
      try { rmSync(f); } catch { /* ignore */ }
    }
  }
  console.log('\n=== MCP DISCOVERY VERIFY LEDGER ===');
  console.log(log.join('\n'));
  console.log(`\nVERDICT: ${allPass ? 'GO' : 'NO-GO'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  console.log('\nVERDICT: NO-GO');
  process.exit(1);
});
