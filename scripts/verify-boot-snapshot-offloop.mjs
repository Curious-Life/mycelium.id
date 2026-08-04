#!/usr/bin/env node
// verify:boot-snapshot-offloop — D-130 proof: the boot-path pre-migration
// snapshot runs OFF the event loop (awaited child) with the fail-closed
// contract intact, and the server answers honestly while it runs.
//
//   A. fail-closed split (injected copy child): migrating + child failure →
//      THROWS (boot refuses to migrate an un-backed-up vault); baseline +
//      child failure → continues.
//   B. the migrations fingerprint is recorded ONLY after a successful copy
//      (a failed one must not poison the next attempt — the sync twin's rule).
//   C. THE REAL CHILD on a REAL vault: the snapshot exists, opens, and
//      quick_checks 'ok' — and the parent's EVENT LOOP KEEPS TICKING during
//      the copy (the whole point of D-130; the sync path scores zero ticks).
//   D. /account/status honesty: getBootPhase → booting:true + bootPhase in the
//      payload; no phase → booting:false (the portal's re-poll keys on this).
//   E. wiring pins: init.js runs the off-loop snapshot before ensureVaultSchema;
//      server-rest listens BEFORE awaiting the boot sequence; the portal layout
//      handles s.booting (never routes a booting vault to /setup).
//
// MUTATION-TESTED: (D-130, 2026-08-04) the migrating-throw removed from
// maybeSnapshotBeforeMigrateOffloop (child failure logs and continues — a
// destructive migration would proceed un-backed-up) → A1 RED (no throw) while
// A2/B/C/D/E stay GREEN. Restored → GO.
// MUTATION-TESTED: (D-130, 2026-08-04) the awaited child replaced with the
// synchronous snapshotSync body inside the off-loop twin (the pre-fix
// behaviour) → C2 RED (zero event-loop ticks during the copy) AND A1/B2/A2
// RED (the injected failing child is bypassed entirely, so the fail-closed
// checks stop being drivable — the injection seam is itself load-bearing)
// while C1 stays GREEN (the copy is still valid — exactly why the liveness
// check exists). Restored → GO.
// MUTATION-TESTED: (D-130, 2026-08-04) /account/status `booting` hardwired to
// false in src/account/router.js → D1 RED (booting:false + bootPhase present —
// the portal would route a booting vault to /setup, the D-080 shape) while
// D2 stays GREEN. Restored → GO.
// MUTATION-TESTED: (round-1 gate review H4, 2026-08-04) runVaultCopyChild's
// exit handler made to ignore the exit code (always ok:true — gutting the
// fail-closed "no snapshot → no migration" contract) → C3 AND C4 RED.
// Restored → GO.
// MUTATION-TESTED: (round-1 gate review H5, 2026-08-04) the worker's
// verify-before-rename block deleted (a torn/empty copy would rename into
// place as a "backup" that cannot restore) → C4 RED (the empty-schema copy is
// accepted) while C3 stays GREEN (a garbage src fails at VACUUM, before
// verify — exactly why C4's empty-db case exists). Restored → GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import express from 'express';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeSnapshotBeforeMigrateOffloop } from '../src/account/snapshot-on-boot.js';
import { runVaultCopyChild } from '../src/db/vault-copy.js';
import { accountRouter } from '../src/account/router.js';

const ledger = [];
let allPass = true;
function check(name, cond) {
  const ok = !!cond;
  allPass = allPass && ok;
  ledger.push(`[${ok ? '✓' : '✗'}] ${name}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'boot-snap-offloop-'));
const MIG = join(scratch, 'migrations');
mkdirSync(MIG, { recursive: true });
writeFileSync(join(MIG, '0001_x.sql'), 'CREATE TABLE IF NOT EXISTS t (id INTEGER);');

/** A real plaintext vault with enough pages that the copy takes measurable time. */
function makeVault(p, { rows = 6000 } = {}) {
  const db = new Database(p);
  db.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, b BLOB)');
  const ins = db.prepare('INSERT INTO blobs (b) VALUES (?)');
  const chunk = Buffer.alloc(1024, 7);
  const tx = db.transaction((n) => { for (let i = 0; i < n; i++) ins.run(chunk); });
  tx(rows);
  db.close();
}

const failingChild = async () => ({ ok: false, code: 2, reason: 'gate-injected-failure' });
const okChild = (real) => (o) => real ? runVaultCopyChild(o) : (async () => { writeFileSync(o.destPath, 'x'); return { ok: true, code: 0, reason: null }; })();

try {
  // ── A: fail-closed split ────────────────────────────────────────────────────
  {
    const dir = join(scratch, 'a1'); mkdirSync(dir);
    const dbFile = join(dir, 'v.db'); makeVault(dbFile, { rows: 10 });
    let threw = null;
    try { await maybeSnapshotBeforeMigrateOffloop({ dbFile, dbKeyHex: null, migrationsDir: MIG, copyChild: failingChild }); }
    catch (e) { threw = e; }
    check('A1 migrating + child failure → THROWS (refuses to migrate un-backed-up)',
      threw && /Refusing to migrate/.test(String(threw.message)));
    check('B2 …and the fingerprint is NOT recorded after the failure',
      !existsSync(join(dir, 'snapshots', '.last-migrations-fp')));

    // baseline: record fp + a snapshot first (so migrating=false), then fail the child.
    const dir2 = join(scratch, 'a2'); mkdirSync(dir2);
    const dbFile2 = join(dir2, 'v.db'); makeVault(dbFile2, { rows: 10 });
    const ok1 = await maybeSnapshotBeforeMigrateOffloop({ dbFile: dbFile2, dbKeyHex: null, migrationsDir: MIG, copyChild: okChild(false) });
    check('B1 successful copy → snapshot path returned + fingerprint recorded',
      Boolean(ok1) && existsSync(join(dir2, 'snapshots', '.last-migrations-fp')));
    // now delete the baseline file so haveBaseline=false while fp matches → baseline re-take
    rmSync(ok1);
    let threw2 = null;
    let logged = '';
    try { await maybeSnapshotBeforeMigrateOffloop({ dbFile: dbFile2, dbKeyHex: null, migrationsDir: MIG, copyChild: failingChild, log: (m) => { logged += m; } }); }
    catch (e) { threw2 = e; }
    check('A2 baseline + child failure → boot continues with a loud log',
      threw2 === null && /baseline snapshot FAILED/.test(logged));
  }

  // ── C: the real child, real vault, live event loop ─────────────────────────
  {
    const dir = join(scratch, 'c'); mkdirSync(dir);
    const dbFile = join(dir, 'v.db'); makeVault(dbFile, { rows: 6000 }); // ~6 MB
    let ticks = 0;
    const t = setInterval(() => { ticks += 1; }, 1);
    const dest = await maybeSnapshotBeforeMigrateOffloop({ dbFile, dbKeyHex: null, migrationsDir: MIG });
    clearInterval(t);
    let qc = null;
    if (dest && existsSync(dest)) {
      const d = new Database(dest, { readonly: true });
      try { qc = d.pragma('quick_check', { simple: true }); } finally { d.close(); }
    }
    check('C1 real child copy → snapshot exists, opens, quick_check ok', qc === 'ok');
    check('C2 event loop KEPT TICKING during the copy (the D-130 point)', ticks >= 5);
  }

  // ── C3/C4 (round-1 gate review H4+H5): the REAL child's FAILURE semantics.
  // H4: exit-code honesty — a child that fails must not report ok (driven with
  // a garbage non-SQLite src through the real spawn + the real fail-closed
  // throw). H5: the worker's verify-before-rename — an EMPTY database VACUUMs
  // cleanly but has no schema; only the verify step can refuse it.
  {
    const dir = join(scratch, 'cfail'); mkdirSync(dir);
    const garbage = join(dir, 'v.db');
    writeFileSync(garbage, 'this is not a sqlite file at all — just bytes\n');
    let threw = null;
    try { await maybeSnapshotBeforeMigrateOffloop({ dbFile: garbage, dbKeyHex: null, migrationsDir: MIG }); }
    catch (e) { threw = e; }
    check('C3 REAL child on a garbage src → fail-closed throw, no snapshot, no fingerprint',
      threw !== null && /Refusing to migrate/.test(String(threw?.message))
      && !existsSync(join(dir, 'snapshots', '.last-migrations-fp'))
      && !(existsSync(join(dir, 'snapshots')) && (await import('node:fs')).readdirSync(join(dir, 'snapshots')).some((x) => x.endsWith('.db'))));

    const dir2 = join(scratch, 'cempty'); mkdirSync(dir2);
    const emptyDb = join(dir2, 'v.db');
    new Database(emptyDb).close(); // valid SQLite, ZERO tables — VACUUMs fine, verify must refuse
    const r = await runVaultCopyChild({ srcDbPath: emptyDb, destPath: join(dir2, 'copy.db'), dbKeyHex: null });
    check('C4 REAL child verify: an empty-schema copy is REFUSED before rename (no dest, ok:false)',
      r.ok === false && !existsSync(join(dir2, 'copy.db')));
  }

  // ── D: /account/status honesty ─────────────────────────────────────────────
  {
    const statusOf = async (getBootPhase) => {
      const app = express();
      app.use('/api/v1/account', accountRouter({
        isInitialized: () => false,
        completeBoot: async () => {},
        getBootError: () => null,
        getBootPhase,
        kcvPath: join(scratch, 'no-kcv.json'),
        lockFile: join(scratch, 'no-lock'),
        dbPath: join(scratch, 'no-db.db'),
        uploadsRoot: scratch,
        remoteConfigPath: join(scratch, 'no-remote.json'),
      }));
      const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const port = srv.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/account/status`);
      const j = await res.json();
      srv.close();
      return j;
    };
    const mid = await statusOf(() => 'snapshot');
    check('D1 boot in flight → booting:true + bootPhase:snapshot', mid.booting === true && mid.bootPhase === 'snapshot');
    const idle = await statusOf(() => null);
    check('D2 no boot in flight → booting:false + bootPhase:null', idle.booting === false && idle.bootPhase === null);
  }

  // ── E: wiring pins ─────────────────────────────────────────────────────────
  {
    const init = readFileSync('src/db/init.js', 'utf8');
    const iOff = init.indexOf('maybeSnapshotBeforeMigrateOffloop({');
    const iSchema = init.indexOf('ensureVaultSchema(dbPath, userHex)');
    check('E1 init.js: off-loop snapshot awaited BEFORE ensureVaultSchema', iOff > 0 && iSchema > iOff);
    const rest = readFileSync('src/server-rest.js', 'utf8');
    const iKick = rest.indexOf('const bootSequencePromise = runBootSequence()');
    const iListen = rest.indexOf('const s = app.listen(port, host');
    const iBoot = rest.indexOf('await bootSequencePromise');
    // Round-1 blocker shape: the boot KICK precedes listen (so the `booting`
    // latch is armed before any request can land) and the AWAIT follows listen
    // (so the port answers during the boot).
    check('E2 server-rest: boot kicked BEFORE listen; awaited AFTER listen', iKick > 0 && iListen > iKick && iBoot > iListen);
    const layout = readFileSync('portal-app/src/routes/+layout.svelte', 'utf8');
    check('E3 portal layout re-polls on s.booting (never /setup during a boot)', /s\.booting/.test(layout));
    const setup = readFileSync('portal-app/src/routes/setup/+page.svelte', 'utf8');
    check('E4 portal setup page waits out s.booting', /s\.booting/.test(setup));
  }
} catch (e) {
  check(`fatal: ${e?.message || e}`, false);
}
rmSync(scratch, { recursive: true, force: true });

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
