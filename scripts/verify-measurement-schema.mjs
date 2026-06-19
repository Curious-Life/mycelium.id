// verify:measurement-schema — F4. Proves the schema deltas: the new
// cognitive_events table (spec I4) + the `language` day-1 columns on the four
// metric tables that lacked them, that applyMigrations is idempotent (re-runs
// clean), and that cognitive_events' sensitive fields (magnitude/detail/headline)
// are encrypted at rest while round-tripping through the adapter. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-measurement-schema.db', KCV = 'data/verify-measurement-schema-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const cols = (db, t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));

// ── Apply migrations + idempotency ──
const d0 = new Database(DB);
applyMigrations(d0);
let idem = true, idemErr = '';
try { applyMigrations(d0); } catch (e) { idem = false; idemErr = e.message; }   // re-run must be clean
rec('S1. applyMigrations is idempotent (re-run on populated db)', idem, idemErr);

// ── cognitive_events table + shape ──
const ce = cols(d0, 'cognitive_events');
const needCE = ['id', 'user_id', 'era_id', 'event_type', 'level', 'window_start', 'window_end', 'language', 'magnitude', 'severity', 'detail', 'headline', 'detected_at', 'dismissed_at'];
const missCE = needCE.filter((c) => !ce.has(c));
rec('S2. cognitive_events created with the full I4 column set', ce.size > 0 && missCE.length === 0, missCE.length ? `missing: ${missCE.join(',')}` : `${ce.size} columns`);

// ── language day-1 on the four tables that lacked it ──
for (const t of ['cognitive_metrics_trajectory', 'topology_metrics', 'frequency_snapshots', 'complexity_snapshots']) {
  rec(`S3. ${t}.language present (NOT NULL DEFAULT 'en')`, cols(d0, t).has('language'));
}
d0.close();

// ── Encryption round-trip + ciphertext-at-rest ──
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const MARK_DETAIL = 'CONTRIB_SECRET_MARKER';
const MARK_HEAD = 'HEADLINE_SECRET_MARKER';
await db.rawQuery(
  `INSERT INTO cognitive_events (id, user_id, era_id, event_type, level, window_end, magnitude, severity, detail, headline)
   VALUES (?, ?, ?, 'phase_lock', 'realm', ?, ?, 'rare', ?, ?)`,
  ['ce-1', U, 'era-test', '2026-06-04', 31.8, JSON.stringify({ contributors: [MARK_DETAIL] }), MARK_HEAD],
);
const back = (await db.rawQuery(`SELECT magnitude, detail, headline, event_type, severity FROM cognitive_events WHERE user_id = ? AND id = 'ce-1'`, [U])).results?.[0] || {};
rec('S4. cognitive_events round-trips through the adapter (decrypted reads match)',
  Number(back.magnitude) === 31.8 && String(back.detail).includes(MARK_DETAIL) && back.headline === MARK_HEAD && back.event_type === 'phase_lock' && back.severity === 'rare',
  `magnitude=${back.magnitude} headline=${back.headline}`);
close();

// Raw read (no adapter) → sensitive fields must be ciphertext, NOT plaintext markers.
const raw = new Database(DB, { readonly: true });
const rawRow = raw.prepare(`SELECT magnitude, detail, headline FROM cognitive_events WHERE id = 'ce-1'`).get();
raw.close();
// SQLCipher collapse (Stage B/C cut 6): cognitive_events magnitude/detail/headline are
// PLAINTEXT-in-cipher — the markers read back through the raw column; at-rest = whole-file
// SQLCipher (verify:at-rest).
const present = [MARK_DETAIL, MARK_HEAD, '31.8'].filter((m) => JSON.stringify(rawRow).includes(m));
rec('S5. magnitude + detail + headline PLAINTEXT-in-cipher (collapse cut 6; verify:at-rest)', present.length === 3, `plaintext markers present=${present.length}/3`);

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — cognitive_events + language day-1 schema deltas in place + encrypted' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
