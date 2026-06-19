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

  // Measure event-loop responsiveness DURING the cold MISS. A 20ms heartbeat
  // timer records its actual fire gaps; the max gap is the longest the single
  // Node event loop was monopolized (unable to serve any other request). Before
  // the chunked-decrypt fix this gap ≈ the whole ~10–23s fold (HTTP 000 for every
  // other endpoint). After, each setImmediate batch boundary lets the timer (and
  // real concurrent requests) run, so the max stall collapses to ~one batch.
  let last = process.hrtime.bigint();
  let maxStall = 0;
  const beat = setInterval(() => {
    const now = process.hrtime.bigint();
    maxStall = Math.max(maxStall, Number(now - last) / 1e6);
    last = now;
  }, 20);
  const [tMiss, body] = await timed(get);
  clearInterval(beat);

  const parsed = JSON.parse(body);
  const [tWarm] = await timed(get);
  bustTerritoryRiver(); // simulate app restart: in-proc memo gone, persisted row remains
  const [tReboot] = await timed(get);

  // The cap means a genuine MISS now decrypts at most CAP weeks, not all 417.
  const CAP = 180;
  const cappedOk = parsed.weeks?.length === Math.min(WEEKS, CAP);
  const stallOk = maxStall < 1000; // loop must stay sub-second responsive under a cold fold

  console.log('\n────────────── territory-river timings (production scale) ──────────────');
  console.log(`  weeks=${parsed.weeks?.length} (cap ${CAP}) anchors=${parsed.anchors?.length} novelty.path=${parsed.novelty?.path?.length}`);
  console.log(`  MISS   (decrypt ≤${CAP} vectors + fold)    : ${ms(tMiss)}   ← cold path`);
  console.log(`  WARM   (in-process memo hit)             : ${ms(tWarm)}   ← repeat load`);
  console.log(`  REBOOT (persisted row, decrypt 1 blob)   : ${ms(tReboot)}   ← first load post-restart`);
  console.log(`  speedup: warm ${(tMiss / tWarm).toFixed(0)}× · reboot ${(tMiss / tReboot).toFixed(0)}×`);
  console.log(`  max event-loop stall during cold MISS    : ${ms(maxStall)}   ${stallOk ? '✓ responsive' : '✗ MONOPOLIZED'}`);
  console.log(`  capped to recent ${CAP} weeks            : ${cappedOk ? '✓' : `✗ got ${parsed.weeks?.length}`}`);
  console.log('────────────────────────────────────────────────────────────────────────');

  await srv.close?.();
  process.exit(stallOk && cappedOk ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
