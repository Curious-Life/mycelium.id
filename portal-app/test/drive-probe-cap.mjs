// Drives the REAL src/lib/mind-probe-cap.ts decision — the bound behind MindscapeView's
// "Checking your mind…" spinner. That spinner re-probes /readiness every ~4s while the answer
// isn't known-true; with no bound a persistently-failing read spun it FOREVER (the same
// unbounded-spinner class as the generate `unknown`/`starting`/`running` caps). The cap is
// extracted as a pure function so it is drivable HERE without mounting the THREE.js-heavy
// MindscapeView (which imports THREE + six children + four stores). This RUNS the function; a
// source grep is a projection.
//
// Reach, stated honestly: this gates the DECISION (the bound is finite and trips at it), not
// MindscapeView's render of the capped state — that wiring (genProbeExhausted → the "Couldn't read
// your map — Retry" branch, and retryProbe re-arming the poll) is verified by reading the component
// and would need a full MindscapeView mount to gate. The bound is the falsifiable half, and it is
// the half that turns an infinite spinner into a finite one.
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-drive-probe-cap';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

const out = { ok: true };
try {
  await build({
    entryPoints: ['src/lib/mind-probe-cap.ts'],
    outfile: `${GEN}/mind-probe-cap.js`,
    bundle: true, format: 'esm', platform: 'neutral',
    logLevel: 'silent',
  });
  const { probeExhausted, PROBE_MAX_FAILS } = await import(pathToFileURL(`${process.cwd()}/${GEN}/mind-probe-cap.js`).href);
  out.max = PROBE_MAX_FAILS;
  // Below the bound: still checking (not yet exhausted). At the bound: exhausted ⇒ the view shows
  // the retryable "couldn't read your map" state instead of an infinite spinner.
  out.belowBound = probeExhausted(PROBE_MAX_FAILS - 1);
  out.atBound = probeExhausted(PROBE_MAX_FAILS);
} catch (e) {
  out.ok = false; out.error = String(e?.stack || e);
}
console.log(JSON.stringify(out));
rmSync(GEN, { recursive: true, force: true });
process.exit(0);
