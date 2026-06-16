// scripts/verify-rest-tls.mjs — S-REST-TLS: the native TLS listener for the
// mobile app's direct-over-Tailscale connection (Odysseus "bind + TLS +
// auth-always-on"). The plain-http server stays loopback-only; the TLS listener
// serves the SAME app over real TLS, and because a remote client's socket peer is
// non-loopback the A1 gate enforces the owner Bearer with NO X-Forwarded-For
// dependence. Asserts:
//   A. TLS actually terminates (an HTTPS request gets served).
//   B. the auth gate runs on the TLS listener: networked + no/!valid Bearer → 401.
//   C. networked + valid Bearer → not 401 (the app is reachable).
//   D. the recovery-key / account control surface is NEVER served to a networked
//      caller, even with a valid Bearer → 403 (CLAUDE.md §4).
//   E. FAIL-CLOSED: a missing/unreadable cert does NOT start TLS and does NOT
//      fall back to plaintext-on-network — tlsServer is null, loopback http works.
//
// A networked (non-loopback) client is simulated with an X-Forwarded-For header
// (same technique as verify-portal-auth / verify-portal-bearer-remote); a REAL
// remote peer is non-loopback intrinsically, so the gate behaves identically.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

// Self-signed throwaway cert/key for the test listener (test process only).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const STATIC_BEARER = crypto.randomBytes(24).toString('hex');
process.env.MYCELIUM_DISABLE_EMBED = '1';
process.env.MYCELIUM_MCP_BEARER = STATIC_BEARER;

const DATA = mkdtempSync(join(tmpdir(), 'myc-tls-'));
const CERT = join(DATA, 'cert.pem');
const KEY = join(DATA, 'key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', KEY, '-out', CERT, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });

const hex = () => crypto.randomBytes(32).toString('hex');
const NET = '9.9.9.9';
const SENS = '/api/v1/portal/transcription/status';
const RECOVERY = '/api/v1/account/recovery-key';

let serverA = null, serverB = null;
try {
  const { startRestServer } = await import('../src/server-rest.js');

  // ── Instance A: TLS configured with a valid cert ──────────────────────────
  process.env.MYCELIUM_REST_TLS_CERT = CERT;
  process.env.MYCELIUM_REST_TLS_KEY = KEY;
  process.env.MYCELIUM_REST_TLS_PORT = '0';        // ephemeral
  process.env.MYCELIUM_REST_TLS_HOST = '127.0.0.1'; // test binds loopback; XFF simulates networked
  serverA = await startRestServer({ dbPath: join(DATA, 'a.db'), kcvPath: join(DATA, 'a.kcv'), userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });

  ok(!!serverA.tlsServer, '0. TLS listener started with a valid cert');
  const tlsPort = serverA.tlsServer.address().port;
  const base = `https://127.0.0.1:${tlsPort}`;
  const call = (path, { xff = null, bearer = null } = {}) => {
    const headers = {};
    if (xff) headers['x-forwarded-for'] = xff;
    if (bearer) headers['authorization'] = `Bearer ${bearer}`;
    return fetch(`${base}${path}`, { headers }).then((r) => r.status);
  };

  // A. TLS terminates + app served (loopback peer here → trusted, so not 401)
  ok(await call(SENS) !== 401, 'A. HTTPS request served over the TLS listener (TLS terminates)');

  // B. gate runs on TLS: networked + no/bad Bearer → 401
  ok(await call(SENS, { xff: NET }) === 401, 'B1. TLS + networked, no Bearer → 401');
  ok(await call(SENS, { xff: NET, bearer: hex() + hex() }) === 401, 'B2. TLS + networked, wrong Bearer → 401');

  // C. networked + valid Bearer → not 401
  ok(await call(SENS, { xff: NET, bearer: STATIC_BEARER }) !== 401, 'C. TLS + networked, valid Bearer → not 401');

  // D. control surface never served to a networked caller (even with Bearer)
  ok(await call(RECOVERY, { xff: NET, bearer: STATIC_BEARER }) === 403, 'D. TLS + networked + Bearer → /account/recovery-key → 403 (never leaks)');

  await serverA.close(); serverA = null;

  // ── Instance B: cert path is bogus → FAIL-CLOSED (no TLS, no plaintext-net) ─
  process.env.MYCELIUM_REST_TLS_CERT = join(DATA, 'does-not-exist.pem');
  process.env.MYCELIUM_REST_TLS_KEY = join(DATA, 'nope.pem');
  serverB = await startRestServer({ dbPath: join(DATA, 'b.db'), kcvPath: join(DATA, 'b.kcv'), userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  ok(serverB.tlsServer === null, 'E1. bogus cert → TLS listener NOT started (fail-closed, no insecure fallback)');
  const httpStatus = await fetch(`${serverB.url}${SENS}`).then((r) => r.status).catch(() => 0);
  ok(httpStatus !== 0 && httpStatus !== 401, 'E2. loopback http still serves (desktop unaffected)', `(${httpStatus})`);
} catch (err) {
  ok(false, `boot/integration failed: ${String(err?.message || err).slice(0, 200)}`);
} finally {
  try { await serverA?.close?.(); } catch { /* */ }
  try { await serverB?.close?.(); } catch { /* */ }
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO'); process.exit(0);
