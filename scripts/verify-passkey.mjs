// scripts/verify-passkey.mjs — passkey (WebAuthn) auth plugin (Phase 5.3).
//
// Boots the REAL createAuth() (with @better-auth/passkey wired) + migrateAuth,
// mounts the better-auth handler, and asserts the server side: the login-challenge
// endpoint works and derives the per-box rpID from baseURL, enrollment is
// auth-gated, and the verify endpoints exist. The full browser/device WebAuthn
// ceremony (register a credential with a real authenticator) is the host/device
// smoke (Spike S2) — not deterministically scriptable here.
import { readFileSync } from 'node:fs';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { createAuth, migrateAuth, ensurePasskeyLastUsedColumn } from '../src/auth.js';

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); } };

process.env.MYCELIUM_AUTH_SECRET = 'verify-passkey-secret-'.padEnd(48, 'x');
const RP = 'alice.mycelium.id';
const origin = `https://${RP}`;

const app = express();
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const { auth, database } = createAuth({ baseURL: origin, dbPath: ':memory:' });
  await migrateAuth(auth); // creates the plugin's passkey table (additive)
  ok(true, 'createAuth() with passkey plugin builds + migrates');
  app.all('/api/auth/*splat', toNodeHandler(auth));

  // last_used_at tracking (Settings passkey panel) — the app-local column better-auth
  // doesn't ship. ensurePasskeyLastUsedColumn adds it; must be idempotent.
  const hasCol = () => database.prepare('PRAGMA table_info(passkey)').all().some((c) => c.name === 'last_used_at');
  ok(!hasCol(), 'passkey.last_used_at absent before ensure (better-auth ships no such field)');
  ensurePasskeyLastUsedColumn(database);
  ok(hasCol(), 'ensurePasskeyLastUsedColumn adds last_used_at');
  let idempotent = true; try { ensurePasskeyLastUsedColumn(database); } catch { idempotent = false; }
  ok(idempotent && hasCol(), 'ensurePasskeyLastUsedColumn is idempotent (safe on every boot)');

  const get = (p) => fetch(`${base}${p}`, { headers: { origin } });
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body || {}) });

  // 1. Login challenge (usernameless / discoverable) — GET, must work pre-auth.
  const r1 = await get('/api/auth/passkey/generate-authenticate-options');
  const o1 = await r1.json().catch(() => ({}));
  ok(r1.status === 200, 'generate-authenticate-options (GET) → 200 (login challenge)', `(${r1.status})`);
  ok(o1?.rpId === RP, 'rpId derives PER-BOX from baseURL', `(${o1?.rpId})`);
  ok(typeof o1?.challenge === 'string' && o1.challenge.length > 0, 'challenge issued');

  // 2. Enrollment options require an existing session → unauth must NOT succeed.
  const r2 = await get('/api/auth/passkey/generate-register-options');
  ok(r2.status !== 200, 'generate-register-options is auth-gated (unauth not 200)', `(${r2.status})`);

  // 3. The verify endpoints exist (wired), not 404.
  for (const p of ['verify-registration', 'verify-authentication']) {
    const r = await post(`/api/auth/passkey/${p}`, {});
    ok(r.status !== 404, `/passkey/${p} endpoint exists (not 404)`, `(${r.status})`);
  }

  // 4. Settings-panel management surface (server-http.js) — source-level guards.
  //    The enriched list endpoint must be session-gated + scoped to the caller's
  //    own rows, never returning another account's credentials.
  const srvHttp = readFileSync(new URL('../src/server-http.js', import.meta.url), 'utf8');
  const startIdx = srvHttp.indexOf("app.get('/api/auth/passkeys'");
  const endIdx = srvHttp.indexOf("app.all('/api/auth/*splat'", startIdx);
  const listBlock = startIdx >= 0 && endIdx > startIdx ? srvHttp.slice(startIdx, endIdx) : '';
  ok(startIdx >= 0, 'GET /api/auth/passkeys list endpoint mounted');
  ok(/getSession\(/.test(listBlock) && /401/.test(listBlock), 'list endpoint is session-gated (getSession → 401)');
  ok(/WHERE userId = \?/.test(listBlock) && /session\.user\.id/.test(listBlock), 'list endpoint scopes rows to the authenticated user');
  ok(!/credential_?id|publicKey|public_key/i.test(listBlock), 'list endpoint never returns credentialID / public key');
  ok(/ensurePasskeyLastUsedColumn\(/.test(srvHttp), 'last_used_at column ensured after migrateAuth');

  // 5. The last_used stamp runs AFTER better-auth's own verification (afterVerification
  //    hook), so it cannot weaken the auth check, and keys off the credentialID.
  const authSrc = readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
  ok(/afterVerification:/.test(authSrc), 'passkey config wires authentication.afterVerification (post-verify hook)');
  ok(/UPDATE passkey SET last_used_at = \? WHERE credentialID = \?/.test(authSrc), 'afterVerification stamps last_used_at by credentialID');
} catch (err) {
  ok(false, `boot/integration failed: ${String(err?.message || err).slice(0, 160)}`);
} finally {
  try { server.close(); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO'); process.exit(0);
