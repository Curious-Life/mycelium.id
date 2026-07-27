// scripts/verify-voice-readiness.mjs — D-003 ↻2: the voice engine must never be
// able to sit in "starting" forever, and a render failure must name its real cause.
//
// WHAT THIS GATE CLAIMS
// ---------------------
// D-003 has now shipped-and-broken three times. Each fix was aimed at the seam the
// previous one missed, and each time the OPERATOR-VISIBLE state was the same
// sentence — "voice engine is starting or needs Apple… try again shortly" — over a
// condition that never resolved. So this gate does not assert "voice works" (it
// cannot: MLX is Apple-Silicon-only and CI has no model weights). It asserts the
// three things that are provable off that hardware, and that were all false:
//
//   P — the PYTHON service's model load does not LATCH. One failed load used to pin
//       every later /tts at 503 for the process lifetime while /health still
//       answered ok:true. Driven for real: the service is spawned against a stub
//       loader that fails once and then succeeds, and against no loader at all.
//   S — the SUPERVISOR cannot rest in a non-terminal state. Every stuck path
//       (governor halted, crash loop, probe never succeeding) must converge on a
//       terminal status carrying a reason AND a remedy.
//   R — the REPLY TOOL preserves the voice tri-state. `!!args.voice` coerced "the
//       agent said nothing" into an explicit `voice:false` on the wire, so the
//       chokepoint's reply-time toggle consult (the QA6-VOICE fix, #328) could never
//       fire. verify:channel-egress V1 stayed green because it POSTs the chokepoint
//       directly and never drives createReplyDomain — an M-001-class false green.
//
// WHAT IT CANNOT CLAIM: that a real mlx-audio render produces audio. The stub
// loader proves the STATE MACHINE and the DIAGNOSTICS, not the synth. Real audio is
// operator-smoke-only, on Apple Silicon, with the model + a frozen sample.
//
// MUTATION RECORD — 18 mutations were applied one at a time, the suite run against each,
// and the file restored. 17 RED. The one that did not is recorded too, because a mutation
// that stays green is the finding (M-001: a gate green for the wrong reason).
//
// MUTATION-TESTED: restored the load latch (`if _model is not None or _load_error is not None:
//   return _model`) in pipeline/qwen3-tts-service.py:_load → P3, P4, P4b, P6, P6b RED
//   (one failed load pinned the service for its whole lifetime — the D-003 ↻2 core)
// MUTATION-TESTED: dropped `"status"/"reason"` from the /health body → P2, P4b, P5c, P6, P7b RED.
//   NOTE: S3 does NOT red on this one — S3 stubs /health in Node, so it gates the SUPERVISOR's
//   READING, not the service's REPORTING. Both are covered, by different rows; do not read
//   S3 as evidence about the python.
// MUTATION-TESTED: widened `except ImportError` back to the whole class → P7, P7b RED
//   (a missing sub-dependency got the terminal "this Mac cannot run MLX" verdict)
// MUTATION-TESTED: replaced the background loader thread with a load-before-bind call →
//   P6, P6b RED (a retryable boot failure never recovered without an owner render)
// MUTATION-TESTED: `if (true) return false;` at the top of enforceStartingDeadline() in
//   src/tts/qwen3-tts-supervisor.js → S1, S1b, S1c, S2, S2b, S6c, S6d RED (health rested at
//   'starting' with no reason and no remedy — the exact operator-visible symptom). This is
//   the load-bearing anti-stick guarantee.
// MUTATION-TESTED: removed the progress re-arm, making the deadline a plain wall clock →
//   S6 REDs (a HEALTHY, progressing 2.9 GB download was declared a terminal failure — the
//   opposite defect, found in adversarial review of this very diff)
// MUTATION-TESTED: moved the MAX_INSTALL_ATTEMPTS check back inside the backoff window →
//   S7c, S7d RED (the "terminal" state never stood; the pip install kept retrying forever)
// MUTATION-TESTED: probe() forced to `const status = 'ok'` (the old `r.ok`-only probe) →
//   S3, S3b RED (a /health reporting a failed model load was called "Local voice ready.")
// MUTATION-TESTED: dropped QWEN_TTS_PRELOAD from the spawn env → S8 REDs
// MUTATION-TESTED: `if (governor.isHalted()) return;` (bare, the pre-fix line) ALONE → the
//   suite stays GREEN. Recorded as the honest result: handlePortConflict writes the same
//   terminal health, so the halt branch is defence-in-depth, not the guarantee. Mutating
//   BOTH layers together REDs S5 + S5b (status=starting, detail=undefined) — verified.
// MUTATION-TESTED: restored `voice: !!args?.voice && platform === 'telegram'` in
//   src/tools/reply.js → R1 REDs (an unset voice put `voice:false` on the wire, so the
//   chokepoint never consulted the owner's toggle)
// MUTATION-TESTED: collapsed classifyUpstreamError back to `render-upstream-${status}` in
//   src/tts/voice-render.js → R4, R4b, R4c, R4d RED (the real reason discarded again)
// MUTATION-TESTED: removed the path-redaction rule → R5, R5b RED (a /Users/<name>/… path
//   reached the surfaced detail)
// MUTATION-TESTED: removed the unicode-separator fold → R5b REDs (`∕Users∕someone∕` smuggled
//   the username past the path rule)
// MUTATION-TESTED: removed the paired-quote redaction → R5i REDs (the unpaired-quote
//   fallback still hid the text, but at the cost of the whole diagnostic tail)
// MUTATION-TESTED: removed the unpaired-quote rule → R5d REDs (`got input: "the line`
//   survived verbatim)
// MUTATION-TESTED: dropped VAULT_REASON_CODES in the daemon's qwen provider → all three
//   R7 rows RED (every specific reason collapsed back to 'render-failed')
// MUTATION-TESTED: made src/internal-router.js forward `detail` to the confined daemon →
//   R9 REDs (§1: the sanitizer's residual is bounded by that seam staying closed)
// All restored afterwards; the suite returns GREEN on the restored tree (67 pass · 0 fail).

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY = process.env.MYCELIUM_PYTHON || 'python3';

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

/** A minimal but VALID mono 16-bit WAV — the service wave-validates the ref sample. */
function tinyWav(frames = 240) {
  const data = Buffer.alloc(frames * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const REF_B64 = tinyWav().toString('base64');

const root = await mkdtemp(path.join(tmpdir(), 'voiceready-'));

// ═══════════════════════════════════════════════════════════════════════════════
// P — the python service's load must not latch (driven for real)
// ═══════════════════════════════════════════════════════════════════════════════
//
// A stub `mlx_audio.tts.utils.load_model` on PYTHONPATH: it counts calls in a file,
// raises RuntimeError on the first, and returns a model whose generate() raises on
// the second. That gives us, in one process: a retryable load failure, an actual
// re-attempt, and a genuine synth failure whose reason must survive to the wire.
async function writeStubRuntime(dir) {
  await mkdir(path.join(dir, 'mlx_audio', 'tts'), { recursive: true });
  await writeFile(path.join(dir, 'mlx_audio', '__init__.py'), '');
  await writeFile(path.join(dir, 'mlx_audio', 'tts', '__init__.py'), '');
  await writeFile(path.join(dir, 'mlx_audio', 'tts', 'utils.py'), `
import os
_C = os.environ["FAKE_LOAD_COUNT_FILE"]

def _bump():
    n = 0
    try:
        with open(_C) as f:
            n = int(f.read().strip() or "0")
    except Exception:
        n = 0
    with open(_C, "w") as f:
        f.write(str(n + 1))
    return n

class _M:
    def generate(self, **kw):
        raise RuntimeError("mlx kernel unavailable for /Users/someone/models/qwen3 'the spoken line'")

def load_model(d):
    n = _bump()
    if n == 0:
        raise RuntimeError("transient load boom")
    return _M()
`);
}

async function startService({ dir, port, env = {} }) {
  const child = spawn(PY, ['pipeline/qwen3-tts-service.py', '--serve', '--port', String(port)], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      PYTHONPATH: dir,
      MYCELIUM_QWEN_TTS_PORT: String(port),
      QWEN_TTS_MODEL_DIR: dir,
      QWEN_TTS_LOAD_RETRY_BASE_S: '1',
      QWEN_TTS_LOAD_RETRY_MAX_S: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  for (let i = 0; i < 100; i++) {                      // wait for the bind
    await sleep(100);
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return { child, log: () => out }; }
    catch { /* not up yet */ }
  }
  try { child.kill(); } catch { /* */ }                // never orphan the python
  throw new Error(`service never bound on :${port}\n${out}`);
}
const health = (port) => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
const tts = async (port) => {
  const r = await fetch(`http://127.0.0.1:${port}/tts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello', ref_audio_b64: REF_B64, ref_text: 'a reference line' }),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
};

{
  const dir = path.join(root, 'stub'); await mkdir(dir, { recursive: true });
  await writeStubRuntime(dir);
  const countFile = path.join(dir, 'count.txt');
  const port = await freePort();
  const svc = await startService({ dir, port, env: { FAKE_LOAD_COUNT_FILE: countFile } });
  try {
    // ── P1: the FIRST load fails → honest 503 naming the retryable reason ──────
    const a = await tts(port);
    ok(a.status === 503 && String(a.body?.error || '').startsWith('model-unavailable:'),
      'P1 first load fails → 503 model-unavailable (retryable token, not a bare 500)',
      `status=${a.status} err=${String(a.body?.error || '').slice(0, 60)}`);
    ok(a.body?.reason === 'load-failed', 'P1b the 503 carries reason=load-failed', `reason=${a.body?.reason}`);

    // ── P2: /health reports the MODEL's state, not just "I am listening" ───────
    const h1 = await health(port);
    ok(h1.status === 'error' && h1.reason === 'load-failed',
      'P2 ⭐ /health names the load failure (was: ok:true and nothing else, so the supervisor called it ready)',
      `status=${h1.status} reason=${h1.reason} loaded=${h1.loaded}`);

    // ── P3: the load is RE-ATTEMPTED after the backoff (the un-latch) ──────────
    ok(Number((await readFile(countFile, 'utf8')).trim()) === 1, 'P3a exactly one load attempt so far');
    await sleep(1400);                                  // past QWEN_TTS_LOAD_RETRY_BASE_S=1
    const b = await tts(port);
    const attempts = Number((await readFile(countFile, 'utf8')).trim());
    ok(attempts === 2, 'P3 ⭐ the load is RE-ATTEMPTED (a failed load no longer latches for the process lifetime)',
      `attempts=${attempts}`);

    // ── P4: the second load succeeds; the SYNTH failure surfaces its own reason ─
    ok(b.status === 500 && String(b.body?.error || '').startsWith('synth-failed:'),
      'P4 ⭐ a genuine synth failure surfaces as synth-failed:<reason> (the D-003 residual is now visible)',
      `status=${b.status} err=${String(b.body?.error || '').slice(0, 80)}`);
    const h2 = await health(port);
    ok(h2.status === 'ok' && h2.loaded === true, 'P4b /health flips to ok once the retried load lands', `status=${h2.status}`);
  } finally { svc.child.kill(); }
}

{
  // ── P5: NO runtime at all (ImportError) → TERMINAL, and it stops re-attempting ─
  const dir = path.join(root, 'noruntime'); await mkdir(dir, { recursive: true });
  const port = await freePort();
  const svc = await startService({ dir, port });
  try {
    const a = await tts(port);
    ok(a.status === 503 && String(a.body?.error || '').startsWith('voice-runtime-missing:'),
      'P5 ⭐ no mlx_audio → 503 voice-runtime-missing (a DIFFERENT, terminal token — not the same 503 as a load failure)',
      `err=${String(a.body?.error || '').slice(0, 60)}`);
    ok(a.body?.reason === 'runtime-missing', 'P5b reason=runtime-missing', `reason=${a.body?.reason}`);
    const h = await health(port);
    ok(h.status === 'needs-runtime' && h.reason === 'runtime-missing',
      'P5c /health says needs-runtime (degraded+retryable-by-install in the service-state taxonomy)', `status=${h.status}`);
    await sleep(1400);
    const b = await tts(port);
    ok(b.status === 503 && String(b.body?.error || '').startsWith('voice-runtime-missing:'),
      'P5d a terminal runtime-missing does NOT flip to a retryable state on retry');
  } finally { svc.child.kill(); }
}

{
  // ── P6: with eager preload, health must CONVERGE ON ITS OWN ────────────────
  // Adversarial review found the first version of this diff moved the dishonest
  // state one layer up: preloading before bind meant a retryable boot failure pinned
  // /health at status:'error' forever, because the only thing that ever re-attempted
  // a load was an inbound /tts. A background loader now retries, so a service whose
  // first load fails becomes genuinely ready WITHOUT the owner poking it.
  const dir = path.join(root, 'preload'); await mkdir(dir, { recursive: true });
  await writeStubRuntime(dir);
  const countFile = path.join(dir, 'count.txt');
  const port = await freePort();
  const svc = await startService({ dir, port, env: { FAKE_LOAD_COUNT_FILE: countFile, QWEN_TTS_PRELOAD: '1' } });
  try {
    let converged = null;
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      const h = await health(port);
      if (h.status === 'ok') { converged = h; break; }
    }
    ok(converged !== null,
      'P6 ⭐ a retryable load failure at boot RECOVERS on its own (was: /health pinned at error until an owner render)',
      converged ? 'status=ok' : `never converged; last=${JSON.stringify(await health(port))}`);
    ok(Number((await readFile(countFile, 'utf8')).trim()) >= 2,
      'P6b the background loader is what re-attempted it (no /tts was ever sent)');
  } finally { svc.child.kill(); }
}

{
  // ── P7: a missing SUB-dependency is retryable, not "this Mac can't run MLX" ──
  // `except ImportError` was too wide: mlx-audio lazily imports soundfile and
  // per-model backends, so a missing sub-dep produced the terminal "needs Apple
  // Silicon" verdict on a box one pip install away from working — a WRONG terminal
  // state, the same dishonest-state family as the bug being fixed.
  const dir = path.join(root, 'subdep'); await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, 'mlx_audio', 'tts'), { recursive: true });
  await writeFile(path.join(dir, 'mlx_audio', '__init__.py'), '');
  await writeFile(path.join(dir, 'mlx_audio', 'tts', '__init__.py'), '');
  await writeFile(path.join(dir, 'mlx_audio', 'tts', 'utils.py'),
    'def load_model(d):\n    import totally_missing_soundfile_subdep\n');
  const port = await freePort();
  const svc = await startService({ dir, port });
  try {
    const a = await tts(port);
    ok(a.body?.reason === 'load-failed',
      'P7 ⭐ a missing SUB-dependency is classified retryable (not the terminal "needs Apple Silicon" verdict)',
      `reason=${a.body?.reason} err=${String(a.body?.error || '').slice(0, 60)}`);
    const h = await health(port);
    ok(h.status === 'error', 'P7b /health reports it as a load failure, not needs-runtime', `status=${h.status}`);
  } finally { svc.child.kill(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// S — the supervisor cannot rest in a non-terminal state
// ═══════════════════════════════════════════════════════════════════════════════
process.env.MYCELIUM_QWEN_TTS_START_CEILING_MS = '600';   // seconds, not minutes, for the gate
const READY_STATE = { phase: 'ready', variant: 'Qwen3-TTS-12Hz-1.7B-Base-8bit' };

async function driveSupervisor({ spawnImpl, port, ticks = 14, tickMs = 40 }) {
  process.env.MYCELIUM_QWEN_TTS_PORT = String(port);
  // Fresh module per scenario: the supervisor keeps module-level singletons.
  const mod = await import(`../src/tts/qwen3-tts-supervisor.js?s=${Math.random()}`);
  const sup = mod.startQwenTtsSupervisor({
    home: process.cwd(), shouldRun: () => true, tickMs,
    spawn: spawnImpl, getState: () => READY_STATE,
    reapOrphan: async () => ({ reaped: false, reason: 'no-holder' }),
  });
  await sleep(tickMs * ticks);
  const h = mod.getQwenTtsHealth();
  sup.stop();
  return h;
}

// A child that exits immediately — the crash loop. 6 straight failures halt the
// governor, and THAT is the path that used to leave health pinned at 'starting'.
function crashingSpawn() {
  return () => {
    const listeners = {};
    const child = {
      pid: 424242,
      stderr: { on: () => {} },
      on: (ev, fn) => { listeners[ev] = fn; if (ev === 'exit') setTimeout(() => fn(1), 5); },
      kill: () => {},
    };
    return child;
  };
}

{
  const port = await freePort();   // nothing listening → every probe fails
  const h = await driveSupervisor({ spawnImpl: crashingSpawn(), port, ticks: 40, tickMs: 40 });
  ok(h.status === 'down',
    'S1 ⭐ a crash-looping/halted voice service reaches a TERMINAL down state (was: pinned at "starting" for the session)',
    `status=${h.status} msg=${h.message}`);
  ok(typeof h.detail === 'string' && h.detail.length > 0, 'S1b the terminal state names a reason', `detail=${h.detail}`);
  ok(typeof h.remedy === 'string' && h.remedy.length > 10,
    'S1c ⭐ the terminal state carries a REMEDY the owner can execute (the QA6 bar)', `remedy=${String(h.remedy).slice(0, 50)}`);
  ok(!/try again shortly/i.test(String(h.message) + String(h.remedy || '')),
    'S1d the terminal state does not tell the owner to "try again shortly"');
}

{
  // S2 — the DEADLINE backstop: a child that stays alive but never answers /health.
  // Nothing in this path records a failure, so before the deadline existed health
  // would read 'starting' for as long as the app ran.
  const port = await freePort();
  const aliveSpawn = () => ({ pid: 525252, stderr: { on: () => {} }, on: () => {}, kill: () => {} });
  const h = await driveSupervisor({ spawnImpl: aliveSpawn, port, ticks: 40, tickMs: 40 });
  ok(h.status === 'down',
    'S2 ⭐ a service that is alive but never becomes healthy converts to terminal at the ceiling (no infinite "starting")',
    `status=${h.status} detail=${h.detail}`);
  ok(typeof h.remedy === 'string' && h.remedy.length > 10, 'S2b the ceiling conversion carries a remedy');
}

{
  // S3 — the false GREEN: a service that ANSWERS /health 200 but reports a failed
  // model load must not be called ready. probe() used to test only `r.ok`.
  const port = await freePort();
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, loaded: false, status: 'error', reason: 'load-failed' }));
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  try {
    const neverSpawn = () => { throw new Error('must not spawn — a service is already listening'); };
    const h = await driveSupervisor({ spawnImpl: neverSpawn, port, ticks: 20, tickMs: 50 });
    ok(h.status === 'down',
      'S3 ⭐ /health 200 with a failed model load is NOT reported as ready (was: "Local voice ready." while every render 503\'d) — and not left at the symptom, "starting", either',
      `status=${h.status}`);
    ok(h.status === 'down' && h.detail === 'load-failed', 'S3b it is reported as down:load-failed with a remedy', `detail=${h.detail}`);
  } finally { srv.close(); }
}

{
  // S3c — the honest GREEN still works: status 'ok' in the body → adopted as ready.
  const port = await freePort();
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, loaded: true, status: 'ok', reason: null }));
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  try {
    const h = await driveSupervisor({ spawnImpl: () => { throw new Error('no spawn'); }, port, ticks: 20, tickMs: 50 });
    ok(h.status === 'ok', 'S3c a genuinely loaded service is still adopted as ready (the fix is not just "always red")', `status=${h.status}`);
  } finally { srv.close(); }
}

{
  // S5 — the port-conflict halt: a FOREIGN process holds :8094, so the service can
  // never bind. That is terminal until the owner acts, and the health must say which
  // port and who holds it — not "starting…". (This path halts immediately, so unlike
  // the crash loop it does not depend on the deadline backstop.)
  const port = await freePort();
  const conflictSpawn = () => {
    const child = {
      pid: 626262,
      stderr: { on: (ev, fn) => { if (ev === 'data') setTimeout(() => fn(Buffer.from('OSError: [Errno 48] Address already in use')), 2); } },
      on: (ev, fn) => { if (ev === 'exit') setTimeout(() => fn(1), 20); },
      kill: () => {},
    };
    return child;
  };
  process.env.MYCELIUM_QWEN_TTS_PORT = String(port);
  const mod = await import(`../src/tts/qwen3-tts-supervisor.js?s=${Math.random()}`);
  const sup = mod.startQwenTtsSupervisor({
    home: process.cwd(), shouldRun: () => true, tickMs: 40,
    spawn: conflictSpawn, getState: () => READY_STATE,
    reapOrphan: async () => ({ reaped: false, reason: 'foreign', holder: { pid: 999 } }),
  });
  await sleep(400);
  const h = mod.getQwenTtsHealth();
  sup.stop();
  ok(h.status === 'down' && /held by another process/.test(String(h.detail || '')),
    'S5 ⭐ a foreign holder on the voice port is terminal AND names itself (never "starting")',
    `status=${h.status} detail=${h.detail}`);
  ok(typeof h.remedy === 'string' && /quit it/i.test(h.remedy), 'S5b the port conflict carries an executable remedy', `remedy=${String(h.remedy).slice(0, 40)}`);
}

{
  // S6 ⭐ THE OPPOSITE FAILURE. A fix for "stuck starting" must not become "stuck
  // failed": a 2.9 GB snapshot download legitimately runs past any wall-clock
  // ceiling. Adversarial review caught the first version of this diff converting a
  // HEALTHY, progressing download into 'down' + "needs Apple Silicon". So progress
  // re-arms the stall clock, and this drives a download that keeps advancing for
  // many multiples of the ceiling.
  const port = await freePort();
  process.env.MYCELIUM_QWEN_TTS_PORT = String(port);
  process.env.MYCELIUM_QWEN_TTS_START_CEILING_MS = '200';
  let progress = 0;
  const mod = await import(`../src/tts/qwen3-tts-supervisor.js?s=${Math.random()}`);
  const sup = mod.startQwenTtsSupervisor({
    home: process.cwd(), shouldRun: () => true, tickMs: 30,
    spawn: () => { throw new Error('must not spawn while the model is downloading'); },
    getState: () => ({ phase: 'downloading', progress: (progress += 3), variant: 'Qwen3-TTS-12Hz-1.7B-Base-8bit' }),
    reapOrphan: async () => ({ reaped: false, reason: 'no-holder' }),
  });
  const seen = new Set();
  for (let i = 0; i < 30; i++) { await sleep(40); seen.add(mod.getQwenTtsHealth().status); }
  sup.stop();
  ok(!seen.has('down'),
    'S6 ⭐ a PROGRESSING model download is never converted to a terminal failure (the deadline is a STALL deadline, not a wall clock)',
    `statuses seen=${[...seen].join(',')} elapsed≫ceiling`);
  ok(seen.has('installing'), 'S6b it is honestly reported as a setup step while it progresses');

  // …and a STALLED download (no progress at all) still becomes terminal.
  const mod2 = await import(`../src/tts/qwen3-tts-supervisor.js?s=${Math.random()}`);
  const sup2 = mod2.startQwenTtsSupervisor({
    home: process.cwd(), shouldRun: () => true, tickMs: 30,
    spawn: () => { throw new Error('no spawn'); },
    getState: () => ({ phase: 'downloading', progress: 7, variant: 'Qwen3-TTS-12Hz-1.7B-Base-8bit' }),
    reapOrphan: async () => ({ reaped: false, reason: 'no-holder' }),
  });
  await sleep(900);
  const h2 = mod2.getQwenTtsHealth();
  sup2.stop();
  ok(h2.status === 'down' && /stalled/.test(String(h2.detail || '')),
    'S6c ⭐ a STALLED setup (progress frozen) DOES become terminal, with a remedy', `status=${h2.status} detail=${h2.detail}`);
  ok(typeof h2.remedy === 'string' && h2.remedy.length > 10, 'S6d the stall verdict carries a remedy');
  delete process.env.MYCELIUM_QWEN_TTS_START_CEILING_MS;
}

{
  // S7 — a runtime install that keeps failing must STOP attempting and rest at a
  // terminal degraded state. The cap used to be checked inside the backoff window, so
  // once the window expired it re-attempted anyway and health flapped forever.
  const port = await freePort();
  process.env.MYCELIUM_QWEN_TTS_PORT = String(port);
  process.env.MYCELIUM_QWEN_TTS_INSTALL_BASE_MS = '20';
  const mod = await import(`../src/tts/qwen3-tts-supervisor.js?s=${Math.random()}`);
  // getState stays 'needs-runtime' no matter how often startDownload is called —
  // exactly an Intel box, where mlx-audio can never become importable.
  // NOT cache-busted: the supervisor imports this module by its plain path, so the
  // provisioner seam must be set on the SAME instance the supervisor will call.
  const model = await import('../src/tts/qwen3-tts-model.js');
  let installs = 0;
  model.__setProvisioner(async () => { installs++; throw new Error('mlx-audio not importable'); });
  const sup = mod.startQwenTtsSupervisor({
    home: process.cwd(), shouldRun: () => true, tickMs: 20,
    spawn: () => { throw new Error('no spawn'); },
    getState: () => ({ phase: 'needs-runtime', progress: 0, variant: 'Qwen3-TTS-12Hz-1.7B-Base-8bit' }),
    reapOrphan: async () => ({ reaped: false, reason: 'no-holder' }),
  });
  // Sample repeatedly: a single snapshot passes whenever it happens to land inside a
  // backoff window, even while the install is still being retried forever.
  const seen = [];
  for (let i = 0; i < 60; i++) { await sleep(25); seen.push(mod.getQwenTtsHealth().status); }
  const h = mod.getQwenTtsHealth();
  const installsAfterCap = installs;
  await sleep(400);
  sup.stop();
  const installsLater = installs;
  model.__setProvisioner(null);
  delete process.env.MYCELIUM_QWEN_TTS_INSTALL_BASE_MS;
  ok(h.status === 'needs-runtime' && h.detail === 'runtime-missing',
    'S7 ⭐ a runtime that cannot be installed rests at a TERMINAL needs-runtime (was: flapped installing ↔ needs-runtime forever)',
    `status=${h.status} detail=${h.detail}`);
  ok(typeof h.remedy === 'string' && /Apple Silicon/.test(h.remedy), 'S7b it names the real reason (Apple Silicon + mlx-audio)');
  ok(installsLater === installsAfterCap && installs <= 4,
    'S7c ⭐ it actually STOPS attempting (the cap used to be checked inside the backoff window, so it re-attempted forever)',
    `installs=${installs} (unchanged over the last 400ms: ${installsLater === installsAfterCap})`);
  ok(!seen.slice(seen.indexOf('needs-runtime')).includes('installing'),
    'S7d ⭐ once terminal it does not flap back to "installing"',
    `tail=${[...new Set(seen.slice(seen.indexOf('needs-runtime')))].join(',')}`);
}

{
  // S8 — the spawn env must ask the service to load eagerly, or /health can only say
  // "no load attempted yet" until the owner's first render and the supervisor has
  // nothing to report. (Ungated in the first version of this diff.)
  const port = await freePort();
  process.env.MYCELIUM_QWEN_TTS_PORT = String(port);
  const mod = await import(`../src/tts/qwen3-tts-supervisor.js?s=${Math.random()}`);
  let spawnEnv = null, spawnArgv = null;
  const sup = mod.startQwenTtsSupervisor({
    home: process.cwd(), shouldRun: () => true, tickMs: 30,
    spawn: (bin, argv, o) => { spawnArgv = argv; spawnEnv = o?.env; return { pid: 1, stderr: { on: () => {} }, on: () => {}, kill: () => {} }; },
    getState: () => READY_STATE,
    reapOrphan: async () => ({ reaped: false, reason: 'no-holder' }),
  });
  await sleep(150);
  sup.stop();
  ok(spawnEnv?.QWEN_TTS_PRELOAD === '1', 'S8 the voice service is spawned with eager preload so /health can report a real state', `preload=${spawnEnv?.QWEN_TTS_PRELOAD}`);
  ok(!('ENCRYPTION_MASTER_KEY' in (spawnEnv || {})) && !('MYCELIUM_MASTER_KEY' in (spawnEnv || {})),
    'S8b the env allowlist still carries NO key material to the child (§4)');
  ok(Array.isArray(spawnArgv) && spawnArgv[0] === 'pipeline/qwen3-tts-service.py',
    'S8c the orphan-identity argv anchor is unchanged (service-guard relies on it)');
}

{
  // S4 — every status the supervisor can emit must map through the ONE taxonomy,
  // and a terminal one must be classified as such (no surface re-derivation).
  const { serviceState, isRetryable } = await import('../src/system/service-state.js');
  ok(serviceState('down') === 'failed' && isRetryable('down') === true, 'S4 down → failed + retryable');
  ok(serviceState('needs-runtime') === 'degraded' && isRetryable('needs-runtime') === true, 'S4b needs-runtime → degraded + retryable');
  ok(serviceState('starting') === 'loading' && isRetryable('starting') === false, 'S4c starting → loading (never a resting verdict)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// R — the reply tool's voice tri-state, driven through the REAL domain
// ═══════════════════════════════════════════════════════════════════════════════
{
  const { createReplyDomain } = await import('../src/tools/reply.js');
  const sent = [];
  const mkDomain = () => createReplyDomain({
    agentUrl: 'http://127.0.0.1:1',
    fetch: async (url, init) => {
      if (String(url).endsWith('/internal/inbound-context/current')) {
        return { ok: true, status: 200, json: async () => ({ source: 'telegram', channelId: '777', channelKind: 'telegram-dm' }) };
      }
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, delivered: true }) };
    },
  });

  sent.length = 0;
  await mkDomain().handlers.reply({ text: 'hello' });
  ok(sent.length === 1 && !('voice' in sent[0].body),
    'R1 ⭐ agent said nothing about voice → NO `voice` key on the wire, so the chokepoint consults the owner\'s toggle',
    `body keys=${Object.keys(sent[0]?.body || {}).join(',')}`);

  sent.length = 0;
  await mkDomain().handlers.reply({ text: 'hello', voice: false });
  ok(sent.length === 1 && sent[0].body.voice === false,
    'R2 an EXPLICIT voice:false still rides the wire (the agent can suppress one reply)');

  sent.length = 0;
  await mkDomain().handlers.reply({ text: 'hello', voice: true });
  ok(sent.length === 1 && sent[0].body.voice === true, 'R3 an explicit voice:true still forces a spoken reply');
}

{
  // R4 — the render seam surfaces the REAL upstream reason, sanitized.
  const { classifyUpstreamError, sanitizeRenderDetail } = await import('../src/tts/voice-render.js');
  const c = classifyUpstreamError({ error: 'synth-failed: RuntimeError shape mismatch (1, 24000)' }, 500);
  ok(c.error === 'synth-failed',
    'R4 ⭐ an upstream synth-failed is surfaced as `synth-failed`, not collapsed to render-upstream-500', `error=${c.error}`);
  ok(/shape mismatch/.test(c.detail || ''), 'R4b the sanitized detail keeps the diagnostic shape', `detail=${c.detail}`);

  const t = classifyUpstreamError({ error: 'voice-runtime-missing: No module named mlx_audio' }, 503);
  ok(t.error === 'voice-runtime-missing' && t.terminal === true,
    'R4c a terminal runtime-missing is flagged terminal (so no UI can say "try again shortly")');
  const m = classifyUpstreamError({ error: 'model-unavailable: cannot read weights' }, 503);
  ok(m.error === 'model-unavailable' && m.terminal === false, 'R4d a retryable load failure is NOT flagged terminal');

  // §1 — the detail is UNTRUSTED text. A path names the user; a quoted span is the
  // likeliest place an exception echoes the line being spoken (vault plaintext).
  // Each fixture below is a bypass that WORKED against the first version of the
  // sanitizer (found in adversarial review), so each row is a real regression guard.
  const pathy = sanitizeRenderDetail('FileNotFoundError: /Users/someone/Library/Application Support/mycelium/models/qwen3/model.safetensors');
  ok(!/someone|Library|safetensors/.test(pathy), 'R5 ⭐ a realistic absolute path is redacted (§1: it names the user)', pathy);
  const uni = sanitizeRenderDetail('FileNotFoundError: ∕Users∕someone∕Library∕sample.wav');
  ok(!/someone/.test(uni), 'R5b ⭐ a UNICODE path separator cannot smuggle the username past the path rule', uni);
  const quoted = sanitizeRenderDetail("ValueError: could not speak 'my private thought' twice");
  ok(!/my private thought/.test(quoted), 'R5c ⭐ a quoted span is redacted (it can echo the spoken line — vault plaintext)', quoted);
  const unpaired = sanitizeRenderDetail('ValueError: got input: "my private thought lives here');
  ok(!/my private thought/.test(unpaired), 'R5d ⭐ an UNPAIRED quote is treated as an unterminated span, not as safe text', unpaired);
  const curly = sanitizeRenderDetail('ValueError: got “my private thought” here');
  ok(!/my private thought/.test(curly), 'R5e ⭐ curly quotes are folded before redaction', curly);
  const longPrefix = sanitizeRenderDetail(`${'x'.repeat(280)} "my private thought"`);
  ok(!/my private thought/.test(longPrefix), 'R5f ⭐ a long prefix cannot push a quoted span past the truncation point', longPrefix);
  ok(!/A{40}/.test(sanitizeRenderDetail(`boom ${'A'.repeat(60)}`)), 'R5g an opaque blob is redacted');
  ok(sanitizeRenderDetail('y'.repeat(500)).length <= 120, 'R5h the detail is hard-capped');
  const midQuote = sanitizeRenderDetail("RuntimeError: tensor 'ref_audio' shape mismatch (1, 24000)");
  ok(!/ref_audio/.test(midQuote) && /24000/.test(midQuote),
    'R5i ⭐ a quoted span is redacted WITHOUT discarding the diagnostic tail after it (redaction must not cost the diagnosis)', midQuote);

  const unknown = classifyUpstreamError({ error: 'totally-new-upstream-string: whatever' }, 500);
  ok(unknown.error === 'render-upstream-500',
    'R6 an unrecognised upstream token can never become the error code (allowlist, not passthrough)', `error=${unknown.error}`);
}

{
  // R7 — the CHANNEL path, driven for real end-to-end: a stub vault render endpoint
  // returns each honest 503/500, and the REAL qwen provider → REAL tts/index.js →
  // REAL createVoicePipeline must land the SPECIFIC reason code. Before the fix every
  // one of these arrived with an undefined code and collapsed to 'render-failed'.
  // (This used to be a source-grep, which would have stayed green with the cases
  // wired to nothing — flagged in adversarial review.)
  const { createServer } = await import('node:http');
  let mode = 'runtime-missing';
  const RESP = {
    'runtime-missing': [503, { ok: false, error: 'voice-runtime-missing', detail: 'No module named mlx audio' }],
    'model-unavailable': [503, { ok: false, error: 'model-unavailable' }],
    'synth-failed': [500, { ok: false, error: 'synth-failed' }],
    'sample-pending': [501, { ok: false, error: 'voice-sample-pending' }],
  };
  const srv = createServer((req, res) => {
    const [code, body] = RESP[mode];
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const rport = await freePort();
  await new Promise((r) => srv.listen(rport, '127.0.0.1', r));
  try {
    process.env.MYCELIUM_VOICE_RENDER_URL = `http://127.0.0.1:${rport}/api/v1/internal/voice-render`;
    process.env.TTS_PROVIDER = 'qwen';
    process.env.QWEN_TTS_ENABLED = '1';
    const { createVoicePipeline } = await import('../packages/channel-daemon/voice-pipeline.js');
    const pipeline = createVoicePipeline({ sendVoice: async () => {}, logPrefix: 'gate' });
    ok(pipeline.isEnabled() === true, 'R7a the qwen opt-in makes the pipeline enabled (the real isConfigured chain)');
    const expected = {
      'runtime-missing': 'voice-runtime-missing',
      'model-unavailable': 'voice-model-unavailable',
      'synth-failed': 'voice-synth-failed',
      'sample-pending': 'voice-sample-pending',
    };
    for (const [m, code] of Object.entries(expected)) {
      mode = m;
      const v = await pipeline.deliver({ target: '1', text: 'A sentence to speak aloud.' });
      ok(v.voiceSent === 0 && v.code === code,
        `R7 ⭐ upstream ${m} lands as the SPECIFIC code ${code} (was: all of them → 'render-failed')`,
        `code=${v.code}`);
    }
    // …and the OWNER-FACING notice must name a remedy for each, through the real
    // send-handler text builder — a reason with no remedy is the QA6 bar unmet.
    const send = await readFile(new URL('../packages/channel-daemon/egress/send-handler.js', import.meta.url), 'utf8');
    for (const code of Object.values(expected)) {
      const row = new RegExp(`'${code}':\\s*'([^']+)'`).exec(send);
      ok(!!row && /Settings|re-record|record|Apple Silicon|agent page/i.test(row[1]),
        `R8 the ${code} notice names something the owner can DO`, row ? row[1].slice(0, 60) : 'MISSING');
    }
  } finally {
    srv.close();
    delete process.env.MYCELIUM_VOICE_RENDER_URL;
    delete process.env.TTS_PROVIDER;
    delete process.env.QWEN_TTS_ENABLED;
  }
}

{
  // R9 — CONFINEMENT (§1): the cross-process seam must NOT forward `detail` to the
  // keyless channel daemon. The sanitizer's residual (unquoted prose) is bounded by
  // exactly this, so it is asserted, not assumed.
  const ir = await readFile(new URL('../src/internal-router.js', import.meta.url), 'utf8');
  const block = ir.slice(ir.indexOf("router.post('/api/v1/internal/voice-render'"));
  // Bound by the NEXT route, not by the first `});` — that closed
  // renderWithSample({...}) and cut the response line the check is about.
  const nextRoute = block.indexOf('router.', 10);
  const body = nextRoute === -1 ? block : block.slice(0, nextRoute);
  ok(!/\bdetail\b/.test(body),
    'R9 ⭐ the daemon-facing voice-render route returns the token only — `detail` never leaves the owner surface');
}

await rm(root, { recursive: true, force: true });

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
