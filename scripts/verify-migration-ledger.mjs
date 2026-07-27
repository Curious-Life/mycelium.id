#!/usr/bin/env node
// verify-migration-ledger.mjs — the migration ledger, drift REPORTING, and self-heal.
//
// Independent review (2026-07-15) BLOCKED the first cut of this: it failed CLOSED on
// divergence, which bricks a Finder-launched app (unreachable env hatch → white screen),
// dev+prod SHARE one vault so branch skew is routine, and 8/54 migration files have been
// edited after landing (so the hash guard would refuse boot on a comment fix). It also
// MISSED the real vector: the canonical repo runs the old ledger-less applyMigrations, so
// nothing lands in the ledger to diverge FROM. This gate locks in the corrected behavior:
// report + self-heal + keep booting, and prove schemaDrift() sees a ledger-less foreign build.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { applyMigrations, schemaDrift } from '../src/db/migrate.js';
import { readLedger, LEDGER_TABLE } from '../src/db/migration-ledger.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const root = mkdtempSync(join(tmpdir(), 'myc-ledger-'));
const mkdir = (n) => { const d = join(root, n); mkdirSync(d, { recursive: true }); return d; };
const write = (d, f, sql) => writeFileSync(join(d, f), sql);
const db = () => new Database(':memory:');
const quiet = (fn) => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };

// this build's lineage
const DEV = mkdir('dev');
write(DEV, '0001_init.sql', 'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT);\nCREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY);');
write(DEV, '0041_categories_provenance.sql', 'ALTER TABLE messages ADD COLUMN categories_provenance TEXT;');
// the canonical repo's DIVERGENT lineage — same number, different file (the real fork)
const FOREIGN = mkdir('foreign');
write(FOREIGN, '0001_init.sql', 'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT);\nCREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY);');
write(FOREIGN, '0041_attachment_transcribe_attempts.sql', 'ALTER TABLE messages ADD COLUMN transcribe_attempts INTEGER DEFAULT 0;');

delete process.env.MYCELIUM_STRICT_LINEAGE;
console.log('\nmigration ledger + drift reporting + self-heal');

t('fresh vault: applies all + records them', () => {
  const d = db();
  assert.deepEqual(applyMigrations(d, DEV), ['0001_init.sql', '0041_categories_provenance.sql']);
  assert.equal(readLedger(d).size, 2);
  d.close();
});

t('re-run is a NO-OP (skip-if-applied — the 458ms→3ms win)', () => {
  const d = db();
  applyMigrations(d, DEV);
  assert.deepEqual(applyMigrations(d, DEV), []);
  d.close();
});

t('BOOTSTRAP: existing populated vault with NO ledger is not bricked', () => {
  const d = db();
  d.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT, categories_provenance TEXT); CREATE TABLE facts (id TEXT PRIMARY KEY)');
  quiet(() => applyMigrations(d, DEV));
  assert.equal(readLedger(d).size, 2, 'ledger backfilled');
  d.close();
});

// ── the review's HIGH-1 / HIGH-2: divergence must NEVER brick the boot ──
t('HIGH-1: foreign/newer lineage (branch skew) WARNS but still BOOTS', () => {
  const d = db();
  applyMigrations(d, FOREIGN);                       // a build with an extra migration ran first
  const applied = quiet(() => applyMigrations(d, DEV)); // this build boots the same vault
  assert.ok(Array.isArray(applied), 'must NOT throw — a boot refusal is an unrecoverable white screen');
  assert.ok(readLedger(d).has('0041_attachment_transcribe_attempts.sql'), 'foreign entry retained for forensics');
  d.close();
});

t('HIGH-2: an edited migration file WARNS but still BOOTS (8/54 were edited after landing)', () => {
  const d = db();
  applyMigrations(d, DEV);
  const MUT = mkdir('mutated');
  write(MUT, '0001_init.sql', 'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT);\nCREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY);');
  write(MUT, '0041_categories_provenance.sql', 'ALTER TABLE messages ADD COLUMN categories_provenance TEXT; -- typo fix');
  const applied = quiet(() => applyMigrations(d, MUT));
  assert.ok(Array.isArray(applied), 'a comment fix must not refuse boot on every existing vault');
  d.close();
});

t('opt-in MYCELIUM_STRICT_LINEAGE=1 DOES gate (CI only, never the shipped app)', () => {
  const d = db();
  applyMigrations(d, FOREIGN);
  process.env.MYCELIUM_STRICT_LINEAGE = '1';
  let threw = null;
  try { quiet(() => applyMigrations(d, DEV)); } catch (e) { threw = e; } finally { delete process.env.MYCELIUM_STRICT_LINEAGE; }
  assert.ok(threw && /lineage/i.test(threw.message), 'strict mode must throw');
  d.close();
});

// ── the review's MED-4: skip-if-applied removed the old self-heal ──
t('MED-4: a DROPPED expected table is restored (self-heal preserved)', () => {
  const d = db();
  applyMigrations(d, DEV);
  d.exec('DROP TABLE facts');
  const applied = quiet(() => applyMigrations(d, DEV));
  assert.ok(applied.length > 0, 'must re-apply when an expected table is missing');
  const back = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='facts'`).get();
  assert.ok(back, 'facts table restored');
  d.close();
});

// ── the review's MED-5: the ledger can't see a ledger-less foreign build; schemaDrift can ──
t('MED-5: schemaDrift() SEES a ledger-less foreign build (the real vector)', () => {
  const d = db();
  applyMigrations(d, DEV);
  d.exec('ALTER TABLE messages ADD COLUMN transcribe_attempts INTEGER DEFAULT 0'); // foreign build, records nothing
  const drift = schemaDrift(d, DEV);
  assert.ok(drift.some((x) => x.table === 'messages' && x.column === 'transcribe_attempts'),
    'must report the foreign column the ledger cannot see');
  d.close();
});

t('schemaDrift() is quiet on a clean vault (no false positives)', () => {
  const d = db();
  applyMigrations(d, DEV);
  assert.deepEqual(schemaDrift(d, DEV), []);
  d.close();
});

// ── the review's MED-3: readLedger must not fail OPEN ──
t('MED-3: an unreadable ledger REFUSES (does not silently look un-migrated)', () => {
  const d = db();
  applyMigrations(d, DEV);
  d.exec(`DROP TABLE ${LEDGER_TABLE}`);
  d.exec(`CREATE TABLE ${LEDGER_TABLE} (bogus TEXT)`); // hijacked/corrupt shape
  let threw = null;
  try { readLedger(d); } catch (e) { threw = e; }
  assert.ok(threw && /unreadable/i.test(threw.message), 'must refuse, not return an empty Map');
  d.close();
});

// ── the review's MED-2: the toy fixtures never exercised the REAL 54 migrations ──
t('MED-2: the REAL migrations/ set bootstraps + is a no-op on the 2nd run', () => {
  const d = db();
  const n = readdirSync('migrations').filter((f) => f.endsWith('.sql')).length;
  const first = quiet(() => applyMigrations(d, 'migrations'));
  assert.equal(first.length, n, `all ${n} real migrations applied`);
  assert.deepEqual(quiet(() => applyMigrations(d, 'migrations')), [], '2nd run applies nothing');
  assert.deepEqual(schemaDrift(d, 'migrations'), [], 'a vault built from our own migrations has no drift');
  d.close();
});

t('ledger table is a normal table (carried by backup/rebuild tooling)', () => {
  const d = db();
  applyMigrations(d, DEV);
  assert.ok(d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(LEDGER_TABLE));
  d.close();
});

try { rmSync(root, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
