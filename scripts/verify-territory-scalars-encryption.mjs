// verify:territory-scalars-encryption — SEC-3. Proves the per-territory cognitive
// scalars (energy/coherence/velocity/current_vitality/point_delta) are encrypted
// at rest and that readers coerce them back to numbers + sort in JS (energy /
// current_vitality can no longer be SQL-ORDER BY'd). message_count stays plaintext
// (structural ranking key) — asserted too. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-territory-scalars.db', KCV = 'data/verify-territory-scalars-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Distinctive scalar values (won't appear in base64 ciphertext).
const rows = [
  { tid: 1, name: 'Alpha', energy: 0.512345, vit: 0.612345, msg: 50 },
  { tid: 2, name: 'Beta',  energy: 0.912345, vit: 0.876543, msg: 40 },
  { tid: 3, name: 'Gamma', energy: 0.112345, vit: 0.212345, msg: 30 },
];
for (const r of rows) {
  await db.rawQuery(
    `INSERT INTO territory_profiles (id, user_id, territory_id, name, energy, coherence, velocity, current_vitality, current_phase, message_count, is_catchall)
     VALUES (?,?,?,?,?,?,?,?,'active',?,0)`,
    [`tp-${r.tid}`, U, r.tid, r.name, r.energy, 0.4, 0.1, r.vit, r.msg]);
}

// (1) ciphertext at rest — energy + current_vitality not plaintext; message_count IS plaintext.
const raw = new Database(DB, { readonly: true });
const rr = raw.prepare(`SELECT energy, current_vitality, message_count FROM territory_profiles WHERE id='tp-2'`).get();
raw.close();
const rb = JSON.stringify(rr);
rec('TS1. energy + current_vitality ENCRYPTED at rest; message_count stays plaintext',
  !rb.includes('0.912345') && !rb.includes('0.876543') && Number(rr.message_count) === 40,
  `raw=${rb.slice(0, 60)}…`);

// (2) getAllWithDynamics: energy decrypted to numbers, sorted DESC in JS.
const all = await db.territoryDocs.getAllWithDynamics(U);
const energies = all.map((t) => t.energy);
rec('TS2. getAllWithDynamics: energy numeric + sorted desc in JS (0.91,0.51,0.11)',
  all.length === 3 && all.every((t) => typeof t.energy === 'number')
    && all[0].territory_id === 2 && all[1].territory_id === 1 && all[2].territory_id === 3,
  `energies=${energies.join(', ')}`);

// (3) getByTerritoryId coerces scalars to numbers.
const t2 = await db.territoryDocs.getByTerritoryId(U, 2);
rec('TS3. getByTerritoryId coerces decrypted scalars to numbers',
  typeof t2.energy === 'number' && Math.abs(t2.energy - 0.912345) < 1e-9 && typeof t2.current_vitality === 'number' && Math.abs(t2.current_vitality - 0.876543) < 1e-9,
  `energy=${t2.energy} vitality=${t2.current_vitality}`);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — territory cognitive scalars encrypted; readers decrypt+coerce+JS-sort' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
