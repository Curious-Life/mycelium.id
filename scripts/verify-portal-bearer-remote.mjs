// scripts/verify-portal-bearer-remote.mjs — A1 of the iOS full-portal rebuild.
//
// The native mobile app reaches the box over Tailscale (non-loopback) and
// authenticates with the owner's static Bearer. A1 opened the SENSITIVE portal
// routers (chat / measurement / claims / activity / usage / transcription) — which
// decrypt vault plaintext and historically gated loopback-only — to that same
// Bearer authority, via makePortalOwnerGate (src/http/require-vault-auth.js).
//
// Asserts, with a non-loopback request SIMULATED by an X-Forwarded-For header
// (the same trick verify-portal-auth / verify-control-loopback use):
//   • sensitive endpoint: loopback → not 401 (desktop unchanged)
//   • sensitive endpoint: networked + valid Bearer → not 401 (THE A1 fix)
//   • sensitive endpoint: networked + no / wrong Bearer → 401 (fail-closed)
//   • CONTROL regression: the Bearer must NOT reach the recovery-key / account /
//     remote surfaces — those stay loopback-only (self-gated). A networked Bearer
//     request to /account/recovery-key must NEVER return 200.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const STATIC_BEARER = crypto.randomBytes(24).toString('hex');
const WRONG_BEARER = crypto.randomBytes(24).toString('hex');
process.env.MYCELIUM_DISABLE_EMBED = '1';
process.env.MYCELIUM_MCP_BEARER = STATIC_BEARER;

const DATA = mkdtempSync(join(tmpdir(), 'myc-pbearer-'));
const DB = join(DATA, 'mycelium.db');
const KCV = join(DATA, 'kcv.json');
const hex = () => crypto.randomBytes(32).toString('hex');

// Sensitive routers (gated by makePortalOwnerGate after A1).
const SENS = ['/api/v1/portal/transcription/status', '/api/v1/portal/usage'];
// Control surfaces (must stay loopback-only — Bearer must NOT reach them).
const CTRL_STATUS = '/api/v1/account/status';
const CTRL_RECOVERY = '/api/v1/account/recovery-key';
const CTRL_REMOTE = '/api/v1/remote/status';

let server = null;
try {
  const { startRestServer } = await import('../src/server-rest.js');
  server = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const base = server.url;

  const call = (path, { xff = null, bearer = null, method = 'GET' } = {}) => {
    const headers = {};
    if (xff) headers['x-forwarded-for'] = xff;       // simulate a non-loopback (networked) peer
    if (bearer) headers['authorization'] = `Bearer ${bearer}`;
    return fetch(`${base}${path}`, { method, headers }).then((r) => r.status);
  };
  const NET = '9.9.9.9';

  // A–D: sensitive routers.
  for (const ep of SENS) {
    const a = await call(ep);
    ok(a !== 401, `A. loopback ${ep} → not 401 (desktop unchanged)`, `(${a})`);

    const b = await call(ep, { xff: NET });
    ok(b === 401, `B. networked, no Bearer ${ep} → 401`, `(${b})`);

    const c = await call(ep, { xff: NET, bearer: WRONG_BEARER });
    ok(c === 401, `C. networked, wrong Bearer ${ep} → 401`, `(${c})`);

    const d = await call(ep, { xff: NET, bearer: STATIC_BEARER });
    ok(d !== 401, `D. networked, valid Bearer ${ep} → not 401 (A1 opens the sensitive router)`, `(${d})`);
  }

  // E: CONTROL regression — Bearer must NOT reach the recovery-key/account/remote
  //    surfaces. These self-gate on isTrustedLoopback, so a networked request
  //    (even with a valid Bearer) must be rejected. The recovery-key assertion is
  //    the load-bearing one: a leaked recovery key is game over (CLAUDE.md §4).
  const e0 = await call(CTRL_STATUS);
  ok(e0 === 200, `E0. loopback ${CTRL_STATUS} → 200 (control works locally)`, `(${e0})`);

  const e1 = await call(CTRL_STATUS, { xff: NET, bearer: STATIC_BEARER });
  ok(e1 === 403, `E1. networked + valid Bearer ${CTRL_STATUS} → 403 (Bearer denied at control)`, `(${e1})`);

  const e2 = await call(CTRL_RECOVERY, { xff: NET, bearer: STATIC_BEARER });
  ok(e2 !== 200, `E2. networked + valid Bearer ${CTRL_RECOVERY} → NOT 200 (recovery key never leaks)`, `(${e2})`);

  const e3 = await call(CTRL_REMOTE, { xff: NET, bearer: STATIC_BEARER });
  ok(e3 === 403, `E3. networked + valid Bearer ${CTRL_REMOTE} → 403 (Bearer denied at remote control)`, `(${e3})`);
} catch (err) {
  ok(false, `boot/integration failed: ${String(err?.message || err).slice(0, 200)}`);
} finally {
  try { await server?.close?.(); } catch { /* */ }
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO'); process.exit(0);
