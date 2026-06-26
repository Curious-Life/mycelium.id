// verify:snapshot-on-boot — the opt-in, fail-closed pre-migration vault snapshot
// (src/account/snapshot-on-boot.js). Exercises the gating (flag + migrations
// fingerprint), the round-trip (snapshot opens + carries the pre-migration data),
// retention prune, and fail-closed-on-write-error. Plaintext db (dbKeyHex=null →
// online .backup) so it needs no SQLCipher key; the keyed VACUUM-INTO branch is
// covered by verify:backup / verify:at-rest.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// KEEP is read at import → pin it before importing the module under test.
process.env.MYCELIUM_SNAPSHOT_KEEP = '3';
const { maybeSnapshotBeforeMigrate } = await import('../src/account/snapshot-on-boot.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};
const snaps = (dir) => { try { return readdirSync(path.join(dir, 'snapshots')).filter((f) => f.startsWith('pre-migrate-')); } catch { return []; } };

const root = mkdtempSync(path.join(os.tmpdir(), 'snap-boot-'));
const dataDir = path.join(root, 'data'); mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'mycelium.db');
const migDir = path.join(root, 'migrations'); mkdirSync(migDir, { recursive: true });
writeFileSync(path.join(migDir, '0001_init.sql'), 'CREATE TABLE IF NOT EXISTS t (id INTEGER, v TEXT);');

// a real plaintext vault with one row to prove the snapshot carries data
{
  const db = new Database(dbFile);
  db.exec('CREATE TABLE t (id INTEGER, v TEXT); INSERT INTO t VALUES (1, \'hello\');');
  db.close();
}
const args = { dbFile, dbKeyHex: null, migrationsDir: migDir, log: () => {} };

// 1. flag unset → no-op
delete process.env.MYCELIUM_SNAPSHOT_ON_BOOT;
ok(maybeSnapshotBeforeMigrate(args) === null && snaps(dataDir).length === 0, 'flag unset → no snapshot');

// 2. flag set, fresh fingerprint → snapshot written + round-trips with the data
process.env.MYCELIUM_SNAPSHOT_ON_BOOT = '1';
const first = maybeSnapshotBeforeMigrate(args);
ok(first && existsSync(first), 'flag set + new migrations → snapshot written', first ? path.basename(first) : '(none)');
ok(snaps(dataDir).length === 1, 'exactly one snapshot so far', `(${snaps(dataDir).length})`);
{
  const sdb = new Database(first, { readonly: true });
  const row = sdb.prepare('SELECT v FROM t WHERE id = 1').get();
  sdb.close();
  ok(row && row.v === 'hello', 'snapshot round-trips: opens + carries pre-migration data');
}

// 3. second run, migrations UNCHANGED → skipped (fast path, no new snapshot)
ok(maybeSnapshotBeforeMigrate(args) === null && snaps(dataDir).length === 1, 'unchanged migrations → skip (no new snapshot)');

// 4. migrations CHANGE (new file) → new snapshot
writeFileSync(path.join(migDir, '0002_more.sql'), 'CREATE TABLE IF NOT EXISTS t2 (id INTEGER);');
const second = maybeSnapshotBeforeMigrate(args);
ok(second && second !== first && snaps(dataDir).length === 2, 'changed migrations → new snapshot', `(${snaps(dataDir).length})`);

// 5. retention prune to MYCELIUM_SNAPSHOT_KEEP=3 — churn the fingerprint a few times
for (let i = 3; i <= 6; i++) {
  writeFileSync(path.join(migDir, `000${i}_x.sql`), `CREATE TABLE IF NOT EXISTS t${i} (id INTEGER);`);
  // unique-ish wall-clock stamp per write so filenames don't collide
  maybeSnapshotBeforeMigrate(args);
}
ok(snaps(dataDir).length <= 3, 'retention prune caps snapshots at KEEP=3', `(${snaps(dataDir).length})`);

// 6. FAIL CLOSED — a snapshot write error throws (caller won't migrate), and the
// fingerprint gate is NOT poisoned (a retry will try again).
{
  const root2 = mkdtempSync(path.join(os.tmpdir(), 'snap-fc-'));
  const dd2 = path.join(root2, 'data'); mkdirSync(dd2, { recursive: true });
  const db2 = path.join(dd2, 'mycelium.db');
  new Database(db2).close();
  let threw = false;
  try {
    // invalid dbKeyHex makes snapshotDb throw → our wrapper must re-throw fail-closed
    maybeSnapshotBeforeMigrate({ dbFile: db2, dbKeyHex: 'not-64-hex', migrationsDir: migDir, log: () => {} });
  } catch (e) { threw = /Refusing to migrate/i.test(String(e.message)); }
  ok(threw, 'snapshot write failure throws fail-closed (Refusing to migrate)');
  ok(!existsSync(path.join(dd2, 'snapshots', '.last-migrations-fp')), 'failed snapshot does NOT record fingerprint (retryable)');
  rmSync(root2, { recursive: true, force: true });
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
