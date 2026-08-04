// src/db/vault-copy.js — spawn + await the vault-copy child (D-130).
//
// The ONE way to take a consistent vault copy without blocking the event loop:
// used by the boot-path pre-migration snapshot (snapshot-on-boot.js, awaited
// under the init lock) and the pre-backfill backup (jobs.js). The child is
// src/db/vault-copy-worker.mjs — write-capable VACUUM INTO + verify + atomic
// rename (see its header for why write-capable is load-bearing).
//
// NO TIMEOUT, deliberately: a multi-GB copy legitimately takes many minutes and
// the callers' contracts are fail-closed ("no snapshot → no migration") — a
// deadline that kills a slow-but-progressing copy would convert slow disks into
// refused boots. Honesty during the wait comes from the boot-phase surface
// (/account/status booting:'snapshot'), not from a timer.
//
// NOT registered with the crash-reaper (D-136), same doctrine as
// snapshot-schedule.js/integrity.js: a durability child must survive a parent
// crash — a half-orphaned copy finishes, verifies, renames, and exits on its
// own; it holds no port and burns no resident model.
//
// SECURITY (§4): the db-file key travels ONLY in the allowlisted child env
// (MYCELIUM_SNAPSHOT_KEY — the snapshot-worker.mjs precedent), never argv,
// never logged. stderr from the child is tail-bounded and content-free.

import { spawn as _spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORKER = fileURLToPath(new URL('./vault-copy-worker.mjs', import.meta.url));

/**
 * Copy the vault at srcDbPath to destPath in a child process; resolve when the
 * child exits. Resolves { ok:true } on a verified copy, { ok:false, reason }
 * otherwise — the CALLER decides fail-closed vs fail-soft (snapshot-on-boot's
 * migrating/baseline split).
 *
 * @param {{ srcDbPath:string, destPath:string, dbKeyHex:string|null,
 *           spawn?:typeof _spawn, log?:(m:string)=>void }} o
 * @returns {Promise<{ok:boolean, code:number|null, reason:string|null}>}
 */
export function runVaultCopyChild({ srcDbPath, destPath, dbKeyHex = null, spawn = _spawn, log = () => {} } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [WORKER], {
        // DETACHED (round-1 review): the durability doctrine in this header —
        // "a half-orphaned copy finishes, verifies, renames" — is only TRUE
        // when the child is in its own process group; non-detached it shared
        // the parent's group and the crash-reaper's group sweep SIGKILLed it
        // mid-VACUUM (torn .tmp left forever). detached:true is exactly how
        // snapshot-schedule.js earns the same doctrine. The parent still
        // awaits 'exit' normally.
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          // Allowlist only — no ambient secrets, no vault paths beyond the copy pair.
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          MYCELIUM_COPY_SRC: path.resolve(srcDbPath),
          MYCELIUM_COPY_DEST: path.resolve(destPath),
          ...(dbKeyHex ? { MYCELIUM_SNAPSHOT_KEY: dbKeyHex } : {}),
        },
      });
    } catch (e) {
      resolve({ ok: false, code: null, reason: `spawn-failed:${String(e?.code || 'error')}` });
      return;
    }
    let errTail = '';
    child.stderr?.on('data', (d) => { errTail = (errTail + String(d)).slice(-500); });
    child.on('error', () => { /* surfaced via exit */ });
    child.on('exit', (code, signal) => {
      if (code === 0) { resolve({ ok: true, code, reason: null }); return; }
      const reason = signal ? `killed:${signal}` : (errTail.trim().split('\n').pop() || `exit ${code}`);
      log(`[vault-copy] child failed (${reason})`);
      resolve({ ok: false, code, reason });
    });
  });
}

// ── Armed copy provider ───────────────────────────────────────────────────────
// The db-file key legitimately lives at BOOT scope (src/index.js, where
// snapshot-schedule gets it). Jobs that later need an off-loop consistent copy
// (the pre-backfill backup, src/jobs.js) must not have the key plumbed through
// the router layer — instead boot ARMS this module once, and the job asks for a
// copy by destination only. Fail-soft: an un-armed process reports not-armed
// and the caller falls back to its previous (sync) path.
let _armed = null; // { dbPath, dbKeyHex } — in-process memory only (§4)

/** Called ONCE from boot with the canonical vault's path + db-file key. */
export function armVaultCopy({ dbPath, dbKeyHex = null } = {}) {
  if (!dbPath) return;
  _armed = { dbPath, dbKeyHex: dbKeyHex || null };
}

/** True when boot has armed the provider (gates/diagnostics). */
export function vaultCopyArmed() { return Boolean(_armed); }

/**
 * Off-loop consistent copy of the ARMED vault to destPath.
 * @returns {Promise<{ok:boolean, code:number|null, reason:string|null}>}
 */
export function runArmedVaultCopy({ destPath, expectSrc = null, spawn, log } = {}) {
  if (!_armed) return Promise.resolve({ ok: false, code: null, reason: 'not-armed' });
  // Round-1 review (MED): the caller states which vault it believes it is
  // backing up; a divergence must NOT silently produce an ok:true copy of a
  // DIFFERENT database (the caller then falls back to its own sync copy of
  // the right file).
  if (expectSrc && _armed.dbPath !== expectSrc) {
    return Promise.resolve({ ok: false, code: null, reason: 'src-mismatch' });
  }
  return runVaultCopyChild({ srcDbPath: _armed.dbPath, destPath, dbKeyHex: _armed.dbKeyHex, spawn, log });
}
