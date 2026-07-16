// scripts/vault-repair/guard.mjs — refuse to run maintenance against a LIVE vault.
//
// WHY THIS EXISTS. The root-cause sweep (2026-07-16) ranked "repair/verify tooling run
// against the canonical vault while the app is writing it" as the PRIME suspect for the
// recurring corruption (five events in two weeks): these scripts open the file raw —
// deliberately bypassing src/db/writer-lock.js, whose own header exempts "backup/VACUUM"
// openers — and some run wal_checkpoint(TRUNCATE)/VACUUM/REINDEX. The repo's own repro
// harness (repro-corruption.mjs) demonstrates that an in-place VACUUM under live writers
// corrupts.
//
// TARGET-RELATIVE by design (review B1). The first version gated only
// `target === paths.dbPath()` — but from a dev checkout dbPath() resolves to
// <cwd>/data/mycelium.db, so pointing a repair script at the REAL app vault silently
// waived the guard: the reviewer ran it against the live vault, app holding it, and it
// passed. There is no reason to scope this at all: ANY vault with a live holder must
// refuse maintenance. So the checks are made against the TARGET itself — its own
// writer-lock file, its own open file handles — with no canonical-path comparison to
// get wrong.
//
// Override: MYCELIUM_REPAIR_FORCE=1, loudly. Never the default.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function pidAliveNotZombie(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try {
    return !execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch { return true; } // can't tell → assume alive (fail closed)
}

/**
 * Throw unless the TARGET vault is quiesced (no live writer-lock holder beside it, no
 * process holding it open). A target that doesn't exist yet (e.g. a rebuild DEST)
 * passes — there is nothing to contend with.
 * @param {string} target path the maintenance script is about to touch
 * @param {{ what?: string }} [opts] verb for the error message ("rebuild", "excise", …)
 */
export function assertQuiesced(target, { what = 'maintenance' } = {}) {
  if (!target) throw new Error(`refusing ${what}: no target path given`);
  const t = resolve(String(target));
  if (!existsSync(t)) return; // a not-yet-created destination has no holders

  if (process.env.MYCELIUM_REPAIR_FORCE === '1') {
    console.error(`[guard] ⚠ MYCELIUM_REPAIR_FORCE=1 — running ${what} against ${basename(t)} WITHOUT a quiesce check. If anything holds it, this is the known corruption mechanism.`);
    return;
  }

  // 1. The target's OWN writer lock names a live holder → an app family is up on it.
  //    (src/db/writer-lock.js writes `<dir>/mycelium.db.writer.lock` beside the vault.)
  const lock = join(dirname(t), `${basename(t)}.writer.lock`);
  if (existsSync(lock)) {
    let pid = -1;
    try { pid = parseInt(String(readFileSync(lock, 'utf8')).trim().split(/\s+/)[0], 10); } catch { /* unreadable → fall through to lsof */ }
    if (pidAliveNotZombie(pid)) {
      throw new Error(
        `refusing ${what}: ${basename(t)} is locked by live pid ${pid} — an app is running on it. `
        + `Quit it first (osascript -e 'quit app "Mycelium Dev"'), verify lsof shows no holders, then retry. `
        + `Running ${what} against a live vault is the leading corruption mechanism. Override: MYCELIUM_REPAIR_FORCE=1.`,
      );
    }
  }

  // 2. Belt: ANY process with the target open (covers raw openers that take no lock).
  //    lsof exits 1 with no output when nothing holds the file — that is the good case.
  //    A MISSING lsof (ENOENT) is NOT the good case: warn loudly rather than silently
  //    degrade to lockfile-only coverage (review: fail-open on minimal-PATH hosts).
  let holders = '';
  try {
    holders = execFileSync('lsof', ['-t', '--', t], { encoding: 'utf8' }).trim();
  } catch (e) {
    if (e?.code === 'ENOENT') {
      console.error(`[guard] ⚠ lsof not found on PATH — open-handle check SKIPPED for ${basename(t)}; only the writer-lock check ran. Verify by hand that nothing holds the vault.`);
    }
    holders = '';
  }
  if (holders) {
    throw new Error(
      `refusing ${what}: pid(s) ${holders.split('\n').join(', ')} still have ${basename(t)} open. `
      + `Quit them first, then retry. Override: MYCELIUM_REPAIR_FORCE=1.`,
    );
  }
}

export default assertQuiesced;
