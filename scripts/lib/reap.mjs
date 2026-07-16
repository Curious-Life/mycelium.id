// Spawn a child that CANNOT outlive the gate that started it.
//
// A verify gate that spawns `node src/index.js` and kills it on the happy path only
// leaks a live vault writer on every early throw — and an orphan holding a writer
// lock fails LATER, UNRELATED gates closed at getDb(). That reads as "my diff broke
// it" when nothing is broken, which is how a red gate stops meaning anything.
//
// So reaping is not the caller's job to remember: register the kill with the
// PROCESS, not with the code path. `process.on('exit')` fires on normal return, on
// an uncaught throw, and on an explicit process.exit(), so the child dies on every
// path a gate can leave by. SIGINT/SIGTERM are wired too — those do NOT fire 'exit'
// on their own, so a Ctrl-C'd gate would otherwise leak exactly like a throw.
//
// Never reach for MYCELIUM_SKIP_WRITER_LOCK=1 to dodge an orphan's lock: that
// disables the fail-closed single-writer guard the vault relies on against
// corruption, and makes the gates lie on a real box. Kill the child instead.
import { spawn } from 'node:child_process';

const live = new Set();

// SIGKILL, not SIGTERM: this is a last-resort sweep on the way out, with no event
// loop left to await a graceful exit. A child that ignores TERM would survive.
const reapAll = () => {
  for (const child of live) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  live.clear();
};

let wired = false;
const wire = () => {
  if (wired) return;
  wired = true;
  process.on('exit', reapAll);
  // A signal does not fire 'exit' by itself. Reap, then re-raise with the
  // conventional 128+signo so the gate's exit status still tells the truth.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { reapAll(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
};

/**
 * spawn() with the same signature, plus a guarantee: the child is killed when this
 * process exits, however it exits. Returns the ChildProcess.
 */
export function spawnReaped(command, args, options) {
  wire();
  const child = spawn(command, args, options);
  live.add(child);
  child.on('exit', () => live.delete(child)); // reaped or self-exited; stop tracking
  return child;
}

/** Kill a reaped child early (the happy path) and stop tracking it. */
export function reap(child, signal = 'SIGTERM') {
  try { child.kill(signal); } catch { /* already gone */ }
  live.delete(child);
}
