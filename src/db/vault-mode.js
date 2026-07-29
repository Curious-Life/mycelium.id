// src/db/vault-mode.js — LAYER B: when nothing owns the vault, the KERNEL refuses writes.
//
// Layer A (src/db/vault-lease.js) is a check inside our own code, so it can only stop code
// that runs it: an orphaned pipeline child, a second app instance. It is structurally blind
// to a stray script, `sqlite3` on the command line, a sync client, or an older build. This
// is the half that answers the operator's actual ask —
//   "if the app is closed, we should not let other processes write to the db"
// — because the refusal comes from the operating system, not from us.
//
// ── MEASURED, NOT ASSUMED (spikes 1+2, 2026-07-29, this machine) ───────────────────────
//   0400 blocks a write-capable open of a keyed WAL vault ........ SQLITE_READONLY
//   0400 still permits page_count / quick_check / SELECT ......... yes
//     …even across a 14 MB uncheckpointed -wal (the crash shape) . yes, 3500/3500 rows
//   SQLite propagates the db's mode to a NEW -wal/-shm ........... yes
//   restoring main + -wal + -shm ................................ works
//   restoring THE MAIN FILE ONLY ................................ PERMANENT BRICK
//   chmod stops an ALREADY-OPEN writer .......................... NO
//   VACUUM INTO from a 0400 source with no -shm ................. FAILS
//
// Two of those shape everything here. The main-file-only restore is why lock/unlock must
// always cover the WHOLE family — a human or a repair script fixing just `mycelium.db`
// leaves `-wal`/`-shm` at 0400 and writes fail forever with no visible cause. And "chmod
// does not stop an already-open writer" is why this is a SECOND layer rather than a
// replacement: an existing handle keeps writing through its fd, which is Layer A's job.
//
// ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────────────
// NOT an access-control boundary. A same-uid process can chmod it back — this stops
// ACCIDENTAL and FOREIGN-CODE writers, which is the entire observed threat population, not
// a hostile local user. Also note a foreign writer cannot write MEANINGFUL SQL to an
// encrypted vault at all; what it can do is mutate bytes, which is exactly what a sync
// client or an interrupted copy does, and exactly what a read-only mode prevents.
//
// RESIDUAL, STATED RATHER THAN IMPLIED: after a HARD crash the mode stays writable until
// the next launch, because nothing of ours runs to flip it. Closing that would need a
// launchd agent. It is covered by DETECTION instead — the first-encounter integrity gate
// (D-117, src/db/init.js) refuses to write to a vault it cannot verify.
import { chmodSync, statSync, existsSync } from 'node:fs';
import { vaultFileFamily } from '../paths.js';
import { vaultIsEncrypted } from './open.js';

/** Opt-out, mirroring the lease's own. */
const disabled = () => process.env.MYCELIUM_SKIP_VAULT_MODE === '1';

export const LOCKED_MODE = 0o400;    // owner read-only: the kernel refuses a write open
export const UNLOCKED_MODE = 0o600;  // owner read/write, and no wider — see §1/§7

// Say it once per process. A filesystem without POSIX modes would otherwise log on every
// boot, every snapshot and every quit, which trains people to ignore it.
let _warned = false;

/**
 * Set the whole vault file family to `mode`, and VERIFY it took.
 *
 * ⚠️ THE VERIFY IS THE POINT (CLAUDE.md §10). Eight existing chmod sites in this repo are
 * `catch { /* best-effort *\/ }`, and that is the right call for a snapshot's permissions.
 * It is the WRONG call here: a silent no-op leaves the vault writable while the app
 * believes it is protected, which is a false guarantee in the one place it costs a vault.
 * exFAT, SMB, some synced folders and any non-POSIX mount ignore chmod outright, so this
 * reports honestly and the caller degrades to Layer A rather than pretending.
 *
 * @returns {{ changed: string[], failed: string[], verified: boolean, reason: string }}
 */
export function setVaultFileMode(dbPath, mode) {
  const out = { changed: [], failed: [], verified: true, reason: 'ok' };
  if (disabled()) return { ...out, verified: false, reason: 'MYCELIUM_SKIP_VAULT_MODE=1' };
  if (!dbPath || dbPath === ':memory:') return { ...out, verified: false, reason: 'not a file vault' };

  for (const f of vaultFileFamily(dbPath)) {
    if (!existsSync(f)) continue;              // -wal/-shm/sidecar are often absent
    try {
      chmodSync(f, mode);
      // Read it back. chmod can succeed and change nothing.
      const got = statSync(f).mode & 0o777;
      if (got === mode) out.changed.push(f);
      else { out.failed.push(`${f} (wanted ${mode.toString(8)}, is ${got.toString(8)})`); out.verified = false; }
    } catch (e) {
      out.failed.push(`${f} (${e?.code || e?.message})`);
      out.verified = false;
    }
  }
  if (!out.verified) out.reason = `the filesystem did not apply the mode to ${out.failed.length} file(s)`;
  return out;
}

/**
 * The vault is owned — make it writable. Runs BEFORE anything opens it write-capable.
 *
 * ORDER IS LOAD-BEARING and was measured: src/account/snapshot-on-boot.js opens the source
 * WRITE-CAPABLE on purpose (a read-only open was tried and reverted 2026-07-28), and in the
 * migrating case its failure is fail-closed. So a vault still at 0400 would stop boot at
 * the pre-migration snapshot. This must precede ensureVaultSchema.
 */
export function unlockVaultFiles(dbPath, { log = () => {} } = {}) {
  const r = setVaultFileMode(dbPath, UNLOCKED_MODE);
  if (!r.verified && !_warned && r.reason !== 'MYCELIUM_SKIP_VAULT_MODE=1' && r.reason !== 'not a file vault') {
    _warned = true;
    log(`[mycelium] vault file-mode protection is NOT active: ${r.reason}. `
      + `This filesystem does not apply POSIX permissions, so a process that is not Mycelium `
      + `could write to the vault while the app is closed. The in-process ownership lease still applies.`);
  }
  return r;
}

/**
 * Nothing owns the vault any more — make it read-only.
 *
 * Called when the OWNER releases (a graceful quit), never by an inheritor or a child: they
 * hold no ownership to give up, and a child locking the vault while its parent is still
 * serving would be exactly backwards.
 */
export function lockVaultFiles(dbPath, { log = () => {} } = {}) {
  // ⚠️ ENCRYPTED VAULTS ONLY — and this is the same scoping wal-guard.js already made, for
  // the same reason. That file states it outright: "a PLAINTEXT vault (dev-only) is
  // unguarded". Layer B protects the configuration the product SHIPS; a plaintext vault is
  // dev/legacy and is left alone.
  //
  // Why it MUST be scoped, not merely why it may be: on an ENCRYPTED vault the Python
  // pipeline never opens the file — run-clustering.sh detects the cipher and routes every
  // stage through the Node bridge (design pivot P3). On a PLAINTEXT vault it opens the file
  // DIRECTLY (d1_client.py, local_db.py), and Python holds no presence lock, so it is
  // invisible to the last-one-out rule. Sealing there strands it: the full suite caught
  // exactly that — five pipeline stages dying with
  // `sqlite3.OperationalError: attempt to write a readonly database` and thirteen more
  // skipped behind them.
  //
  // So the rule is not "seal unless someone is here" but "seal only what the presence rule
  // can actually see", and on a plaintext vault it cannot see Python.
  if (!vaultIsEncrypted(dbPath)) {
    return { changed: [], failed: [], verified: false, reason: 'plaintext vault — Layer B is deliberately inert (dev/legacy, and Python writes it directly)' };
  }

  // Called by src/db/vault-lease.js `leaveVault` — the LAST process to stop using the vault
  // seals it, decided from presence locks. Nothing else in node calls this, and a shutdown
  // path that calls it directly is reintroducing a defect: sealing on "I am exiting" rather
  // than on "nobody is left" strands whoever is still here (measured: a gate died with
  // SQLITE_READONLY, and a sibling quit lost 13 of 60 writes).
  //
  // ⚠️ AN EARLIER VERSION OF THIS COMMENT SAID THE TAURI SHELL SEALS. It did, for one
  // revision, and then did not — `seal_vault` no longer exists in main.rs. A comment that
  // outlives the design it describes is worse than none, because it is the thing that stops
  // the next reader checking.
  const r = setVaultFileMode(dbPath, LOCKED_MODE);
  if (r.verified && r.changed.length) log(`[mycelium] vault sealed read-only (${r.changed.length} files) — nothing owns it now`);
  return r;
}

/**
 * THE UN-BRICK, as a supported operation rather than folklore.
 *
 * Restoring ONLY the main file is a PERMANENT BRICK — measured: SQLite propagates the main
 * file's mode to a newly created -wal/-shm, so a vault locked to 0400 leaves its sidecars
 * at 0400, and fixing just `mycelium.db` leaves every write failing with SQLITE_READONLY
 * and nothing on screen to explain it. That is the natural thing for a human or a repair
 * script to do, which is why the correct action ships as a function and is gated.
 */
export function unbrickVaultFiles(dbPath, { log = () => {} } = {}) {
  const r = setVaultFileMode(dbPath, UNLOCKED_MODE);
  log(r.verified
    ? `[mycelium] vault permissions restored on ${r.changed.length} file(s)`
    : `[mycelium] could not restore vault permissions: ${r.reason}`);
  return r;
}

export default { setVaultFileMode, lockVaultFiles, unlockVaultFiles, unbrickVaultFiles, LOCKED_MODE, UNLOCKED_MODE };
