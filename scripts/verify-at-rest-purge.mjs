// scripts/verify-at-rest-purge.mjs — verify:at-rest-purge
//
// Stage 0 (SQLCipher-mandatory): after the at-rest migration, a full PLAINTEXT
// copy of the vault is left at <db>.pre-cipher-<ts>. purgePlaintextBackup() removes
// it — but ONLY after PROVING the live vault is a working, keyed ciphertext file.
// This gate proves the purge is correct (happy path) AND fail-safe (it KEEPS the
// backup on every doubt: no key, live vault still plaintext, wrong key) so it can
// never destroy the only good copy. @see docs/DESIGN-sqlcipher-stage0-mandatory-2026-06-19.md
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveDbKey } from '../src/account/keystore.js';
import { ensureVaultEncrypted, purgePlaintextBackup, isPlaintextSqlite } from '../src/account/db-cipher-migrate.js';

const USER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const KEY = deriveDbKey(USER);
const WRONG = deriveDbKey(OTHER);
const ledger = [];
const rec = (n, c, x = '') => { ledger.push(c); console.log(`  [${c ? '✓' : '✗'}] ${n}${x ? ' — ' + x : ''}`); };
const backups = (dir) => readdirSync(dir).filter((f) => f.includes('mycelium.db.pre-cipher-') && !f.endsWith('-wal') && !f.endsWith('-shm'));
const keyedReads = (p, key = KEY) => {
  const d = new Database(p); try { d.pragma(`cipher='sqlcipher'`); d.pragma(`key="x'${key}'"`); return d.prepare('SELECT v FROM marker LIMIT 1').get()?.v; } finally { d.close(); }
};

function seedPlaintextVault(dbPath) {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE marker(v TEXT)');
  db.prepare('INSERT INTO marker(v) VALUES (?)').run('LIVE_DATA');
  for (let i = 0; i < 50; i++) db.prepare('INSERT INTO marker(v) VALUES (?)').run('row-' + i);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

// Fresh migrated vault in its own dir → { dir, dbPath }
function migrated(base) {
  const dbPath = join(base, 'mycelium.db');
  seedPlaintextVault(dbPath);
  const r = ensureVaultEncrypted({ dbPath, dbKeyHex: KEY });
  if (!r.migrated) throw new Error('setup: migration did not run');
  return { dbPath, preCipherPath: r.preCipherPath };
}

function main() {
  const root = mkdtempSync(join(tmpdir(), 'verify-atrest-purge-'));
  const mk = (n) => { const d = join(root, n); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };

  // ── 1. HAPPY PATH: keyed + intact → backup purged, vault still reads ──────────
  {
    const dir = mk('happy');
    const { dbPath } = migrated(dir);
    rec('1a migration leaves exactly one .pre-cipher backup', backups(dir).length === 1, `count=${backups(dir).length}`);
    rec('1b backup is plaintext (the redundant copy)', isPlaintextSqlite(join(dir, backups(dir)[0])));
    const res = purgePlaintextBackup({ dbPath, dbKeyHex: KEY });
    rec('1c purge removed the backup', backups(dir).length === 0 && res.purged.length === 1, `remaining=${backups(dir).length} purged=${res.purged.length}`);
    rec('1d live vault is STILL ciphertext + opens keyed + data intact', !isPlaintextSqlite(dbPath) && keyedReads(dbPath) === 'LIVE_DATA');
  }

  // ── 2. FAIL-SAFE: no key → keep ──────────────────────────────────────────────
  {
    const dir = mk('nokey');
    const { dbPath } = migrated(dir);
    const res = purgePlaintextBackup({ dbPath, dbKeyHex: null });
    rec('2 no DB key → backup KEPT (never delete unverified)', backups(dir).length === 1 && res.purged.length === 0, `remaining=${backups(dir).length}`);
  }

  // ── 3. FAIL-SAFE: live vault still plaintext (migration incomplete) → keep ────
  {
    const dir = mk('plaintext-live');
    const dbPath = join(dir, 'mycelium.db');
    seedPlaintextVault(dbPath);
    // fabricate a stray .pre-cipher next to a STILL-plaintext live vault
    writeFileSync(`${dbPath}.pre-cipher-1`, ''); seedPlaintextVault(`${dbPath}.pre-cipher-1`);
    const res = purgePlaintextBackup({ dbPath, dbKeyHex: KEY });
    rec('3 live vault still PLAINTEXT → backup KEPT', existsSync(`${dbPath}.pre-cipher-1`) && res.purged.length === 0);
  }

  // ── 4. FAIL-SAFE: wrong key → live vault won't open keyed → keep ──────────────
  {
    const dir = mk('wrongkey');
    const { dbPath } = migrated(dir);
    const res = purgePlaintextBackup({ dbPath, dbKeyHex: WRONG });
    rec('4 wrong key (keyed reopen fails) → backup KEPT', backups(dir).length === 1 && res.purged.length === 0, `remaining=${backups(dir).length}`);
    // and the correct key STILL works afterwards (we didn't corrupt anything)
    rec('4b correct key still reads the vault after a refused purge', keyedReads(dbPath) === 'LIVE_DATA');
  }

  // ── 5. IDEMPOTENT: second purge is a clean no-op ──────────────────────────────
  {
    const dir = mk('idem');
    const { dbPath } = migrated(dir);
    purgePlaintextBackup({ dbPath, dbKeyHex: KEY });
    const res = purgePlaintextBackup({ dbPath, dbKeyHex: KEY });
    rec('5 second purge → no-op (nothing left to remove)', backups(dir).length === 0 && res.purged.length === 0);
  }

  // ── 6. SCOPING: only .pre-cipher siblings are touched ─────────────────────────
  {
    const dir = mk('scope');
    const { dbPath } = migrated(dir);
    const bystander = join(dir, 'unrelated.db'); seedPlaintextVault(bystander);
    const kcv = join(dir, 'kcv.json'); writeFileSync(kcv, '{}');
    purgePlaintextBackup({ dbPath, dbKeyHex: KEY });
    rec('6 unrelated files (other .db, kcv.json) are NOT touched', existsSync(bystander) && existsSync(kcv) && backups(dir).length === 0);
  }

  rmSync(root, { recursive: true, force: true });
  const pass = ledger.filter(Boolean).length, fail = ledger.length - pass;
  console.log(`\n================================================================`);
  console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — at-rest plaintext-backup purge (self-verifying, fail-safe)  (${pass} pass, ${fail} fail)  EXIT=${fail === 0 ? 0 : 1}`);
  console.log(`================================================================`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
