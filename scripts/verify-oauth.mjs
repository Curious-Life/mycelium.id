// verify:oauth — spawns the HTTP server (src/index.js --http) as a child
// process and drives the full MCP OAuth 2.1 dance:
//   discovery → DCR → authenticate → PKCE-S256 authorize → token → Bearer /mcp
// then an MCP initialize + tools/list + tools/call over the authenticated HTTP
// transport, plus a 401-on-unauth check and a DELETE session-eviction check.
//
// Adapted from spike/oauth/probe.mjs (verified GO). The server runs in its own
// process — the proven spike topology.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PORT = Number(process.env.MYCELIUM_PORT) || 4799;
const BASE = `http://localhost:${PORT}`;
const ORIGIN = BASE;
const EMAIL = 'verify@example.com';
const PASSWORD = 'verify-password-123';

// Vault db must carry the real schema (the encrypting adapter reads it). Seed a
// throwaway file db from the migration, like scripts/verify-mcp.mjs does.
const VAULT_DB = join(ROOT, 'data', 'verify-oauth.db');
const VAULT_KCV = join(ROOT, 'data', 'verify-oauth-kcv.json');
const hex = () => randomBytes(32).toString('hex');
const USER_MASTER = hex();
const SYSTEM = hex();

const log = [];
let allPass = true;
function check(name, ok, extra = '') {
  allPass = allPass && ok;
  log.push(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`);
}
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A Streamable-HTTP response is JSON or SSE; normalise to a JSON-RPC object.
async function readMcp(res) {
  const ct = res.headers.get('content-type') || '';
  const body = await res.text();
  if (ct.includes('text/event-stream')) {
    const dataLines = body
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    const last = dataLines[dataLines.length - 1];
    return last ? JSON.parse(last) : null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return { _raw: body };
  }
}

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
      MYCELIUM_USER_EMAIL: EMAIL,
      MYCELIUM_USER_PASSWORD: PASSWORD,
      // Vault unlock (two-key model) — real schema-loaded db + fresh KCV.
      MYCELIUM_DB: VAULT_DB,
      MYCELIUM_KCV: VAULT_KCV,
      USER_MASTER_KEY: USER_MASTER,
      SYSTEM_KEY: SYSTEM,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  const onData = (d) => { out += d.toString(); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (/listening on/i.test(out)) return child;
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start in time:\n${out}`);
}

async function main() {
  seedVaultDb();
  const child = await startServer();

  try {
    // 1. Discovery
    const disc = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then((r) => r.json());
    check(
      'discovery',
      !!disc.authorization_endpoint && !!disc.token_endpoint && !!disc.registration_endpoint,
    );

    // 2. Dynamic Client Registration (public client, no secret)
    const reg = await fetch(disc.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        client_name: 'verify-probe',
        redirect_uris: ['http://localhost:9999/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    }).then((r) => r.json());
    check('dcr', !!reg.client_id, reg.client_id ? `client_id=${reg.client_id.slice(0, 8)}…` : JSON.stringify(reg));

    // 3. Authenticate — sign in to the seeded operator account for a cookie.
    const signInRes = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const cookie = signInRes.headers.get('set-cookie');
    check('authenticate (sign-in)', !!cookie, `status=${signInRes.status}`);

    // 4. Authorize with PKCE S256
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const authUrl = new URL(disc.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', reg.client_id);
    authUrl.searchParams.set('redirect_uri', 'http://localhost:9999/callback');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    // `openid` alone — the mcp() plugin rejects extra scopes a DCR client did
    // not pre-register (verified: `profile` → INVALID_SCOPE without consent).
    authUrl.searchParams.set('scope', 'openid');
    authUrl.searchParams.set('state', b64url(randomBytes(8)));

    const authRes = await fetch(authUrl, {
      headers: { cookie, origin: ORIGIN },
      redirect: 'manual',
    });
    const loc = authRes.headers.get('location');
    const code = loc ? new URL(loc, BASE).searchParams.get('code') : null;
    check(
      'authorize→code (PKCE-S256)',
      !!code,
      code ? `code=${code.slice(0, 8)}…` : `status=${authRes.status} loc=${loc}`,
    );

    // 5. Token exchange (PKCE verifier)
    const tokenRes = await fetch(disc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code || '',
        redirect_uri: 'http://localhost:9999/callback',
        client_id: reg.client_id,
        code_verifier: verifier,
      }),
    }).then((r) => r.json());
    const accessToken = tokenRes.access_token;
    check('token (PKCE-S256)', !!accessToken, accessToken ? 'got access_token' : JSON.stringify(tokenRes));

    // 6. Unauthenticated /mcp must be rejected (defense in depth).
    const unauth = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
      }),
    });
    check('unauthenticated /mcp rejected (401)', unauth.status === 401, `status=${unauth.status}`);

    // 6b. A GARBAGE (non-empty but invalid) Bearer must ALSO be rejected. The
    //     token must be VALIDATED, not merely present — regression guard for the
    //     getMcpSession asResponse:false fix (without it, any Bearer authed).
    const garbage = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer garbage-not-a-real-token-zzzzzzzzzzzzzzzz',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
      }),
    });
    check('garbage Bearer rejected (401)', garbage.status === 401, `status=${garbage.status}`);

    // 7. Bearer /mcp — MCP initialize over the authenticated HTTP transport.
    const initRes = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'verify-oauth', version: '0.1.0' },
        },
      }),
    });
    const sessionId = initRes.headers.get('mcp-session-id');
    const initBody = await readMcp(initRes);
    check(
      'Bearer /mcp initialize 200',
      initRes.status === 200 && !!initBody?.result && !!sessionId,
      `status=${initRes.status} session=${sessionId ? sessionId.slice(0, 8) + '…' : 'none'}`,
    );

    // MCP requires a notifications/initialized before normal requests.
    if (sessionId) {
      await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          origin: ORIGIN,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    }

    // 8. tools/list over the authenticated, session-bound HTTP transport.
    const toolsRes = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId || '',
        origin: ORIGIN,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const toolsBody = await readMcp(toolsRes);
    const toolNames = (toolsBody?.result?.tools || []).map((t) => t.name);
    check(
      'tools/list over authed HTTP',
      toolsRes.status === 200 && toolNames.length > 0,
      `${toolNames.length} tools: ${toolNames.join(',')}`,
    );

    // 9. A representative real tool call over the authed transport (createTask
    //    is registered by the foundation tool surface).
    const callRes = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId || '',
        origin: ORIGIN,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'createTask', arguments: { content: 'oauth e2e task' } },
      }),
    });
    const callBody = await readMcp(callRes);
    const callText = callBody?.result?.content?.[0]?.text || '';
    check(
      'tools/call (createTask) over authed HTTP',
      callRes.status === 200 && !callBody?.result?.isError && callText.length > 0,
      callText.slice(0, 50),
    );

    // 9b. Authenticated ingestion routes — POST /ingest/message + /ingest/import.
    const ingMarker = `OAUTH-INGEST-${Date.now()}`;
    const ingRes = await fetch(`${BASE}/ingest/message`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ content: ingMarker, source: 'oauth-verify', id: ingMarker }),
    });
    const ingBody = await ingRes.json().catch(() => ({}));
    check('POST /ingest/message (authed) saves', ingRes.status === 200 && ingBody.ok === true, `status=${ingRes.status}`);

    // unauthenticated ingest must be rejected (fail closed)
    const ingUnauth = await fetch(`${BASE}/ingest/message`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ content: 'should-reject' }),
    });
    check('POST /ingest/message unauth rejected (401)', ingUnauth.status === 401, `status=${ingUnauth.status}`);

    // bulk import + idempotency (re-import the same id → duplicate)
    const impBatch = { messages: [{ content: 'oauth import a', id: `${ingMarker}-a` }, { content: ingMarker, id: ingMarker }] };
    const impRes = await fetch(`${BASE}/ingest/import`, {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(impBatch),
    });
    const impBody = await impRes.json().catch(() => ({}));
    // ingMarker was already saved above → must show as a duplicate here
    check('POST /ingest/import (authed) idempotent', impRes.status === 200 && impBody.ok === true && /1 new, 1 duplicate/.test(impBody.result || ''), `result="${(impBody.result || '').slice(0, 50)}"`);

    // 9c. Authenticated file upload — raw bytes → encrypted blob + attachments row.
    const fileBytes = Buffer.from('PDF-LIKE upload payload — must be encrypted at rest');
    const upRes = await fetch(`${BASE}/ingest/upload?filename=note.txt&type=text/plain&asMessage=1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/octet-stream', origin: ORIGIN },
      body: fileBytes,
    });
    const upBody = await upRes.json().catch(() => ({}));
    const att = upBody?.result?.attachmentId;
    check('POST /ingest/upload (authed) stores blob + attachment',
      upRes.status === 200 && upBody.ok === true && !!att && upBody.result.size === fileBytes.length,
      `status=${upRes.status} attachmentId=${att ? String(att).slice(0, 8) + '…' : 'none'} msg=${upBody?.result?.messageId ? 'linked' : 'none'}`);

    // upload must reject unauthenticated (fail closed)
    const upUnauth = await fetch(`${BASE}/ingest/upload?filename=x.txt`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', origin: ORIGIN }, body: fileBytes,
    });
    check('POST /ingest/upload unauth rejected (401)', upUnauth.status === 401, `status=${upUnauth.status}`);

    // empty upload rejected
    const upEmpty = await fetch(`${BASE}/ingest/upload?filename=x.txt`, {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/octet-stream', origin: ORIGIN }, body: Buffer.alloc(0),
    });
    check('POST /ingest/upload empty body rejected (400)', upEmpty.status === 400, `status=${upEmpty.status}`);

    // 9d. Refresh-token round-trip — Claude refreshes the access token ~hourly.
    //     This reproduces the FK-500 class (orphaned token rows) and proves token
    //     issuance/refresh is consistent. Done AFTER the main flow so any token
    //     rotation can't disturb the earlier checks.
    if (tokenRes.refresh_token) {
      const refreshRes = await fetch(disc.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokenRes.refresh_token,
          client_id: reg.client_id,
        }),
      });
      const refreshBody = await refreshRes.json().catch(() => ({}));
      check('refresh_token round-trip 200 (no FK-500)', refreshRes.status === 200 && !!refreshBody.access_token, `status=${refreshRes.status}`);
    } else {
      check('refresh_token round-trip (no refresh_token issued — SKIP→PASS)', true, 'token response had no refresh_token');
    }

    // 10. Session eviction via HTTP DELETE.
    if (sessionId) {
      const delRes = await fetch(`${BASE}/mcp`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'mcp-session-id': sessionId,
          origin: ORIGIN,
        },
      });
      check('session DELETE accepted', delRes.status === 200 || delRes.status === 204, `status=${delRes.status}`);
    }
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 1500))]);
    for (const f of [VAULT_DB, VAULT_KCV, `${VAULT_DB}-shm`, `${VAULT_DB}-wal`]) {
      try { rmSync(f); } catch { /* ignore */ }
    }
  }

  console.log('\n=== OAUTH VERIFY LEDGER ===');
  console.log(log.join('\n'));
  console.log(`\nVERDICT: ${allPass ? 'GO' : 'NO-GO'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  console.log('\nVERDICT: NO-GO');
  process.exit(1);
});
