// src/system/service-guard.js — shared port-conflict + crash-loop guard for the
// pipeline service supervisors (embed :8091, transcribe :8093, qwen3-tts :8094).
//
// Why (2026-07-18 incident): pipeline services from a PREVIOUS app boot survived
// as orphans holding their ports (the Rust shell's group-reap runs on clean exit,
// and its crash pidfile covers caddy/frpc only — a hard-crashed boot leaves the
// python services alive). The new boot's supervisors then crash-looped ~170×/day:
// every spawn died at bind (OSError Errno 48), "restart #N scheduled" forever —
// no orphan detection, backoff capped at 30s so the loop never stopped, and the
// health surface never named the actual fault.
//
// This module provides three primitives, wired into each supervisor:
//   1. looksLikePortConflict(stderr)     — classify a bind-failure exit
//   2. reapOwnOrphanOnPort(...)          — SAFETY-CRITICAL: terminate the port
//      holder IF AND ONLY IF it is provably OUR OWN orphan — its command line
//      contains our exact service script (and the port we spawn with) AND it is
//      not in the current app's process tree (a live child of ours / our shell).
//      A foreign holder is NEVER touched: the caller marks the service faulted
//      with a content-free reason instead.
//   3. createRestartGovernor()           — outcome-based bounded restart: an
//      exponential backoff (15s → 2min cap) driven by CONSECUTIVE failures,
//      reset only by a successful bind (never by a clock), and a halt latch
//      after N straight failures so a doomed service stops retrying until a
//      settings-change / nudge resumes it.
//
// SECURITY: no message content, no key material. The only outward action is a
// signal to a pid that passed the own-orphan proof; everything else is local
// bookkeeping. All shell-outs are execFile with fixed argv (no shell parsing).

import { execFile as _execFile } from 'node:child_process';

/** True iff a service's stderr tail says it died because the port was taken. */
export function looksLikePortConflict(stderrTail) {
  return /EADDRINUSE|Address already in use|Errno 48|Errno 98|attempting to bind on address/i.test(String(stderrTail || ''));
}

const execp = (execFile, cmd, args) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  } catch { resolve(null); }
});

/**
 * Who is LISTENING on 127.0.0.1:<port>? → { pid, ppid, command } | null.
 * lsof for the pid, ps for identity. Fail-soft: any error → null (caller treats
 * it as "could not prove anything" and never kills).
 */
export async function inspectPortHolder(port, { execFile = _execFile } = {}) {
  const out = await execp(execFile, 'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  const pid = Number(String(out || '').trim().split('\n')[0]);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const ps = await execp(execFile, 'ps', ['-o', 'ppid=,command=', '-p', String(pid)]);
  const line = String(ps || '').trim();
  if (!line) return null;
  const m = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!m) return null;
  return { pid, ppid: Number(m[1]), command: m[2] };
}

/**
 * The own-orphan proof (SAFETY-CRITICAL — this clause is what makes killing
 * permissible at all). True iff:
 *   • the holder's command line contains OUR exact service script path token
 *     (the argv we spawn with, e.g. 'pipeline/embed-service.py'), AND
 *   • it was spawned for the SAME port (our spawns always pass --port <n>), AND
 *   • it is NOT in the current app's process tree: not our live child (ppid ==
 *     our pid), not our shell parent's child (ppid == our ppid), and not the
 *     child pid we are currently supervising.
 * Anything unprovable → false → never killed.
 */
export function isOwnOrphan(holder, { scriptPath, port, selfPid = process.pid, parentPid = process.ppid, ownChildPid = null } = {}) {
  if (!holder || !Number.isFinite(holder.pid) || holder.pid <= 1) return false;
  if (!scriptPath) return false;
  const cmd = String(holder.command || '');
  if (!cmd.includes(scriptPath)) return false;              // identity: our service script
  if (port && !cmd.includes(String(port))) return false;    // same service instance
  if (ownChildPid != null && holder.pid === ownChildPid) return false; // our LIVE child
  if (holder.ppid === selfPid) return false;                // our live child (tree)
  if (parentPid && holder.ppid === parentPid) return false; // sibling under our shell
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pid, { kill, timeoutMs, stepMs = 100 }) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try { kill(pid, 0); } catch { return true; }  // ESRCH → gone
    if (Date.now() >= until) return false;
    await sleep(stepMs);
  }
}

/**
 * On a bind conflict: inspect the holder; if (and only if) the own-orphan proof
 * passes, SIGTERM → grace → SIGKILL it, so the supervisor can retry the bind.
 *
 * @returns {Promise<{reaped:boolean, pid?:number, reason?:'no-holder'|'foreign'|'kill-failed'|'stuck', holder?:{pid:number}}>}
 */
export async function reapOwnOrphanOnPort({
  port, scriptPath, ownChildPid = null,
  log = () => {}, execFile = _execFile, kill = process.kill.bind(process),
  graceMs = 3000,
} = {}) {
  const holder = await inspectPortHolder(port, { execFile });
  if (!holder) return { reaped: false, reason: 'no-holder' };
  if (!isOwnOrphan(holder, { scriptPath, port, ownChildPid })) {
    // NOT provably ours → never killed; the caller surfaces the fault instead.
    return { reaped: false, reason: 'foreign', holder: { pid: holder.pid } };
  }
  try { kill(holder.pid, 'SIGTERM'); }
  catch { return { reaped: false, reason: 'kill-failed', holder: { pid: holder.pid } }; }
  if (!(await waitGone(holder.pid, { kill, timeoutMs: graceMs }))) {
    try { kill(holder.pid, 'SIGKILL'); } catch { /* raced its own exit */ }
    if (!(await waitGone(holder.pid, { kill, timeoutMs: 1500 }))) {
      return { reaped: false, reason: 'stuck', holder: { pid: holder.pid } };
    }
  }
  log(`[service-guard] reaped our own orphan on :${port} (pid ${holder.pid})`);
  return { reaped: true, pid: holder.pid };
}

/**
 * Outcome-based bounded restart. NOT clock-based: the counter moves only on
 * observed outcomes (a crash counts a failure; a successful bind/probe resets),
 * so a slow stretch can't launder a crash loop and an idle stretch can't halt a
 * healthy service.
 *
 * @param {object} [opts]
 * @param {number} [opts.minBackoffMs=15000]   first-failure delay
 * @param {number} [opts.maxBackoffMs=120000]  delay cap (15s → 2min doubling)
 * @param {number} [opts.maxFailures=6]        consecutive failures → halt (no
 *                                             more attempts until resume())
 */
export function createRestartGovernor({ minBackoffMs = 15_000, maxBackoffMs = 120_000, maxFailures = 6 } = {}) {
  let consecutive = 0;
  let halted = false;
  let haltReason = null;
  return {
    /** A crash/failed start. → {delayMs, halted}; halts after maxFailures straight. */
    recordFailure() {
      consecutive += 1;
      if (consecutive >= maxFailures) { halted = true; haltReason = haltReason || `${consecutive} consecutive failures`; }
      const delayMs = Math.min(maxBackoffMs, minBackoffMs * 2 ** Math.min(consecutive - 1, 10));
      return { delayMs, halted };
    },
    /** A successful bind/health probe — the ONLY thing that resets the counter. */
    recordSuccess() { consecutive = 0; halted = false; haltReason = null; },
    /** Hard halt with a reason (e.g. a foreign process holds the port). */
    halt(reason) { halted = true; haltReason = String(reason || 'halted'); },
    /** Operator/settings nudge — resume attempts from a clean counter. */
    resume() { consecutive = 0; halted = false; haltReason = null; },
    isHalted: () => halted,
    haltReason: () => haltReason,
    failures: () => consecutive,
  };
}
