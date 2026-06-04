// verify:health-encryption — proves the type-agnostic-encryption fix closes the
// numeric-column leak. health_daily metrics are written as NUMBERS via the
// auto-encrypt adapter; before the fix they were stored PLAINTEXT (the adapter
// only encrypted strings). This asserts: (1) numeric metrics are ciphertext at
// rest, (2) reads coerce them back to numbers (parseHealthRow), (3) a range
// round-trips with values intact, (4) pre-fix PLAINTEXT rows still read as
// numbers (backward-compat). PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-health-encryption.db', KCV = 'data/verify-health-encryption-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Distinctive 7-digit step counts (unlikely to appear by chance in base64 ciphertext).
const days = [
  { date: '2026-06-01', steps: 1234567, hrv_avg: 61, sleep_duration_min: 421 },
  { date: '2026-06-02', steps: 2345671, hrv_avg: 62, sleep_duration_min: 432 },
  { date: '2026-06-03', steps: 3456712, hrv_avg: 63, sleep_duration_min: 443 },
  { date: '2026-06-04', steps: 4567123, hrv_avg: 64, sleep_duration_min: 454 },
  { date: '2026-06-05', steps: 5671234, hrv_avg: 65, sleep_duration_min: 465 },
];
const STEP_MARKERS = days.map((d) => String(d.steps));
const EXPECTED_SUM = days.reduce((a, d) => a + d.steps, 0);

await db.health.syncDays(U, days);

// (1) ciphertext at rest — raw read (no adapter) must not contain plaintext steps.
const raw = new Database(DB, { readonly: true });
const rawRows = raw.prepare(`SELECT date, steps, hrv_avg FROM health_daily WHERE user_id = ?`).all(U);
raw.close();
const rawBlob = JSON.stringify(rawRows);
const leaked = STEP_MARKERS.filter((m) => rawBlob.includes(m));
rec('HE1. health numerics (steps/hrv) are ENCRYPTED at rest (was plaintext before the fix)',
  leaked.length === 0 && rawRows.length === 5 && String(rawRows[0].steps).length > 20,
  leaked.length ? `LEAKED: ${leaked.join(',')}` : `${rawRows.length} rows, steps col is an envelope`);

// (2) read coerces decrypted strings back to numbers.
const day1 = await db.health.getDay(U, '2026-06-01');
rec('HE2. getDay decrypts + coerces numerics to numbers', typeof day1.steps === 'number' && day1.steps === 1234567 && typeof day1.hrv_avg === 'number', `steps=${day1.steps} (${typeof day1.steps}) hrv=${day1.hrv_avg}`);

// (3) range round-trips with values intact.
const range = await db.health.getRange(U, '2026-06-01', '2026-06-05');
const sum = range.reduce((a, r) => a + (typeof r.steps === 'number' ? r.steps : NaN), 0);
rec('HE3. getRange round-trips all 5 days as numbers (sum intact)', range.length === 5 && sum === EXPECTED_SUM, `n=${range.length} sum=${sum} (expected ${EXPECTED_SUM})`);

// (4) backward-compat: a PRE-FIX plaintext row (numbers written without encryption) still reads as numbers.
const raw2 = new Database(DB);
raw2.prepare(`INSERT INTO health_daily (id, user_id, date, steps, hrv_avg, source, scope) VALUES (?,?,?,?,?,'legacy','personal')`)
  .run(`${U}:2026-05-30`, U, '2026-05-30', 9999999, 70);   // plaintext numbers, bypassing the adapter
raw2.close();
const legacy = await db.health.getDay(U, '2026-05-30');
rec('HE4. pre-fix PLAINTEXT rows still read as numbers (Number() handles both)', typeof legacy.steps === 'number' && legacy.steps === 9999999, `steps=${legacy.steps} (${typeof legacy.steps})`);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — numeric encrypted columns now encrypted at rest + decrypt-coerced on read' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
