// Bench: territory-river endpoint at production scale (417 encrypted weekly
// activation vectors + ~370 encrypted territory-profile names), matching the live
// vault. Times three reads through the REAL booted encrypting adapter:
//   miss    — first GET: decrypt 417 vectors + fold (the ~21s-cold path)
//   warm    — second GET: in-process memo hit
//   reboot  — clear in-proc memo, GET again: persisted-row hit (decrypt ONE blob)
// Not a pass/fail gate — prints timings for the before/after ledger.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { importMasterKey, encrypt } from '../src/crypto/crypto-local.js';
import { bustTerritoryRiver } from '../src/territory-river-cache.js';

const DB = 'data/bench-territory-river.db';
const KCV = 'data/bench-territory-river-kcv.json';
const UID = 'local-user';
const RUN = 'bench-run-0001';
const WEEKS = 417;        // matches the live vault
const TERRITORIES = 372;  // matches the live vault
const ACTIVE_PER_WEEK = 35;

const ms = (t) => `${t.toFixed(0)}ms`;
async function timed(fn) { const s = process.hrtime.bigint(); const v = await fn(); return [Number(process.hrtime.bigint() - s) / 1e6, v]; }

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const userHex = crypto.randomBytes(32).toString('hex');
  const systemHex = crypto.randomBytes(32).toString('hex');
  const key = await importMasterKey(userHex); // same key the server resolves → it can decrypt our writes
  const enc = (obj) => encrypt(typeof obj === 'string' ? obj : JSON.stringify(obj), 'personal', key);

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex, systemHex, port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url } = srv;
  const seed = new Database(DB);

  console.log(`seeding ${WEEKS} weeks × ~${ACTIVE_PER_WEEK} territories (encrypted vectors) + ${TERRITORIES} encrypted profiles…`);
  const start = new Date('2018-01-07').getTime();
  const insTraj = seed.prepare(
    `INSERT INTO fisher_trajectory
       (user_id, level, window_type, window_start, window_end, activation_vector,
        message_count, active_territory_count, clustering_run_id, low_confidence, scope)
     VALUES (?, 'territory', 'weekly_step', ?, ?, ?, ?, ?, ?, 0, 'personal')`);
  for (let i = 0; i < WEEKS; i++) {
    const day = new Date(start + i * 7 * 86400000).toISOString().slice(0, 10);
    const vec = {};
    for (let k = 0; k < ACTIVE_PER_WEEK; k++) {
      const tid = ((i * 7 + k * 11) % TERRITORIES) + 1;
      vec[tid] = Math.round((0.4 / ACTIVE_PER_WEEK + Math.random() * 0.02) * 1e4) / 1e4;
    }
    insTraj.run(UID, day, day, await enc(vec), 10 + (i % 20), ACTIVE_PER_WEEK, RUN);
  }
  const insProf = seed.prepare(
    `INSERT INTO territory_profiles (territory_id, user_id, name, is_anchored, last_active, updated_at)
       VALUES (?, ?, ?, ?, '2025-12-01', '2025-12-01T00:00:00Z')`);
  for (let t = 1; t <= TERRITORIES; t++) {
    insProf.run(t, UID, await enc(`Territory name ${t}`), t <= 7 ? 1 : 0);
  }
  const insFreq = seed.prepare(
    `INSERT INTO frequency_snapshots (user_id, window_start, window_end, granularity, compression)
       VALUES (?, ?, ?, 'week', ?)`);
  for (let i = 0; i < WEEKS; i++) {
    const day = new Date(start + i * 7 * 86400000).toISOString().slice(0, 10);
    insFreq.run(UID, day, day, await enc('0.37'));
  }
  seed.close();

  const get = () => fetch(`${url}/api/v1/portal/territory-river`).then((r) => r.text());
  bustTerritoryRiver();

  const [tMiss, body] = await timed(get);
  const parsed = JSON.parse(body);
  const [tWarm] = await timed(get);
  bustTerritoryRiver(); // simulate app restart: in-proc memo gone, persisted row remains
  const [tReboot] = await timed(get);

  console.log('\n────────────── territory-river timings (production scale) ──────────────');
  console.log(`  weeks=${parsed.weeks?.length} anchors=${parsed.anchors?.length} novelty.path=${parsed.novelty?.path?.length}`);
  console.log(`  MISS   (decrypt 417 vectors + fold)      : ${ms(tMiss)}   ← before (every load did this)`);
  console.log(`  WARM   (in-process memo hit)             : ${ms(tWarm)}   ← after, repeat load`);
  console.log(`  REBOOT (persisted row, decrypt 1 blob)   : ${ms(tReboot)}   ← after, first load post-restart`);
  console.log(`  speedup: warm ${(tMiss / tWarm).toFixed(0)}× · reboot ${(tMiss / tReboot).toFixed(0)}×`);
  console.log('────────────────────────────────────────────────────────────────────────');

  await srv.close?.();
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
