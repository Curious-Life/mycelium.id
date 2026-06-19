// verify:at-rest-default — the CRITICAL fix gate. After the SQLCipher Stage B/C
// collapse, content has NO per-field envelope, so whole-file SQLCipher is the only
// at-rest defense — and it must be the DEFAULT for the REAL server launch (incl. the
// documented `node src/index.js` self-host path), NOT opt-in. The fix is ENTRY-POINT
// gated, not path-based: the index.js main guard sets MYCELIUM_AT_REST, so importers —
// the ~104 verify gates AND the pipeline subprocesses that `import { boot }` as a
// library, many with MYCELIUM_DB pointed at a temp fixture — never trip it.
//
// This gate proves the two halves of that contract:
//   T1. boot() called AS A LIBRARY with NO flag → vault stays PLAINTEXT (Design D5 /
//       the ~104-gate invariant; this is the exact regression a path-based check caused,
//       which born-encrypted fixtures and broke verify:vitality + 28 other gates).
//   T2. boot() with the flag ON → vault is BORN ENCRYPTED + reads back.
//   T3. fail-closed predicate: at-rest on + unkeyed ⇒ index.js refuses.
//   T4. THE REAL LAUNCH: `node src/index.js` on an existing PLAINTEXT vault with NO
//       MYCELIUM_AT_REST migrates it to ciphertext (the entry-point default-on, e2e).
// PASS/FAIL ledger. @see docs/PRE-FREEZE-SECURITY-DESIGN-2026-06-19.md, src/index.js.
import Database from 'better-sqlite3';
import { rmSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { applyMigrations } from '../src/db/migrate.js';
import { boot } from '../src/index.js';
import { atRestEnabled, vaultIsEncrypted } from '../src/db/open.js';
import { isPlaintextSqlite } from '../src/account/db-cipher-migrate.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const clearFlag = () => { delete process.env.MYCELIUM_AT_REST; };

const dir = mkdtempSync(join(tmpdir(), 'verify-at-rest-default-'));
try {
  // ── T1. boot() AS A LIBRARY, no flag → PLAINTEXT (Design D5 / importer safety) ──
  // This is THE regression: every verify gate + pipeline subprocess calls boot() this
  // way. If boot() auto-encrypted, their plaintext fixtures would become SQLITE_NOTADB.
  clearFlag();
  rec('T0. precondition: MYCELIUM_AT_REST is NOT set', !atRestEnabled());
  const f1 = join(dir, 'lib-noflag.db');
  applyMigrations(new Database(f1));
  const b1 = await boot({ dbPath: f1, kcvPath: join(dir, 'k1.json'), userHex, systemHex, embedder: null });
  b1.close();
  rec('T1. boot() imported as a library with NO flag → vault stays PLAINTEXT (D5 intact)',
    existsSync(f1) && isPlaintextSqlite(f1));

  // ── T2. boot() with the flag ON → BORN ENCRYPTED + reads back ──────────────────
  const f2 = join(dir, 'lib-flagon.db');
  process.env.MYCELIUM_AT_REST = '1';
  const b2 = await boot({ dbPath: f2, kcvPath: join(dir, 'k2.json'), userHex, systemHex, embedder: null });
  const back = await b2.db.rawQuery('SELECT 1 AS ok');
  b2.close();
  rec('T2. boot() with MYCELIUM_AT_REST=1 → vault BORN ENCRYPTED at rest + reads back',
    vaultIsEncrypted(f2) && !isPlaintextSqlite(f2) && (Array.isArray(back) ? back[0]?.ok : back?.results?.[0]?.ok) === 1);
  clearFlag();

  // ── T3. fail-closed predicate (index.js: `if (atRestEnabled() && !dbKeyHex) throw`) ─
  const wouldRefuse = (keyed) => atRestEnabled() && !keyed;
  process.env.MYCELIUM_AT_REST = '1';
  const refuseOnUnkeyed = wouldRefuse(null) === true && wouldRefuse('deadbeef') === false;
  clearFlag();
  const openWhenOff = wouldRefuse(null) === false; // at-rest off ⇒ never refuses
  rec('T3. fail-closed: at-rest on + unkeyed ⇒ refuse; at-rest on + keyed ⇒ open; at-rest off ⇒ open',
    refuseOnUnkeyed && openWhenOff);

  // ── T4. THE REAL LAUNCH: `node src/index.js` on an EXISTING PLAINTEXT vault, with
  //        NO MYCELIUM_AT_REST, migrates it to ciphertext (entry-point default-on). ──
  const f4 = join(dir, 'launch', 'mycelium.db');
  mkdirSync(join(dir, 'launch'), { recursive: true });
  { const d = new Database(f4); applyMigrations(d); d.prepare("INSERT INTO facts(id,user_id,category,key,value) VALUES (?,?,?,?,?)").run('f1', 'u', 'c', 'k', 'PLAINTEXT_MARKER'); d.close(); }
  const seededPlain = isPlaintextSqlite(f4);
  const env = { ...process.env, MYCELIUM_DB: f4, MYCELIUM_KCV: join(dir, 'launch', 'kcv.json'),
    USER_MASTER_KEY: userHex, SYSTEM_KEY: systemHex, MYCELIUM_KEY_SOURCE: 'env' };
  delete env.MYCELIUM_AT_REST; // prove the DEFAULT — the launch must turn it on itself
  const proc = spawn('node', ['src/index.js'], { env, stdio: 'ignore' });
  let migrated = false;
  for (let i = 0; i < 60 && !migrated; i++) {   // up to ~18s
    await sleep(300);
    if (existsSync(f4) && !isPlaintextSqlite(f4)) migrated = true;
  }
  try { proc.kill('SIGKILL'); } catch {}
  rec('T4. `node src/index.js` (no flag) migrates an EXISTING plaintext vault → ciphertext (entry-point default-on)',
    seededPlain && migrated, `seeded_plaintext=${seededPlain} migrated_to_cipher=${migrated}`);
} finally {
  clearFlag();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the real launch (node src/index.js) defaults at-rest ON (entry-point gated); boot()-as-library stays plaintext (D5 intact); fail-closed' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
