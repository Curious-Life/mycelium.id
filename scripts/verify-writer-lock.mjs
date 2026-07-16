#!/usr/bin/env node
// verify-writer-lock.mjs — the fail-closed single-family vault writer lock.
//
// Proves: non-canonical/:memory: pass-through, per-db lock identity (a canonical FIXTURE
// locks itself, never another db's lock file; a symlink-aliased path is still ONE vault),
// first acquire + token publish, same-token family allow, ancestry family allow (no token),
// FOREIGN live holder refusal, dead-holder reclaim, release-only-if-owner, escape hatch.
// Drives writer-lock.js against a FAKE canonical path (MYCELIUM_DB) in a temp dir — never
// touches the real vault.

import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }

const dir = mkdtempSync(join(tmpdir(), 'myc-wl-'));
const VAULT = join(dir, 'mycelium.db');
const LOCK = join(dir, 'mycelium.db.writer.lock');
// Pin the canonical path the lock guards to our temp vault.
process.env.MYCELIUM_DB = VAULT;
delete process.env.MYCELIUM_VAULT_FAMILY;
delete process.env.MYCELIUM_SKIP_WRITER_LOCK;

const { acquireVaultWriterLock } = await import('../src/db/writer-lock.js');
const clearLock = () => { try { rmSync(LOCK); } catch {} };
const clearFam = () => { delete process.env.MYCELIUM_VAULT_FAMILY; };

console.log('\nvault writer-lock');

await t(':memory: → no-op pass-through (no lockfile)', async () => {
  const h = acquireVaultWriterLock(':memory:');
  assert.equal(existsSync(LOCK), false);
  h.release();
});

await t('non-canonical path → no-op (never locks test/temp dbs)', async () => {
  const h = acquireVaultWriterLock(join(dir, 'somethingelse.db'));
  assert.equal(existsSync(LOCK), false);
  h.release();
});

await t('REGRESSION: a canonical FIXTURE locks ITSELF, never another db’s lock file', async () => {
  // THE BUG (2026-07-16): the lock filename was a CONSTANT ('mycelium.db.writer.lock')
  // resolved against dirname(dbPath). A verify gate points MYCELIUM_DB at a fixture sitting
  // beside the vault — and paths.js dbPath() READS MYCELIUM_DB, so the fixture BECAME
  // "canonical" here: the non-canonical no-op above never fired, and the constant basename
  // sent the fixture at the VAULT's lock file. Four gates (realm-prune, describe-gating,
  // describe-coverage, history) then failed closed against the running app for a reason
  // having nothing to do with what they test. Lock identity must follow the DB FILE.
  // RED on the constant-basename code: it creates LOCK and never FIXTURE_LOCK.
  clearLock(); clearFam();
  const FIXTURE = join(dir, 'verify-fixture.db');
  const FIXTURE_LOCK = `${FIXTURE}.writer.lock`;
  const prevDb = process.env.MYCELIUM_DB;
  process.env.MYCELIUM_DB = FIXTURE; // exactly what a gate puts in its child's env
  try {
    const h = acquireVaultWriterLock(FIXTURE);
    assert.ok(existsSync(FIXTURE_LOCK), 'the fixture must lock ITSELF (<db>.writer.lock)');
    assert.equal(existsSync(LOCK), false, 'the fixture must NEVER touch another vault’s lock file');
    h.release();
    assert.equal(existsSync(FIXTURE_LOCK), false, 'release removes the fixture’s own lock');
  } finally {
    if (prevDb === undefined) delete process.env.MYCELIUM_DB; else process.env.MYCELIUM_DB = prevDb;
  }
});

await t('ALIAS: one vault reached via a symlinked dir is ONE vault (must not fail OPEN)', async () => {
  // resolve() alone leaves /d/mycelium.db and /d/link/mycelium.db looking like two different
  // vaults: the canonical test no-ops, NO lock is taken, and two writers share one file —
  // fail OPEN, the exact corruption this lock exists to prevent. Identity realpaths the dir.
  // RED on resolve()-only code: it takes no lock at all through the alias.
  clearLock(); clearFam();
  const linkDir = join(dir, 'link');
  try { symlinkSync(dir, linkDir, 'dir'); } catch { /* already there from a prior run */ }
  const ALIAS = join(linkDir, 'mycelium.db'); // same inode as VAULT, different spelling
  const h = acquireVaultWriterLock(ALIAS);    // MYCELIUM_DB still points at VAULT
  assert.ok(existsSync(LOCK), 'an aliased path to the canonical vault must still be locked');
  h.release();
  assert.equal(existsSync(LOCK), false);
});

await t('first acquire on canonical vault writes lockfile + publishes token', async () => {
  clearLock(); clearFam();
  const h = acquireVaultWriterLock(VAULT);
  assert.ok(existsSync(LOCK), 'lockfile created');
  const [pidStr, , token] = readFileSync(LOCK, 'utf8').trim().split(/\s+/);
  assert.equal(Number(pidStr), process.pid, 'records our pid');
  assert.ok(token && token.length >= 16, 'records a family token');
  assert.equal(process.env.MYCELIUM_VAULT_FAMILY, token, 'publishes token to env for children');
  h.release();
  assert.equal(existsSync(LOCK), false, 'release removes the lockfile we own');
});

await t('same-process re-acquire is idempotent (same family via ancestry+token)', async () => {
  clearLock(); clearFam();
  const a = acquireVaultWriterLock(VAULT);
  const b = acquireVaultWriterLock(VAULT); // must NOT throw — we are our own family
  b.release(); // no-op (not owner)
  assert.ok(existsSync(LOCK), 'first holder still owns the lock after a family no-op release');
  a.release();
  assert.equal(existsSync(LOCK), false);
});

// A live sleeper child, recorded with a start time within tolerance of NOW so the
// lock classifies it as a LIVE holder (not a reused/dead pid).
async function liveHolder(token) {
  const { spawn } = await import('node:child_process');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 250));
  writeFileSync(LOCK, `${sleeper.pid} ${Date.now()} ${token}`); // startMs≈now → holderStillLive=true
  return sleeper;
}

await t('FOREIGN live holder (alive, different token, not an ancestor) → REFUSE', async () => {
  clearLock(); clearFam();
  const sleeper = await liveHolder('foreign-token-xyz'); // a child = NOT our ancestor
  let threw = false;
  try { acquireVaultWriterLock(VAULT); } catch (e) { threw = /already open by another process/.test(e.message); }
  sleeper.kill('SIGKILL');
  assert.ok(threw, 'must refuse a live foreign holder');
  assert.equal(readFileSync(LOCK, 'utf8').split(/\s+/)[2], 'foreign-token-xyz', 'must NOT steal the live foreign lock');
});

await t('same-token holder → ALLOW even if not an ancestor (env-token family)', async () => {
  clearLock(); clearFam();
  const sleeper = await liveHolder('shared-family-token');
  process.env.MYCELIUM_VAULT_FAMILY = 'shared-family-token'; // we carry the family token
  let allowed = true, stole = false;
  try { const h = acquireVaultWriterLock(VAULT); h.release(); } catch { allowed = false; }
  stole = readFileSync(LOCK, 'utf8').split(/\s+/)[0] === String(process.pid);
  sleeper.kill('SIGKILL');
  assert.ok(allowed, 'matching family token must be allowed');
  assert.ok(!stole, 'a family member must NOT take ownership of the holder’s lock');
});

await t('HIGH-1 regression: SIBLING app-family (non-ancestor holder) — token allows, no-token refuses', async () => {
  // Models the real topology: server-rest + `index.js --http` are SIBLINGS under the
  // Tauri shell (neither is the other's ancestor). Ancestry can't save the 2nd process,
  // so the shell-injected MYCELIUM_VAULT_FAMILY token is what must let it in.
  clearLock(); clearFam();
  const holder = await liveHolder('launch-token-abc'); // "server-rest" holds it
  // (a) sibling WITHOUT the token (the bug: main.rs never injected it) → REFUSE
  let refusedNoToken = false;
  try { acquireVaultWriterLock(VAULT); } catch (e) { refusedNoToken = /already open by another process/.test(e.message); }
  // (b) sibling WITH the shell-injected token (the fix) → ALLOW, and does NOT steal
  process.env.MYCELIUM_VAULT_FAMILY = 'launch-token-abc';
  let allowedWithToken = true, stole = false;
  try { acquireVaultWriterLock(VAULT).release(); } catch { allowedWithToken = false; }
  stole = readFileSync(LOCK, 'utf8').split(/\s+/)[0] === String(process.pid);
  holder.kill('SIGKILL');
  assert.ok(refusedNoToken, 'a token-less sibling must be refused (this is the bug main.rs fixes)');
  assert.ok(allowedWithToken, 'a sibling carrying the injected family token must be allowed');
  assert.ok(!stole, 'the allowed sibling must not seize the holder’s lock');
});

await t('ZOMBIE holder is DEAD, not alive → reclaim (a <defunct> pid bricked boot live)', async () => {
  // process.kill(pid,0) SUCCEEDS on a zombie — it is still in the process table until its
  // parent reaps it. Live 2026-07-15: server-rest died on an uncaught SQLITE_CORRUPT, lingered
  // as <defunct>, and EVERY later boot hit "vault is already open by another process (pid
  // 75970)" → app permanently bricked, env-only hatch unreachable from a Finder launch.
  clearLock(); clearFam();
  const { spawn, execFileSync } = await import('node:child_process');

  // ⚠️ NODE CANNOT PRODUCE A ZOMBIE. libuv installs a SIGCHLD handler and waitpid()s every
  // child_process child, so `spawn(node, ['-e','process.exit(0)'])` is ALWAYS reaped —
  // state reads "reaped", never "Z". This test used to spawn exactly that, hit its own
  // `return` on the skip, and t() counted the bare return as a PASS: the one assertion
  // written for isZombie() had never executed on any machine, while the gate printed
  // "VERDICT: GO — 11 passed". A permanent false green over the vault's anti-double-writer
  // lock (independent review, 2026-07-15).
  //
  // A real zombie needs a parent that FORKS and never wait()s. perl does; node can't.
  const zpidFile = join(dir, 'zpid');
  const parent = spawn('perl', ['-e',
    `$|=1; my $p=fork(); if($p==0){ exit 0 } open(F,">","${zpidFile}"); print F "$p"; close F; sleep 30;`,
  ], { stdio: 'ignore' });

  let zpid = null, state = '';
  for (let i = 0; i < 40 && !(state.startsWith('Z')); i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { zpid = Number(readFileSync(zpidFile, 'utf8').trim()) || null; } catch { /* not written yet */ }
    if (!zpid) continue;
    try { state = execFileSync('ps', ['-o', 'state=', '-p', String(zpid)], { encoding: 'utf8' }).trim(); } catch { state = ''; }
  }

  try {
    // FAIL, never skip. An unproducible zombie means this gate is not testing the thing it
    // exists to test — silence there is what let the original false green survive.
    assert.ok(zpid && state.startsWith('Z'),
      `could not produce a zombie (pid=${zpid} state=${state || 'gone'}) — this gate MUST NOT pass without exercising isZombie()`);

    // The bug, pinned: a corpse still answers kill(pid,0) as alive.
    let killSaysAlive = false;
    try { process.kill(zpid, 0); killSaysAlive = true; } catch { /* ESRCH */ }
    assert.ok(killSaysAlive, 'precondition: process.kill(zombie,0) must succeed — that IS the bug isZombie() exists to catch');

    writeFileSync(LOCK, `${zpid} ${Date.now()} zombie-token`);
    const h = acquireVaultWriterLock(VAULT);         // must NOT throw — a corpse holds nothing
    assert.equal(readFileSync(LOCK, 'utf8').split(/\s+/)[0], String(process.pid), 'zombie lock must be reclaimed');
    h.release();
  } finally {
    try { parent.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

await t('dead holder → reclaim + acquire', async () => {
  clearLock(); clearFam();
  writeFileSync(LOCK, `999999 12345 dead-token`); // pid that is not alive
  const h = acquireVaultWriterLock(VAULT);
  const [pidStr] = readFileSync(LOCK, 'utf8').trim().split(/\s+/);
  assert.equal(Number(pidStr), process.pid, 'reclaimed: now our pid holds it');
  h.release();
});

await t('release does NOT delete a lock reclaimed by someone else', async () => {
  clearLock(); clearFam();
  const h = acquireVaultWriterLock(VAULT);        // we own it
  writeFileSync(LOCK, `424242 0 someone-new`);     // simulate another owner overwrote it
  h.release();                                     // must be a no-op (pid mismatch)
  assert.ok(existsSync(LOCK), 'must not delete a lock we no longer own');
  assert.equal(readFileSync(LOCK, 'utf8').split(/\s+/)[0], '424242');
});

await t('escape hatch MYCELIUM_SKIP_WRITER_LOCK=1 → no-op', async () => {
  clearLock(); clearFam();
  process.env.MYCELIUM_SKIP_WRITER_LOCK = '1';
  const h = acquireVaultWriterLock(VAULT);
  assert.equal(existsSync(LOCK), false, 'skip hatch creates no lock');
  h.release();
  delete process.env.MYCELIUM_SKIP_WRITER_LOCK;
});

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
