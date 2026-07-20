// Drives the REAL src/lib/generate.ts embedding-poll loop against a stubbed `api` and a MOCK
// CLOCK, to prove the `unknown` (SQLCipher scan-failure) branch is CAPPED — it was the ONLY
// branch in pollEmbedding without a terminal, so a persistent `unknown` spun the
// "Checking your conversations…" indicator FOREVER on a fresh machine (the live-test hang,
// 2026-07-18). This RUNS the state machine; a source grep is a projection.
//
// Why a mock clock: the cap is a wall-clock bound (UNKNOWN_STALL_MS ~25s, mirroring
// embedStallSince). Overriding Date.now lets us jump PAST the bound deterministically while the
// module's own setInterval poll fires in real time — the same chain a real outage exercises,
// without a 25s wait. Everything else is the real module (esbuild strips TS types; only `./api`
// is stubbed).
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-drive-embedding';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// One mutable POST response and one mutable /processing-status response, flipped by the scenarios
// below. `__procCalls` counts processing-status GETs so we can prove the poll STOPPED after the cap
// (a still-armed interval would keep incrementing it).
writeFileSync(`${GEN}/api-stub.js`, `
export async function api(path, init) {
  const p = String(path);
  const method = (init && init.method) || 'GET';
  if (p.includes('/processing-status')) {
    globalThis.__procCalls = (globalThis.__procCalls || 0) + 1;
    const r = globalThis.__proc;
    return { ok: true, status: 200, json: async () => r };
  }
  if (p.includes('/mycelium/generate') && method === 'POST') {
    const r = globalThis.__respPost;
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
// fires on wall time, so one real poll cycle (~POLL_MS) elapses per wait — but the ELAPSED the
// module measures is whatever we set. A big jump (well past UNKNOWN_STALL_MS=25s) trips the cap
// on the next poll without a real wait of that length. ──
let mockNow = 1_000_000;
Date.now = () => mockNow;

const mod = await import(pathToFileURL(`${process.cwd()}/${GEN}/generate.js`).href);
const { generate, start, reset } = mod;
const { get } = await import('svelte/store');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = 1500;

// 409 keeps start() in the `embedding` phase and arms the poll (run()); the immediate tick is the
// first /processing-status read. embedded stays < MIN_EMBEDDED so it never auto-starts out.
const RESP_409 = { ok: false, status: 409, body: { error: 'Only 2 of 500 conversations are ready…', embedded: 2, total: 500 } };
const snap = () => { const s = get(generate); return { phase: s.phase, message: s.message, error: s.error, retryable: s.retryable }; };

const out = { ok: true };
try {
  // ── SCENARIO A: a persistent `unknown` CAPS to a retryable error (and STOPS polling) ──
  reset();
  globalThis.__procCalls = 0;
  globalThis.__respPost = RESP_409;
  globalThis.__proc = { unknown: true };
  mockNow = 1_000_000;
  await start();            // → embedding, run() → immediate poll #1 (unknown ⇒ clock starts)
  await wait(200);
  out.transient = snap();   // BEFORE the cap: still polling, calm copy — "Reading your vault…"

  mockNow += 60_000;        // jump WELL past UNKNOWN_STALL_MS
  await wait(POLL + 300);   // one interval poll #2 ⇒ cap
  out.capped = snap();      // error + retryable + honest copy
  const callsAtCap = globalThis.__procCalls;

  mockNow += 60_000;
  await wait(POLL + 300);   // if the interval were still armed, procCalls would climb
  out.callsAtCap = callsAtCap;
  out.callsAfterCap = globalThis.__procCalls;   // MUST equal callsAtCap ⇒ stop() cleared the poll

  // ── SCENARIO B: a good (non-unknown) count between unknowns CLEARS the clock ⇒ no false cap ──
  reset();
  globalThis.__procCalls = 0;
  globalThis.__respPost = RESP_409;
  globalThis.__proc = { unknown: true };
  mockNow = 2_000_000;
  await start();            // poll #1 unknown ⇒ clock starts at 2_000_000
  await wait(200);
  mockNow += 60_000;        // long past the bound…
  globalThis.__proc = { embedded: 2, total: 500 };   // …but the NEXT read succeeds (non-unknown)
  await wait(POLL + 300);   // poll #2 ⇒ clears the clock, stays embedding (2 < MIN)
  out.recovered = snap();   // NOT error — a successful count escaped the cap
  globalThis.__proc = { unknown: true };             // unknown returns, but the clock is fresh now
  await wait(POLL + 300);   // poll #3 ⇒ clock restarts at now; now-now < bound ⇒ NO immediate cap
  out.recoveredThenUnknown = snap();   // still embedding, proves the clock RESET (not merely paused)

  // ── SCENARIO C (P1-C): a `total:0` count must NOT hard-error immediately (the mid-import race) ──
  // The count SUCCEEDED (no `unknown`) but measured 0 — either a truly-empty vault OR the transient-0
  // of an active import whose SWR-cached backlog is still a stale pre-import snapshot. The first poll
  // must stay calm ("Preparing…"), a non-zero total between must CLEAR the clock, and only a
  // PERSISTENT 0 past EMPTY_CONFIRM_MS may surface the honest "import first" terminal.
  reset();
  globalThis.__procCalls = 0;
  globalThis.__respPost = RESP_409;
  globalThis.__proc = { embedded: 0, total: 0 };   // a real, successful 0
  mockNow = 3_000_000;
  await start();            // poll #1: total 0 ⇒ clock starts, calm copy, NO error
  await wait(200);
  out.zeroTransient = snap();   // still embedding — must NOT be the "import first" error yet

  globalThis.__proc = { embedded: 2, total: 500 };   // the import populated ⇒ counts appear
  await wait(POLL + 300);   // poll #2 ⇒ clears the zero clock, stays embedding (2 < MIN)
  out.zeroThenPopulated = snap();   // NOT the empty-vault error — the race resolved

  // Now a GENUINELY empty vault: 0 that persists past the bound ⇒ the honest terminal.
  reset();
  globalThis.__procCalls = 0;
  globalThis.__respPost = RESP_409;
  globalThis.__proc = { embedded: 0, total: 0 };
  mockNow = 4_000_000;
  await start();            // poll #1: clock starts
  await wait(200);
  mockNow += 60_000;        // jump WELL past EMPTY_CONFIRM_MS
  await wait(POLL + 300);   // poll #2 ⇒ the empty-vault terminal
  out.zeroPersistent = snap();   // error, NOT retryable, "import first"
} catch (e) {
  out.ok = false; out.error = String(e?.stack || e);
} finally {
  try { reset(); } catch { /* */ }
}
console.log(JSON.stringify(out));
rmSync(GEN, { recursive: true, force: true });
process.exit(0);
