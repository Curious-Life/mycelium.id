// src/db/snapshot-schedule.js — decide WHEN the vault gets an automatic snapshot.
//
// WHY THIS EXISTS: src/account/snapshot-on-boot.js is a pre-MIGRATION safety net, and its
// trigger is exactly that — "the migration set changed, or no snapshot exists at all"
// (snapshot-on-boot.js:120-122, `if (!migrating && haveBaseline) return null`). A vault
// whose schema is settled therefore takes ONE baseline snapshot and never another. Weeks
// of writing accumulate behind a single old copy.
//
// That is not a hypothetical. On 2026-07-26 a production vault was damaged and there was
// nothing to restore from — no snapshots directory at all. The lesson is not "corruption
// must never happen" (an unbounded goal: bad sector, panic mid-fsync, a driver bug) but
// "corruption must be SURVIVABLE". Bounding damage is the fail-stop latch's job
// (src/db/vault-halt.js); being able to go back an hour is this one's.
//
// TIME-BASED, not event-based, and deliberately so: the events worth snapshotting before
// are the ones we already know about (a migration — covered above). The whole point here
// is the damage nobody predicted.
//
// Fire-and-forget, exactly like maybeScheduleIntegrityCheck: a detached child, never
// blocking boot, never able to fail a launch. A missed snapshot must never cost a boot.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { isVaultHalted, readVaultCorruptMarker } from './vault-halt.js';
import { isImportQuiesced } from './import-quiesce.js';
import { recordDurabilityEvent } from './durability-log.js';

const WORKER = fileURLToPath(new URL('./snapshot-worker.mjs', import.meta.url));

/** The packaged app's vault — the ONLY vault worth automatic snapshots. */
function platformVaultPath() {
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'id.mycelium.app', 'mycelium.db');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'id.mycelium.app', 'mycelium.db');
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'id.mycelium.app', 'mycelium.db');
}
const STAMP = '.last-auto-snapshot';
const PREFIX = 'auto-';

/** Never snapshot more often than this. A snapshot is a full VACUUM INTO of the whole
 *  vault — measured in a real boot: 3 snapshots of an 86 MB vault in 5 seconds under a
 *  mis-set interval, 258 MB written while the app was still starting up. On a 2 GB vault
 *  that is ~24 s of heavy I/O per copy. A backup system that can saturate the disk is a
 *  liability, so the cadence has a floor no configuration can go under. */
const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Hours between automatic snapshots (default 24). 0/negative disables. */
/** Exported for verify:vault-snapshots — the floor is a load-bearing safety property and
 *  a source-text check could not see `intervalMs()` return early (measured: `if (true)
 *  return 1;` left three greps green while the schedule copied a 2 GB vault every second). */
export function intervalMs() {
  const raw = Number(process.env.MYCELIUM_SNAPSHOT_INTERVAL_H ?? 24);
  const h = Number.isFinite(raw) ? raw : 24;
  if (h <= 0) return 0; // explicit disable
  const ms = h * 60 * 60 * 1000;
  // The floor is waived only for an explicit `force` (gates/dev), never in normal operation.
  if (String(process.env.MYCELIUM_SNAPSHOT_AUTO ?? '').trim().toLowerCase() === 'force') return ms;
  return Math.max(ms, MIN_INTERVAL_MS);
}

/** Age of the newest automatic snapshot, in ms. Infinity when there is none. */
export function newestSnapshotAgeMs(dbPath) {
  const snapDir = path.join(path.dirname(dbPath), 'snapshots');
  // Prefer the stamp (cheap), but fall back to the actual files — a stamp without a
  // snapshot beside it would otherwise suppress the very first real backup.
  let newest = 0;
  try {
    for (const f of fs.readdirSync(snapDir)) {
      if (!f.startsWith(PREFIX) || !f.endsWith('.db')) continue;
      const m = fs.statSync(path.join(snapDir, f)).mtimeMs;
      if (m > newest) newest = m;
    }
  } catch { /* no dir yet */ }
  return newest ? Date.now() - newest : Infinity;
}

/**
 * Spawn a detached snapshot if one is due. Returns a content-free verdict for logs/tests.
 *
 * @param {{dbPath:string, dbKeyHex?:string|null, isCanonical?:boolean, log?:Function}} o
 * @returns {{ scheduled:boolean, reason:string }}
 */
export function maybeScheduleSnapshot({ dbPath, dbKeyHex = null, isCanonical = true, log } = {}) {
  try {
    if (!dbPath || dbPath === ':memory:') return { scheduled: false, reason: 'no-vault' };
    // Fixtures and pipeline temp DBs must never spawn snapshot workers.
    if (!isCanonical) return { scheduled: false, reason: 'not-canonical' };
    if (String(process.env.MYCELIUM_SNAPSHOT_AUTO ?? '').trim().toLowerCase() === 'off') {
      return { scheduled: false, reason: 'disabled' };
    }
    const every = intervalMs();
    if (every <= 0) return { scheduled: false, reason: 'disabled' };

    // D-128: never VACUUM the vault while a bulk import is mid-restore — the detached
    // worker copying pages under a mass raw write is half of the corruption pair the
    // quiesce exists to prevent. The schedule re-fires later; nothing is lost.
    if (isImportQuiesced()) return { scheduled: false, reason: 'import-quiesced' };
    // Never snapshot a vault we have already caught being damaged: the copy would be
    // damaged too, and rotation would spend the slot that still holds a good one.
    // The worker re-checks the on-disk marker itself (it is the cross-process signal);
    // this is the cheap in-process half.
    if (isVaultHalted()) return { scheduled: false, reason: 'vault-halted' };
    // WHICH file the marker condemns matters here too. The marker is directory-scoped, and
    // the boot gate deliberately leaves a marker naming ANOTHER file in place — so a bare
    // existence test disabled automatic snapshots on a perfectly healthy vault, forever,
    // and silently (this early return skipped the log, and src/index.js discards the
    // result). A machine reaching a corruption event with nothing to restore from is the
    // exact failure the schedule exists to prevent. Round-6 review, 2026-07-28.
    const mark = readVaultCorruptMarker(dbPath);
    if (mark && (!mark.db || mark.db === path.basename(dbPath))) {
      log?.(`[snapshot] not scheduling: this vault is marked corrupt (${mark.source || 'unknown'}) — existing snapshots are the recovery path and will not be rotated`);
      return { scheduled: false, reason: 'vault-corrupt' };
    }
    if (mark) {
      log?.(`[snapshot] a .vault-corrupt marker here names "${mark.db}", not this vault — snapshots continue`);
    }

    // "isCanonical" is not a strong enough filter on its own: paths.js calls whatever
    // MYCELIUM_DB points at canonical, and ~100 verify gates point it at a fixture. Those
    // runs would each spawn a worker and litter snapshots/ beside temp DBs. Automatic
    // snapshots are an OPERATIONAL concern — they belong to the vault the user actually
    // runs. MYCELIUM_SNAPSHOT_AUTO=force opts a non-standard location in deliberately.
    const forced = String(process.env.MYCELIUM_SNAPSHOT_AUTO ?? '').trim().toLowerCase() === 'force';
    if (!forced && path.resolve(dbPath) !== platformVaultPath()) {
      return { scheduled: false, reason: 'not-app-vault' };
    }

    const age = newestSnapshotAgeMs(dbPath);
    if (age < every) return { scheduled: false, reason: 'not-due' };

    const child = spawn(process.execPath, [WORKER], {
      detached: true,
      // stderr is PIPED, not ignored. With 'ignore' every failure was invisible: a snapshot
      // that never ran looked exactly like one that succeeded, on a machine whose owner
      // believed they had backups. That is the same silence this whole change set exists to
      // remove — the vault told us it was damaged and we discarded the message.
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MYCELIUM_DB: dbPath,
        ...(dbKeyHex ? { MYCELIUM_SNAPSHOT_KEY: dbKeyHex } : {}),
        ...(process.env.MYCELIUM_SNAPSHOT_KEEP_AUTO ? { MYCELIUM_SNAPSHOT_KEEP_AUTO: process.env.MYCELIUM_SNAPSHOT_KEEP_AUTO } : {}),
        ...(process.env.MYCELIUM_SNAPSHOT_BUDGET_X ? { MYCELIUM_SNAPSHOT_BUDGET_X: process.env.MYCELIUM_SNAPSHOT_BUDGET_X } : {}),
        // D-140 review M1: the full-integrity opt-out is read by the WORKER — an
        // allowlist that doesn't forward it makes the documented flag silently dead.
        ...(process.env.MYCELIUM_SNAPSHOT_FULL_CHECK ? { MYCELIUM_SNAPSHOT_FULL_CHECK: process.env.MYCELIUM_SNAPSHOT_FULL_CHECK } : {}),
      },
    });
    // Capture the worker's own verdict and make it durable. Bounded: a worker that somehow
    // produced unbounded output must not be able to grow this process's memory.
    let tail = '';
    child.stderr?.on('data', (d) => { tail = (tail + d).slice(-2000); });
    child.stderr?.on('error', () => { /* pipe died — nothing to report */ });
    child.on('error', () => { /* spawn failed — the next boot/tick tries again */ });
    child.on('exit', (code) => {
      const lines = tail.split('\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (code === 0) { log?.(`[snapshot] ${last.replace(/^\[snapshot\] /, '') || 'done'}`); return; }
      // 3 = not due / no room (expected), 4 = refused on a condemned vault (correct).
      // Anything else is a snapshot that did NOT happen, and the owner must be able to find
      // out — silently skipping is how a machine reaches a corruption event with no backups.
      if (code === 3 || code === 4) { log?.(`[snapshot] skipped: ${last.replace(/^\[snapshot\] /, '')}`); return; }
      log?.(`[snapshot] FAILED (exit ${code}): ${last.replace(/^\[snapshot\] /, '')} — this vault did NOT get a backup.`);
      try { recordDurabilityEvent('snapshot-failed', { exit: code }); } catch { /* */ }
    });
    child.unref();
    log?.(`[snapshot] automatic snapshot scheduled (last one ${age === Infinity ? 'never' : `${Math.round(age / 3.6e6)}h ago`})`);
    return { scheduled: true, reason: age === Infinity ? 'no-snapshot-yet' : 'due' };
  } catch (e) {
    // A scheduler that throws would turn "no backup" into "no boot". Never.
    log?.(`[snapshot] scheduler skipped (${e?.message || e})`);
    return { scheduled: false, reason: 'error' };
  }
}

/**
 * Boot-time call plus a recurring timer, so a machine that stays up for weeks keeps
 * snapshotting. The timer is unref'd — it never holds the process open.
 * @returns {() => void} stop
 */
export function startSnapshotSchedule(opts = {}) {
  maybeScheduleSnapshot(opts);
  const tick = Math.min(intervalMs() || 0, 60 * 60 * 1000); // check hourly at most
  if (tick <= 0) return () => {};
  const timer = setInterval(() => maybeScheduleSnapshot(opts), tick);
  timer.unref?.();
  return () => clearInterval(timer);
}

export default maybeScheduleSnapshot;
