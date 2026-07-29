// scripts/verify-vault-mode.mjs — LAYER B: the kernel refuses writes to an unowned vault.
//
// Every row here uses REAL SQLite opens against REAL files. Layer B's whole claim is about
// what the OPERATING SYSTEM does, so a fixture that asserted on our own return values would
// be testing the wrapper and not the guarantee — the class this branch's reviews found
// seven times.
//
// MUTATION-TESTED: 2026-07-29 — each mutation grep'd back off disk AND `node --check`ed
// before its result was believed. RE-RUN IN FULL after the seal moved to presence locks,
// because the previous record described rows that no longer exist — a record that survives
// the code it describes is worth less than none.
//   lockVaultFiles made a no-op ................. B1, B3, C1, C2 RED
//   the file family narrowed to the main file ... B4, C2 RED
//   the chmod failure swallowed ................. B5 RED
//   the last leaver never seals ................. G1, G2 RED   (the one-shot defect)
//   presence blind to live processes ............ G3 RED
//   an INHERITOR registers no presence .......... G4 RED       (the 13-lost-writes shape)
//   --http's bindBoundedShutdown → void httpServer  G12 RED   — the ONLY sibling the shell
//     spawns (main.rs:803) loses its SIGTERM handler, so the default action kills it without
//     running the exit handler that seals: it dies fast but the vault stays at MODE 600. This
//     is THE regression G7/G8 pretended to cover — they SIGTERMed a synthetic child that
//     called the now-deleted sealVaultOnTermination, which --http never used.
//   the escape hatch unlocks without joining .... G9 RED      (one-shot, via the hatch)
//   the seal removed from --enrich/--public ..... G11a, G11b RED — the "one of four
//     entry points" defect, which the 421-gate suite could not see at all
//   the bounded drain reverted to UNBOUNDED ..... G10, G11a, G11b RED — before G11 held a
//     stalled socket, this mutation left BOTH G11 rows green while --public measurably hung
//     10 s past SIGTERM; the rows could see the seal but not the drain they were named for
//   server-rest back to the UNBOUNDED shutdown .. G10 RED     — the fix was previously
//     invisible to the whole 421-gate suite; it could have been reverted wholesale
//   sealing extended to PLAINTEXT vaults ........ G6 RED, AND verify:pipeline-runs-through
//     goes from 19 executed / 0 failed to 5 stages dead on a read-only database
//   a NON-CANONICAL user registers no presence .. G5 RED, AND verify:realm-prune
//     reproduces its SQLITE_READONLY crash — the row is tied to a real failure, not a flag
//
// ⚠️ THE PREVIOUS TWO ROWS HERE WERE SOURCE GREPS AND HAD NO TEETH AT ALL. An adversarial
// review made Layer B completely inert two different ways — flipping `#[cfg(unix)]` to
// `#[cfg(windows)]`, and re-aiming the sealer one directory up — and BOTH left this gate at
// 10/10. It also reintroduced a seal in a file that was not on the allowlist and stayed
// green. G1-G5 now spawn real processes and read the file mode, because a grep cannot see
// whether the vault ended up read-only.
//
// ⚠️ ONE SURVIVOR, RECORDED. Removing the READ-BACK in setVaultFileMode (`const got = mode`)
// leaves the gate GREEN. B5 proves we report a chmod that THREW, not one that succeeds and
// silently does nothing — the exFAT/SMB case the read-back exists for, which I could not
// produce in a gate. Kept as cheap insurance and said so.
import './lib/gate-stdout.mjs';   // MUST be the first line of code — setBlocking only affects LATER writes
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync, chmodSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
import { setVaultFileMode, lockVaultFiles, unlockVaultFiles, unbrickVaultFiles, LOCKED_MODE, UNLOCKED_MODE } from '../src/db/vault-mode.js';

const KEY = 'b'.repeat(64);
// Every child claimChild() ever spawns, so a row that throws mid-way cannot leave one
// behind. Round 12 found THREE alive on the developer's machine at 2 h 51 m — holding a
// lease AND a presence lock — from rows whose kill() sat after the assertions. Registering
// centrally means a new row cannot forget.
const SPAWNED = new Set();
const reapAll = () => { for (const p of SPAWNED) { try { p.kill('SIGKILL'); } catch { /* */ } } SPAWNED.clear(); };
process.on('exit', reapAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { reapAll(); process.exit(1); });

let pass = 0; let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  [✓] ${name}`); }
  catch (e) { fail++; console.log(`  [✗] ${name}\n      ${String(e.message).split('\n').slice(0, 5).join('\n      ')}`); }
  // UNCONDITIONAL, and after EVERY row rather than at each kill site. Five rows spawned
  // `hold: true` children that never self-exit and were killed only AFTER their assertions,
  // so any failure left them running forever. A per-row sweep cannot be forgotten by the
  // next row the way a per-site kill can.
  finally { reapAll(); }
};

/** A real keyed WAL vault with real content. `hot` leaves an uncheckpointed -wal. */
function vault(prefix, { hot = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `vm-${prefix}-`));
  const db = join(dir, 'mycelium.db');
  const h = new Database(db);
  h.pragma(`cipher='sqlcipher'`);
  h.pragma(`key="x'${KEY}'"`);
  h.pragma('journal_mode = WAL');
  h.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = h.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < 300; i++) ins.run(`row-${i}`);
  if (hot) { h.pragma('wal_autocheckpoint = 0'); for (let i = 0; i < 800; i++) ins.run(`hot-${i}`); }
  else h.close();
  return { dir, db };
}
const open = (p, opts = {}) => {
  const h = new Database(p, opts);
  h.pragma(`cipher='sqlcipher'`);
  h.pragma(`key="x'${KEY}'"`);
  return h;
};
const modeOf = (p) => (statSync(p).mode & 0o777);

console.log('\n── vault file mode (Layer B) ─────────────────────────────────');

// ── B1. THE GUARANTEE. ───────────────────────────────────────────────────────────
await t('B1. a LOCKED vault refuses a write — from the kernel, not from us', () => {
  const { dir, db } = vault('b1');
  const r = lockVaultFiles(db);
  assert.ok(r.verified, `precondition: the lock must actually apply (${r.reason})`);
  assert.equal(modeOf(db), LOCKED_MODE, 'precondition: the file must really be 0400');
  let refused = null;
  try { const h = open(db); h.prepare('INSERT INTO t (v) VALUES (?)').run('foreign'); h.close(); }
  catch (e) { refused = e.code; }
  assert.equal(refused, 'SQLITE_READONLY',
    `a locked vault must refuse a write with SQLITE_READONLY (got ${refused ?? 'the write SUCCEEDED'})`);
  rmSync(dir, { recursive: true, force: true });
});

// ── B2. …WITHOUT BLINDING THE THINGS THAT PROTECT IT. ───────────────────────────
// The D-117 first-encounter gate reads the vault on every boot. If locking broke that, the
// two layers would be in conflict and the integrity check would go dark exactly when the
// vault is unowned — which is when it matters most.
await t('B2. a LOCKED vault still permits the reads the integrity gate depends on', () => {
  const { dir, db } = vault('b2');
  lockVaultFiles(db);
  const h = open(db, { readonly: true, fileMustExist: true });
  try {
    assert.ok(Number(h.pragma('page_count', { simple: true })) > 0, 'page_count must work at 0400');
    assert.equal(h.pragma('quick_check').map((r) => r.quick_check ?? r).join('|'), 'ok', 'quick_check must work at 0400');
    assert.equal(h.prepare('SELECT count(*) c FROM t').get().c, 300, 'SELECT must work at 0400');
  } finally { h.close(); }
  rmSync(dir, { recursive: true, force: true });
});

// ── B3. THE BRICK, WATCHED FAILING. ─────────────────────────────────────────────
// SQLite propagates the main file's mode to a NEW -wal/-shm, so a vault locked to 0400
// leaves its sidecars at 0400 too. Restoring ONLY the main file — the natural thing for a
// human or a repair script — leaves every write failing forever with nothing on screen to
// explain it. This row exists so that stays FIXED, not remembered.
await t('B3. restoring ONLY the main file does NOT un-brick it (this is why unbrick covers the family)', () => {
  const { dir, db } = vault('b3');
  lockVaultFiles(db);
  // Force the sidecars into existence at the locked mode, the way a refused writer would.
  try { const h = open(db); try { h.prepare('INSERT INTO t (v) VALUES (?)').run('x'); } catch { /* refused */ } h.close(); } catch { /* */ }
  chmodSync(db, UNLOCKED_MODE);                       // the NAIVE fix: main file only
  const sidecars = [`${db}-wal`, `${db}-shm`].filter(existsSync);
  assert.ok(sidecars.length > 0, 'precondition: the refused write must have created sidecars, or this row proves nothing');
  assert.ok(sidecars.every((f) => modeOf(f) === LOCKED_MODE), 'precondition: the sidecars must still be locked');
  let stillRefused = null;
  try { const h = open(db); h.prepare('INSERT INTO t (v) VALUES (?)').run('after-naive-fix'); h.close(); }
  catch (e) { stillRefused = e.code; }
  assert.equal(stillRefused, 'SQLITE_READONLY',
    'the naive un-brick must still fail — if this ever passes, the hazard is gone and B4 is the only thing left proving unbrick covers the family');
  rmSync(dir, { recursive: true, force: true });
});

// ── B4. …AND THE SUPPORTED UN-BRICK WORKS. ──────────────────────────────────────
await t('B4. unbrickVaultFiles restores the WHOLE family and writes work again', () => {
  const { dir, db } = vault('b4');
  lockVaultFiles(db);
  try { const h = open(db); try { h.prepare('INSERT INTO t (v) VALUES (?)').run('x'); } catch { /* */ } h.close(); } catch { /* */ }
  const r = unbrickVaultFiles(db);
  assert.ok(r.verified, `the un-brick must verify (${r.reason})`);
  const h = open(db);
  try { h.prepare('INSERT INTO t (v) VALUES (?)').run('restored'); }
  finally { h.close(); }
  rmSync(dir, { recursive: true, force: true });
});

// ── B5. A FLIP THAT DID NOT TAKE MUST BE REPORTED, NOT SWALLOWED. ───────────────
// Eight existing chmod sites in this repo are best-effort by design. Here a silent no-op
// would leave the vault writable while the app believes it is sealed — a false guarantee,
// which is the "green for the wrong reason" class in the one place it costs a vault.
await t('B5. a mode that CANNOT be applied is reported as unverified (no silent false guarantee)', () => {
  const { dir, db } = vault('b5');
  if (process.platform !== 'darwin') {
    // `chflags uchg` is the only portable-enough way I found to make chmod FAIL on a file
    // we own. Stated rather than silently skipped: on Linux this row asserts nothing, and
    // the failure-reporting path is covered there only by the non-darwin half below.
    const r0 = setVaultFileMode(db, LOCKED_MODE);
    assert.equal(r0.verified, true, 'a normal chmod must verify (the failure half is darwin-only)');
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  execFileSync('chflags', ['uchg', db]);            // immutable: chmod now throws EPERM
  try {
    const r = setVaultFileMode(db, LOCKED_MODE);
    assert.equal(r.verified, false,
      'a chmod that could not be applied must report verified:false — a silent no-op leaves the vault writable while the app believes it is sealed');
    assert.ok(r.failed.some((f) => f.includes('mycelium.db')),
      `and it must name the file that failed (got: ${JSON.stringify(r.failed)})`);
    assert.notEqual(modeOf(db), LOCKED_MODE, 'precondition: the mode must really not have applied');
  } finally {
    execFileSync('chflags', ['nouchg', db]);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── C1. THE ORDERING THAT KEEPS BOOT ALIVE. ─────────────────────────────────────
// snapshot-on-boot opens the source WRITE-CAPABLE on purpose, and in the migrating case its
// failure is fail-closed. A vault still locked at that moment stops boot dead. Measured
// during the design spike; asserted here so the ordering cannot silently regress.
await t('C1. a locked vault is unlocked before a write-capable open would be attempted', () => {
  const { dir, db } = vault('c1');
  lockVaultFiles(db);
  assert.equal(modeOf(db), LOCKED_MODE, 'precondition: locked');
  const r = unlockVaultFiles(db);
  assert.ok(r.verified, `unlock must verify (${r.reason})`);
  assert.equal(modeOf(db), UNLOCKED_MODE, 'and the file must really be writable again');
  const h = open(db);                       // the write-capable open boot would do
  try { h.prepare('INSERT INTO t (v) VALUES (?)').run('boot'); } finally { h.close(); }
  rmSync(dir, { recursive: true, force: true });
});

// ── C2. THE SEARCH SIDECAR IS COVERED. ──────────────────────────────────────────
// mycelium.search.db is in vaultFileFamily and holds a semantic index — CLAUDE.md §7 treats
// embeddings with the same paranoia as plaintext. Locking the vault and leaving the index
// writable would protect the smaller half.
await t('C2. the search sidecar is locked with the vault (embeddings are sensitive, §7)', () => {
  const { dir, db } = vault('c2');
  const sidecar = db.replace(/\.db$/, '.search.db');
  const s = new Database(sidecar); s.exec('CREATE TABLE idx (id INTEGER PRIMARY KEY)'); s.close();
  const r = lockVaultFiles(db);
  assert.ok(r.changed.some((f) => f.endsWith('.search.db')),
    `the sidecar must be in the locked set (locked: ${r.changed.map((f) => f.split('/').pop()).join(', ')})`);
  assert.equal(modeOf(sidecar), LOCKED_MODE, 'and it must really be read-only on disk');
  rmSync(dir, { recursive: true, force: true });
});

// ── C3. A HOT -wal SURVIVES THE ROUND TRIP. ─────────────────────────────────────
// The crash shape: uncheckpointed frames beside the vault. Locking must not lose them, and
// unlocking must give them back — those pages are the only recoverable content a damaged
// vault has, which is the whole reason the 0-byte probe stopped opening files.
await t('C3. lock → unlock across a HOT uncheckpointed -wal loses no committed rows', () => {
  const { dir, db } = vault('c3', { hot: true });
  const before = (() => { const h = open(db, { readonly: true }); try { return h.prepare('SELECT count(*) c FROM t').get().c; } finally { h.close(); } })();
  assert.equal(before, 1100, 'precondition: the hot -wal must hold the extra rows');
  lockVaultFiles(db);
  unlockVaultFiles(db);
  const after = (() => { const h = open(db, { readonly: true }); try { return h.prepare('SELECT count(*) c FROM t').get().c; } finally { h.close(); } })();
  assert.equal(after, before, `the round trip must not lose rows (${before} → ${after})`);
  rmSync(dir, { recursive: true, force: true });
});

// ══ THE GUARANTEE, END TO END, WITH REAL PROCESSES ════════════════════════════════
// The previous G1/G2 were SOURCE GREPS, and an adversarial review defeated both without
// touching a single assertion: flipping `#[cfg(unix)]` to `#[cfg(windows)]` (Layer B inert
// on macOS) and re-aiming the sealer one directory up BOTH left the gate at 10/10. It also
// reintroduced a seal in a file that was not on G1's four-file allowlist and stayed green.
//
// A grep cannot see whether the vault ends up read-only. These spawn real processes against
// a real canonical vault and then LOOK AT THE MODE.
function claimChild(dir, { hold = false, env = {} } = {}) {
  const body = `import * as L from ${JSON.stringify(join(REPO, 'src/db/vault-lease.js'))};
const r = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' });
console.log('ROLE:' + r.role);
${hold ? `import { existsSync } from 'node:fs';
const bye = process.env.MYCELIUM_DATA_DIR + '/bye-' + process.pid;
setInterval(() => { if (existsSync(bye)) process.exit(0); }, 40);` : 'process.exit(0);'}`;
  const f = join(dir, `claim-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(f, body);
  const c = spawn(process.execPath, [f], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, MYCELIUM_DATA_DIR: dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  SPAWNED.add(c);
  c.on('exit', () => SPAWNED.delete(c));
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  return { c, out: () => out, err: () => err };
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠️ NEVER LEAK A SPAWNED CHILD. An assertion between spawn and kill throws straight past
// the cleanup: `t()` catches it, the suite prints NO-GO and exits, and the child does NOT.
// Proven by an adversarial review — one failing readiness check left `node src/index.js
// --enrich` and `--public` alive indefinitely, each holding a lease and a presence lock on
// its temp vault, with no idle timeout. That is the 2 h 54 m orphan this whole branch
// exists to stop, manufactured by the gate that guards against it, on every red run.
const reap = (...procs) => {
  for (const p of procs) {
    try { p?.kill?.('SIGKILL'); } catch { /* already gone */ }
    try { p?.c?.kill?.('SIGKILL'); } catch { /* the claimChild wrapper */ }
  }
};
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await settle(50); }
  return false;
};

await t('G1. the LAST process to leave seals the vault (this is the whole guarantee)', async () => {
  const { dir, db } = vault('g1');
  const kid = claimChild(dir);
  assert.ok(await waitFor(() => /ROLE:/.test(kid.out())), `precondition: the child must claim (${kid.err().slice(-200)})`);
  await waitFor(() => kid.c.exitCode !== null);
  await settle(300);
  assert.equal(modeOf(db), LOCKED_MODE,
    `a process that used the vault and left with nobody else here must SEAL it (mode ${modeOf(db).toString(8)}) — otherwise one run disarms Layer B for good`);
  // …and the seal is real, not just a number.
  let refused = null;
  try { const h = open(db); h.prepare('INSERT INTO t (v) VALUES (?)').run('foreign'); h.close(); }
  catch (e) { refused = e.code; }
  assert.equal(refused, 'SQLITE_READONLY', `and the kernel must actually refuse the write (got ${refused ?? 'SUCCESS'})`);
  rmSync(dir, { recursive: true, force: true });
});

await t('G2. a SEALED vault is unlocked by the next user and RE-SEALED when it leaves (not one-shot)', async () => {
  const { dir, db } = vault('g2');
  lockVaultFiles(db);
  assert.equal(modeOf(db), LOCKED_MODE, 'precondition: start sealed');
  const kid = claimChild(dir);
  assert.ok(await waitFor(() => /ROLE:/.test(kid.out())), `precondition: the child must claim through a sealed vault (${kid.err().slice(-200)})`);
  await waitFor(() => kid.c.exitCode !== null);
  await settle(300);
  assert.equal(modeOf(db), LOCKED_MODE,
    'a non-app run must UNLOCK and then RE-SEAL — leaving it writable is how Layer B became one-shot: one recovery-tooling run disarmed it indefinitely');
  rmSync(dir, { recursive: true, force: true });
});

// ── G4. THE SIBLING CASE — the OWNER leaves, an INHERITOR stays. ────────────────
// G3's stayer is the OWNER, so it never exercised an INHERITOR's presence: removing the
// inheritor's join left G3 green (a survivor, caught by mutation). This is also the exact
// shape that lost 13 of 60 writes before presence existed — the owning sibling quitting
// first while the other kept serving.
await t('G4. the OWNER leaving does not seal while an INHERITOR is still serving', async () => {
  const { dir, db } = vault('g4');
  const owner = claimChild(dir, { hold: true, env: { MYCELIUM_VAULT_FAMILY: 'fam-g4' } });
  assert.ok(await waitFor(() => /ROLE:owner/.test(owner.out())), `precondition: the first must be OWNER (${owner.out()}${owner.err().slice(-200)})`);
  const inheritor = claimChild(dir, { hold: true, env: { MYCELIUM_VAULT_FAMILY: 'fam-g4' } });
  assert.ok(await waitFor(() => /ROLE:inheritor/.test(inheritor.out())),
    `precondition: the second must be INHERITOR, or this row tests G3 again (${inheritor.out()}${inheritor.err().slice(-200)})`);

  writeFileSync(join(dir, `bye-${owner.c.pid}`), '1');     // the owner quits gracefully
  assert.ok(await waitFor(() => owner.c.exitCode !== null), 'precondition: the owner must actually exit');
  await settle(400);

  assert.notEqual(modeOf(db), LOCKED_MODE,
    'the owner leaving must NOT seal while an inheritor is still serving — this is the 13-lost-writes defect, and it is why an inheritor must hold a presence lock too');
  const h = open(db);
  try { h.prepare('INSERT INTO t (v) VALUES (?)').run('inheritor-still-writing'); } finally { h.close(); }
  inheritor.c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// ── (G7, G8 REMOVED 2026-07-29) ──────────────────────────────────────────────────
// G7 ("SIGTERM still seals") and G8 ("a never-ending handle still seals within the 6 s
// grace") both SIGTERMed a SYNTHETIC child that called `sealVaultOnTermination` — a helper
// with zero product callers, now deleted. Their real guarantees are proven directly on the
// shipped entry points, each SIGTERMed for real with a stalled socket held: G10 (server-rest),
// G11a/b (--enrich/--public) and G12 (--http). Deleting a function whose only caller was the
// gate, and re-aiming its rows at real code, is the same call this repo made on assertVaultOwnership.

// ── G9. THE ESCAPE HATCH MUST RE-SEAL. ──────────────────────────────────────────
// MYCELIUM_SKIP_VAULT_LEASE=1 unlocked and returned WITHOUT joining, so nothing ever
// re-sealed — the one-shot defect straight back in through the hatch four in-product error
// messages recommend. Whoever unlocks must be able to re-seal.
await t('G9. a MYCELIUM_SKIP_VAULT_LEASE=1 run re-seals on the way out (the hatch is not one-shot)', async () => {
  const { dir, db } = vault('g9');
  lockVaultFiles(db);
  assert.equal(modeOf(db), LOCKED_MODE, 'precondition: start sealed');
  const kid = claimChild(dir, { env: { MYCELIUM_SKIP_VAULT_LEASE: '1' } });
  assert.ok(await waitFor(() => /ROLE:skipped/.test(kid.out())), `precondition: the hatch must engage (${kid.out()}${kid.err().slice(-200)})`);
  await waitFor(() => kid.c.exitCode !== null);
  await settle(300);
  assert.equal(modeOf(db), LOCKED_MODE,
    'recovery tooling must leave the vault as it found it — unlocking without re-sealing disarms Layer B indefinitely');
  rmSync(dir, { recursive: true, force: true });
});

// ── G6. A PLAINTEXT VAULT IS NEVER SEALED. ──────────────────────────────────────
// Same scoping wal-guard.js already made, for the same reason ("a PLAINTEXT vault
// (dev-only) is unguarded"). It is not a preference: on an ENCRYPTED vault the Python
// pipeline never opens the file — run-clustering.sh routes every stage through the Node
// bridge — but on a PLAINTEXT vault it opens the file DIRECTLY, and Python holds no
// presence lock, so it is invisible to the last-one-out rule. Sealing there stranded it:
// the full suite caught five stages dying with
// `sqlite3.OperationalError: attempt to write a readonly database`, thirteen more skipped
// behind them, and the gate reporting NO-GO at 184/420.
await t('G6. a PLAINTEXT vault is never sealed (Python writes it directly and holds no presence)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vm-g6-'));
  const db = join(dir, 'mycelium.db');
  const h = new Database(db);            // NO cipher pragma: a genuinely plaintext vault
  h.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  h.prepare('INSERT INTO t (v) VALUES (?)').run('plain');
  h.close();
  const r = lockVaultFiles(db);
  assert.equal(r.verified, false, 'a plaintext vault must report that Layer B is inert, not claim a seal');
  assert.notEqual(modeOf(db), LOCKED_MODE, 'and it must be left writable');
  const w = new Database(db);            // …and a direct writer, as Python is, still works
  try { w.prepare('INSERT INTO t (v) VALUES (?)').run('python-would-write-here'); } finally { w.close(); }
  rmSync(dir, { recursive: true, force: true });
});

// ── G5. THE ENVIRONMENT-RELATIVE ASYMMETRY. ─────────────────────────────────────
// isCanonicalVault() reads MYCELIUM_DB, so two processes can disagree about whether the
// SAME FILE is "the vault". verify:realm-prune's parent passes dbPath explicitly (not
// canonical for it, so no presence) while the child it spawns gets MYCELIUM_DB (canonical),
// and the child sealed the file on exit — the parent then died with SQLITE_READONLY. That
// crash reported as "62 gates, zero FAIL rows", the signature that has misled me twice.
//
// Presence is therefore registered for ANY vault; only a CANONICAL one is ever sealed.
await t('G5. a process using a vault it does not consider canonical still blocks the seal', async () => {
  const { dir, db } = vault('g5');
  // The "parent": uses the file by explicit path, with MYCELIUM_DB pointing SOMEWHERE ELSE,
  // so this vault is not canonical for it — exactly verify:realm-prune's shape.
  const elsewhere = mkdtempSync(join(tmpdir(), 'vm-g5-other-'));
  const parent = claimChild(dir, { hold: true, env: { MYCELIUM_DB: join(elsewhere, 'mycelium.db') } });
  assert.ok(await waitFor(() => /ROLE:/.test(parent.out())), `precondition: the parent must join (${parent.err().slice(-200)})`);
  assert.match(parent.out(), /ROLE:skipped/, `precondition: the vault must be NON-canonical for the parent (got ${parent.out().trim()})`);

  const child = claimChild(dir);                       // canonical for it: claims, then leaves
  assert.ok(await waitFor(() => /ROLE:owner/.test(child.out())), `precondition: the child must own it (${child.err().slice(-200)})`);
  await waitFor(() => child.c.exitCode !== null);
  await settle(400);

  assert.notEqual(modeOf(db), LOCKED_MODE,
    'the child must not seal a vault the parent is still using just because the parent does not call it canonical');
  const h = open(db);
  try { h.prepare('INSERT INTO t (v) VALUES (?)').run('parent-still-writing'); } finally { h.close(); }
  parent.c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

await t('G3. a process that leaves does NOT seal while another is still using the vault', async () => {
  const { dir, db } = vault('g3');
  const stayer = claimChild(dir, { hold: true, env: { MYCELIUM_VAULT_FAMILY: 'fam-g3' } });
  assert.ok(await waitFor(() => /ROLE:/.test(stayer.out())), `precondition: the first process must claim (${stayer.err().slice(-200)})`);
  const leaver = claimChild(dir, { env: { MYCELIUM_VAULT_FAMILY: 'fam-g3' } });
  assert.ok(await waitFor(() => /ROLE:/.test(leaver.out())), `precondition: the second must join (${leaver.err().slice(-200)})`);
  await waitFor(() => leaver.c.exitCode !== null);
  await settle(400);
  assert.notEqual(modeOf(db), LOCKED_MODE,
    'sealing here strands the process still using the vault — this is the defect that killed verify:realm-prune and lost 13 of 60 sibling writes');
  const h = open(db);
  try { h.prepare('INSERT INTO t (v) VALUES (?)').run('still-serving'); } finally { h.close(); }
  stayer.c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// ── G10. THE REAL SERVER, THE REAL SIGNAL. ──────────────────────────────────────
// ⚠️ EVERY OTHER ROW HERE SIGTERMs A SYNTHETIC CHILD that imports vault-lease directly, so
// the bounded shutdown in src/server-rest.js was UNOBSERVABLE: an adversarial review
// confirmed it could be reverted wholesale and the 421-row suite would stay green. The only
// gate that spawns the real server kills it with SIGKILL and asserts nothing about the mode.
//
// This spawns `node src/server-rest.js` — the actual shipped entry point — holds a real
// half-sent request open (the thing that made server.close() never return), SIGTERMs it,
// and reads the file mode. It also caught a missing import that `node --check` cannot see.
await t('G10. the REAL server-rest seals on SIGTERM, with a stalled connection held open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vm-g10-'));
  const { deriveSystemKey, deriveDbKey } = await import('../src/account/keystore.js');
  const userHex = 'c'.repeat(64);
  // Born-encrypted, so Layer B applies (it is deliberately inert on plaintext vaults).
  const dbPath = join(dir, 'mycelium.db');
  const seed = new Database(dbPath);
  seed.pragma(`cipher='sqlcipher'`);
  seed.pragma(`key="x'${deriveDbKey(userHex)}'"`);
  seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  seed.close();

  const port = 18000 + Math.floor(Math.random() * 900);
  let proc; let sock;
  try {
  proc = spawn(process.execPath, ['src/server-rest.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      MYCELIUM_DATA_DIR: dir, MYCELIUM_DB: dbPath, MYCELIUM_KCV: join(dir, 'kcv.json'),
      MYCELIUM_REST_PORT: String(port), MYCELIUM_PORTAL_MODE: 'none',
      MYCELIUM_KEY_SOURCE: 'env', USER_MASTER_KEY: userHex, SYSTEM_KEY: deriveSystemKey(userHex),
      MYCELIUM_AT_REST: '1', MYCELIUM_DISABLE_EMBED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Central net, the instant it exists (matches claimChild:268). An EXTERNAL SIGINT/SIGTERM
  // to THE GATE during this row's live window runs reapAll()+process.exit(1) (line 70), which
  // SKIPS the pending `finally { reap(proc) }` — orphaning a real server that holds a vault
  // lease AND a presence lock. That is the 2 h 51 m orphan this suite exists to stop; the
  // row-local finally alone does not cover the gate being signalled.
  SPAWNED.add(proc); proc.on('exit', () => SPAWNED.delete(proc));
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const up = await waitFor(() => /portal \+ REST on http/i.test(out) || proc.exitCode !== null, 30000);
  assert.ok(up && proc.exitCode === null, `precondition: the real server must come up (${out.slice(-400)})`);
  assert.notEqual(modeOf(dbPath), LOCKED_MODE, 'precondition: writable while it serves');

  // A HALF-SENT request: headers never completed. This is what makes server.close() hang.
  sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => { sock.on('connect', r); sock.on('error', r); });
  try { sock.write('GET / HTTP/1.1\r\nHost: x\r\n'); } catch { /* */ }

  const t0 = Date.now();
  proc.kill('SIGTERM');
  const gone = await waitFor(() => proc.exitCode !== null || proc.signalCode !== null, 6000);
  const took = Date.now() - t0;
  try { sock.destroy(); } catch { /* */ }
  assert.ok(gone,
    `the real server must exit within the shell 6 s grace despite a stalled connection (took ${took} ms) — past that main.rs SIGKILLs it and nothing seals`);
  await settle(400);
  assert.equal(modeOf(dbPath), LOCKED_MODE,
    `and it must have SEALED the vault (mode ${modeOf(dbPath).toString(8)}, exit after ${took} ms)`);
  rmSync(dir, { recursive: true, force: true });
  } finally { reap(proc); try { sock?.destroy(); } catch { /* */ } }
});

// ── G11. EVERY ENTRY POINT THAT BOOTS THE VAULT SEALS IT. ───────────────────────
// I wired the seal into ONE of four entry points and the suite could not tell: --enrich and
// --public boot the vault, claim ownership, and had NO signal handler at all, so SIGTERM
// left the vault unlocked with a stale presence file. G10 covers server-rest; this covers
// the two modes that were missed, by spawning the REAL `node src/index.js <mode>`.
for (const mode of ['--enrich', '--public']) {
  await t(`G11${mode === '--enrich' ? 'a' : 'b'}. \`node src/index.js ${mode}\` seals the vault on SIGTERM`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `vm-g11-${mode.slice(2)}-`));
    const { deriveSystemKey, deriveDbKey } = await import('../src/account/keystore.js');
    const userHex = 'c'.repeat(64);
    const dbPath = join(dir, 'mycelium.db');
    // A REAL, MIGRATED, born-encrypted vault — not a hand-seeded table. The first version
    // of this row created one table and `--public` refused to serve ("publish_nonce
    // missing"), so the row failed on its own fixture rather than on the product. Use the
    // product's own initialiser: whatever the entry point needs, it gets.
    const prevDir = process.env.MYCELIUM_DATA_DIR; const prevDb = process.env.MYCELIUM_DB;
    process.env.MYCELIUM_DATA_DIR = dir; process.env.MYCELIUM_DB = dbPath;
    process.env.MYCELIUM_AT_REST = '1';
    try {
      const { initVaultStorage } = await import('../src/db/init.js');
      await initVaultStorage({ dbPath, userHex, log: () => {} });
    } finally {
      if (prevDir === undefined) delete process.env.MYCELIUM_DATA_DIR; else process.env.MYCELIUM_DATA_DIR = prevDir;
      if (prevDb === undefined) delete process.env.MYCELIUM_DB; else process.env.MYCELIUM_DB = prevDb;
    }
    const port = 18100 + Math.floor(Math.random() * 700);
    let proc;
    try {
    proc = spawn(process.execPath, ['src/index.js', mode], {
      cwd: REPO,
      env: {
        ...process.env,
        MYCELIUM_DATA_DIR: dir, MYCELIUM_DB: dbPath, MYCELIUM_KCV: join(dir, 'kcv.json'),
        MYCELIUM_KEY_SOURCE: 'env', USER_MASTER_KEY: userHex, SYSTEM_KEY: deriveSystemKey(userHex),
        MYCELIUM_AT_REST: '1', MYCELIUM_DISABLE_EMBED: '1',
        MYCELIUM_ENRICH_PORT: String(port), MYCELIUM_PUBLIC_PORT: String(port + 1),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Central net, the instant it exists (matches claimChild:268 / G10 / G12) — see there.
    SPAWNED.add(proc); proc.on('exit', () => SPAWNED.delete(proc));
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    const up = await waitFor(() => /service on|surface on/i.test(out) || proc.exitCode !== null, 40000);
    assert.ok(up && proc.exitCode === null, `precondition: ${mode} must come up (${out.slice(-400)})`);
    // POSITIVE PRECONDITION: it must have UNLOCKED, or "sealed" below could just be the
    // mode it was already in — the vacuous pass this gate has produced before.
    assert.notEqual(modeOf(dbPath), LOCKED_MODE, `precondition: ${mode} must unlock while it runs`);
    // A HALF-SENT REQUEST — headers never completed. Without this the row can only see the
    // SEAL, which the old immediate-exit code also did: reverting the bounded drain left
    // G11 GREEN while --public measurably hung 10 s past SIGTERM and would be SIGKILLed by
    // the shell at 6 s, never sealing. A row that cannot see the behaviour it is named for
    // is the "green for the wrong reason" shape, in the row added to close it.
    const sock = net.connect(mode === '--enrich' ? port : port + 1, '127.0.0.1');
    await new Promise((r) => { sock.on('connect', r); sock.on('error', r); });
    try { sock.write('GET / HTTP/1.1\r\nHost: x\r\n'); } catch { /* */ }

    const t0 = Date.now();
    proc.kill('SIGTERM');
    const gone = await waitFor(() => proc.exitCode !== null || proc.signalCode !== null, 6000);
    const took = Date.now() - t0;
    try { sock.destroy(); } catch { /* */ }
    assert.ok(gone,
      `${mode} must exit inside the shell 6 s grace WITH A STALLED CONNECTION HELD (took ${took} ms) — past that main.rs SIGKILLs it and nothing seals`);
    await settle(500);
    assert.equal(modeOf(dbPath), LOCKED_MODE,
      `${mode} must seal on SIGTERM (mode ${modeOf(dbPath).toString(8)}) — it boots the vault and claims ownership like any other entry point`);
    rmSync(dir, { recursive: true, force: true });
  } finally { reap(proc); }
  });
}

// ── G12. THE ONLY SIBLING THE TAURI SHELL ACTUALLY SPAWNS. ──────────────────────
// ⚠️ main.rs:803 spawns `node src/index.js --http` and NOTHING ELSE among the node siblings
// on a normal launch — the :4711 remote MCP/OAuth surface, the MOST in-flight work of any
// entry point. Yet until this row NO gate spawned it: an adversarial review deleted its
// `bindBoundedShutdown` (→ `void httpServer;`) and measured verify:vault-mode 20/20 GO and
// verify:vault-ownership 19/19 GO while a real SIGTERM left the vault at MODE 600 — Layer B
// disarmed on every app quit, invisible to all 421 gates. G10 proves server-rest and G11
// the two http siblings the shell does NOT spawn; this proves the one it does.
//
// --http joins+unlocks the vault at STARTUP — createHttpApp's shared ingestion handle,
// `boot()` at server-http.js:516, NOT per MCP session — so a bare launch is enough to see
// both the unlock and the seal; no OAuth handshake required. Removing bindBoundedShutdown
// leaves the process with NO SIGTERM handler, so the default action terminates it WITHOUT
// running the `exit` handler that carries leaveVault(): it dies fast but never seals, and
// the mode assertion below is what catches that. (ensureOperatorUser is skipped — no
// MYCELIUM_USER_PASSWORD — so the OAuth stack boots headless.)
await t('G12. `node src/index.js --http` — the sibling the shell spawns — seals on SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vm-g12-'));
  const { deriveSystemKey, deriveDbKey } = await import('../src/account/keystore.js');
  const userHex = 'c'.repeat(64);
  const dbPath = join(dir, 'mycelium.db');
  // A REAL, MIGRATED, born-encrypted vault via the product's own initialiser. The OAuth boot
  // path opens the full ingestion vault (boot → initVaultStorage → getDb), and a hand-seeded
  // one-table file is the "fixture did not exercise the product" trap this branch hit eleven
  // times (G11b failed on exactly that). initVaultStorage applies the schema but does NOT
  // call getDb, so it registers NO presence — the gate process cannot block the child's seal.
  const prevDir = process.env.MYCELIUM_DATA_DIR; const prevDb = process.env.MYCELIUM_DB;
  process.env.MYCELIUM_DATA_DIR = dir; process.env.MYCELIUM_DB = dbPath;
  process.env.MYCELIUM_AT_REST = '1';
  try {
    const { initVaultStorage } = await import('../src/db/init.js');
    await initVaultStorage({ dbPath, userHex, log: () => {} });
  } finally {
    if (prevDir === undefined) delete process.env.MYCELIUM_DATA_DIR; else process.env.MYCELIUM_DATA_DIR = prevDir;
    if (prevDb === undefined) delete process.env.MYCELIUM_DB; else process.env.MYCELIUM_DB = prevDb;
  }
  const port = 19000 + Math.floor(Math.random() * 700);
  let proc; let sock;
  try {
  proc = spawn(process.execPath, ['src/index.js', '--http'], {
    cwd: REPO,
    env: {
      ...process.env,
      MYCELIUM_DATA_DIR: dir, MYCELIUM_DB: dbPath, MYCELIUM_KCV: join(dir, 'kcv.json'),
      MYCELIUM_PORT: String(port), MYCELIUM_HTTP_HOST: '127.0.0.1',
      MYCELIUM_KEY_SOURCE: 'env', USER_MASTER_KEY: userHex, SYSTEM_KEY: deriveSystemKey(userHex),
      MYCELIUM_AT_REST: '1', MYCELIUM_DISABLE_EMBED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Central net, the instant it exists (matches claimChild:268). An EXTERNAL SIGINT/SIGTERM
  // to THE GATE during this row's live window runs reapAll()+process.exit(1) (line 70), which
  // SKIPS the pending `finally { reap(proc) }` — orphaning a real server that holds a vault
  // lease AND a presence lock. That is the 2 h 51 m orphan this suite exists to stop; the
  // row-local finally alone does not cover the gate being signalled.
  SPAWNED.add(proc); proc.on('exit', () => SPAWNED.delete(proc));
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const up = await waitFor(() => /HTTP\+OAuth listening on/i.test(out) || proc.exitCode !== null, 45000);
  assert.ok(up && proc.exitCode === null, `precondition: --http must come up (${out.slice(-500)})`);
  // The vault must NOT already be sealed before we SIGTERM, or the equal(0400) below could
  // be a pre-existing state rather than a transition --http caused. Honest scope: the fixture
  // is born ~0600 (initVaultStorage does not chmod), so this guards the STARTING state, it
  // does not by itself prove --http unlocked. --http's unlock is exercised by getDb on boot
  // (createHttpApp's shared boot() at server-http.js:516); the SEAL assertion below is what
  // catches the `void httpServer` mutation. Same shape as G10/G11.
  assert.notEqual(modeOf(dbPath), LOCKED_MODE, 'precondition: the vault must not be sealed before SIGTERM');

  // A HALF-SENT request — headers never completed — the exact thing that makes
  // server.close() never return. With bindBoundedShutdown present it must still drain and
  // exit inside the shell's 6 s grace; with it removed the process dies immediately on the
  // default SIGTERM action but skips leaveVault(), so the SEAL — not the exit — is the tell.
  sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => { sock.on('connect', r); sock.on('error', r); });
  try { sock.write('GET / HTTP/1.1\r\nHost: x\r\n'); } catch { /* */ }

  const t0 = Date.now();
  proc.kill('SIGTERM');
  const gone = await waitFor(() => proc.exitCode !== null || proc.signalCode !== null, 6000);
  const took = Date.now() - t0;
  try { sock.destroy(); } catch { /* */ }
  assert.ok(gone,
    `--http must exit inside the shell 6 s grace with a stalled connection held (took ${took} ms) — past that main.rs SIGKILLs it and nothing seals`);
  await settle(500);
  assert.equal(modeOf(dbPath), LOCKED_MODE,
    `--http must seal on SIGTERM (mode ${modeOf(dbPath).toString(8)}, exit after ${took} ms) — it is the ONLY sibling the Tauri shell spawns (main.rs:803)`);
  rmSync(dir, { recursive: true, force: true });
  } finally { reap(proc); try { sock?.destroy(); } catch { /* */ } }
});

console.log(`\nVERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
