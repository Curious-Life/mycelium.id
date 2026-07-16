#!/usr/bin/env node
// scripts/vault-repair/repro-corruption.mjs — controlled reproduction of the vault
// "database disk image is malformed" corruption.
//
// WHY: two memories disagreed about the root cause. The 2026-07-01 sweep proved
// (6/6) that concurrent WAL INSERT writers are SAFE and that a torn `copyFileSync`
// of a live vault is the killer. The torn-copy sites are now fixed — yet the vault
// corrupted again on 2026-07-14/15. This harness tests what that sweep never did:
// TWO DIVERGENT CODEBASES asserting different DDL (migrations) on ONE vault, which
// we PROVED is happening in production (the live vault carries `transcribe_attempts`,
// a column only the canonical `mycelium.id` repo's 0041 migration creates, while this
// repo is on a different 0041 — the schema is a Frankenstein of two lineages).
//
// Everything runs on SYNTHETIC keyed SQLCipher vaults in a temp dir. The real vault
// is never touched. Each scenario ends with PRAGMA quick_check on a fresh connection.
//
// Usage: node scripts/vault-repair/repro-corruption.mjs [rows]

import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, writeSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROWS = Number(process.argv[2]) || 20000;
// This harness CORRUPTS its target BY DESIGN. It must be impossible to point it at the
// canonical vault: refuse even when quiesced, with no env override honoured.
{
  const { dbPath } = await import('../../src/paths.js');
  const { resolve } = await import('node:path');
  let canonical = null; try { canonical = resolve(dbPath()); } catch { /* no canonical here */ }
  const target = process.env.MYCELIUM_DB ? resolve(process.env.MYCELIUM_DB) : null;
  if (canonical && target === canonical) {
    console.error('repro-corruption: REFUSING to run against the canonical vault — this script destroys its target.');
    process.exit(2);
  }
}
const KEY = 'a'.repeat(64); // synthetic key — NOT the user's key; no real data involved

// ── the app's EXACT open path (adapter/d1.js): cipher → key → temp_store → WAL → busy_timeout
function openVault(path, { readonly = false } = {}) {
  const db = new Database(path, { readonly });
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${KEY}'"`);
  db.pragma('temp_store = MEMORY');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

const quickCheck = (path) => {
  try {
    const d = openVault(path, { readonly: true });
    const r = d.pragma('quick_check')[0].quick_check;
    d.close();
    return r;
  } catch (e) { return `OPEN FAILED: ${e.message}`; }
};

// ── the two DIVERGENT migration lineages, modeled on the real fork at 0041 ──
// dev lineage: 0041_categories_provenance … 0049_cluster_gravity
const LINEAGE_DEV = [
  `ALTER TABLE messages ADD COLUMN categories_provenance TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_msg_cat_prov ON messages(categories_provenance)`,
  `ALTER TABLE messages ADD COLUMN inner_state_axes TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_msg_axes ON messages(inner_state_axes, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_dev_scope ON messages(scope, created_at)`,
  `DROP INDEX IF EXISTS idx_msg_foreign_attempts`,   // dev doesn't know the foreign index → churn
];
// canonical repo (mycelium.id): 0041_attachment_transcribe_attempts
const LINEAGE_FOREIGN = [
  `ALTER TABLE messages ADD COLUMN transcribe_attempts INTEGER DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS idx_msg_foreign_attempts ON messages(transcribe_attempts)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_foreign_created ON messages(created_at, id)`,
  `DROP INDEX IF EXISTS idx_msg_axes`,               // foreign doesn't know dev's index → churn
  `CREATE INDEX IF NOT EXISTS idx_msg_foreign_scope ON messages(scope)`,
];

function applyLineage(db, stmts) {
  let applied = 0;
  for (const s of stmts) {
    try { db.exec(s); applied++; }
    catch (e) { if (!/duplicate column|already exists/i.test(e.message)) throw e; }
  }
  return applied;
}

function seed(path, rows) {
  const db = openVault(path);
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, user_id TEXT, content TEXT, scope TEXT, created_at TEXT)`);
  const ins = db.prepare('INSERT INTO messages (id,user_id,content,scope,created_at) VALUES (?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      ins.run(`id-${i}`, 'u1', `content ${i} ${'x'.repeat(180)}`, 'personal', new Date(1700000000000 + i * 1000).toISOString());
    }
  })();
  db.close();
}

// ── cross-process lock, byte-identical to src/db/init.js (.vault-init.lock) ──
function acquireLock(lockPath, waitMs = 20000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { const fd = openSync(lockPath, 'wx'); writeSync(fd, String(process.pid)); closeSync(fd); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) return false;
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},60)']); // ~60ms nap without async
    }
  }
}
const releaseLock = (p) => { try { unlinkSync(p); } catch {} };

// ── CHILD MODE: one "codebase" hammering a vault ────────────────────────────
if (process.env.REPRO_ROLE) {
  const path = process.env.REPRO_DB;
  const role = process.env.REPRO_ROLE;          // 'dev' | 'foreign'
  const mode = process.env.REPRO_MODE;          // 'insert' | 'ddl' | 'ddl-locked' | 'journalmode' | 'vacuum'
  const lockPath = path + '.init.lock';
  try {
    // D/ JOURNAL-MODE SWITCH under live WAL writers. The documented recovery path
    // re-encrypts via `PRAGMA rekey`, which REQUIRES journal_mode=DELETE (non-WAL).
    // Flipping a live WAL db to a rollback journal while another process writes it
    // is a textbook freelist/page-allocation corruptor — and "2nd reference to page"
    // IS freelist corruption. If this reproduces, the RECOVERY plants the damage.
    if (mode === 'journalmode') {
      if (role === 'dev') {                     // the app: keeps writing in WAL
        const db = openVault(path);
        const ins = db.prepare('INSERT INTO messages (id,user_id,content,scope,created_at) VALUES (?,?,?,?,?)');
        for (let i = 0; i < 6000; i++) { try { ins.run(`w-${i}`, 'u1', 'z'.repeat(200), 'personal', new Date().toISOString()); } catch { /* busy */ } }
        db.close();
      } else {                                  // the "recovery": flips journal mode + rekeys
        for (let k = 0; k < 3; k++) {
          const db = openVault(path);
          try { db.pragma('journal_mode = DELETE'); db.pragma('journal_mode = WAL'); } catch { /* busy */ }
          db.close();
        }
      }
      process.exit(0);
    }
    // E/ full VACUUM (whole-file rewrite) under live writers.
    if (mode === 'vacuum') {
      if (role === 'dev') {
        const db = openVault(path);
        const ins = db.prepare('INSERT INTO messages (id,user_id,content,scope,created_at) VALUES (?,?,?,?,?)');
        for (let i = 0; i < 6000; i++) { try { ins.run(`v-${i}`, 'u1', 'q'.repeat(200), 'personal', new Date().toISOString()); } catch { /* busy */ } }
        db.close();
      } else {
        const db = openVault(path);
        try { db.exec('VACUUM'); } catch { /* busy */ }
        db.close();
      }
      process.exit(0);
    }
    if (mode === 'insert') {
      const db = openVault(path);
      const ins = db.prepare('INSERT INTO messages (id,user_id,content,scope,created_at) VALUES (?,?,?,?,?)');
      for (let i = 0; i < 4000; i++) ins.run(`${role}-${i}`, 'u1', `w ${'y'.repeat(120)}`, 'personal', new Date().toISOString());
      db.close();
    } else {
      const stmts = role === 'dev' ? LINEAGE_DEV : LINEAGE_FOREIGN;
      for (let round = 0; round < 3; round++) {   // every boot re-asserts the lineage (no ledger!)
        const locked = mode === 'ddl-locked' ? acquireLock(lockPath) : true;
        const db = openVault(path);
        try { applyLineage(db, stmts); } finally { db.close(); if (mode === 'ddl-locked' && locked) releaseLock(lockPath); }
      }
    }
    process.exit(0);
  } catch (e) { console.error(`[${role}] ${e.message}`); process.exit(3); }
}

// ── PARENT: run the scenarios ───────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'myc-repro-'));
const run = (dbPath, role, mode) => spawnSync(process.execPath, [SELF], {
  env: { ...process.env, REPRO_ROLE: role, REPRO_DB: dbPath, REPRO_MODE: mode }, encoding: 'utf8',
});

function scenario(name, mode, expectation) {
  const db = join(dir, `${mode}-${Date.now()}.db`);
  seed(db, ROWS);
  const before = quickCheck(db);
  // launch both "codebases" CONCURRENTLY
  const a = spawnSync(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const mk = (role) => spawn(process.execPath, ['${SELF}'], { env: { ...process.env, REPRO_ROLE: role, REPRO_DB: '${db}', REPRO_MODE: '${mode}' }, stdio: 'inherit' });
    const p1 = mk('dev'), p2 = mk('foreign');
    let n = 0; const done = () => { if (++n === 2) process.exit(0); };
    p1.on('exit', done); p2.on('exit', done);
  `], { encoding: 'utf8', timeout: 180000 });
  const after = quickCheck(db);
  const ok = after === 'ok';
  console.log(`\n${ok ? '✅' : '❌'} ${name}`);
  console.log(`   before=${before} | after=${String(after).split('\n')[0].slice(0, 90)}`);
  console.log(`   expectation: ${expectation}`);
  if (a.stderr && a.stderr.trim()) console.log(`   child stderr: ${a.stderr.trim().split('\n').slice(0, 2).join(' | ')}`);
  try { for (const s of ['', '-wal', '-shm']) if (existsSync(db + s)) rmSync(db + s); } catch {}
  return ok;
}

console.log(`\nvault corruption repro — synthetic SQLCipher, ${ROWS} rows, app's exact driver+pragmas`);
console.log(`(no real vault is touched; temp dir ${dir})`);

const r1 = scenario('A/ CONTROL: 2 concurrent WAL INSERT writers', 'insert',
  'CLEAN — replicates the 2026-07-01 finding (concurrency is safe)');
const r2 = scenario('B/ TWO DIVERGENT CODEBASES running conflicting DDL, UNSERIALIZED', 'ddl',
  'the hypothesis under test');
const r3 = scenario('C/ same divergent DDL, SERIALIZED by the shared .vault-init.lock (production-like)', 'ddl-locked',
  'production takes this lock — if this corrupts, the lock does NOT protect us');
const r4 = scenario('D/ journal_mode WAL→DELETE→WAL (the rekey/recovery path) under live WAL writers', 'journalmode',
  'if CORRUPT: the RECOVERY procedure plants the damage — explains the endless recurrence');
const r5 = scenario('E/ full VACUUM (whole-file rewrite) under live writers', 'vacuum',
  'if CORRUPT: any in-place VACUUM while the app runs is a corruptor');

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n──── VERDICT ────`);
console.log(`  A control (concurrent inserts)      : ${r1 ? 'CLEAN' : 'CORRUPT'}`);
console.log(`  B divergent DDL, unserialized       : ${r2 ? 'CLEAN' : 'CORRUPT'}`);
console.log(`  C divergent DDL, locked (prod-like) : ${r3 ? 'CLEAN' : 'CORRUPT'}`);
console.log(`  D journal_mode flip (rekey path)    : ${r4 ? 'CLEAN' : 'CORRUPT'}`);
console.log(`  E VACUUM under writers             : ${r5 ? 'CLEAN' : 'CORRUPT'}`);
console.log('');
