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

// MUTATION-TESTED: (D-121, 2026-08-03) the changed-file guard in src/db/migrate.js was disabled
// (`if (changedSet.has(f) && !reapplyChanged)` → `if (false && …)`) → D121a REDs (divergent_extra
// column lands + applied-list includes the changed file), D121c REDs, D121d REDs (heal becomes a
// back door); D121b stays GREEN as the control. Guard restored → 16/16 GREEN. This is the exact
// pre-fix behaviour: before D-121 the loop skipped only on hash-EQUAL, so a changed file WAS
// re-applied while the comment above it claimed "not re-applying".
// MUTATION-TESTED: (D-121, 2026-08-03, post-review) the heal's expected-table scoping
// reverted (`healFiles = files`) → D121e REDs: the second boot heal-loops over the table
// the refused file can never create (the security review's F4, reproduced then fixed).
// Restored → 17/17 GREEN.
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

// ── D-121: divergent lineage must never RE-ASSERT its DDL (fail closed on the destructive act) ──
// The 2026-07-27/30 corruption mechanism: two lineages fork at one number, and re-applying the
// other build's version of an already-applied file asserts conflicting DDL into a live vault.
// The old loop skipped only on hash-EQUAL, so a changed file WAS re-applied — while the comment
// above it claimed "not re-applying". These checks pin the corrected behaviour.
t('D121a: a hash-CHANGED migration is NOT re-applied — its DDL never lands, the ledger keeps the truth', () => {
  const d = db();
  applyMigrations(d, DEV);
  const before = readLedger(d).get('0041_categories_provenance.sql');
  const DIV = mkdir('divergent');
  write(DIV, '0001_init.sql', 'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT);\nCREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY);');
  write(DIV, '0041_categories_provenance.sql', 'ALTER TABLE messages ADD COLUMN categories_provenance TEXT;\nALTER TABLE messages ADD COLUMN divergent_extra TEXT;');
  const applied = quiet(() => applyMigrations(d, DIV));
  assert.ok(!applied.includes('0041_categories_provenance.sql'), 'changed file must not be in the applied list');
  const cols = d.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
  assert.ok(!cols.includes('divergent_extra'), 'the divergent DDL must NOT have been asserted');
  assert.equal(readLedger(d).get('0041_categories_provenance.sql'), before,
    'the ledger must still record what ACTUALLY ran — an unapplied hash recorded would be a lie');
  d.close();
});

t('D121b (control): MYCELIUM_LINEAGE_REAPPLY=1 DOES apply the changed file — proves D121a is non-vacuous', () => {
  const d = db();
  applyMigrations(d, DEV);
  const DIV = mkdir('divergent-optin');
  write(DIV, '0001_init.sql', 'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT);\nCREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY);');
  write(DIV, '0041_categories_provenance.sql', 'ALTER TABLE messages ADD COLUMN categories_provenance TEXT;\nALTER TABLE messages ADD COLUMN divergent_extra TEXT;');
  process.env.MYCELIUM_LINEAGE_REAPPLY = '1';
  try { quiet(() => applyMigrations(d, DIV)); } finally { delete process.env.MYCELIUM_LINEAGE_REAPPLY; }
  const cols = d.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
  assert.ok(cols.includes('divergent_extra'), 'the explicit opt-in must apply this build\'s version');
  d.close();
});

t('D121c: a NEW migration beside a changed one still applies — the refusal is per-file, not global', () => {
  const d = db();
  applyMigrations(d, DEV);
  const DIV = mkdir('divergent-plus-new');
  write(DIV, '0001_init.sql', 'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT);\nCREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY);');
  write(DIV, '0041_categories_provenance.sql', 'ALTER TABLE messages ADD COLUMN categories_provenance TEXT;\nALTER TABLE messages ADD COLUMN divergent_extra TEXT;');
  write(DIV, '0050_new_table.sql', 'CREATE TABLE IF NOT EXISTS qa10_new (id TEXT PRIMARY KEY);');
  const applied = quiet(() => applyMigrations(d, DIV));
  // (the new file's expected table also trips the self-heal, which legitimately re-applies
  //  UNCHANGED files — the claim here is only: new applies, changed still refused)
  assert.ok(applied.includes('0050_new_table.sql'), 'the genuinely new file applies');
  assert.ok(!applied.includes('0041_categories_provenance.sql'), 'the changed file stays refused');
  assert.ok(d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='qa10_new'`).get(), 'new table created');
  const cols = d.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
  assert.ok(!cols.includes('divergent_extra'), 'divergent DDL still absent');
  d.close();
});

t('D121d: the self-heal re-applies UNCHANGED files but still refuses the changed one', () => {
  const d = db();
  applyMigrations(d, DEV);
  d.exec('DROP TABLE facts'); // trigger heal
  const DIV = mkdir('divergent-heal');
  write(DIV, '0001_init.sql', 'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT);\nCREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY);');
  write(DIV, '0041_categories_provenance.sql', 'ALTER TABLE messages ADD COLUMN categories_provenance TEXT;\nALTER TABLE messages ADD COLUMN divergent_extra TEXT;');
  const applied = quiet(() => applyMigrations(d, DIV));
  assert.ok(d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='facts'`).get(), 'dropped table healed');
  const cols = d.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
  assert.ok(!cols.includes('divergent_extra'), 'heal must not become a back door for divergent DDL');
  assert.ok(!applied.includes('0041_categories_provenance.sql'), 'changed file refused even under heal');
  d.close();
});

t('D121e: a changed file that ADDS a table does NOT trip the self-heal every boot (no heal loop)', () => {
  // Independent security review (2026-08-03): with the heal's expected-table set computed
  // from ALL of this build's files, an edited migration adding a table made the heal fire
  // EVERY boot forever — re-applying all migrations each time (the DDL re-assertion D-121
  // exists to stop) while the changed file stayed refused and its table never appeared.
  // The expected set now excludes refused files' tables.
  const d = db();
  applyMigrations(d, DEV);
  const DIV = mkdir('divergent-newtable');
  write(DIV, '0001_init.sql', 'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, content TEXT);\nCREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY);');
  write(DIV, '0041_categories_provenance.sql', 'ALTER TABLE messages ADD COLUMN categories_provenance TEXT;\nCREATE TABLE IF NOT EXISTS div_only_table (id TEXT PRIMARY KEY);');
  const boot2 = quiet(() => applyMigrations(d, DIV));
  const boot3 = quiet(() => applyMigrations(d, DIV));
  assert.deepEqual(boot2, [], 'the changed file is refused and nothing else needs applying');
  assert.deepEqual(boot3, [], 'and the NEXT boot must not heal-loop over the table the refusal makes impossible');
  assert.ok(!d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='div_only_table'`).get(), 'the divergent table stays absent (refused, not healed in)');
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
