#!/usr/bin/env node
// verify-device-tokens.mjs — Unit A gate (the phone QR-pairing design §6).
//
// Exercises the REAL migration SQL + the REAL device-tokens namespace + the REAL
// auth gate functions (resolveRequester / makePortalOwnerGate). Mutation-proof:
// each security row FAILS if its guard is reverted (noted per row).
//
//   D1  a minted token authorizes at BOTH gates (via:'device')
//   D2  a revoked token authorizes NOTHING          (revert `revoked_at IS NULL` → FAIL)
//   D3  the raw token is NEVER stored; list() leaks no hash
//   D4  unknown token rejected; loopback bypass intact; shared bearer still works (additivity)
//   D5  no matcher (db absent) ⇒ device path disabled, not fail-open
//
// Pure Node, no network. Uses an in-memory better-sqlite3 seeded from the actual
// migrations/0052_device_tokens.sql so a schema drift breaks the gate.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createDeviceTokensNamespace } from '../src/db/device-tokens.js';
import { resolveRequester, makePortalOwnerGate } from '../src/http/require-vault-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(Boolean(pass));
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// ---- Real migration → in-memory DB + a minimal d1Query/firstRow shim ----------
const raw = new Database(':memory:');
raw.exec(fs.readFileSync(path.join(ROOT, 'migrations/0052_device_tokens.sql'), 'utf8'));
// 0057 generalizes device_tokens to per-client tokens (adds kind + idle_expires_at).
// Loading the REAL migration keeps the gate honest against schema drift.
raw.exec(fs.readFileSync(path.join(ROOT, 'migrations/0057_device_token_web.sql'), 'utf8'));
const d1Query = async (sql, params = []) => {
  const stmt = raw.prepare(sql);
  if (/^\s*select/i.test(sql)) return { results: stmt.all(...params) };
  const info = stmt.run(...params);
  return { meta: { last_row_id: info.lastInsertRowid, changes: info.changes } };
};
const dt = createDeviceTokensNamespace({ d1Query, rawDb: raw });

// Fake requests. Loopback iff socket.remoteAddress is a loopback peer AND no proxy header.
const netReq = (authz, cookie) => ({
  socket: { remoteAddress: '10.0.0.5' },
  headers: { ...(authz ? { authorization: authz } : {}), ...(cookie ? { cookie } : {}) },
});
const loopReq = () => ({ socket: { remoteAddress: '127.0.0.1' }, headers: {} });

const USER = 'owner-user';
// Set the shared bearer BEFORE the first resolveRequester call — expectedBearer()
// module-caches on first use (in production it is set at boot; verify:app-bearer
// covers the resolveMcpBearer path). A known value lets D4d prove additivity.
const SHARED_BEARER = 'S'.repeat(48);
process.env.MYCELIUM_MCP_BEARER = SHARED_BEARER;
const match = (t) => dt.matchSync(t);
const ownerGate = makePortalOwnerGate({ userId: USER, deviceTokenMatch: match });
const ownerGateNoDT = makePortalOwnerGate({ userId: USER, deviceTokenMatch: null });

async function main() {
  // ---- Mint ------------------------------------------------------------------
  const { token, id } = await dt.mint('Pixel 9', USER);

  // D1 — minted token authorizes at BOTH gates as via:'device' ----------------
  const rr = await resolveRequester(netReq(`Bearer ${token}`), { userId: USER, deviceTokenMatch: match });
  rec('D1a global /api gate: minted token → via:device', rr && rr.id === USER && rr.via === 'device', JSON.stringify(rr));
  const og = ownerGate(netReq(`Bearer ${token}`));
  rec('D1b owner gate: minted token → owner', og && og.id === USER);
  // HEADER-ONLY (v6 audit): a device token in the ambient mycelium_bearer cookie must
  // NOT authorize (would be CSRF-exempt). It falls through to session validation → null.
  const rc = await resolveRequester(netReq(null, `mycelium_bearer=${token}`), { userId: USER, deviceTokenMatch: match, validateSession: async () => null });
  rec('D1c cookie-form device token → NOT accepted (header-only, fail-closed)', rc === null, JSON.stringify(rc));

  // D2 — revoke kills exactly that token (MUTATION: drop `revoked_at IS NULL` → FAIL) --
  await dt.revoke(id);
  const rrRevoked = await resolveRequester(netReq(`Bearer ${token}`), { userId: USER, deviceTokenMatch: match });
  rec('D2a revoked token → gate denies (null)', rrRevoked === null, JSON.stringify(rrRevoked));
  rec('D2b revoked token → matchSync null', match(token) === null);
  rec('D2c revoked token → owner gate null', ownerGate(netReq(`Bearer ${token}`)) === null);

  // D3 — hash-at-rest: raw token never stored; list() leaks no hash ------------
  const { token: t2 } = await dt.mint('iPad', USER);
  const rowHash = raw.prepare('SELECT token_hash FROM device_tokens WHERE device_label = ?').get('iPad')?.token_hash;
  rec('D3a stored value is NOT the raw token', rowHash && rowHash !== t2);
  rec('D3b stored value is a 64-hex sha256', /^[0-9a-f]{64}$/.test(rowHash || ''));
  const list = await dt.list();
  rec('D3c list() returns no token_hash field', list.length > 0 && list.every((r) => !('token_hash' in r)));

  // D4 — additivity + unknown rejection + loopback intact ----------------------
  rec('D4a unknown token → matchSync null', match('deadbeef'.repeat(8)) === null);
  const rrUnknown = await resolveRequester(netReq('Bearer ' + 'z'.repeat(64)), { userId: USER, deviceTokenMatch: match });
  rec('D4b unknown token → gate denies', rrUnknown === null);
  const rrLoop = await resolveRequester(loopReq(), { userId: USER, deviceTokenMatch: match });
  rec('D4c loopback still bypasses (via:loopback)', rrLoop && rrLoop.via === 'loopback');
  // shared static bearer still works alongside device tokens (set at top, pre-cache)
  const rrShared = await resolveRequester(netReq(`Bearer ${SHARED_BEARER}`), { userId: USER, deviceTokenMatch: match });
  rec('D4d shared MYCELIUM_MCP_BEARER still authorizes (via:bearer)', rrShared && rrShared.via === 'bearer');

  // D5 — no matcher ⇒ device path disabled, NOT fail-open ----------------------
  const { token: t3 } = await dt.mint('Nexus', USER);
  const rrNoDT = await resolveRequester(netReq(`Bearer ${t3}`), { userId: USER, deviceTokenMatch: null });
  rec('D5a null matcher ⇒ device token NOT accepted (fail-closed)', rrNoDT === null);
  rec('D5b null matcher ⇒ owner gate denies device token', ownerGateNoDT(netReq(`Bearer ${t3}`)) === null);
  // a throwing matcher must also deny, never authorize
  const rrThrow = await resolveRequester(netReq(`Bearer ${t3}`), { userId: USER, deviceTokenMatch: () => { throw new Error('boom'); } });
  rec('D5c throwing matcher ⇒ gate denies (fail-closed)', rrThrow === null);

  const allPass = ledger.length > 0 && ledger.every(Boolean);
  console.log('\n' + '='.repeat(66));
  console.log(`VERDICT: ${allPass ? 'GO — per-device tokens: minted/authorized, revocable, hashed-at-rest, additive, fail-closed' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(66));
  raw.close();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-device-tokens threw:', e); process.exit(1); });
