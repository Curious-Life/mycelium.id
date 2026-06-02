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

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-portal-tps.db';
const KCV = 'data/verify-portal-tps-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

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
    const freeHandle = await j(M('/profile/handle/check?handle=forest_walker'));
    rec('P2. /profile/handle/check (reserved vs free)',
      okHandle.body?.available === false && freeHandle.body?.available === true,
      `reserved=${okHandle.body?.available} free=${freeHandle.body?.available}`);

    // P3 — edit (PUT) persists handle + display_name + signature
    const put = await fetch(`${url}/api/v1/portal/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'forest_walker', display_name: 'Martin', signature: 'into the trees' }),
    });
    const putBody = await put.json().catch(() => ({}));
    rec('P3. PUT /profile persists handle/display_name/signature',
      put.status === 200 && putBody.profile?.handle === 'forest_walker' && putBody.profile?.display_name === 'Martin' && putBody.profile?.signature === 'into the trees',
      `status=${put.status} handle=${putBody.profile?.handle}`);

    // P4 — read-back is persisted (round-trips through user_profiles)
    const prof2 = await j(M('/profile'));
    rec('P4. GET /profile reflects the saved edits',
      prof2.body?.profile?.handle === 'forest_walker' && prof2.body?.profile?.display_name === 'Martin',
      `handle=${prof2.body?.profile?.handle}`);

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
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — Phases T/P/S: Timeline + Profile + Settings backed (all 6 primary-nav screens now render real data)' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-portal-tps threw:', e); process.exit(1); });
