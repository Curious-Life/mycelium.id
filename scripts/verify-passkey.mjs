// scripts/verify-passkey.mjs — passkey (WebAuthn) auth plugin (Phase 5.3).
//
// Boots the REAL createAuth() (with @better-auth/passkey wired) + migrateAuth,
// mounts the better-auth handler, and asserts the server side: the login-challenge
// endpoint works and derives the per-box rpID from baseURL, enrollment is
// auth-gated, and the verify endpoints exist. The full browser/device WebAuthn
// ceremony (register a credential with a real authenticator) is the host/device
// smoke (Spike S2) — not deterministically scriptable here.
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { createAuth, migrateAuth } from '../src/auth.js';

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
  const { auth } = createAuth({ baseURL: origin, dbPath: ':memory:' });
  await migrateAuth(auth); // creates the plugin's passkey table (additive)
  ok(true, 'createAuth() with passkey plugin builds + migrates');
  app.all('/api/auth/*splat', toNodeHandler(auth));

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
} catch (err) {
  ok(false, `boot/integration failed: ${String(err?.message || err).slice(0, 160)}`);
} finally {
  try { server.close(); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO'); process.exit(0);
