#!/usr/bin/env node
// verify-auth-db-heal.mjs — auth.db is REGENERABLE, and is treated that way.
//
// WHY THIS IS NOT THE VAULT'S PROBLEM, measured rather than assumed (2026-07-28): with
// auth.db fully corrupt the DESKTOP app boots and serves normally — portal HTTP 200,
// /account/status 200, no auth error in the log. `createAuth` is reached only from
// src/server-http.js (the :4711 remote/OAuth surface) and src/remote/config.js; the desktop
// path is the auth shim, which authenticates from loopback trust plus device-sessions
// stored INSIDE the vault. An adversarial review called this "corrupt auth.db = locked out
// of a healthy vault"; the experiment says otherwise. It costs the REMOTE surface, never
// access to your own data.
//
// So it earns REGENERATION, not the vault's machinery. Giving a file whose loss costs a
// re-pair the same fail-stop latch + snapshots + WAL guard as a file whose loss is
// unrecoverable would be three more layers protecting nothing. The pattern used instead is
// the one already established for the regenerable search index: detect → QUARANTINE (never
// delete; it holds secrets a human may want to salvage) → recreate → say what to redo.
//
// MUTATION-TESTED: removed the healAuthDbIfCorrupt() call from createAuth → "a corrupt
//   auth.db is healed rather than fatal" REDs
// MUTATION-TESTED: moved healAuthDbIfCorrupt() back BELOW resolveAuthSecret() (the original
//   bug — resolveAuthSecret opens auth.db itself and throws first) → "a corrupt auth.db is
//   healed rather than fatal" REDs
// MUTATION-TESTED: made the heal rmSync the damaged file instead of renaming it →
//   "the damaged file is QUARANTINED, never deleted" REDs
// MUTATION-TESTED: made isAuthDbCorrupt() return true for any error → "a non-corruption
//   error is NOT treated as damage" REDs
//
// ⚠️ TWO of these checks were GREEN FOR THE WRONG REASON on the first pass, and only
// re-running the mutations exposed it:
//  · the ordering check compared source indexes and matched the function DEFINITION (above
//    createAuth) rather than the call site, so it stayed green with the heal moved back
//    below resolveAuthSecret. Worse, every other test passed an explicit `secret`, which
//    short-circuits resolveAuthSecret entirely — so NOTHING exercised the ordering. It is
//    now behavioural: createAuth({ dbPath }) with no secret, which is the real boot path.
//  · the classifier check used a DIRECTORY at the db path, which the isFile() guard
//    short-circuits before the classifier is ever consulted. It now uses an unreadable
//    regular FILE, which reaches the open and fails with a permission error.
// Both only became real tests after the mutation refused to turn them red.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
// MUTATION-TESTED (2026-07-28), added after an adversarial review found the heal acted
// destructively on a SINGLE observation. Each mutation applied, confirmed on disk, run,
// restored:
//   K. removed the settle + fresh-connection re-probe (act on the first reading)
//      → "a destructive heal is CONFIRMED on a second look" REDs (it finishes instantly).
//   U. kept sleepSync() but ignored the second probe (`const second = first`)
//      → "a file that READS CLEAN on the second look is NOT quarantined" REDs.
//      ⚠️ U SURVIVED against the K check alone, and that is the lesson: K asserts only
//      elapsed >= 2500ms, and a stopwatch cannot tell "waited, then looked again" from
//      "waited". The safety property is what the SECOND LOOK decides, so it is now driven
//      directly — the file is damaged when the first probe runs and healthy by the second.
//      The restore has to come from ANOTHER PROCESS: sleepSync() is Atomics.wait and
//      blocks this event loop outright, so an in-process timer can never fire during the
//      settle and the first draft of that check could not have exercised the transient.
//
// ⚠️ L. removing the `moved === 0` stand-down is NOT COVERED, and saying so is the point.
// Two attempts failed honestly: "exactly one quarantine exists" is true either way (only
// one rename can win), and asserting the loser takes the `moved === 0` path SPECIFICALLY
// is timing-dependent — the winner usually finishes inside the loser's 3s settle, so the
// loser legitimately stands down via the re-probe instead, and the check then fails on
// correct code. The race check asserts the invariant both routes satisfy (exactly one
// acted, exactly one stood down). The `moved === 0` branch is a tight-race guard protected
// BY CONSTRUCTION, not by a check; reaching it deterministically needs an injection point
// in the product that is not worth adding.


import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readdirSync, copyFileSync, openSync, readSync, writeSync, closeSync, statSync, mkdirSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const root = mkdtempSync(join(tmpdir(), 'myc-authheal-'));

/** A plaintext auth.db shaped like the real one (it is NOT SQLCipher — verified on disk). */
function makeAuthDb(dir, name = 'auth.db') {
  const p = join(dir, name);
  const db = new Database(p);
  db.exec('CREATE TABLE mycelium_app_secret(id INTEGER PRIMARY KEY, secret TEXT)');
  db.exec('CREATE TABLE user(id TEXT PRIMARY KEY, email TEXT)');
  db.prepare('INSERT INTO mycelium_app_secret(secret) VALUES (?)').run('s3cr3t-value');
  db.prepare("INSERT INTO user(id, email) VALUES ('u1','a@b.c')").run();
  db.close();
  return p;
}

/** Same-lineage page-1 splice: decrypts/parses, structurally a lie. */
function corrupt(p) {
  const donor = `${p}.donor`;
  copyFileSync(p, donor);
  const d = new Database(donor);
  d.exec('CREATE TABLE pad(a TEXT)');
  const i = d.prepare('INSERT INTO pad(a) VALUES (?)');
  d.transaction(() => { for (let k = 0; k < 9000; k++) i.run('Q'.repeat(200) + k); })();
  d.pragma('wal_checkpoint(TRUNCATE)');
  d.close();
  const PS = 4096, a = openSync(donor, 'r'), b = openSync(p, 'r+'), buf = Buffer.alloc(PS);
  readSync(a, buf, 0, PS, 0); writeSync(b, buf, 0, PS, 0);
  closeSync(a); closeSync(b); rmSync(donor, { force: true });
}

const quarantined = (dir) => readdirSync(dir).filter((f) => /^auth\.db\.corrupt-/.test(f));

// ══ 1. the premise: a healthy auth.db is left alone ════════════════════════════
await t('a healthy auth.db is opened untouched (no spurious quarantine)', async () => {
  const dir = mkdtempSync(join(root, 'ok-'));
  const p = makeAuthDb(dir);
  const before = statSync(p).size;
  const { createAuth } = await import('../src/auth.js');
  createAuth({ dbPath: p, secret: 'x'.repeat(40) });
  assert.equal(quarantined(dir).length, 0, 'a healthy file must never be set aside');
  assert.ok(statSync(p).size >= before, 'the original file must still be the live one');
});

// ══ 2. THE POINT: corruption heals instead of killing the remote surface ═══════
await t('a corrupt auth.db is healed rather than fatal', async () => {
  const dir = mkdtempSync(join(root, 'heal-'));
  const p = makeAuthDb(dir);
  corrupt(p);
  // precondition: it really is damaged
  let threw = null;
  try { const d = new Database(p, { readonly: true }); d.prepare('SELECT count(*) FROM sqlite_master').get(); d.close(); }
  catch (e) { threw = e; }
  assert.ok(threw && /CORRUPT|NOTADB/.test(threw.code), `fixture is not corrupt (${threw?.code})`);

  const { createAuth } = await import('../src/auth.js');
  assert.doesNotThrow(() => createAuth({ dbPath: p, secret: 'x'.repeat(40) }),
    'a corrupt auth.db must not take the remote surface down permanently');

  // the live file is fresh and usable
  const fresh = new Database(p, { readonly: true });
  assert.doesNotThrow(() => fresh.prepare('SELECT count(*) FROM sqlite_master').get());
  fresh.close();
});

await t('the damaged file is QUARANTINED, never deleted', async () => {
  const dir = mkdtempSync(join(root, 'quar-'));
  const p = makeAuthDb(dir);
  const originalBytes = statSync(p).size;
  corrupt(p);
  const { createAuth } = await import('../src/auth.js');
  createAuth({ dbPath: p, secret: 'x'.repeat(40) });

  const aside = quarantined(dir);
  assert.equal(aside.length, 1, `expected exactly one quarantined file, got ${aside.length}`);
  // It holds the signing secret and the relay/MCP secrets — a human may want to salvage
  // one by hand, so the bytes must still be there.
  assert.ok(statSync(join(dir, aside[0])).size >= originalBytes,
    'the quarantined file must retain the original bytes');
});

// ══ 3. the ORDERING bug that made the first version of this a no-op ════════════
await t('a destructive heal is CONFIRMED on a second look, not taken on one reading', async () => {
  // Quarantining rotates the signing secret + relay/acme-dns secrets + the MCP bearer:
  // every OAuth token and paired device dies. The repo already learned in
  // vault-integrity-check.mjs that a concurrent write makes a read-only probe read as
  // damage TRANSIENTLY — and there the action is only an advisory marker. One reading is
  // not enough to justify the destructive version.
  //
  // Behavioural proof that the settle+re-probe actually RUNS: the heal cannot complete
  // faster than the settle it is required to wait out. Deleting the re-verify makes this
  // finish immediately.
  const dir = mkdtempSync(join(root, 'settle-'));
  const p = makeAuthDb(dir);
  corrupt(p);
  const { createAuth } = await import('../src/auth.js');
  const t0 = Date.now();
  createAuth({ dbPath: p, secret: 'x'.repeat(40) });
  const elapsed = Date.now() - t0;
  // precondition: it really did quarantine (otherwise "slow" would prove nothing)
  assert.equal(quarantined(dir).length, 1, 'precondition: the damaged file must have been quarantined');
  assert.ok(elapsed >= 2500,
    `the heal confirmed damage in ${elapsed}ms — too fast to have re-probed on a fresh connection after a settle`);
});

await t('a REQUEST-path caller never blocks the event loop on the settle', async () => {
  // sleepSync is Atomics.wait — it freezes the whole loop. createAuth is also reached from
  // src/remote/config.js:437 (setOperatorPassword) via an HTTP route, where a 3s stall
  // would freeze every concurrent request. That caller passes settleOnDamage:false and
  // must decline to act rather than settle; the next boot heals it.
  const dir = mkdtempSync(join(root, 'nosettle-'));
  const p = makeAuthDb(dir);
  corrupt(p);
  const { createAuth } = await import('../src/auth.js');
  const t0 = Date.now();
  createAuth({ dbPath: p, secret: 'x'.repeat(40), settleOnDamage: false });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `a request-path caller must not wait out the settle (took ${elapsed}ms)`);
  assert.equal(quarantined(dir).length, 0,
    'and must not quarantine on a single reading — the boot path owns that decision');
});

await t('a file that READS CLEAN on the second look is NOT quarantined (the re-probe decides, not the clock)', async () => {
  // ⚠️ The check above measures the SLEEP, and a second re-review proved that is not the
  // property: keeping sleepSync() while ignoring the second probe (`const second = first`)
  // left it GREEN 8/8. A stopwatch cannot tell "waited then looked again" from "waited".
  //
  // This drives the actual safety property. The file is damaged when the FIRST probe runs
  // and healthy by the time the second one does — exactly the transient a concurrent
  // sibling produces — so only a real re-probe can reach the right answer.
  const dir = mkdtempSync(join(root, 'transient-'));
  const p = makeAuthDb(dir);
  const healthy = readFileSync(p);
  corrupt(p);
  // The restore must come from ANOTHER PROCESS. sleepSync() is Atomics.wait, which blocks
  // this event loop outright — an in-process setTimeout cannot fire during the settle, so
  // the first version of this check could never have exercised the transient at all.
  const good = join(dir, 'good.bytes');
  writeFileSync(good, healthy);
  const restorer = spawn(process.execPath, ['-e',
    `const fs=require('fs');setTimeout(()=>{try{fs.copyFileSync(${JSON.stringify(good)},${JSON.stringify(p)});}catch{}},1200);`,
  ], { stdio: 'ignore' });
  try {
    const { createAuth } = await import('../src/auth.js');
    createAuth({ dbPath: p, secret: 'x'.repeat(40) });
  } finally { try { restorer.kill(); } catch { /* */ } }
  assert.equal(quarantined(dir).length, 0,
    'a file that reads clean on the second look must NOT be quarantined — that is the whole point of the settle');
  const fresh = new Database(p, { readonly: true });
  assert.doesNotThrow(() => fresh.prepare('SELECT count(*) FROM sqlite_master').get(), 'the original file must survive untouched');
  fresh.close();
});

await t('two processes racing to heal produce ONE quarantine, and the loser stands down', async () => {
  // Both siblings can observe the same damage. The loser used to find nothing left to
  // rename, SKIP the move, and still return true — claiming a quarantine it never did,
  // after which both minted a fresh db and a fresh signing secret.
  const dir = mkdtempSync(join(root, 'race-'));
  const p = makeAuthDb(dir);
  corrupt(p);
  const child = join(dir, 'heal-child.mjs');
  writeFileSync(child, [
    `import { createAuth } from ${JSON.stringify(fileURLToPath(new URL('../src/auth.js', import.meta.url)))};`,
    `try { createAuth({ dbPath: process.argv[2], secret: 'x'.repeat(40) }); console.log('DONE'); }`,
    `catch (e) { console.log('THREW:' + (e?.message || e)); }`,
    `process.exit(0);`,
  ].join('\n'));
  const procs = await Promise.all([0, 1].map(() => new Promise((res) => {
    const c = spawn(process.execPath, [child, p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => res({ code, out: out.trim(), err }));
  })));
  // POSITIVE PRECONDITION: both children must have actually run to their reporting line.
  for (const r of procs) assert.match(r.out, /DONE|THREW/, `a racer never reported (out=${r.out})`);
  assert.equal(quarantined(dir).length, 1,
    `exactly one quarantine must exist, got ${quarantined(dir).length} — both racers acted`);
  // Exactly one racer may ACT; the other must stand down — by either legitimate route:
  // the settle re-probe finding the file healthy again (the common case, since the winner
  // usually finishes inside the loser's settle window), or the `moved === 0` guard when
  // the two are tight enough that both reach the rename. Which route is taken depends on
  // process-startup skew, so assert the INVARIANT both satisfy, not one path.
  const acted = procs.filter((r) => /has been set aside as/i.test(r.err)).length;
  assert.equal(acted, 1, `exactly one racer may quarantine, got ${acted}`);
  // NOT asserted: which route the loser took to stand down. It has three legitimate ones
  // depending on process-startup skew — the settle re-probe finding the file healthy, the
  // `moved === 0` guard, or simply starting after the winner finished and never seeing
  // damage at all (which logs nothing). Asserting any ONE of them made this gate flaky
  // (measured 2 GO / 1 NO-GO over 3 runs) and a gate that cannot discriminate makes every
  // verdict it gives uninformative. The invariant that matters is above: exactly one
  // quarantine, by exactly one racer, and a usable db afterwards.
  const fresh = new Database(p, { readonly: true });
  assert.doesNotThrow(() => fresh.prepare('SELECT count(*) FROM sqlite_master').get(), 'the live auth.db must be usable after the race');
  fresh.close();
});

await t('the heal runs BEFORE anything reads the db (ordering regression guard)', async () => {
  // resolveAuthSecret() reads the signing secret out of auth.db itself, so a heal placed
  // after it never runs — the first implementation had exactly this bug and looked correct.
  // BEHAVIOURAL, not textual. The first version of this check compared source indexes and
  // matched the function DEFINITION (which is above createAuth) rather than the call site,
  // so it stayed green with the heal moved back below resolveAuthSecret. And every other
  // test passes an explicit `secret`, which short-circuits resolveAuthSecret entirely —
  // so none of them exercised the ordering at all. Omitting the secret is what reproduces
  // the real boot path.
  const dir = mkdtempSync(join(root, 'order-'));
  const p = makeAuthDb(dir);
  corrupt(p);
  const { createAuth } = await import('../src/auth.js');
  assert.doesNotThrow(
    () => createAuth({ dbPath: p }), // NO explicit secret ⇒ resolveAuthSecret() really runs
    'with no injected secret, resolveAuthSecret() reads auth.db itself — the heal must have '
    + 'already run, or this throws SQLITE_CORRUPT before it can',
  );
  assert.equal(quarantined(dir).length, 1, 'the damaged file must have been set aside');

  // …and the ordering is still asserted in source, against the CALL site specifically.
  const src = (await import('node:fs')).readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
  // Match the CALL by its indentation + opening paren, not by its full argument list — an
  // exact-text index broke the moment a second argument was added (settleOnDamage), which
  // is a check failing on a correct change rather than on a regression.
  const iHeal = src.indexOf('    healAuthDbIfCorrupt(dbPath'); // the call, indented in createAuth
  const iSecret = src.indexOf('opts.secret || resolveAuthSecret()');
  assert.ok(iHeal > 0, 'the heal CALL site (not its definition) must be found');
  assert.ok(iSecret > 0, 'resolveAuthSecret call not found — repoint this check');
  assert.ok(iHeal < iSecret, 'the heal must precede resolveAuthSecret()');
});

// ══ 4. it must not treat every failure as damage ═══════════════════════════════
await t('a non-corruption error is NOT treated as damage', async () => {
  const dir = mkdtempSync(join(root, 'nc-'));
  const p = makeAuthDb(dir);
  const { createAuth } = await import('../src/auth.js');
  createAuth({ dbPath: p, secret: 'x'.repeat(40) });
  assert.equal(quarantined(dir).length, 0, 'a working db must never be quarantined');

  // A path that does not exist is "nothing to heal", not "damage".
  const missing = join(dir, 'nope.db');
  assert.doesNotThrow(() => createAuth({ dbPath: missing, secret: 'x'.repeat(40) }));
  assert.equal(quarantined(dir).length, 0, 'an absent db must not produce a quarantine file');

  // A healthy db never enters the catch, so the checks above cannot see the classifier at
  // all — they passed with isAuthDbCorrupt() hardwired to true. A DIRECTORY at the db path
  // raises SQLITE_CANTOPEN: a real error that is emphatically NOT structural damage, and
  // must propagate rather than quietly "heal" (which would mean renaming a directory aside
  // and inventing a fresh db over a genuine configuration mistake).
  const dir2 = mkdtempSync(join(root, 'cantopen-'));
  const asDir = join(dir2, 'auth.db');
  mkdirSync(asDir, { recursive: true });
  // The property under test is not "it throws" (better-auth defers the real open, so it
  // may not) — it is that a non-damage error must never trigger the DESTRUCTIVE branch.
  // With isAuthDbCorrupt() hardwired true, the CANTOPEN sends this directory down the
  // quarantine path and it gets renamed aside; that is what must not happen.
  try { createAuth({ dbPath: asDir, secret: 'x'.repeat(40) }); } catch { /* throwing is fine */ }
  assert.equal(readdirSync(dir2).filter((f) => /corrupt-/.test(f)).length, 0,
    'a CANTOPEN (a directory at the db path) must NOT be quarantined as if it were damage');
  assert.ok(existsSync(asDir), 'the path must be left exactly where it was');

  // The directory case is short-circuited by the isFile() guard, so it does not exercise
  // the CLASSIFIER. An UNREADABLE REGULAR FILE does: it is a file, so it reaches the open,
  // and fails with a permission error that is emphatically not structural damage.
  const dir3 = mkdtempSync(join(root, 'perm-'));
  const locked = makeAuthDb(dir3);
  chmodSync(locked, 0o000);
  try { createAuth({ dbPath: locked, secret: 'x'.repeat(40) }); } catch { /* throwing is fine */ }
  const q3 = readdirSync(dir3).filter((f) => /corrupt-/.test(f));
  chmodSync(locked, 0o600); // restore so the temp dir can be cleaned up
  assert.equal(q3.length, 0,
    'an unreadable file is a PERMISSION problem, not damage — quarantining it would destroy '
    + 'the only copy of the signing secret over a chmod');
});

// ══ 5. the design decision itself, recorded where it will be read ══════════════
await t('auth.db is NOT given the vault\'s durability machinery (and the reason is stated)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
  assert.match(src, /REGENERABLE-WITH-FRICTION/,
    'the file must state why it is treated differently from the vault');
  // It must NOT have quietly acquired the vault's mechanisms.
  assert.doesNotMatch(src, /vault-halt|assertVaultUsable|snapshot-schedule/,
    'auth.db must not import the vault fail-stop/snapshot machinery — its loss costs a re-pair, not data');
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
