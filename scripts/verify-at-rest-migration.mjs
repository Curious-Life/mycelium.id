// scripts/verify-at-rest-migration.mjs — verify:at-rest-migration
//
// Hardened at-rest init: the bugs the FIRST live encryption attempt hit (the
// dual-boot migration RACE, the unkeyed ensureVaultSchema, broken new-user
// born-encrypted). Exercises the REAL initVaultStorage path (not boot() directly,
// which is what let the old gate miss all of it) + TRUE cross-process concurrency.
// @see docs/AT-REST-MIGRATION-HARDENING-DESIGN-2026-06-18.md
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveDbKey } from '../src/account/keystore.js';
import { ensureVaultSchema, initVaultStorage } from '../src/db/init.js';
import { isPlaintextSqlite } from '../src/account/db-cipher-migrate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const KEY = deriveDbKey(USER);
const ledger = [];
const rec = (n, c, x = '') => { ledger.push(c); console.log(`  [${c ? '✓' : '✗'}] ${n}${x ? ' — ' + x : ''}`); };
const encrypted = (p) => existsSync(p) && !isPlaintextSqlite(p);
const setFlag = (on) => { if (on) process.env.MYCELIUM_AT_REST = '1'; else delete process.env.MYCELIUM_AT_REST; };
const preCipherCount = (dir) => readdirSync(dir).filter((f) => f.includes('mycelium.db.pre-cipher-')).length;
const openKeyed = (p) => { const d = new Database(p); d.pragma(`cipher='sqlcipher'`); d.pragma(`key="x'${KEY}'"`); return d; };

// A child process that runs initVaultStorage once (for the cross-process race test).
const CHILD = `
import { initVaultStorage } from ${JSON.stringify(join(ROOT, 'src/db/init.js'))};
const dbPath = process.argv[2];
initVaultStorage({ dbPath, userHex: ${JSON.stringify(USER)}, log: () => {} })
  .then(() => process.exit(0))
  .catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
`;

function seedPlaintextVault(dbPath) {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE marker(v TEXT)');
  db.prepare('INSERT INTO marker(v) VALUES (?)').run('LIVE_DATA');
  for (let i = 0; i < 200; i++) db.prepare('INSERT INTO marker(v) VALUES (?)').run('row-' + i);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-atrest-mig-'));

  // ── A. ensureVaultSchema is KEY-AWARE (the 3 spike cases) ──────────────────
  setFlag(true);
  {
    const f = join(dir, 'a1', 'mycelium.db');
    ensureVaultSchema(f, USER); // fresh + at-rest → born encrypted
    rec('A1 fresh + at-rest → ensureVaultSchema BORN-ENCRYPTS (schema in cipher db)', encrypted(f),
      `encrypted=${encrypted(f)}`);
    const d = openKeyed(f); const ok = d.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c > 0; d.close();
    rec('A1b born-encrypted vault has the applied schema (keyed read)', ok);
  }
  {
    const f = join(dir, 'a2', 'mycelium.db'); require_mkdir(f); seedPlaintextVault(f);
    ensureVaultSchema(f, USER); // existing plaintext + at-rest → stays plaintext (migration rekeys later)
    rec('A2 existing plaintext + at-rest → ensureVaultSchema keeps it PLAINTEXT (no key-on-plaintext throw)',
      !encrypted(f) && isPlaintextSqlite(f));
  }

  // ── B. initVaultStorage — the four real paths ─────────────────────────────
  // B1 NEW USER: fresh + at-rest → born encrypted, getDb-style keyed read works.
  setFlag(true);
  {
    const f = join(dir, 'b1', 'mycelium.db');
    const key = await initVaultStorage({ dbPath: f, userHex: USER, log: () => {} });
    const d = openKeyed(f); const tbls = d.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c; d.close();
    rec('B1 NEW-USER fresh + at-rest → born encrypted + schema + returns key', encrypted(f) && key === KEY && tbls > 0,
      `encrypted=${encrypted(f)} key=${key === KEY} tables=${tbls}`);
  }
  // B2 EXISTING PLAINTEXT → migrate; data intact; one backup.
  {
    const base = join(dir, 'b2'); const f = join(base, 'mycelium.db'); require_mkdir(f); seedPlaintextVault(f);
    const key = await initVaultStorage({ dbPath: f, userHex: USER, log: () => {} });
    const d = openKeyed(f); const n = d.prepare('SELECT count(*) c FROM marker').get().c; const m = d.prepare("SELECT v FROM marker WHERE v='LIVE_DATA'").get()?.v; d.close();
    rec('B2 EXISTING-PLAINTEXT + at-rest → migrated, data intact, one .pre-cipher',
      encrypted(f) && key === KEY && n === 201 && m === 'LIVE_DATA' && preCipherCount(base) === 1,
      `encrypted=${encrypted(f)} rows=${n} backups=${preCipherCount(base)}`);
  }
  // B3 EXISTING ENCRYPTED, relaunch with NO flag → self-detect → keyed schema + key (bug #2 regression).
  {
    const base = join(dir, 'b3'); const f = join(base, 'mycelium.db'); require_mkdir(f); seedPlaintextVault(f);
    setFlag(true); await initVaultStorage({ dbPath: f, userHex: USER, log: () => {} }); // encrypt
    setFlag(false); // relaunch WITHOUT flag
    let threw = false, key = null;
    try { key = await initVaultStorage({ dbPath: f, userHex: USER, log: () => {} }); } catch { threw = true; }
    const d = !threw ? openKeyed(f) : null; const n = d ? d.prepare('SELECT count(*) c FROM marker').get().c : -1; if (d) d.close();
    rec('B3 ENCRYPTED relaunch (NO flag) → self-detect keyed schema+open, no re-migration',
      !threw && key === KEY && n === 201 && preCipherCount(base) === 1,
      `threw=${threw} key=${key === KEY} rows=${n} backups=${preCipherCount(base)}`);
    setFlag(true);
  }
  // B4 PLAINTEXT + at-rest OFF → stays plaintext, null key (unchanged default).
  setFlag(false);
  {
    const f = join(dir, 'b4', 'mycelium.db'); require_mkdir(f); seedPlaintextVault(f);
    const key = await initVaultStorage({ dbPath: f, userHex: USER, log: () => {} });
    rec('B4 at-rest OFF → vault stays PLAINTEXT, null key (unchanged)', !encrypted(f) && key === null,
      `encrypted=${encrypted(f)} key=${key}`);
  }
  setFlag(true);

  // ── C. CONCURRENCY — the race regression. N processes, same fresh-plaintext
  //    vault, all MYCELIUM_AT_REST=1 → exactly ONE migrates, ZERO corruption. ──
  {
    const base = join(dir, 'race'); const f = join(base, 'mycelium.db'); require_mkdir(f); seedPlaintextVault(f);
    const childPath = join(base, 'child.mjs'); writeFileSync(childPath, CHILD);
    const N = 4;
    const env = { ...process.env, MYCELIUM_AT_REST: '1' };
    const procs = Array.from({ length: N }, () => new Promise((resolve) => {
      const p = spawn(process.execPath, [childPath, f], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ code, err: err.trim() }));
    }));
    const results = await Promise.all(procs);
    const allOk = results.every((r) => r.code === 0);
    const backups = preCipherCount(base);
    // vault must be encrypted + fully intact + openable
    let rows = -1, intact = false;
    try { const d = openKeyed(f); rows = d.prepare('SELECT count(*) c FROM marker').get().c; d.close(); intact = rows === 201; } catch { /* corrupt */ }
    rec('C CONCURRENCY: N=4 racing migrations → all exit 0',
      allOk, allOk ? '' : results.filter((r) => r.code).map((r) => r.err.split('\n').pop()).join(' | ').slice(0, 120));
    rec('C exactly ONE migration happened (one .pre-cipher), vault encrypted + intact',
      backups === 1 && encrypted(f) && intact, `backups=${backups} encrypted=${encrypted(f)} rows=${rows}`);
  }

  // ── D. Lock staleness — a dead-holder lock gets stolen (no deadlock) ───────
  {
    const base = join(dir, 'lock'); const f = join(base, 'mycelium.db'); require_mkdir(f); seedPlaintextVault(f);
    const lockPath = join(base, '.vault-init.lock');
    const fd = openSync(lockPath, 'wx'); writeSync(fd, '999999'); closeSync(fd); // dead pid
    // backdate not needed: pid 999999 is (almost certainly) dead → stealable immediately
    let ok = false;
    try { const key = await initVaultStorage({ dbPath: f, userHex: USER, log: () => {} }); ok = key === KEY && encrypted(f); } catch { ok = false; }
    rec('D stale lock (dead holder pid) is stolen → init proceeds (no deadlock)', ok && !existsSync(lockPath),
      `ok=${ok} lockGone=${!existsSync(lockPath)}`);
  }

  // ── E. KEY MATCH — the data-safety invariant. The vault is encrypted with the
  //    key DERIVED from USER_MASTER (deterministic HKDF), and opens with the SAME
  //    derived key — no separate/random key (so never "encrypted with a key we
  //    don't have", no data loss). A NEW user holds USER_MASTER (their recovery
  //    key) so can always re-derive it. A DIFFERENT master must NOT open it. ─────
  {
    const base = join(dir, 'keymatch'); const f = join(base, 'mycelium.db'); require_mkdir(f); seedPlaintextVault(f);
    const OTHER = 'f'.repeat(64);
    const detOk = deriveDbKey(USER) === deriveDbKey(USER) && deriveDbKey(USER) !== deriveDbKey(OTHER);
    const openKey = await initVaultStorage({ dbPath: f, userHex: USER, log: () => {} });
    const d = openKeyed(f); const v = d.prepare("SELECT v FROM marker WHERE v='LIVE_DATA'").get()?.v; d.close();
    let otherRejected = false;
    try { const b = new Database(f); b.pragma(`cipher='sqlcipher'`); b.pragma(`key="x'${deriveDbKey(OTHER)}'"`); b.prepare('SELECT 1 FROM marker').get(); b.close(); }
    catch { otherRejected = true; }
    rec('E KEY MATCH: encrypt-key == open-key == deriveDbKey(USER_MASTER); our key opens; wrong master rejected',
      detOk && openKey === deriveDbKey(USER) && v === 'LIVE_DATA' && otherRejected,
      `deterministic=${detOk} openKey==derive=${openKey === deriveDbKey(USER)} ourKeyReads=${v === 'LIVE_DATA'} wrongRejected=${otherRejected}`);
  }

  setFlag(false);
  rmSync(dir, { recursive: true, force: true });
  const pass = ledger.filter(Boolean).length, fail = ledger.length - pass;
  console.log(`\n================================================================`);
  console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — at-rest migration hardening (race-safe, key-aware schema, born-encrypted)  (${pass} pass, ${fail} fail)  EXIT=${fail === 0 ? 0 : 1}`);
  console.log(`================================================================`);
  process.exit(fail === 0 ? 0 : 1);
}

import { mkdirSync } from 'node:fs';
function require_mkdir(file) { mkdirSync(dirname(file), { recursive: true }); }

main().catch((e) => { console.error('verify:at-rest-migration crashed:', e); process.exit(1); });
