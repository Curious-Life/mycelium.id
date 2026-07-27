#!/usr/bin/env node
// verify-wal-guard.mjs — the foreign-WAL quarantine guard, driven by the EXACT mechanism
// that corrupted the production vault (demonstrated live 2026-07-16).
//
// SQLite binds a -wal to its db by FILENAME, not content. Replace the db file while a
// stale -wal remains → the next open replays previous-generation frames into the new
// file. On a real vault that splices old pages into a new b-tree: invalid page pointers,
// rowid disorder, freelist wrong — the damage signature of five corruption events in two
// weeks. A rebuilt vault swapped WITH its stale WAL died in ~2.5h; the same rebuild
// swapped with sidecars removed survived. The guard makes the hygiene automatic.
//
// The gate re-runs the demonstration twice: WITHOUT the guard (the corruption must
// actually happen — proves the scenario is real, not vacuous) and WITH the guard (the
// swapped file must open exactly as validated). Plus the safety-critical negative cases:
// a legitimate crash-WAL must NEVER be quarantined.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import { mkdtempSync, copyFileSync, rmSync, existsSync, readdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { guardAgainstForeignWal, recordVaultBinding } from '../src/db/wal-guard.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const dir = mkdtempSync(join(tmpdir(), 'myc-walguard-'));
const DB = join(dir, 'vault.db');
const quiet = { log: () => {} };

// Build generation 1 (table gen1) leaving REAL uncheckpointed frames in its -wal,
// and generation 2 (table gen2) as a clean standalone file to swap in.
function makeGenerations() {
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  const a = new Database(DB); a.pragma('journal_mode=WAL');
  a.exec('CREATE TABLE gen1(id INTEGER PRIMARY KEY, v TEXT)');
  a.prepare('INSERT INTO gen1(v) VALUES (?)').run('old-world');
  copyFileSync(`${DB}-wal`, join(dir, 'stale.wal'));   // capture the live WAL pre-close
  a.close();                                            // close checkpoints the original
  const g2 = join(dir, 'gen2.db');
  const b = new Database(g2); b.pragma('journal_mode=WAL');
  b.exec('CREATE TABLE gen2(x TEXT)'); b.prepare('INSERT INTO gen2 VALUES (?)').run('new-world');
  b.close();
  return g2;
}

const tablesOf = (p) => { const d = new Database(p, { readonly: true }); const r = d.prepare("SELECT name FROM sqlite_master ORDER BY name").all().map(x => x.name); d.close(); return r; };

console.log('\nforeign-WAL guard — the swap+stale-WAL corruption mechanism');

t('SANITY (no guard): the mechanism is REAL — a stale WAL hijacks a swapped-in file', () => {
  const g2 = makeGenerations();
  copyFileSync(g2, DB);                                 // swap gen2 into place…
  copyFileSync(join(dir, 'stale.wal'), `${DB}-wal`);    // …leaving gen1's WAL behind
  rmSync(`${DB}-shm`, { force: true });
  const tables = tablesOf(DB);                          // open WITHOUT the guard
  assert.deepEqual(tables, ['gen1'], `stale WAL must resurrect gen1 over the swap (got ${tables}) — if this fails the whole scenario is vacuous`);
});

// Synthetic ENCRYPTED-vault generations: the guard never opens SQLite — it reads the
// first 16 bytes (the SQLCipher KDF salt) — so raw files with random headers model an
// encrypted vault exactly. Every rebuilt/VACUUM INTO file has a fresh random salt.
const encFile = () => Buffer.concat([randomBytes(16), Buffer.alloc(4096 - 16)]);

t('WITH the guard: a rename-swap of a REBUILT (new-salt) vault + stale WAL → quarantined', () => {
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  writeFileSync(DB, encFile());                         // gen1, encrypted
  writeFileSync(`${DB}-wal`, Buffer.from('gen1-frames'));
  recordVaultBinding(DB);                               // the app recorded gen1 as current
  const g2 = join(dir, 'gen2.db'); writeFileSync(g2, encFile());  // rebuilt: fresh salt
  renameSync(g2, DB);                                   // atomic install (new inode + new salt)…
  const r = guardAgainstForeignWal(DB, quiet);          // ← what boot now does
  assert.ok(r.quarantined.some((q) => q.includes('-wal.foreign-')), 'the stale WAL must be quarantined');
  assert.ok(!existsSync(`${DB}-wal`), 'no -wal may remain to replay');
  assert.ok(readdirSync(dir).some((f) => f.includes('.foreign-')), 'quarantined, never deleted (evidence preserved)');
});

t('REVIEW PoC 1: a whole-FAMILY restore (db + its OWN wal, new inode, SAME salt) is NEVER quarantined', () => {
  // Time Machine / new-Mac migration / re-installing an archived .replaced-* triple:
  // the inode changes but the WAL is same-generation committed data. The inode-based
  // draft of this guard quarantined it — silently dropping every commit that lived only
  // in the WAL. The salt rule must leave it alone.
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  const gen = encFile();
  writeFileSync(DB, gen); writeFileSync(`${DB}-wal`, Buffer.from('family-frames'));
  recordVaultBinding(DB);
  // Restore both to a NEW inode (rename away and back = the restore's effect).
  renameSync(DB, join(dir, 'moved.db')); writeFileSync(DB, gen);   // same salt, new inode
  const r = guardAgainstForeignWal(DB, quiet);
  assert.equal(r.quarantined.length, 0, 'a same-salt family restore is legitimate — quarantining it loses commits');
  assert.ok(existsSync(`${DB}-wal`), 'the family WAL must survive to replay');
});

t('REVIEW PoC 2: plaintext-era binding + now-encrypted file + WAL → NOT comparable, hands off', () => {
  // The at-rest cipher migration swaps plaintext → encrypted. The binding is re-recorded
  // at the swap (init.js), but even a stale plaintext-era binding must not fire: a magic
  // header is not a salt, so the signal is NOT COMPARABLE — no proof, no quarantine.
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  const a = new Database(DB); a.pragma('journal_mode=WAL');
  a.exec('CREATE TABLE t(x)'); a.close();               // plaintext file (magic header)
  recordVaultBinding(DB);                               // plaintext-era binding
  rmSync(`${DB}-wal`, { force: true });
  writeFileSync(DB, encFile());                         // "cipher-migrated" (encrypted now)
  writeFileSync(`${DB}-wal`, Buffer.from('own-crash-frames'));
  const r = guardAgainstForeignWal(DB, quiet);
  assert.equal(r.quarantined.length, 0, "the app's own post-migration crash-WAL must never be sacrificed");
});

t('a PLAINTEXT vault is deliberately unguarded (dev-only trade, documented)', () => {
  const g2 = makeGenerations();                          // real plaintext SQLite files
  recordVaultBinding(DB);
  renameSync(g2, DB);                                    // swap with stale WAL beside it
  copyFileSync(join(dir, 'stale.wal'), `${DB}-wal`); rmSync(`${DB}-shm`, { force: true });
  const r = guardAgainstForeignWal(DB, quiet);
  assert.equal(r.quarantined.length, 0, 'magic headers are not comparable — plaintext never fires (install-vault.mjs is the mitigation)');
});

t('INTEGRATION: init.js calls the guard BEFORE the pre-migrate snapshot opens the file', () => {
  // The gate drove the module directly — a regression that reorders or deletes the
  // init.js hook would go green without this (independent review, finding 5). The
  // snapshot's VACUUM INTO open would itself replay a foreign WAL, so order is load-
  // bearing: guard first, snapshot second.
  const src = readFileSync(new URL('../src/db/init.js', import.meta.url), 'utf8');
  const g = src.indexOf('guardAgainstForeignWal(');
  const s = src.indexOf('maybeSnapshotBeforeMigrate(');
  assert.ok(g > 0, 'init.js must call guardAgainstForeignWal');
  assert.ok(s > 0, 'init.js must still take the pre-migrate snapshot');
  assert.ok(g < s, 'the guard must run BEFORE maybeSnapshotBeforeMigrate');
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(idx.includes('guardAgainstForeignWal'), 'the open-only (initStorage=false) path must also be guarded (review finding 4)');
});

t('WITH the guard: a cp-style IN-PLACE swap (same inode) is caught by the SQLCipher salt', () => {
  // An encrypted vault's first 16 bytes are its KDF salt — random per file generation.
  // `cp rebuilt.db mycelium.db` overwrites in place: SAME inode, different salt. Model
  // the encrypted case with raw files (the guard reads identity, never opens SQLite).
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  writeFileSync(DB, Buffer.concat([randomBytes(16), Buffer.alloc(4096 - 16)]));   // "gen1" encrypted
  writeFileSync(`${DB}-wal`, Buffer.from('pretend-wal-frames'));
  recordVaultBinding(DB);
  const gen2 = Buffer.concat([randomBytes(16), Buffer.alloc(4096 - 16)]);         // rebuilt: new salt
  writeFileSync(DB, gen2);                                                        // cp-style: inode unchanged
  const r = guardAgainstForeignWal(DB, quiet);
  assert.ok(r.quarantined.some((q) => q.includes('-wal.foreign-')), 'salt change must prove the swap even with the same inode');
  assert.ok(!existsSync(`${DB}-wal`));
});

t('SAFETY: a plaintext file (magic header) can NEVER trip the salt test', () => {
  // Both plaintext generations share the SQLite magic — the header signal must stay
  // inert there (inode carries plaintext detection; dev-only anyway).
  makeGenerations();
  const a = new Database(DB); a.pragma('journal_mode=WAL');
  recordVaultBinding(DB);
  a.prepare('INSERT INTO gen1(v) VALUES (?)').run('same-file-more-writes');
  copyFileSync(`${DB}-wal`, join(dir, 'w4.wal')); a.close();
  copyFileSync(join(dir, 'w4.wal'), `${DB}-wal`); rmSync(`${DB}-shm`, { force: true });
  const r = guardAgainstForeignWal(DB, quiet);
  assert.equal(r.quarantined.length, 0, 'identical magic headers must never read as a generation change');
});

t("SAFETY: the app's own crash-WAL is NEVER touched (same generation)", () => {
  makeGenerations();
  const a = new Database(DB); a.pragma('journal_mode=WAL');
  recordVaultBinding(DB);                               // binding = this very file
  a.prepare('INSERT INTO gen1(v) VALUES (?)').run('crash-me');
  copyFileSync(`${DB}-wal`, join(dir, 'crash.wal'));    // preserve the live WAL
  a.close();
  copyFileSync(join(dir, 'crash.wal'), `${DB}-wal`);    // simulate a crash leaving it
  rmSync(`${DB}-shm`, { force: true });
  const r = guardAgainstForeignWal(DB, quiet);
  assert.equal(r.quarantined.length, 0, 'a same-generation WAL is legitimate committed data — quarantining it would LOSE writes');
  const d = new Database(DB);
  const rows = d.prepare('SELECT count(*) c FROM gen1').get().c; d.close();
  assert.equal(rows, 2, 'the crash-WAL must replay normally (both rows present)');
});

t('SAFETY: no recorded binding + a WAL present → do nothing (cannot prove foreign)', () => {
  makeGenerations();
  const a = new Database(DB); a.pragma('journal_mode=WAL');
  a.prepare('INSERT INTO gen1(v) VALUES (?)').run('unjudgeable');
  copyFileSync(`${DB}-wal`, join(dir, 'w2.wal')); a.close();
  copyFileSync(join(dir, 'w2.wal'), `${DB}-wal`);
  rmSync(join(dir, '.vault-binding.json'), { force: true });   // first run under the guard
  const r = guardAgainstForeignWal(DB, quiet);
  assert.equal(r.quarantined.length, 0, 'without proof, the guard must not touch the WAL');
  assert.ok(existsSync(join(dir, '.vault-binding.json')), 'but it must record the binding for next time');
});

t('no WAL at all → binding refreshed to the current file (a clean swap self-heals)', () => {
  const g2 = makeGenerations();
  recordVaultBinding(DB);
  copyFileSync(g2, DB); rmSync(`${DB}-wal`, { force: true }); rmSync(`${DB}-shm`, { force: true });
  const r = guardAgainstForeignWal(DB, quiet);
  assert.equal(r.quarantined.length, 0);
  // Now write a WAL on the NEW generation and re-run: it must be treated as legitimate.
  const d = new Database(DB); d.pragma('journal_mode=WAL');
  d.prepare('INSERT INTO gen2 VALUES (?)').run('post-swap'); copyFileSync(`${DB}-wal`, join(dir, 'w3.wal')); d.close();
  copyFileSync(join(dir, 'w3.wal'), `${DB}-wal`);
  const r2 = guardAgainstForeignWal(DB, quiet);
  assert.equal(r2.quarantined.length, 0, "the new generation's own WAL is legitimate after the binding refresh");
});

t('a corrupted/garbage binding file never blocks boot', () => {
  makeGenerations();
  writeFileSync(join(dir, '.vault-binding.json'), '{not json');
  const r = guardAgainstForeignWal(DB, quiet);
  assert.ok(r.checked, 'guard still runs');
  assert.equal(r.quarantined.length, 0, 'garbage binding = no proof = hands off');
});

try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
