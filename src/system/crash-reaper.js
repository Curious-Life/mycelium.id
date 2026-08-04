// src/system/crash-reaper.js — the crash path's child reaper (D-136 fast-half).
//
// Why (D-136, live-reproduced 2026-08-04): the clean SIGTERM path stops every
// supervisor and kills spawned children (bindBoundedShutdown → closeHandle →
// supervisor.stop → killChild), but the CRASH policy — uncaughtException /
// unhandledRejection → immediate process.exit(1) (deliberate: a corrupted
// process must not linger, D-108) — runs none of that. Every spawned child
// (channel-daemon, embed/transcribe/tts services, ollama serve, pipeline jobs)
// survives, reparents to launchd, and the RESTARTED server then ADOPTS the
// orphan on its port with spawnedByUs=false — which means no later clean
// shutdown ever kills it. One crash permanently converts "our child" into
// "adopted foreign service". The operator watched channel-daemon burn ~98% CPU
// for 3 h 46 m with no app running.
//
// This module keeps a registry of live spawned-by-us children so the crash
// path can kill them in one synchronous sweep before exiting:
//
//   • registerCrashKillChild(child, label) — called at every persistent spawn
//     site right after spawn() succeeds. Auto-deregisters on 'exit'. A pid-less
//     child (spawn failed, or a test fake) is a no-op.
//   • reapChildrenOnCrash() — SYNCHRONOUS, NEVER WAITS (the D-108 constraint:
//     signal the group then exit, never wait on it). Two layers:
//       1. per-pid SIGKILL of every registered child — always safe: it touches
//          only pids we spawned this run, so a dev server sharing the
//          terminal's process group cannot harm its siblings;
//       2. IFF this process is provably its own process-group leader
//          (pgid == pid — true in the packaged app, where the Rust shell
//          spawns us with process_group(0), main.rs set_group), ONE
//          kill(-pid, SIGKILL) group sweep that also reaps grandchildren
//          (e.g. the channel-daemon's ffmpeg remux). The sweep necessarily
//          kills this process too — acceptable and correct: the caller was
//          about to process.exit(1), and the shell watchdog restarts on any
//          child exit. Leadership is probed ONCE at first registration
//          (ps -o pgid=), never in the crash path (no exec while crashing).
//
// DELIBERATELY NOT REGISTERED: the detached durability children —
// db/snapshot-schedule.js (snapshot-worker.mjs) and db/integrity.js — spawn
// with detached:true into their OWN groups precisely so a parent death cannot
// tear a backup mid-copy ("the vault had no snapshot to restore" is the D-110
// failure; durability is not subordinate to lifecycle). The group sweep cannot
// reach them (different pgid) and the registry must not either.
// Also unregistered: keep-awake's caffeinate — spawned with -w <our pid>, the
// OS releases it the instant we die.
//
// SECURITY: no message content, no key material, no shell parsing. The only
// outward action is a signal to a pid recorded from our own spawn() return.
// PID-reuse window: a registered child that died a few ms before the crash
// (its 'exit' event not yet dispatched on a starving loop) could in theory be
// a reused pid. macOS allocates pids sequentially over a 99999 space; the
// window is milliseconds; the alternative (an exec-based name re-check inside
// the crash path) violates the never-wait constraint. Accepted, recorded here.

import { execFileSync as _execFileSync } from 'node:child_process';

/** @type {Map<number, string>} live registered children: pid → label */
const REGISTRY = new Map();

/** null = not probed yet; true/false = probed once at first registration. */
let _groupLeader = null;

function probeGroupLeadership(execFileSync) {
  if (process.platform === 'win32') return false; // negative-pid kill is POSIX-only
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { timeout: 3000 });
    const pgid = Number(String(out).trim());
    return Number.isFinite(pgid) && pgid === process.pid;
  } catch {
    return false; // unprovable → fail closed to the per-pid layer only
  }
}

/**
 * Track a spawned-by-us child for the crash sweep. Call right after the
 * child-process spawn call succeeds; pairs with the clean-path killChild.
 * (This module itself creates no child processes — C10's scanner is textual,
 * so the word is avoided here.)
 * A child with no pid (failed spawn, test fake) is ignored. Idempotent per pid.
 * @param {{pid?:number, once?:Function}} child
 * @param {string} label content-free identity for the crash log (e.g. 'channel-daemon')
 * @param {{execFileSync?:typeof _execFileSync}} [deps] test seam
 * @returns the child, for chaining
 */
export function registerCrashKillChild(child, label, { execFileSync = _execFileSync } = {}) {
  const pid = child?.pid;
  if (!Number.isFinite(pid) || pid <= 0) return child;
  if (_groupLeader === null) _groupLeader = probeGroupLeadership(execFileSync);
  REGISTRY.set(pid, String(label || 'child'));
  try { child.once('exit', () => { REGISTRY.delete(pid); }); } catch { /* EventEmitter-less fake */ }
  return child;
}

/**
 * The crash sweep. SYNCHRONOUS — never waits, never execs, never throws.
 * Layer 1: SIGKILL every registered pid. Layer 2 (group leader only):
 * SIGKILL our whole group — grandchildren included, ourselves included
 * (the caller exits immediately after regardless).
 * @param {{kill?:typeof process.kill, log?:(m:string)=>void, groupLeader?:boolean}} [deps]
 *        test seams; groupLeader overrides the probed value (gates only).
 * @returns {{killed:number, groupSwept:boolean}}
 */
export function reapChildrenOnCrash({ kill = process.kill.bind(process), log = () => {}, groupLeader = _groupLeader } = {}) {
  let killed = 0;
  for (const [pid, label] of REGISTRY) {
    try { kill(pid, 'SIGKILL'); killed += 1; try { log(`[crash-reaper] SIGKILL ${label} (pid ${pid})`); } catch { /* */ } }
    catch { /* already gone (ESRCH) — the goal state */ }
  }
  REGISTRY.clear();
  let groupSwept = false;
  if (groupLeader === true && process.platform !== 'win32') {
    // One signal for the whole family — this also kills US; the caller was
    // exiting anyway and the shell watchdog restarts on any exit.
    try { log('[crash-reaper] group sweep: SIGKILL our own process group'); } catch { /* */ }
    try { kill(-process.pid, 'SIGKILL'); groupSwept = true; } catch { /* */ }
  }
  return { killed, groupSwept };
}

/** Registered pids (content-free), for gates/diagnostics. */
export function crashKillRegistry() { return new Map(REGISTRY); }

/** Test seam: wipe registry + leadership probe cache. */
export function _resetCrashReaperForTest() { REGISTRY.clear(); _groupLeader = null; }
