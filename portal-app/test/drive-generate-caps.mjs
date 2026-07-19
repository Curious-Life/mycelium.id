// Drives the REAL src/lib/generate.ts store against a stubbed `api` and a MOCK CLOCK to prove the
// TWO remaining uncapped generate spinners are now bounded:
//   · `starting` — a POST /generate that never answers used to hold the spinner FOREVER. start()
//                  now arms the poll BEFORE the await, so tick()→checkStarting caps it past
//                  START_TIMEOUT_MS to a RETRYABLE error.
//   · `running`  — a server that never advances past status:'running' used to poll FOREVER.
//                  pollStatus now terminates at RUN_CEILING_MS — a BACKSTOP that sits ABOVE the
//                  server's own MAX_MS (45 min), so a healthy long run is ended by the SERVER's cap,
//                  not the client. `stalled` is a SOFT server hint (≥5 min quiet) that KEEPS the run
//                  alive, never a terminal — so a stalled-but-healthy run must stay running.
// This RUNS the state machine; a source grep is a projection (the same discipline as
// drive-generate-embedding.mjs, whose mock-clock technique this reuses).
//
// Why a mock clock: both caps are wall-clock bounds. Overriding Date.now lets us jump PAST a bound
// deterministically while the module's own setInterval poll fires in real time — the exact chain a
// real hang exercises, without a 15-minute wait. Everything else is the real module (esbuild strips
// TS types; only `./api` is stubbed).
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-drive-caps';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// Mutable POST + /status responses, flipped per scenario. A POST of 'HANG' returns a
// never-resolving promise — the ONLY honest way to hold `starting` still (mirrors the mount
// harness's `hang`). `__statusCalls` counts /status GETs so we can prove the poll STOPPED at a cap.
writeFileSync(`${GEN}/api-stub.js`, `
export async function api(path, init) {
  const p = String(path);
  const method = (init && init.method) || 'GET';
  if (p.includes('/generate/status/')) {
    globalThis.__statusCalls = (globalThis.__statusCalls || 0) + 1;
    // A gated /status GET lets us hold a poll IN its await while a terminal is written by another
    // caller (cancel/reset/an overlapping poll) — the exact race F3's guard closes.
    if (globalThis.__statusGate) await globalThis.__statusGate;
    const r = globalThis.__status;
    return { ok: true, status: 200, json: async () => r };
  }
  if (p.includes('/mycelium/generate') && method === 'POST') {
    const r = globalThis.__respPost;
    if (r === 'HANG') return new Promise(() => {});
    return { ok: r.ok, status: r.status, json: async () => r.body };
  }
  return { ok: true, status: 200, json: async () => ({}) };
}
`);

await build({
  entryPoints: ['src/lib/generate.ts'],
  outfile: `${GEN}/generate.js`,
  bundle: true, format: 'esm', platform: 'neutral',
  external: ['svelte/store'],
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: `${process.cwd()}/${GEN}/api-stub.js` })); } }],
  logLevel: 'silent',
});

// ── The MOCK clock. The module calls Date.now(); we control what it sees. Real setInterval still
// fires on wall time (~POLL_MS per wait), but the ELAPSED the module measures is whatever we set. ──
let mockNow = 1_000_000;
Date.now = () => mockNow;

const mod = await import(pathToFileURL(`${process.cwd()}/${GEN}/generate.js`).href);
const { generate, start, reset } = mod;
const { get } = await import('svelte/store');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = 1500;
const snap = () => { const s = get(generate); return { phase: s.phase, error: s.error, retryable: s.retryable, stalled: s.stalled }; };
const RUNNING_POST = { ok: true, status: 200, body: { jobId: 'job-x', status: 'running' } };

const out = { ok: true };
try {
  // ── STARTING: a POST that never answers CAPS to a retryable error ──
  reset();
  globalThis.__respPost = 'HANG';
  mockNow = 1_000_000;
  void start();             // starting + run() armed; POST hangs (do NOT await — it never resolves)
  await wait(200);          // immediate tick → checkStarting (elapsed 0) ⇒ noop; still starting
  out.startingTransient = snap();
  mockNow += 60_000;        // jump PAST START_TIMEOUT_MS (20s)
  await wait(POLL + 300);   // next interval tick → checkStarting ⇒ cap
  out.startingCapped = snap();
  reset();

  // ── RUNNING: a server wedged at status:'running' that NEVER self-terminates CAPS at the client
  //    ceiling. The ceiling sits ABOVE the server's own MAX_MS (45 min) — it is a backstop for a
  //    server so wedged it blew past its own cap without emitting a terminal — so we must jump past
  //    50 min, not 15. ──
  reset();
  globalThis.__respPost = RUNNING_POST;
  globalThis.__status = { id: 'job-x', status: 'running', step: 1, totalSteps: 5, stageLabel: 'Clustering…' }; // no startedAt ⇒ store keeps its own
  mockNow = 3_000_000;
  await start();            // → running, startedAt = 3_000_000; immediate poll (elapsed 0)
  await wait(200);
  out.runningBefore = snap();
  mockNow += 51 * 60_000;   // +51 min: past RUN_CEILING_MS (50 min = server MAX_MS 45 + 5 margin)
  await wait(POLL + 300);   // poll → elapsed > ceiling ⇒ cap
  out.runningCeiling = snap();
  reset();

  // ── RUNNING + stalled (the REAL wire): the server sets `stalled` only after ≥5 min of stdout
  //    silence, as a SOFT hint that KEEPS the run alive to MAX_MS. So we inject it at a realistic
  //    20 min elapsed (>5 min — a shape the server CAN emit; the old harness injected it at 4 min,
  //    which the server can never produce). It must NOT terminate the run — stalled is a hint, not
  //    a terminal — and the flag must be carried through to the store for the "taking longer" copy. ──
  reset();
  globalThis.__respPost = RUNNING_POST;
  globalThis.__status = { id: 'job-x', status: 'running', step: 1, totalSteps: 5, stalled: true };
  mockNow = 4_000_000;
  await start();
  await wait(200);
  mockNow += 20 * 60_000;   // +20 min: well past STALL_MS (5 min) so `stalled` is reachable, well below the 50-min ceiling
  await wait(POLL + 300);   // poll → stalled but below ceiling ⇒ STILL running (soft hint, not killed)
  out.runningStalledSoft = snap();
  reset();

  // ── HEALTHY LONG RUN: 20 min elapsed, NO stalled flag — the 76k-message-vault case (clustering +
  //    LLM describe + 16 Python measure steps). It must NOT be capped by the client ceiling: only
  //    the server's 45-min cap ends a healthy run. This is the finding F2 regression guard. ──
  reset();
  globalThis.__respPost = RUNNING_POST;
  globalThis.__status = { id: 'job-x', status: 'running', step: 3, totalSteps: 5, stageLabel: 'Describing realms…' }; // no stalled
  mockNow = 5_000_000;
  await start();
  await wait(200);
  mockNow += 20 * 60_000;   // same +20 min, healthy, well below the 50-min ceiling
  await wait(POLL + 300);
  out.runningHealthyLong = snap();   // still running — a healthy long run is never torn down by the client
  reset();

  // ── UN-CAP RACE (F3): a poll that is IN its await when a terminal is written must NOT resurrect
  //    'running' when it resumes. We hang the next /status GET, write a terminal (reset → idle) while
  //    it hangs, then release it — the resumed poll must drop its stale response, leaving idle. ──
  reset();
  globalThis.__respPost = RUNNING_POST;
  globalThis.__status = { id: 'job-x', status: 'running', step: 1, totalSteps: 5, stageLabel: 'Clustering…' };
  mockNow = 6_000_000;
  await start();            // → running; the immediate poll completes (gate not armed yet)
  await wait(200);
  let releaseStatus;
  globalThis.__statusGate = new Promise((r) => { releaseStatus = r; }); // arm: next /status GET will hang
  await wait(POLL + 100);   // an interval tick fires → pollStatus enters the await and HANGS there
  reset();                  // a terminal arrives (cancel/overlap): phase → idle, timer cleared
  globalThis.__statusGate = null;
  releaseStatus();          // the hung poll now resumes AFTER the terminal was written
  await wait(200);          // let it run past its guard
  out.raceAfterTerminal = snap();   // MUST be idle — a late poll must not patch 'running' back
  reset();
} catch (e) {
  out.ok = false; out.error = String(e?.stack || e);
} finally {
  try { reset(); } catch { /* */ }
}
console.log(JSON.stringify(out));
rmSync(GEN, { recursive: true, force: true });
process.exit(0);
