// Keep the Mac awake while Mycelium's always-on server runs, so the enrichment
// drainer, the scheduler / reflection cycles and the channel daemons keep
// processing through a screen lock or a dark display.
//
// THE DISTINCTION THAT MATTERS: a screen lock or display-sleep does NOT stop
// processes — only SYSTEM (idle) sleep does, and that freezes every timer and
// drops the network until wake. Without this, "does it keep working when I lock
// the Mac?" depends entirely on the user's macOS Energy settings (e.g. idle-sleep
// on battery). We make it the app's job instead: hold a power assertion for
// exactly as long as the server lives.
//
// MECHANISM: spawn `caffeinate -i -m -s -w <pid>`. ONE system-wide assertion
// (PreventUserIdleSystemSleep) keeps the WHOLE machine awake — every Mycelium
// worker, and Claude Code, and anything else, all benefit from the single hold.
// `-w <pid>` ties caffeinate to THIS process: when the server exits, crashes, or
// is `kill -9`'d, caffeinate sees the pid vanish and releases the assertion — so a
// lock-up can never leave the Mac permanently un-sleepable (the #1 failure mode of
// naive "disable sleep" hacks). Flags:
//   -i  prevent idle SYSTEM sleep (the one that matters; applies on battery too)
//   -m  prevent disk idle sleep
//   -s  prevent system sleep (macOS honors this only on AC power)
// We deliberately DON'T pass -d: the display may still sleep (screen-off is fine —
// only the system must stay awake), preserving the user's screen-lock privacy.
//
// CAVEATS (surfaced in the UI, not hidden): on BATTERY this holds the Mac awake and
// therefore drains it; and CLOSING THE LID still sleeps a laptop unless it's on AC
// with an external display (clamshell) or `pmset disablesleep 1` (needs sudo) —
// caffeinate cannot override a lid-close. For unattended 24/7 operation, keep the
// Mac plugged in (and lid open, or clamshell).
//
// Platform: macOS only. A no-op (supported:false) everywhere else, so callers can
// invoke it unconditionally.

import { spawn } from 'node:child_process';

// Module singleton — one assertion per process, shared across importers.
const state = { child: null, supported: process.platform === 'darwin', wanted: false, reason: null };

/** Current keep-awake status (no side effects). */
export function keepAwakeStatus() {
  return { supported: state.supported, active: !!state.child, wanted: state.wanted, reason: state.reason };
}

/**
 * Begin holding the system-awake assertion. Idempotent (a second call while
 * already active is a no-op). No-op with a reason on non-macOS or if caffeinate
 * is unavailable. Returns the resulting status.
 */
export function startKeepAwake({ logger = () => {} } = {}) {
  state.wanted = true;
  if (!state.supported) { state.reason = `unsupported_platform:${process.platform}`; return keepAwakeStatus(); }
  if (state.child) return keepAwakeStatus();
  try {
    const child = spawn('caffeinate', ['-i', '-m', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    // ENOENT (no caffeinate) or any spawn failure → clear, record, never throw.
    child.on('error', (e) => {
      if (state.child === child) state.child = null;
      state.reason = `spawn_failed:${e?.code || e?.message || 'error'}`;
      logger(`keep-awake: caffeinate unavailable (${state.reason}) — the Mac may idle-sleep`);
    });
    child.on('exit', () => { if (state.child === child) state.child = null; });
    child.unref(); // don't keep the event loop alive; -w releases on our exit anyway
    state.child = child;
    state.reason = null;
    logger(`keep-awake: holding the Mac awake while Mycelium runs (caffeinate pid ${child.pid}); a screen lock won't pause processing`);
  } catch (e) {
    state.reason = `spawn_failed:${e?.code || e?.message || 'error'}`;
    logger(`keep-awake: could not start (${state.reason})`);
  }
  return keepAwakeStatus();
}

/** Release the assertion (the Mac may idle-sleep again). Idempotent. */
export function stopKeepAwake({ logger = () => {} } = {}) {
  state.wanted = false;
  if (state.child) {
    try { state.child.kill(); } catch { /* already gone */ }
    state.child = null;
    logger('keep-awake: released — the Mac may idle-sleep again');
  }
  return keepAwakeStatus();
}

// Test seam: reset the singleton between cases (never used by the app).
export function __resetKeepAwakeForTest() {
  if (state.child) { try { state.child.kill(); } catch { /* */ } }
  state.child = null; state.wanted = false; state.reason = null; state.supported = process.platform === 'darwin';
}
