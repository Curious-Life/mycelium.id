import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader, decodeJwt } from 'jose';
import crypto from 'node:crypto';
const BASE = 'https://0m.mycelium.id';
const PW = process.argv[2];
const REDIRECT = 'http://localhost:9999/cb';
const b64url = (b) => Buffer.from(b).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const L = (...a) => console.log(...a);

const reg = await fetch(`${BASE}/api/auth/mcp/register`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
  body: JSON.stringify({ client_name: 'probe', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'openid profile email offline_access' }),
});
const regJson = await reg.json();
L('1. register →', reg.status, 'client_id=', regJson.client_id);
const clientId = regJson.client_id;

const si = await fetch(`${BASE}/api/auth/sign-in/email`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
  body: JSON.stringify({ email: 'operator@mycelium.local', password: PW }), redirect: 'manual',
});
const sc = si.headers.getSetCookie ? si.headers.getSetCookie() : [si.headers.get('set-cookie')].filter(Boolean);
const cookie = sc.map((c) => c.split(';')[0]).join('; ');
L('2. sign-in →', si.status, cookie ? '(cookie ok)' : '(NO COOKIE)', si.status >= 400 ? (await si.text()).slice(0, 200) : '');
if (!cookie) process.exit(1);

async function run(label, scope) {
  L(`\n=== ${label}  scope="${scope}" ===`);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(sha256(verifier));
  const qs = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope, state: 'st', resource: `${BASE}/mcp` });
  const az = await fetch(`${BASE}/api/auth/mcp/authorize?${qs}`, { headers: { cookie }, redirect: 'manual' });
  const loc = az.headers.get('location') || '';
  L('  authorize →', az.status, 'loc=', loc.slice(0, 90));
  const code = loc ? new URL(loc, BASE).searchParams.get('code') : null;
  if (!code) { L('  NO CODE. body:', (await az.text()).slice(0, 200)); return; }
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${BASE}/mcp` });
  const tk = await fetch(`${BASE}/api/auth/mcp/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE }, body: form });
  const tj = await tk.json().catch(() => ({}));
  L('  token →', tk.status, 'fields=[' + Object.keys(tj).join(',') + ']');
  const at = tj.access_token, idt = tj.id_token;
  L('  access_token:', at ? `len=${at.length} jwt=${at.split('.').length === 3}` : 'NONE');
  if (idt) {
    const hdr = decodeProtectedHeader(idt), pl = decodeJwt(idt);
    L('  id_token: alg=' + hdr.alg, 'kid=' + (hdr.kid || '-'), 'aud=' + JSON.stringify(pl.aud), 'iss=' + pl.iss);
    try { await jwtVerify(idt, createRemoteJWKSet(new URL(`${BASE}/api/auth/mcp/jwks`))); L('  id_token verify vs JWKS: ✅ PASS'); }
    catch (e) { L('  id_token verify vs JWKS: ❌ FAIL —', e.code || e.message); }
  } else L('  id_token: (none returned)');
  const mcp = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }) });
  L('  /mcp initialize (Bearer) →', mcp.status, '|', (await mcp.text()).slice(0, 220).replace(/\s+/g, ' '));
}
await run('A: with openid', 'openid profile email offline_access');
await run('B: no openid', 'profile email');
