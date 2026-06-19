// src/claims/heartbeat.js — the cadence trigger. A thin, ZERO-LLM timer in the
// REST process that, on each tick, checks whether each cadence's window has
// rolled over since the last snapshot and — if so, and no heavy job is in flight
// — spawns the discovery CHILD (which is where the model runs). Clones the enrich
// drainer's single-flight + unref'd setInterval shape.
//
// Deps are injected so this is unit-testable without a model, a child, or a clock:
//   db          — for db.claims.lastSnapshotWindow
//   spawn(cadences[]) — starts ONE discovery child for all due cadences
//   isJobRunning() — true if a clustering/discovery child is already alive
//   now() — current ms (default Date.now)
//
// See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md §3.5.
import { CADENCES, previousCompleteWindow } from './windows.js';

export function startClaimHeartbeat({
  db,
  userId,
  spawn,
  isJobRunning = () => false,
  now = () => Date.now(),
  intervalMs = 3600_000, // hourly: cheap roll-over checks, heavy work only on a boundary
  cadences = CADENCES,
  runOnBoot = true, // catch a window that rolled over while the process was down
  log = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  if (!db?.claims) throw new TypeError('startClaimHeartbeat: db.claims required');
  if (typeof spawn !== 'function') throw new TypeError('startClaimHeartbeat: spawn required');

  let running = false;
  let timer = null;

  async function cycle() {
    if (running) return; // single-flight; a slow tick must not overlap the next
    running = true;
    try {
      if (isJobRunning()) return; // don't pile onto a live clustering/discovery child
      // Collect every cadence whose window has rolled over since its last
      // snapshot, then spawn ONE child for all of them — the child runs them
      // sequentially so concurrent children never contend for the local model.
      const due = [];
      for (const cadence of cadences) {
        const w = previousCompleteWindow(now(), cadence);
        let last = null;
        try { last = await db.claims.lastSnapshotWindow(userId, cadence); }
        catch { continue; } // db hiccup → try this cadence again next tick
        if (last && last >= w.windowEnd) continue; // already discovered this window
        due.push(cadence);
      }
      if (!due.length) return;
      try {
        await spawn(due);
        log(`[claims] spawned discovery for: ${due.join(', ')}`);
      } catch (e) {
        log(`[claims] spawn failed for ${due.join(',')}: ${String(e?.message || e)}`);
      }
    } finally {
      running = false;
    }
  }

  if (runOnBoot) void cycle(); // check for a rolled-over window on boot
  timer = setInterval(() => { void cycle(); }, intervalMs);
  if (timer.unref) timer.unref(); // never keep the process alive for this timer

  return {
    tick: () => cycle(),
    stop: () => { if (timer) clearInterval(timer); timer = null; },
  };
}

export default startClaimHeartbeat;
