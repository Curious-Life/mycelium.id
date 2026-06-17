// scripts/verify-at-rest-boot.mjs — verify:at-rest-boot (Phase 1 step-5 boot-wiring).
//
// Proves boot() honors the MYCELIUM_AT_REST opt-in: default OFF → plaintext open
// (unchanged); ON → encrypt-in-place migration runs at boot and every vault
// connection opens keyed. Fixture vaults only; the real vault is never touched.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../src/index.js';
import { createStubEmbedder } from '../src/search/index.js';
import { resolveDbKeyHex, atRestEnabled } from '../src/db/open.js';
import { isPlaintextSqlite } from '../src/account/db-cipher-migrate.js';

const ledger = [];
const rec = (n, c, x = '') => { ledger.push(c); console.log(`  [${c ? '✓' : '✗'}] ${n}${x ? ' — ' + x : ''}`); };
const hex = () => crypto.randomBytes(32).toString('hex');
const stub = () => createStubEmbedder(48);
const setFlag = (on) => { if (on) process.env.MYCELIUM_AT_REST = '1'; else delete process.env.MYCELIUM_AT_REST; };
const hasPreCipher = (dbPath) => { const d = join(dbPath, '..'); try { return readdirSync(d).some((f) => f.includes('mycelium.db.pre-cipher-')); } catch { return false; } };

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-atrest-boot-'));

  // ── B1 unit: the opt-in resolver ──────────────────────────────────────────
  setFlag(false);
  rec('B1 default OFF: atRestEnabled()=false, resolveDbKeyHex()=null', atRestEnabled() === false && resolveDbKeyHex(hex()) === null);
  setFlag(true);
  const uh = hex();
  const k = resolveDbKeyHex(uh);
  let threwBad = false; try { resolveDbKeyHex('nothex'); } catch { threwBad = true; }
  rec('B1 ON: resolveDbKeyHex() returns a 64-hex key + rejects a bad USER_MASTER',
    /^[0-9a-f]{64}$/.test(k || '') && k !== uh && threwBad);

  // ── B2 fresh vault + flag ON → BORN encrypted ─────────────────────────────
  setFlag(true);
  {
    const dbPath = join(dir, 'b2', 'mycelium.db'); rmSync(join(dir, 'b2'), { recursive: true, force: true });
    const { db, close } = await boot({ dbPath, kcvPath: join(dir, 'b2', 'kcv.json'), userHex: hex(), systemHex: hex(), embedder: stub() });
    const reads = (await db.rawQuery('SELECT 1 AS x')).results?.[0]?.x === 1;
    close();
    rec('B2 fresh vault + flag ON → file encrypted at rest + keyed connection reads', !isPlaintextSqlite(dbPath) && reads,
      `plaintextHeader=${isPlaintextSqlite(dbPath)} read=${reads}`);
  }

  // ── B3 EXISTING plaintext vault + flag ON → migrated at boot, data intact ──
  {
    const base = join(dir, 'b3'); const dbPath = join(base, 'mycelium.db');
    const { mkdirSync } = await import('node:fs'); mkdirSync(base, { recursive: true });
    // seed a PLAINTEXT vault with a marker row (raw, no crypto)
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE bw_marker(v TEXT)`); seed.prepare(`INSERT INTO bw_marker(v) VALUES (?)`).run('MARKER_PLAINTEXT');
    seed.pragma('wal_checkpoint(TRUNCATE)'); seed.close();
    rec('B3 seed is plaintext', isPlaintextSqlite(dbPath));

    const uHex = hex(), sHex = hex(); // reused on the 2nd boot (same KCV)
    const { db, close } = await boot({ dbPath, kcvPath: join(base, 'kcv.json'), userHex: uHex, systemHex: sHex, embedder: stub() });
    const marker = (await db.rawQuery('SELECT v FROM bw_marker')).results?.[0]?.v;
    close();
    rec('B3 existing plaintext vault → boot migrates to encrypted; marker survives; backup kept',
      !isPlaintextSqlite(dbPath) && marker === 'MARKER_PLAINTEXT' && hasPreCipher(dbPath),
      `encrypted=${!isPlaintextSqlite(dbPath)} marker=${marker} backup=${hasPreCipher(dbPath)}`);

    // ── B4 idempotent: 2nd boot on the now-encrypted vault still reads ───────
    const { db: db2, close: close2 } = await boot({ dbPath, kcvPath: join(base, 'kcv.json'), userHex: uHex, systemHex: sHex, embedder: stub() });
    const marker2 = (await db2.rawQuery('SELECT v FROM bw_marker')).results?.[0]?.v;
    close2();
    rec('B4 2nd boot is idempotent (already encrypted) + still reads', marker2 === 'MARKER_PLAINTEXT', `marker=${marker2}`);
  }

  // ── B5 default OFF: boot leaves a fresh vault PLAINTEXT (no behavior change) ─
  setFlag(false);
  {
    const dbPath = join(dir, 'b5', 'mycelium.db');
    const { db, close } = await boot({ dbPath, kcvPath: join(dir, 'b5', 'kcv.json'), userHex: hex(), systemHex: hex(), embedder: stub() });
    const reads = (await db.rawQuery('SELECT 1 AS x')).results?.[0]?.x === 1;
    close();
    rec('B5 default OFF: fresh vault stays PLAINTEXT (unchanged) + reads', isPlaintextSqlite(dbPath) && reads,
      `plaintextHeader=${isPlaintextSqlite(dbPath)}`);
  }

  setFlag(false);
  rmSync(dir, { recursive: true, force: true });

  const pass = ledger.filter(Boolean).length, fail = ledger.length - pass;
  console.log(`\n================================================================`);
  console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — at-rest boot-wiring (opt-in migrate-then-keyed-open)  (${pass} pass, ${fail} fail)  EXIT=${fail === 0 ? 0 : 1}`);
  console.log(`================================================================`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('verify:at-rest-boot crashed:', e); process.exit(1); });
