// src/core/memory-pressure.js — the OBSERVED memory-pressure probe for the compute
// governor (design COMPUTE-GOVERNOR-DESIGN-2026-07-23 §3.6).
//
// ⚠️ THE ONE RULE THIS MODULE EXISTS TO ENFORCE:
//   `detectHardware().availableRamGb` (== os.freemem()) MUST NOT be the pressure signal.
//
// Measured live on a HEALTHY 16 GB Mac during the design sweep:
//     total 16.0 GB   os.freemem() 0.1 GB   kern.memorystatus_level 56
// os.freemem() on darwin counts only genuinely-free pages, and macOS keeps almost none
// (the rest is compressor-backed file cache it will reclaim on demand). A rule of
// "refuse below 2 GB free" would refuse EVERY admission forever on every Mac — converting
// the D-001 crash into a permanently-dead pipeline, a WORSE bug the operator would report.
//
// So the signal is per-platform and OBSERVED:
//   • darwin  → `sysctl -n kern.memorystatus_level` (a 0–100 "% of memory available"
//               kernel gauge; ≥30 is healthy) cross-checked against `vm_stat`'s
//               compressor + swap-in activity (swap-in rate is what actually correlates
//               with the beachball).
//   • linux   → /proc/meminfo MemAvailable (NEVER MemFree — MemAvailable already accounts
//               for reclaimable cache, the linux analogue of the darwin trap).
//   • win32   → os.freemem() IS availPhys on Windows (unlike darwin, it is genuinely the
//               available physical bytes GlobalMemoryStatusEx reports), so a low fraction
//               there really is pressure.
//
// FAIL DIRECTION (design §3.6, and the same direction restorePauseOnce chose for the same
// reason): a probe that throws or returns garbage resolves to `ok` (ADMIT), never
// `critical` — a broken probe must not be able to wedge the whole pipeline. A wrongly-open
// governor degrades to today's behaviour (no governor); a wrongly-closed one is the dead
// pipeline above.
//
// Pure + injectable: `run` (a synchronous command runner) and `osMod`/`platform` are all
// injectable so the gate can drive every branch offline and deterministically (verify
// C8 encodes the trap above: darwin healthy while os.freemem()/totalmem() < 0.05).

import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// A pressure LEVEL, coarse on purpose — admit() only needs "may I load a big model now?".
export const PRESSURE = Object.freeze({ OK: 'ok', WARN: 'warn', CRITICAL: 'critical' });

// darwin kern.memorystatus_level thresholds. The kernel gauge is "% available": Apple's own
// memorystatus daemon starts pressure notifications well before 0. 30 is the design's healthy
// floor; below 15 the compressor is thrashing. Cross-checked with swap-in below.
const DARWIN_WARN_LEVEL = 30;
const DARWIN_CRITICAL_LEVEL = 15;
// linux MemAvailable as a fraction of MemTotal.
const LINUX_WARN_FRAC = 0.15;
const LINUX_CRITICAL_FRAC = 0.08;
// win32 availPhys fraction (os.freemem is availPhys here).
const WIN_WARN_FRAC = 0.12;
const WIN_CRITICAL_FRAC = 0.06;

// Default synchronous runner: execFileSync (NEVER a shell — no argument ever comes from
// untrusted input here, but the codebase convention is shell-free spawns). Tight timeout so
// a hung sysctl/vm_stat can never stall an admit() decision; a throw → caller fails to OK.
function defaultRun(cmd, args) {
  return String(execFileSync(cmd, args, { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }));
}

// Previous swap-in sample, so a RISING swap-in count (the real beachball fingerprint) can be
// detected across successive probes. Module-scoped: the governor caches the probe on a ~2 s TTL,
// so consecutive readings are a rate proxy. Absolute swapins is cumulative-since-boot and NOT a
// pressure signal on its own — only a positive DELTA is.
let _lastSwapins = null;

function darwinPressure(run) {
  // kern.memorystatus_level — the primary gauge.
  let level = null;
  try { level = Number(String(run('sysctl', ['-n', 'kern.memorystatus_level']).trim())); }
  catch { level = null; }
  // vm_stat "Swapins" — a RISING swap-in count is the beachball's fingerprint. We compare to the
  // previous sample; a positive delta means the box is actively swapping RIGHT NOW.
  let swapins = null;
  try {
    const out = run('vm_stat', []);
    const m = String(out).match(/Swapins:\s*(\d+)/);
    if (m) swapins = Number(m[1]);
  } catch { swapins = null; }
  const swapinDelta = (Number.isFinite(swapins) && Number.isFinite(_lastSwapins)) ? swapins - _lastSwapins : 0;
  if (Number.isFinite(swapins)) _lastSwapins = swapins;

  if (!Number.isFinite(level)) {
    // Probe unavailable → ADMIT (fail-open). Record the reason so a persistently-broken probe
    // is visible in the governor's log rather than silently degrading to no-governor.
    return { level: PRESSURE.OK, signal: 'darwin:memorystatus-unavailable', detail: { level, swapins } };
  }
  let lvl = level >= DARWIN_WARN_LEVEL ? PRESSURE.OK
    : level >= DARWIN_CRITICAL_LEVEL ? PRESSURE.WARN
      : PRESSURE.CRITICAL;
  // ESCALATE on active swapping — never de-escalate. A rising swap-in delta while the gauge is
  // marginal (WARN) means the compressor is already spilling to disk → treat as CRITICAL (the
  // signal the design §3.6 says actually correlates with the hang). A single cumulative reading
  // (no previous sample, delta 0) never escalates, so a healthy box is never fabricated unhealthy.
  let signal = 'darwin:memorystatus_level';
  if (swapinDelta > 0 && lvl === PRESSURE.WARN) { lvl = PRESSURE.CRITICAL; signal = 'darwin:memorystatus_level+swapin-rising'; }
  return { level: lvl, signal, detail: { level, swapins, swapinDelta } };
}

/** Test seam: reset the swap-in delta baseline between checks. */
export function _resetSwapinBaseline() { _lastSwapins = null; }

function linuxPressure(readMeminfo) {
  let info;
  try { info = readMeminfo(); } catch { return { level: PRESSURE.OK, signal: 'linux:meminfo-unavailable', detail: {} }; }
  const grab = (k) => { const m = String(info).match(new RegExp(`^${k}:\\s*(\\d+)\\s*kB`, 'm')); return m ? Number(m[1]) : null; };
  const total = grab('MemTotal');
  const avail = grab('MemAvailable'); // NEVER MemFree — see header.
  if (!Number.isFinite(total) || !Number.isFinite(avail) || total <= 0) {
    return { level: PRESSURE.OK, signal: 'linux:meminfo-unparsed', detail: { total, avail } };
  }
  const frac = avail / total;
  const lvl = frac >= LINUX_WARN_FRAC ? PRESSURE.OK
    : frac >= LINUX_CRITICAL_FRAC ? PRESSURE.WARN
      : PRESSURE.CRITICAL;
  return { level: lvl, signal: 'linux:MemAvailable', detail: { fracAvailable: Math.round(frac * 1000) / 1000 } };
}

function win32Pressure(osMod) {
  const total = osMod.totalmem();
  const free = osMod.freemem(); // availPhys on Windows — genuinely available, unlike darwin.
  if (!(total > 0)) return { level: PRESSURE.OK, signal: 'win32:totalmem-zero', detail: {} };
  const frac = free / total;
  const lvl = frac >= WIN_WARN_FRAC ? PRESSURE.OK
    : frac >= WIN_CRITICAL_FRAC ? PRESSURE.WARN
      : PRESSURE.CRITICAL;
  return { level: lvl, signal: 'win32:availPhys', detail: { fracAvailable: Math.round(frac * 1000) / 1000 } };
}

/**
 * Observe current memory pressure. Synchronous (admit() must not await) and fail-open.
 * @param {object}  [o]
 * @param {string}  [o.platform] os.platform() override (injectable for the gate)
 * @param {Function}[o.run]      (cmd, args) => stdout string (injectable; darwin sysctl/vm_stat)
 * @param {object}  [o.osMod]    node:os override (win32 availPhys)
 * @param {Function}[o.readMeminfo] () => string (linux /proc/meminfo, injectable)
 * @returns {{ level:'ok'|'warn'|'critical', signal:string, detail:object }}
 */
export function memoryPressure({
  platform = os.platform(),
  run = defaultRun,
  osMod = os,
  readMeminfo = () => readFileSync('/proc/meminfo', 'utf8'),
} = {}) {
  try {
    if (platform === 'darwin') return darwinPressure(run);
    if (platform === 'linux') return linuxPressure(readMeminfo);
    if (platform === 'win32') return win32Pressure(osMod);
    // Unknown platform → ADMIT. We do not guess a probe we have not verified.
    return { level: PRESSURE.OK, signal: `unknown-platform:${platform}`, detail: {} };
  } catch (e) {
    // Any unexpected throw → ADMIT (fail-open). This is the last backstop for the §3.6 rule.
    return { level: PRESSURE.OK, signal: 'probe-threw', detail: { error: String(e?.message || e) } };
  }
}

export default memoryPressure;
