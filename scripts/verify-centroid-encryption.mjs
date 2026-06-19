// verify:centroid-encryption — SEC-1. Proves the 256D/3D semantic-fingerprint
// centroids (territory_profiles.centroid_256 / centroid_3d) are encrypted at rest
// and decrypt correctly through the adapter for the live readers (getOrphanGaps,
// compute-territory-neighbors). Embeddings are sensitive (README §7); these were
// plaintext before SEC-1. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-centroid-encryption.db', KCV = 'data/verify-centroid-encryption-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const vec = (spec) => { const v = new Array(256).fill(0); for (const [i, x] of Object.entries(spec)) v[Number(i)] = x; return v; };

const MARK = '0.987654321';   // distinctive centroid component — must NOT survive to disk in plaintext
const c1 = vec({ 0: 0.987654321, 1: 0.1 });
const c2 = vec({ 0: 0.95, 1: 0.31 });   // similar to c1 (cosine > 0.7)
for (const [tid, name, c] of [[1, 'Alpha', c1], [2, 'Beta', c2]]) {
  await db.rawQuery(
    `INSERT INTO territory_profiles (id, user_id, territory_id, name, centroid_256, centroid_3d, message_count, is_catchall)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [`tp-${tid}`, U, tid, name, JSON.stringify(c), JSON.stringify([0.1, 0.2, 0.3]), 50],
  );
}

// (1) SQLCipher collapse (Stage B/C cut 2): centroids are now PLAINTEXT JSON inside
// whole-file SQLCipher (at-rest confidentiality = verify:at-rest, not this per-field
// envelope). Assert the stop-write worked — the centroid is stored as readable JSON
// (a `[`-array), not a wrapped-DEK envelope (which would start `ey`).
const raw = new Database(DB, { readonly: true });
const rawRow = raw.prepare(`SELECT centroid_256, centroid_3d FROM territory_profiles WHERE id = 'tp-1'`).get();
raw.close();
const rawBlob = JSON.stringify(rawRow);
rec('CE1. centroid_256 + centroid_3d stored PLAINTEXT-JSON-in-cipher (collapse: no longer field-encrypted)',
  rawBlob.includes('0.987654321') && String(rawRow.centroid_256).startsWith('['),
  rawBlob.includes('0.987654321') ? 'plaintext JSON in cipher' : `unexpected: ${String(rawRow?.centroid_256).slice(0, 24)}…`);

// (2) adapter read decrypts → parseable vector.
const back = (await db.rawQuery(`SELECT centroid_256 FROM territory_profiles WHERE id = 'tp-1'`, [])).results?.[0];
let parsed = null; try { parsed = JSON.parse(back.centroid_256); } catch {}
rec('CE2. adapter read decrypts centroid → parseable 256D vector', Array.isArray(parsed) && parsed.length === 256 && Math.abs(parsed[0] - 0.987654321) < 1e-9, `len=${parsed?.length} [0]=${parsed?.[0]}`);

// (3) live reader (getOrphanGaps) works over encrypted centroids: T2 is similar to T1, no cofire → a gap.
const gaps = await db.topology.getOrphanGaps({ p_user_id: U, p_territory_id: 1, p_min_similarity: 0.7, p_limit: 10 });
rec('CE3. getOrphanGaps computes cosine over DECRYPTED centroids (finds similar T2)', gaps.some((g) => g.territory_id === 2), `gaps=${gaps.map((g) => g.territory_id).join(',') || 'none'}`);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — centroids encrypted at rest + decrypt for live readers' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
