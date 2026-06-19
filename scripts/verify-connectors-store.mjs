// verify:connectors-store — Tier 2b: the dedicated `connectors` table.
// No network. Proves connector OPERATIONAL STATE moved off the
// `connector:<id>:state` secret blob into a real table, with the PII columns
// encrypted at rest and the structural columns queryable plaintext; that the
// store's public API is unchanged (runner untouched); that legacy `:state`
// secrets backfill into the table; and that tokens + OAuth transients stay in
// the encrypted `secrets` table — never in the connectors table.
//
//   S1 round-trip     setState→getState maps columns↔state (derived lastRun)
//   S2 at-rest        account_label/last_error/recent_runs/pkceVerifier NOT plaintext;
//                     status/cursor/provider ARE plaintext; scan integrity
//   S3 raw columns    encrypted cols are envelopes; plaintext cols are literals
//   S4 list()         metadata-only — never returns the encrypted PII columns
//   S5 patch/remove   patchState merges; remove drops row + token + oauth secrets
//   S6 backfill       legacy connector:<id>:state → table row; secret dropped;
//                     oauth split to :oauth secret; idempotent
//   S7 runner e2e     connect→sync→status→disconnect table-backed; token encrypted
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

process.env.MYCELIUM_CONNECTORS_MOCK = '1';

import crypto from 'node:crypto';
import { rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { createConnectorRunner, registerAdapter } from '../src/connectors/index.js';
import { createConnectorStore } from '../src/connectors/store.js';

const DB = 'data/verify-connectors-store.db';
const KCV = 'data/verify-connectors-store-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

function looksEncrypted(value) {
  if (typeof value !== 'string' || value.length < 20) return false;
  try { const o = JSON.parse(Buffer.from(value, 'base64').toString('utf8')); return !!(o.iv && o.ct && o.dk); }
  catch { return false; }
}

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  // Deterministic non-OAuth test adapter (pulls one item per sync).
  registerAdapter({
    id: 'store-test', label: 'Store Test', provider: 'teststore', oauth: null,
    async pull() { return { items: [{ id: 'store-test:a', source: 'store-test', content: '# A\n\nSTORE body', messageType: 'connector' }], nextCursor: 'c1' }; },
  });

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { db } = srv;
  const uid = 'local-user';
  const store = createConnectorStore({ db, userId: uid });

  // At-rest scan across db + wal + shm (writes may not be checkpointed).
  const bytes = () => [DB, `${DB}-wal`, `${DB}-shm`].filter(existsSync).map((f) => readFileSync(f).toString('latin1')).join('');
  const fileHas = (s) => bytes().includes(s);

  // Markers
  const M_LABEL = 'ACCOUNT-LABEL-MARKER-alice@store.example';
  const M_ERR = 'LAST-ERROR-MARKER-kaboom';
  const M_RUN = 'RECENT-RUN-MARKER-providerdetail';
  const M_PKCE = 'PKCE-VERIFIER-MARKER-zzz';
  const M_OAUTHSTATE = 'OAUTH-STATE-MARKER-qqq';
  const M_CURSOR = 'CURSOR-PLAINTEXT-MARKER-42';
  const TOKEN_MARKER = 'STORE-CONNECTOR-TOKEN-MARKER';

  try {
    // ── S1 round-trip ──
    const recentRuns = [{ at: '2026-06-04T00:00:00.000Z', ok: false, error: M_RUN }];
    await store.setState('store-test', {
      status: 'connected', cursor: M_CURSOR, accountLabel: M_LABEL, lastError: M_ERR,
      lastErrorAt: '2026-06-04T00:00:00.000Z', idleStreak: 2, itemsCreated: 5, recentRuns,
    });
    const st1 = await store.getState('store-test');
    rec('S1. setState→getState round-trips (table-backed; derived lastRun)',
      st1?.status === 'connected' && st1.cursor === M_CURSOR && st1.accountLabel === M_LABEL
      && st1.lastError === M_ERR && st1.idleStreak === 2 && st1.itemsCreated === 5
      && Array.isArray(st1.recentRuns) && st1.recentRuns.length === 1
      && st1.lastRun?.error === M_RUN,
      `status=${st1?.status} cursor=${st1?.cursor} idle=${st1?.idleStreak} created=${st1?.itemsCreated} lastRun=${st1?.lastRun?.error}`);

    // a connecting connector to exercise the encrypted :oauth secret
    await store.setState('connecting-test', { status: 'connecting', cursor: null, oauthState: M_OAUTHSTATE, pkceVerifier: M_PKCE });
    const stc = await store.getState('connecting-test');

    // ── S2 at-rest ──
    // SQLCipher collapse (Stage B/C cut 4): connector PII columns (account_label/
    // last_error/recent_runs) are now PLAINTEXT-in-cipher — at-rest = whole-file
    // SQLCipher (verify:at-rest). pkce/oauthState live in `secrets` (SYSTEM_KEY) → STAY
    // encrypted. cursor/provider were always plaintext structural columns.
    rec('S2. connector PII plaintext-in-cipher (verify:at-rest); secrets-backed oauth STILL encrypted; structural plaintext',
      fileHas(M_LABEL) && fileHas(M_ERR) && fileHas(M_RUN) && !fileHas(M_PKCE) && !fileHas(M_OAUTHSTATE)
      && fileHas(M_CURSOR) && fileHas('teststore'),
      `labelPlain=${fileHas(M_LABEL)} errPlain=${fileHas(M_ERR)} runPlain=${fileHas(M_RUN)} pkceLeak=${fileHas(M_PKCE)} oauthStateLeak=${fileHas(M_OAUTHSTATE)} cursorPlain=${fileHas(M_CURSOR)} providerPlain=${fileHas('teststore')}`);

    // ── S3 raw columns (bypass the adapter) ──
    const rdb = new Database(DB, { readonly: true });
    const rawRow = rdb.prepare('SELECT account_label, last_error, recent_runs, status, cursor, provider FROM connectors WHERE id = ? AND user_id = ?').get('store-test', uid);
    rdb.close();
    rec('S3. connector cols plaintext-in-cipher (collapse cut 4); structural cols literals',
      !looksEncrypted(rawRow?.account_label) && !looksEncrypted(rawRow?.last_error) && !looksEncrypted(rawRow?.recent_runs)
      && String(rawRow?.account_label).includes(M_LABEL)
      && rawRow?.status === 'connected' && rawRow?.cursor === M_CURSOR && rawRow?.provider === 'teststore',
      `label=${String(rawRow?.account_label).slice(0, 24)}… status=${rawRow?.status} cursor=${rawRow?.cursor} provider=${rawRow?.provider}`);

    // ── S4 list() metadata-only ──
    const listed = await db.connectors.list(uid);
    const row = listed.find((r) => r.id === 'store-test');
    const leaks = listed.some((r) => 'account_label' in r || 'last_error' in r || 'recent_runs' in r);
    rec('S4. db.connectors.list() omits encrypted PII columns',
      !!row && row.provider === 'teststore' && !leaks,
      `keys=${Object.keys(row || {}).join(',')}`);

    // oauth transients round-trip but never as table columns
    rec('S4b. oauth transients round-trip via :oauth secret, not the table',
      stc?.oauthState === M_OAUTHSTATE && stc?.pkceVerifier === M_PKCE
      && !('oauthState' in rawRow) && !('pkceVerifier' in rawRow)
      && (await db.secrets.has(uid, 'connector:connecting-test:oauth')),
      `oauthState=${stc?.oauthState === M_OAUTHSTATE} pkce=${stc?.pkceVerifier === M_PKCE}`);

    // ── S5 patch + remove ──
    await store.patchState('store-test', { idleStreak: 0, lastError: null });
    const st5 = await store.getState('store-test');
    await store.setTokens('store-test', { access_token: TOKEN_MARKER });
    await store.remove('store-test');
    const gone = await db.connectors.get(uid, 'store-test');
    const tokGone = await db.secrets.has(uid, 'connector:store-test:tokens');
    rec('S5. patchState merges (kept created=5, idle→0); remove drops row + token secret',
      st5?.idleStreak === 0 && st5?.itemsCreated === 5 && st5?.lastError === null
      && gone === null && tokGone === false,
      `idle=${st5?.idleStreak} created=${st5?.itemsCreated} rowGone=${gone === null} tokGone=${!tokGone}`);

    // ── S6 backfill from a legacy :state secret ──
    await db.secrets.set(uid, {
      key: 'connector:legacy-test:state',
      value: JSON.stringify({ status: 'connected', cursor: 'LEG-CURSOR', connectedAt: '2026-06-01T00:00:00.000Z', oauthState: 'LEG-OS', pkceVerifier: 'LEG-PKCE' }),
      scope: 'personal',
    });
    const preRow = await db.connectors.get(uid, 'legacy-test');
    const bf = await store.backfillLegacyState();
    const postRow = await db.connectors.get(uid, 'legacy-test');
    const legacyGone = !(await db.secrets.has(uid, 'connector:legacy-test:state'));
    const oauthMoved = await db.secrets.has(uid, 'connector:legacy-test:oauth');
    const bf2 = await store.backfillLegacyState(); // idempotent
    rec('S6. legacy :state backfills to table; secret dropped; oauth split; idempotent',
      preRow === null && bf.migrated === 1 && postRow?.status === 'connected' && postRow?.cursor === 'LEG-CURSOR'
      && legacyGone && oauthMoved && bf2.migrated === 0,
      `pre=${preRow} migrated=${bf.migrated} post=${postRow?.status}/${postRow?.cursor} legacyGone=${legacyGone} oauthMoved=${oauthMoved} idempotent=${bf2.migrated === 0}`);
    await store.remove('legacy-test');

    // ── S7 runner end-to-end, table-backed ──
    const runner = createConnectorRunner({ db, userId: uid, enqueueEnrichment: () => {} });
    const con = await runner.connect('store-test', { token: TOKEN_MARKER });
    const sync = await runner.runSync('store-test');
    const status = (await runner.status()).find((x) => x.id === 'store-test');
    const tableRow = await db.connectors.get(uid, 'store-test');
    const tokenLeak = fileHas(TOKEN_MARKER);
    const ids = await runner.store.listIds();
    const dis = await runner.disconnect('store-test');
    const afterDisc = await db.connectors.get(uid, 'store-test');
    rec('S7. runner connect→sync→status→disconnect is table-backed; token encrypted',
      con.ok && con.status === 'connected'
      && sync.ok && sync.created === 1
      && status?.status === 'connected' && !!status.lastSyncAt && status.itemsCreated === 1
      && tableRow?.status === 'connected' && !tokenLeak
      && ids.includes('store-test')
      && dis.ok && afterDisc === null,
      `connect=${con.status} created=${sync.created} status=${status?.status} tableStatus=${tableRow?.status} tokenLeak=${tokenLeak} listed=${ids.includes('store-test')} discGone=${afterDisc === null}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO — connectors table: PII encrypted at rest, structural cols queryable, store API stable, legacy backfill, runner table-backed' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-connectors-store threw:', e); process.exit(1); });
