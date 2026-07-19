// Drives the REAL src/lib/pipeline-poll.ts decision — the tick logic behind MindscapeView's
// readiness timer, and specifically the Unit-5 built-map live-feed fix. That timer is the SOLE
// feeder of the canonical `pipeline` store; it used to CLEAR once mindGenerated===true, freezing the
// built-map overview on stale stages. The fix keeps the SAME timer armed past a built map and
// refreshes ONLY the cheap pipeline slice each tick. The decision is extracted as a pure function so
// it is drivable HERE without mounting the THREE.js-heavy MindscapeView (THREE + six children + four
// stores). This RUNS the function; a source grep is a projection.
//
// Reach, stated honestly: this gates the DECISION (the timer outlives a built map and the tick
// switches to the pipeline-only refresh), not MindscapeView's own $effect wiring of it — that wiring
// (pollAction/timerArmed threaded into the interval callback, refreshPipeline imported) is verified
// by reading the component and would need a full MindscapeView mount to gate. The decision is the
// falsifiable half, and it is the half that turns a frozen built-map overview into a live one.
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-drive-pipeline-poll';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

const out = { ok: true };
try {
  await build({
    entryPoints: ['src/lib/pipeline-poll.ts'],
    outfile: `${GEN}/pipeline-poll.js`,
    bundle: true, format: 'esm', platform: 'neutral',
    logLevel: 'silent',
  });
  const { pollAction, timerArmed } = await import(pathToFileURL(`${process.cwd()}/${GEN}/pipeline-poll.js`).href);

  // ⭐ THE FIX: a BUILT map (mindGenerated===true), cap not tripped → the tick must keep the
  // pipeline slice LIVE ('pipeline'), and the timer must STAY armed. Before Unit 5 this tick did
  // not exist (the timer was cleared) — so a re-import left the overview frozen.
  out.builtMapTick = pollAction(true, false);        // must be 'pipeline'
  out.builtMapArmed = timerArmed(false);             // must be true — the timer OUTLIVES a built map

  // Not-yet-known (fresh vault / failed probe below the cap) → the full convergence poll.
  out.unknownTick = pollAction(null, false);         // must be 'converge'
  out.falseTick = pollAction(false, false);          // must be 'converge' (map known-absent, still resolving)

  // The probe cap OUTRANKS everything: it stops the timer and owns the retry state.
  out.cappedTick = pollAction(true, true);           // must be 'stop'
  out.cappedArmed = timerArmed(true);                // must be false
} catch (e) {
  out.ok = false; out.error = String(e?.stack || e);
}
console.log(JSON.stringify(out));
rmSync(GEN, { recursive: true, force: true });
process.exit(0);
