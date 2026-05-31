// OAuth 2.1 + Streamable-HTTP remote-transport proof (Wave 2). PASS/FAIL ledger.
//
// Starts the REAL src/server-http.js (startHttpServer) on an ephemeral port and
// drives the full MCP remote OAuth flow an unmodified client would:
//   discovery -> DCR -> user sign-in -> PKCE(S256) authorize (+consent if the
//   provider requires it) -> token -> unauthenticated /mcp rejected (fail
//   closed) -> Bearer /mcp initialize -> tools/list + a real tools/call over
//   the authenticated HTTP Streamable transport.
//
// Adapted from spike/oauth/probe.mjs (the proven sequence). Exits 0 only on a
// full GO.
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ledger = [];
const rec = (name, pass, detail) => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail ?? ''}`);
};
const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// --- Test env: ephemeral port, throwaway vault + auth DBs, seeded user. Set
//     BEFORE importing src/* so boot()/loadHttpConfig pick it up. ---
const PORT = 4400 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'verify-oauth@mycelium.local';
const PASSWORD = 'Verify-Passw0rd-123';
const REDIRECT = 'http://localhost:9999/cb';
const hex = () => crypto.randomBytes(32).toString('hex');

const VAULT = `data/verify-oauth-${PORT}.db`;
const KCV = `data/verify-oauth-${PORT}-kcv.json`;
const AUTH_DB = `data/verify-oauth-${PORT}-auth.db`;
const cleanup = () => {
  for (const f of [
    VAULT, `${VAULT}-shm`, `${VAULT}-wal`, KCV,
    AUTH_DB, `${AUTH_DB}-shm`, `${AUTH_DB}-wal`,
  ]) {
    try { rmSync(f); } catch { /* ignore */ }
  }
};
mkdirSync('data', { recursive: true });
cleanup();

// Load the 111-table schema into the throwaway vault BEFORE boot() opens it
// (the encrypting adapter expects the tables to exist; mirrors verify-mcp.mjs).
new Database(VAULT).exec(readFileSync('migrations/0001_init.sql', 'utf8'));

// Vault unlock (boot() requires both hex keys; fail closed otherwise).
process.env.USER_MASTER_KEY = hex();
process.env.SYSTEM_KEY = hex();
process.env.MYCELIUM_DB = VAULT;
process.env.MYCELIUM_KCV = KCV;
// HTTP / OAuth.
process.env.MYCELIUM_HTTP_PORT = String(PORT);
process.env.MYCELIUM_HTTP_HOST = '127.0.0.1';
process.env.MYCELIUM_BASE_URL = BASE;
process.env.MYCELIUM_AUTH_DB = AUTH_DB;
process.env.MYCELIUM_AUTH_SECRET = 'verify-secret-0123456789abcdef0123456789ab';
process.env.MYCELIUM_USER_EMAIL = EMAIL;
process.env.MYCELIUM_USER_PASSWORD = PASSWORD;

const { startHttpServer } = await import('../src/server-http.js');

let httpServer;
let transport;

async function main() {
  httpServer = await startHttpServer();

  // 1 — DISCOVERY (root well-known, RFC 8414).
  const disc = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  const s256 = (disc.code_challenge_methods_supported || []).includes('S256');
  rec(
    '1. discovery doc (AS metadata at root)',
    !!disc.token_endpoint && !!disc.authorization_endpoint && !!disc.registration_endpoint && s256,
    `token=${disc.token_endpoint} S256=${s256}`,
  );

  // 1b — PROTECTED-RESOURCE metadata (root well-known, RFC 9728).
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  rec('1b. protected-resource metadata (at root)', !!prm.resource, `resource=${prm.resource}`);

  // 2 — DCR (RFC 7591): register a brand-new public client.
  const regRes = await fetch(disc.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({
      client_name: 'verify-oauth',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const reg = await regRes.json();
  rec('2. DCR auto-accept (public client)', regRes.status < 300 && !!reg.client_id, `client_id=${reg.client_id}`);

  // 3 — Authenticate the single (seeded) user -> session cookie.
  const signInRes = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const cookie = (signInRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  rec('3. single-user sign-in', signInRes.ok && /session/i.test(cookie), `status=${signInRes.status}`);

  // 4 — PKCE S256 authorize (+ consent if required) -> auth code.
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const authUrl = new URL(disc.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'openid profile',
    state: 'verify-state',
  })) {
    authUrl.searchParams.set(k, v);
  }
  const authRes = await fetch(authUrl, { headers: { cookie, origin: BASE }, redirect: 'manual' });
  // The mcp/oidc provider may answer authorize as an HTTP 302 (Location header)
  // OR, in newer better-auth, a 200 JSON body { redirect: true, url } (no
  // consent needed for the single-user default). If consent IS required it
  // returns { redirect: false } — drive /oauth2/consent then.
  const pickUrl = (raw) => {
    if (!raw || typeof raw !== 'string') return null;
    try { return new URL(raw, BASE); } catch { return null; }
  };
  let redirectUrl = null;
  if (authRes.status === 302 || authRes.status === 303) {
    redirectUrl = pickUrl(authRes.headers.get('location'));
  } else {
    let body = {};
    try { body = await authRes.json(); } catch { body = {}; }
    if (body.url) {
      redirectUrl = pickUrl(body.url);
    } else {
      const consent = await fetch(`${BASE}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE, cookie },
        body: JSON.stringify({ accept: true }),
      }).then((r) => r.json()).catch(() => ({}));
      redirectUrl = pickUrl(consent.url);
    }
  }
  const code = redirectUrl?.searchParams.get('code');
  rec(
    '4. PKCE S256 authorize -> code',
    !!code && redirectUrl?.searchParams.get('state') === 'verify-state',
    `authorize status=${authRes.status} code=${code ? code.slice(0, 10) + '…' : '(none)'}`,
  );

  // 5 — Token exchange with the PKCE verifier.
  const tokRes = await fetch(disc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      code_verifier: verifier,
    }),
  });
  const tok = await tokRes.json();
  const accessToken = tok.access_token;
  rec(
    '5. token (PKCE S256 verified)',
    tokRes.ok && !!accessToken && String(tok.token_type).toLowerCase() === 'bearer',
    `status=${tokRes.status} token_type=${tok.token_type}`,
  );

  // 6 — Unauthenticated /mcp must be rejected (fail closed).
  const noAuth = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: BASE },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
    }),
  });
  const www = noAuth.headers.get('www-authenticate') || '';
  rec(
    '6. unauthenticated /mcp rejected (401 + WWW-Authenticate)',
    noAuth.status === 401 && www.toLowerCase().includes('resource_metadata'),
    `status=${noAuth.status} www-authenticate=${www ? 'present' : 'MISSING'}`,
  );

  // 7 — Bearer /mcp: initialize + tools/list over the authenticated HTTP
  //     Streamable transport (driven by the real MCP SDK client).
  transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: 'verify-oauth', version: '0.0.0' });
  await client.connect(transport); // performs initialize over Bearer /mcp
  rec('7. Bearer /mcp initialize (200, session established)', !!transport.sessionId, `session=${transport.sessionId}`);

  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name);
  rec(
    '8. tools/list over authenticated HTTP',
    names.length > 0 && names.includes('createTask'),
    `${names.length} tools: ${names.join(', ')}`,
  );

  // 9 — A real tool call over the authenticated transport.
  const made = await client.callTool({ name: 'createTask', arguments: { content: 'verify-oauth e2e task' } });
  const text = made.content?.[0]?.text ?? '';
  rec(
    '9. authenticated tools/call round-trip',
    made.content?.[0]?.type === 'text' && text.length > 0 && !made.isError,
    `createTask -> '${text.slice(0, 50)}'`,
  );

  await client.close();
}

main()
  .catch((err) => {
    ledger.push(false);
    console.log(`FAIL  uncaught\n      ${err?.stack ?? err?.message ?? err}`);
  })
  .finally(() => {
    try { httpServer?.close(); } catch { /* ignore */ }
    cleanup();
    const allPass = ledger.length > 0 && ledger.every(Boolean);
    console.log('\n' + '='.repeat(64));
    console.log(`VERDICT: ${allPass ? 'GO — remote OAuth + Streamable-HTTP transport works end-to-end' : 'NO-GO — see FAIL rows'} EXIT=${allPass ? 0 : 1}`);
    console.log('='.repeat(64));
    process.exit(allPass ? 0 : 1);
  });
