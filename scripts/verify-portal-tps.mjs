// Verify Phases T/P/S — the small backings that make the remaining primary-nav
// screens (Timeline, Profile, Settings) render real data instead of empty/error.
// Closes the coherence gap Phase N opened (those 3 are in primary nav). Seeds
// messages through the captureMessage tool, then asserts each screen's minimum
// contract. Settings/stats/agents/identity are graceful on the client but we
// answer them to keep the console clean.
//
//   T1 timeline feed   GET /messages         → {messages:[…]} (metadata stripped)
//   T2 limit honored   GET /messages?limit=1 → 1 row
//   P1 profile         GET /profile          → {profile:{message_count:2,handle,display_name}}
//   S1 settings        GET /settings         → {settings:{timezone}}
//   B1 benign reads    /stats /agents /identity → safe shapes
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { rmSync, mkdirSync, mkdtempSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-portal-tps.db';
const KCV = 'data/verify-portal-tps-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// HERMETIC CONTROL-PLANE STUB. The handle surface (checkAvailability / setHandle's
// intent path) talks to the control plane — the ONLY authority on whether a name is
// free. Point it at an in-process stub over a fresh remote.json so P2/P3/P4 assert the
// TRUE endpoint behaviour deterministically (no live-internet dependency, no flakiness):
// every non-reserved name reads as available, so a submitted handle is RECORDED as an
// intent (desiredHandle → pending_handle) rather than a live claim (this vault has no
// operator password + no in-process master key, so it can never provision here — exactly
// the onboarding state the new contract is written for).
function startCpStub() {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (/^\/v1\/handle\//.test(req.url)) { res.end(JSON.stringify({ available: true })); return; }
    if (/^\/v1\/challenge/.test(req.url)) { res.end(JSON.stringify({ nonce: 'n-1' })); return; }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  // Fresh, isolated remote.json (no publicHost → federation fail-closed, GET handle
  // null) + the stubbed control plane. readProfile/setHandle read these via process.env.
  const cpDir = mkdtempSync(path.join(os.tmpdir(), 'tps-cp-'));
  const cp = await startCpStub();
  process.env.MYCELIUM_REMOTE_CONFIG = path.join(cpDir, 'remote.json');
  process.env.MYCELIUM_CONTROL_PLANE = cp.base;
  delete process.env.MYCELIUM_PUBLIC_HOST;

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url } = srv;
  const j = async (p) => { const r = await fetch(`${url}${p}`); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  const cap = (content, id) => fetch(`${url}/api/v1/captureMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, id, source: 'note' }),
  });
  const M = (p) => `/api/v1/portal${p}`;

  try {
    // O0 — empty vault: first-run welcome shows BEFORE any message exists.
    const onbEmpty = await j(M('/onboarding/status'));
    rec('O0. empty vault → onboarding showWelcome:true', onbEmpty.body?.showWelcome === true,
      `showWelcome=${onbEmpty.body?.showWelcome}`);

    await cap('first timeline message', 't1');
    await cap('second timeline message', 't2');

    // O1 — once messages exist, the welcome stops appearing.
    const onbFull = await j(M('/onboarding/status'));
    rec('O1. after import → onboarding showWelcome:false', onbFull.body?.showWelcome === false
      && onbFull.body?.steps?.data?.messageCount === 2,
      `showWelcome=${onbFull.body?.showWelcome} count=${onbFull.body?.steps?.data?.messageCount}`);

    // T1 — feed
    const feed = await j(M('/messages?limit=50'));
    const msgs = feed.body?.messages;
    const t1ok = feed.status === 200 && Array.isArray(msgs) && msgs.length === 2
      && msgs.every((m) => typeof m.content === 'string' && !('metadata' in m))
      && msgs.some((m) => m.content === 'first timeline message');
    rec('T1. /messages → {messages:[…]} (content present, metadata stripped)', t1ok,
      `count=${msgs?.length} hasMetadata=${msgs?.some((m) => 'metadata' in m)}`);

    // T2 — limit honored
    const one = await j(M('/messages?limit=1'));
    rec('T2. /messages?limit=1 → 1 row', one.body?.messages?.length === 1, `count=${one.body?.messages?.length}`);

    // P1 — profile read (must 200; apiGet throws otherwise). Fresh vault: no
    // user_profiles row yet → handle null, display_name default, live counts.
    const prof = await j(M('/profile'));
    const p = prof.body?.profile;
    rec('P1. /profile read → {message_count:2, handle:null, display_name:"You"}',
      prof.status === 200 && p?.message_count === 2 && p?.handle === null && p?.display_name === 'You',
      `status=${prof.status} message_count=${p?.message_count} handle=${p?.handle}`);

    // P2 — handle availability check
    const okHandle = await j(M('/profile/handle/check?handle=mycelium')); // reserved
    const freeHandle = await j(M('/profile/handle/check?handle=forest-walker')); // DNS-safe (dash, not underscore)
    rec('P2. /profile/handle/check (reserved vs free)',
      okHandle.body?.available === false && freeHandle.body?.available === true,
      `reserved=${okHandle.body?.available} free=${freeHandle.body?.available}`);

    // P3 — edit (PUT). NEW CONTRACT (this PR's thesis): `handle` is no longer a
    // cosmetic `UPDATE user_profiles SET handle=?`. A vault that cannot provision yet
    // (no operator password / no master key — the onboarding state) RECORDS the picked
    // name as an INTENT: it surfaces as `pending_handle`, and GET .handle stays DERIVED
    // from publicHost (null here — federation fail-closed). display_name + signature DO
    // still persist through user_profiles. Asserting the old `handle:'forest-walker'`
    // round-trip would re-assert the repudiated cosmetic-handle behaviour.
    const put = await fetch(`${url}/api/v1/portal/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'forest-walker', display_name: 'Alice', signature: 'into the trees' }),
    });
    const putBody = await put.json().catch(() => ({}));
    rec('P3. PUT /profile persists display_name+signature; handle is INTENT (pending), not a cosmetic row write',
      put.status === 200
      && putBody.profile?.display_name === 'Alice'
      && putBody.profile?.signature === 'into the trees'
      && putBody.profile?.handle === null            // derived from publicHost (none) — NOT the submitted name
      && putBody.profile?.pending_handle === 'forest-walker'  // the intent was recorded
      && putBody.handle?.claimed === false,           // the setter's honest outcome: recorded, not claimed
      `status=${put.status} handle=${putBody.profile?.handle} pending=${putBody.profile?.pending_handle} claimed=${putBody.handle?.claimed}`);

    // P4 — read-back reflects the new contract: display_name persisted, handle still
    // DERIVED (null), the picked name surfaced as pending_handle.
    const prof2 = await j(M('/profile'));
    rec('P4. GET /profile reflects saved edits (display_name persisted; handle derived-null; pending_handle carries the intent)',
      prof2.body?.profile?.display_name === 'Alice'
      && prof2.body?.profile?.signature === 'into the trees'
      && prof2.body?.profile?.handle === null
      && prof2.body?.profile?.pending_handle === 'forest-walker',
      `handle=${prof2.body?.profile?.handle} pending=${prof2.body?.profile?.pending_handle} name=${prof2.body?.profile?.display_name}`);

    // P5 — invalid handle rejected (fail-closed)
    const bad = await fetch(`${url}/api/v1/portal/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'No Spaces!' }),
    });
    rec('P5. PUT /profile rejects an invalid handle → 400', bad.status === 400, `status=${bad.status}`);

    // P6 — recompute refreshes counts
    const rc = await fetch(`${url}/api/v1/portal/profile/stats/recompute`, { method: 'POST' });
    const rcBody = await rc.json().catch(() => ({}));
    rec('P6. POST /profile/stats/recompute → counts refreshed',
      rc.status === 200 && rcBody.profile?.message_count === 2, `status=${rc.status} count=${rcBody.profile?.message_count}`);

    // S1 — settings
    const set = await j(M('/settings'));
    rec('S1. /settings → {settings:{timezone}}', set.status === 200 && typeof set.body?.settings?.timezone === 'string');

    // B1 — benign reads
    const stats = await j(M('/stats'));
    const agents = await j(M('/agents'));
    const identity = await j(M('/identity'));
    rec('B1. /stats /agents /identity → safe shapes',
      stats.body?.messages?.total === 2 && Array.isArray(agents.body?.agents) && identity.body?.ownerName === 'You',
      `stats.total=${stats.body?.messages?.total}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
    try { cp.srv.close(); } catch {}
    try { rmSync(cpDir, { recursive: true, force: true }); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — Phases T/P/S: Timeline + Profile + Settings backed (all 6 primary-nav screens now render real data)' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-portal-tps threw:', e); process.exit(1); });
