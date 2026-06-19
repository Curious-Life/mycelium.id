// Verify Phase 2 — the connectors framework + scheduler.
// No network: uses the mock adapter (MYCELIUM_CONNECTORS_MOCK=1). Proves the
// full path: connect → encrypted token store → sync → captureMessage → cursor
// → dedupe → disconnect, plus the OAuth helpers (unit) and scheduler.cycle().
//
//   C0 oauth helpers     createPkce + buildAuthUrl produce S256 challenge + url
//   C1 connect           POST connect → status connected (token stored)
//   C2 status            GET /connectors lists mock, status connected
//   C3 token@rest        connector token is NOT plaintext in the db file
//   C4 sync              sync pulls 3 → captureMessage ×3 (source=mock), encrypted
//   C5 incremental       second sync advances cursor → pulled 0
//   C6 dedupe            reconnect (cursor reset) → re-pull dedupes (created 0)
//   C7 disconnect        disconnect → status disconnected, tokens gone
//   C8 scheduler cycle   startConnectorScheduler().cycle() drains a connected connector
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

process.env.MYCELIUM_CONNECTORS_MOCK = '1'; // register the mock adapter at boot

import crypto from 'node:crypto';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { createPkce, buildAuthUrl } from '../src/connectors/oauth.js';
import { createConnectorRunner, startConnectorScheduler } from '../src/connectors/index.js';

const DB = 'data/verify-connectors.db';
const KCV = 'data/verify-connectors-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const TOKEN_MARKER = 'UNMISTAKABLE-CONNECTOR-TOKEN-MARKER';
const CONTENT_MARKER = 'hello from the mock connector';

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  // ── C0 oauth helpers (no network) ──
  const pkce = createPkce();
  const url = buildAuthUrl({ authUrl: 'https://accounts.example.com/authorize', clientId: 'cid', redirectUri: 'http://127.0.0.1:8787/cb', scopes: ['a', 'b'], state: 'xyz', codeChallenge: pkce.challenge });
  const u = new URL(url);
  rec('C0. oauth helpers: PKCE S256 + auth url',
    pkce.verifier && pkce.challenge && pkce.method === 'S256'
      && u.searchParams.get('code_challenge') === pkce.challenge && u.searchParams.get('code_challenge_method') === 'S256'
      && u.searchParams.get('client_id') === 'cid' && u.searchParams.get('scope') === 'a b',
    `challenge=${pkce.challenge.slice(0, 8)}… cc_method=${u.searchParams.get('code_challenge_method')}`);

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url: base, db } = srv;
  const uid = 'local-user';
  const C = (p) => `${base}/api/v1/portal${p}`;
  const jpost = async (p, body) => { const r = await fetch(C(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const jget = async (p) => { const r = await fetch(C(p)); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const countMock = async () => (await db.rawQuery('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND source = ?', [uid, 'mock'])).results?.[0]?.c ?? 0;

  try {
    // ── C1 connect ──
    const c1 = await jpost('/connectors/mock/connect', { token: TOKEN_MARKER });
    rec('C1. connect → connected', c1.status === 200 && c1.body.ok && c1.body.status === 'connected', `status=${c1.status} ${JSON.stringify(c1.body)}`);

    // ── C2 status ──
    const c2 = await jget('/connectors');
    const mock = (c2.body.connectors || []).find((x) => x.id === 'mock');
    rec('C2. GET /connectors lists mock as connected', !!mock && mock.status === 'connected' && mock.oauth === false, `mock=${JSON.stringify(mock)}`);

    // ── C3 token encrypted at rest ──
    rec('C3. connector token encrypted at rest', !readFileSync(DB).includes(Buffer.from(TOKEN_MARKER)), `leak=${readFileSync(DB).includes(Buffer.from(TOKEN_MARKER))}`);

    // ── C4 sync ──
    const c4 = await jpost('/connectors/mock/sync');
    const count4 = await countMock();
    const contentLeak = readFileSync(DB).includes(Buffer.from(CONTENT_MARKER));
    rec('C4. sync pulls 3 → captureMessage ×3 (encrypted)',
      c4.status === 200 && c4.body.ok && c4.body.pulled === 3 && c4.body.created === 3 && count4 === 3 && !contentLeak,
      `pulled=${c4.body.pulled} created=${c4.body.created} count=${count4} contentLeak=${contentLeak}`);

    // ── C5 incremental (cursor advanced) ──
    const c5 = await jpost('/connectors/mock/sync');
    rec('C5. second sync advances cursor → pulled 0', c5.body.ok && c5.body.pulled === 0 && (await countMock()) === 3, `pulled=${c5.body.pulled}`);

    // ── C6 dedupe on reconnect (cursor reset) ──
    await jpost('/connectors/mock/disconnect');
    await jpost('/connectors/mock/connect', { token: TOKEN_MARKER });
    const c6 = await jpost('/connectors/mock/sync');
    rec('C6. reconnect re-pull dedupes (created 0, deduped 3)',
      c6.body.ok && c6.body.pulled === 3 && c6.body.created === 0 && c6.body.deduped === 3 && (await countMock()) === 3,
      `pulled=${c6.body.pulled} created=${c6.body.created} deduped=${c6.body.deduped} count=${await countMock()}`);

    // ── C7 disconnect ──
    const c7d = await jpost('/connectors/mock/disconnect');
    const c7s = await jget('/connectors');
    const mock7 = (c7s.body.connectors || []).find((x) => x.id === 'mock');
    rec('C7. disconnect → status disconnected', c7d.body.ok && mock7?.status === 'disconnected', `status=${mock7?.status}`);

    // ── C8 scheduler cycle drains a connected connector ──
    const runner = createConnectorRunner({ db, userId: uid, enqueueEnrichment: () => {} });
    const sched = startConnectorScheduler({ runner, intervalMs: 999_999 });
    await runner.connect('mock', { token: TOKEN_MARKER }); // cursor reset → re-pull (dedupes existing 3)
    await sched.cycle();
    const st8 = await runner.store.getState('mock');
    sched.stop();
    rec('C8. scheduler.cycle() drains connected connector', st8?.status === 'connected' && !!st8?.lastSyncAt && (await countMock()) === 3, `status=${st8?.status} lastSyncAt=${!!st8?.lastSyncAt}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — connectors: oauth helpers, connect/sync/disconnect, encrypted tokens, captureMessage, cursor, dedupe, scheduler' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-connectors threw:', e); process.exit(1); });
