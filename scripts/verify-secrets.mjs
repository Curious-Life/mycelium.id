// Verify Phase 2 — the encrypted secrets namespace (db.secrets).
// OAuth tokens / API keys / connector state live here; `value` (and `key`)
// MUST be ciphertext at rest. Boots the real server (SYSTEM_KEY wired) and
// drives db.secrets directly.
//
//   S1 round-trip       set → get returns the plaintext value
//   S2 value@rest        token is NOT plaintext in the db file
//   S2b key@rest         key name is NOT plaintext in the db file
//   S3 list metadata     list() returns metadata, never values
//   S4 upsert            re-set updates value + version, no duplicate row
//   S5 prefix            list({prefix}) filters by key prefix
//   S6 delete            delete removes the secret
//   S7 user-scoped       another user cannot read it
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-secrets.db';
const KCV = 'data/verify-secrets-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const TOKEN = 'unmistakable-oauth-token-plaintext-marker';
const KEYNAME = 'connector:test:tokens';

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { db } = srv;
  const uid = 'local-user';

  try {
    // ── S1 round-trip ──
    await db.secrets.set(uid, { key: KEYNAME, value: TOKEN, scope: 'personal', description: 'test secret' });
    const got = await db.secrets.get(uid, KEYNAME);
    rec('S1. set → get round-trips', got === TOKEN, `match=${got === TOKEN}`);

    // ── S2 value encrypted at rest ──
    const fileBytes = readFileSync(DB);
    rec('S2. value encrypted at rest (no plaintext token in db file)', !fileBytes.includes(Buffer.from(TOKEN)), `leak=${fileBytes.includes(Buffer.from(TOKEN))}`);

    // ── S2b key encrypted at rest ──
    rec('S2b. key name encrypted at rest', !fileBytes.includes(Buffer.from(KEYNAME)), `keyLeak=${fileBytes.includes(Buffer.from(KEYNAME))}`);

    // ── S3 list metadata only ──
    const list = await db.secrets.list(uid);
    const entry = list.find((e) => e.key === KEYNAME);
    rec('S3. list returns metadata, never values', !!entry && !('value' in entry), `entry=${JSON.stringify(entry)}`);

    // ── S4 upsert ──
    await db.secrets.set(uid, { key: KEYNAME, value: 'rotated-token', scope: 'personal' });
    const got2 = await db.secrets.get(uid, KEYNAME);
    const dupCount = (await db.secrets.list(uid)).filter((e) => e.key === KEYNAME).length;
    const ver = (await db.secrets.list(uid)).find((e) => e.key === KEYNAME)?.version;
    rec('S4. upsert updates value + version, no duplicate row', got2 === 'rotated-token' && dupCount === 1 && ver >= 2, `value=${got2} rows=${dupCount} version=${ver}`);

    // ── S5 prefix list ──
    await db.secrets.set(uid, { key: 'connector:other:state', value: '{}', scope: 'personal' });
    const pref = await db.secrets.list(uid, { prefix: 'connector:' });
    rec('S5. prefix list filters by key prefix', pref.length === 2, `count=${pref.length}`);

    // ── S6 delete ──
    const del = await db.secrets.delete(uid, KEYNAME);
    const gone = await db.secrets.get(uid, KEYNAME);
    rec('S6. delete removes the secret', del.deleted === true && gone === null, `deleted=${del.deleted} gone=${gone === null}`);

    // ── S7 user-scoped ──
    await db.secrets.set(uid, { key: 'mine', value: 'v', scope: 'personal' });
    const other = await db.secrets.get('other-user', 'mine');
    rec('S7. user-scoped (other user cannot read)', other === null, `other=${other}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — secrets: encrypted-at-rest (key+value), round-trip, upsert, metadata-only list, delete, user-scoped' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-secrets threw:', e); process.exit(1); });
