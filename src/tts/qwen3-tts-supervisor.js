// src/tts/qwen3-tts-supervisor.js — lifecycle owner for the local Qwen3-TTS
// voice service (:8094), modeled verbatim on src/tts/kokoro-supervisor.js (which
// this replaces). Starts qwen3-tts-service.py ONLY once the model is downloaded
// AND the user has opted in (QWEN_TTS_ENABLED in the secrets table). Ticks so it
// picks up the model the moment a download finishes; adopts an already-running
// service; restarts on crash with backoff.
//
// SECURITY: the child handles NO key material — it loads the MLX model and
// synthesizes text passed over loopback. Minimal env allowlist (PATH/HOME +
// model dir). Loopback-only, zero egress (design §5.5).
//
// ⚠️ MLX is Apple-Silicon-only. On Intel the model never reaches 'ready'
//    (import mlx_audio fails), so this supervisor stays idle by design — the
//    accepted cost of removing Kokoro (design §6).
import { spawn } from 'node:child_process';
import { qwenPaths, getModelState, resolveQwenPython, startDownload } from './qwen3-tts-model.js';
import { looksLikePortConflict, reapOwnOrphanOnPort, createRestartGovernor } from '../system/service-guard.js';

const SERVICE_SCRIPT = 'pipeline/qwen3-tts-service.py'; // the exact argv token we spawn — the orphan-identity anchor

const PORT = Number(process.env.MYCELIUM_QWEN_TTS_PORT) || 8094;
const TICK_MS = 4000;
const MAX_BACKOFF_MS = 30000;
// How long a NON-terminal state ('starting' / 'installing') may persist before the
// supervisor converts it to a terminal 'down' with a reason + remedy. Generous: a
// cold MLX load of a 2.9 GB model plus a pip install has to fit inside it. What it
// forbids is the FOREVER case (D-003 ↻2).
const STARTING_CEILING_MS = Number(process.env.MYCELIUM_QWEN_TTS_START_CEILING_MS) || 300_000;
// Base of the runtime-auto-install backoff. Overridable so verify:voice-readiness can
// drive the real "install keeps failing → terminal" convergence in under a second.
const INSTALL_BASE_MS = Number(process.env.MYCELIUM_QWEN_TTS_INSTALL_BASE_MS) || 1000;

let _instance = null;
let _health = { status: 'idle', message: 'Local voice not started.' };
export function getQwenTtsHealth() { return _health; }

// Shared resolver — the supervisor MUST use the same python as the pip-install
// and the import-check (qwen3-tts-model.js), or the service runs under a python
// that lacks mlx-audio.
const resolvePython = resolveQwenPython;

// ── D-003 ↻2: "starting" must not be a resting state ─────────────────────────
// Every path out of tick() has to leave _health in a state a human can act on.
// Two ways it used to stick at 'starting' forever:
//   1. `if (governor.isHalted()) return;` — the bounded-restart latch returned with
//      _health still reading "Starting local voice…" from the last attempt, so the
//      UI said "starting… try again shortly" for the rest of the session.
//   2. the post-spawn probe only ever wrote SUCCESS; a failed probe left the
//      'starting' message standing with nothing scheduled to correct it.
// And one false GREEN: probe() tested `r.ok` (the HTTP status) while the service
// answers /health 200 even when the model failed to load — so a box where every
// /tts 503'd reported "Local voice ready."
//
// Statuses are the src/system/service-state.js vocabulary so every surface maps
// them through the ONE taxonomy: 'ok' | 'starting' | 'installing' | 'idle' |
// 'needs-runtime' (degraded, retryable-by-install) | 'down' (failed).
const REMEDY = {
  'runtime-missing': 'Local voice needs Apple Silicon with mlx-audio — reinstall the voice runtime in Settings → Voice.',
  'load-failed': 'The voice model could not be loaded — re-download it in Settings → Voice.',
  'port-conflict': 'Another process holds the voice port — quit it, then toggle voice off and on in Settings → Voice.',
  'crash-loop': 'The voice service keeps stopping — toggle voice off and on in Settings → Voice to try again.',
  'stalled-install': 'Setting up local voice stopped making progress — re-download the voice model in Settings → Voice.',
  'spawn-failed': 'The voice service could not be launched — reinstall the voice runtime in Settings → Voice.',
};

/**
 * Probe /health and read the MODEL's own state out of the BODY, not just the HTTP
 * status. Returns { up, status, reason } — `up` means the port answers, `status` is
 * what the service says about its ability to actually render.
 */
async function probe() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { up: false, status: null, reason: null };
    let body = null;
    try { body = await r.json(); } catch { /* older service build — treat as up, state unknown */ }
    // Fail-closed on the vocabulary: an unrecognised/absent status is NOT 'ok'.
    const status = typeof body?.status === 'string' ? body.status : null;
    const reason = typeof body?.reason === 'string' ? body.reason : null;
    return { up: true, status, reason };
  } catch { return { up: false, status: null, reason: null }; }
}

/** Turn a live /health read into the health object every surface renders. */
function healthFromProbe(p, { adopted = false } = {}) {
  if (p.status === 'ok') return { status: 'ok', message: adopted ? 'Local voice ready (adopted).' : 'Local voice ready.' };
  if (p.status === 'needs-runtime') {
    return { status: 'needs-runtime', message: 'Local voice cannot render on this Mac.', detail: 'runtime-missing', remedy: REMEDY['runtime-missing'] };
  }
  if (p.status === 'error') {
    return { status: 'down', message: 'Local voice failed to load its model.', detail: 'load-failed', remedy: REMEDY['load-failed'] };
  }
  if (p.status === 'checking') return { status: 'starting', message: 'Local voice is loading its model…' };
  // Answering, but it did not say what state it is in — honest absence, never 'ok'.
  return { status: 'starting', message: 'Local voice is starting…' };
}

/**
 * @param {object} opts
 * @param {string} opts.home
 * @param {() => (boolean|Promise<boolean>)} opts.shouldRun  true iff the user opted in (QWEN_TTS_ENABLED)
 * @param {number} [opts.tickMs]  test-only override of the tick interval
 * @param {typeof spawn} [opts.spawn]  injectable (tests)
 * @param {typeof reapOwnOrphanOnPort} [opts.reapOrphan]  injectable (tests)
 * @param {typeof getModelState} [opts.getState]  injectable (tests)
 */
export function startQwenTtsSupervisor({ home = process.cwd(), shouldRun = () => false, tickMs = TICK_MS, spawn: spawnImpl = spawn, reapOrphan = reapOwnOrphanOnPort, getState = getModelState } = {}) {
  if (_instance) return _instance;
  const python = resolvePython({ home });
  let child = null, spawnedByUs = false, failures = 0, nextStartAt = 0, stopped = false, installing = false;
  let errBuf = ''; // stderr tail — lets the exit handler classify a bind conflict
  // Bounded restart (service-guard): outcome-based 15s→2min backoff; halts after
  // N straight failures (or a foreign port holder) until the user re-toggles voice.
  const governor = createRestartGovernor();

  // A spawned child died at bind because :8094 is taken. Reap the holder IFF it
  // is provably OUR OWN orphan (service-guard proof); a foreign holder is NEVER
  // killed — the fault is surfaced content-free and attempts halt.
  async function handlePortConflict() {
    let r = null;
    try { r = await reapOrphan({ port: PORT, scriptPath: SERVICE_SCRIPT, ownChildPid: child?.pid ?? null }); }
    catch { r = { reaped: false, reason: 'no-holder' }; }
    if (r?.reaped) {
      nextStartAt = 0; // recovered the port — retry the bind on the next tick
      setHealth({ status: 'starting', message: 'Recovered the port from a stale voice service — restarting…' });
      return;
    }
    if (r?.reason === 'foreign' || r?.reason === 'stuck' || r?.reason === 'kill-failed') {
      governor.halt(`port :${PORT} held by another process`);
      setHealth({ status: 'down', message: 'Local voice cannot start.', detail: `port :${PORT} held by another process${r?.holder?.pid ? ` (pid ${r.holder.pid})` : ''}`, remedy: REMEDY['port-conflict'] });
      return;
    }
    failures++; nextStartAt = Date.now() + governor.recordFailure().delayMs; // holder vanished — normal accounting
  }
  // Backoff for the needs-runtime AUTO-install (adversarial review of #209, LOW-1):
  // without it a persistently-failing `pip install mlx-audio` re-ran EVERY tick —
  // the storm family #206 just fixed on the pull path. Attempt-based, doubling,
  // capped; reset the moment the model reaches 'ready'.
  // After this many straight auto-install attempts the runtime is not "installing",
  // it is absent — MLX cannot be installed on a non-Apple-Silicon box at all.
  const MAX_INSTALL_ATTEMPTS = 3;
  let installAttempts = 0, nextInstallAt = 0;

  // ── The anti-stick deadline (D-003 ↻2) ──────────────────────────────────────
  // A backstop, deliberately independent of every individual failure path: the
  // moment health enters a NON-terminal state we stamp the clock, and if it is
  // still non-terminal STARTING_CEILING_MS later we convert it to a terminal
  // 'down' with a named reason and a remedy. Any future code path that forgets to
  // report a fault therefore degrades into an honest failure instead of an
  // eternal "starting… try again shortly".
  // `_health` is a module singleton that stop() deliberately leaves alone, while this
  // clock is per-instance. So a second supervisor started in the same process while
  // health already read 'starting' would have an UNSTAMPED clock and the deadline
  // would never fire — the guarantee resting on a coincidence. Stamp on construction.
  let startingSince = 0;
  const NON_TERMINAL = new Set(['starting', 'installing']);
  if (NON_TERMINAL.has(_health.status)) startingSince = Date.now();
  // A terminal verdict STANDS. Without this the deadline oscillated: it converted
  // 'starting' → 'down', the next tick saw a non-non-terminal status and wrote
  // 'starting' again, which re-stamped the clock — so the state flapped and a
  // sampled read still caught "starting". A terminal state is only left by a
  // successful probe, a fresh spawn, or the owner toggling voice.
  const isTerminal = (s) => s === 'down' || s === 'needs-runtime';
  function setHealth(h) {
    if (NON_TERMINAL.has(h.status)) {
      if (!NON_TERMINAL.has(_health.status)) startingSince = Date.now();
    } else {
      startingSince = 0;
    }
    _health = h;
  }
  /**
   * Write health WITHOUT undoing a terminal verdict. A terminal state is only left
   * by a measured SUCCESS ('ok'), a fresh spawn, or the owner toggling voice — never
   * by a routine "still not answering" write. Without this the deadline oscillated
   * (down → starting → re-stamped clock → down …), and a sampled read still caught
   * "starting", which is the very symptom being fixed.
   */
  function setHealthNoDowngrade(h) {
    if (isTerminal(_health.status) && h.status !== 'ok' && !isTerminal(h.status)) return;
    setHealth(h);
  }

  /**
   * True iff health was converted to a terminal state because it STALLED.
   *
   * `stalled` is the load-bearing word. A 2.9 GB snapshot download legitimately runs
   * far past any ceiling, so a plain wall-clock deadline turned a HEALTHY download
   * into "Local voice did not come up — needs Apple Silicon" (found in adversarial
   * review: the fix would have traded stuck-starting for stuck-FAILED, with the
   * wrong remedy). So observable PROGRESS re-arms the clock, and only the absence of
   * progress for the whole ceiling is a fault.
   */
  function enforceStartingDeadline() {
    if (!NON_TERMINAL.has(_health.status)) return false;
    if (!startingSince || Date.now() - startingSince < STARTING_CEILING_MS) return false;
    const reason = _health.status === 'installing' ? 'stalled-install' : 'crash-loop';
    setHealth({ status: 'down', message: 'Local voice did not come up.', detail: `${reason}:start-timeout`, remedy: REMEDY[reason] });
    return true;
  }
  /** Re-arm the stall clock whenever the provisioner made measurable progress. */
  let lastProgress = -1;
  function noteProvisionProgress(progress) {
    const p = Number(progress);
    if (!Number.isFinite(p) || p <= lastProgress) return;
    lastProgress = p;
    if (NON_TERMINAL.has(_health.status)) startingSince = Date.now();   // progress ⇒ not stalled
  }

  const modelDir = () => qwenPaths({ home }, getState().variant).dir;
  const env = () => ({
    PATH: process.env.PATH, HOME: process.env.HOME,
    MYCELIUM_QWEN_TTS_PORT: String(PORT),
    QWEN_TTS_MODEL_DIR: modelDir(),
    // PRELOAD (D-003 ↻2): load the model BEFORE binding the port, so by the time
    // /health answers it can say 'ok' or a terminal fault — never sit at "no load
    // attempted yet" until the owner's first render. The bind is late while a cold
    // 2.9 GB model loads; the re-probe loop reports that as honest 'starting' and
    // the deadline stops it from lasting forever.
    QWEN_TTS_PRELOAD: '1',
    ...(process.env.MYCELIUM_PYTHON ? { MYCELIUM_PYTHON: process.env.MYCELIUM_PYTHON } : {}),
  });

  async function tick() {
    if (stopped) return;
    let want = false; try { want = await shouldRun(); } catch { want = false; }
    let st = {}; try { st = getState() || {}; } catch { st = {}; }
    const phase = st.phase;

    if (!want) { // not opted in → stop any child we spawned
      if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } }
      governor.resume(); // toggling voice off (and later on) is the settings-change resume path
      lastProgress = -1; // a fresh setup cycle re-arms the stall clock from scratch
      setHealth({ status: 'idle', message: 'Local voice off.' }); // clears any terminal verdict — this IS the owner's retry
      return;
    }

    // Model FILES present but the MLX runtime isn't importable (e.g. after an app
    // update reset the bundled python) → AUTO-INSTALL mlx-audio, no UI click.
    // startDownload skips the snapshot since the files already exist. Only for
    // 'needs-runtime'; 'absent' means no model yet — that multi-GB fetch stays a
    // deliberate Download click (design §3.10 consent). Mirrors the whisper +
    // Kokoro supervisors' auto-install.
    if (phase === 'ready') installAttempts = 0;   // a landed install resets the backoff
    if (phase === 'needs-runtime' && !installing) {
      // An install that keeps failing is NOT "installing" forever. The cap is checked
      // BEFORE the backoff window (it used to be checked inside it, so once the window
      // expired the code fell straight through and re-attempted anyway — the terminal
      // state never actually stood, and health flapped needs-runtime ↔ installing for
      // the life of the process).
      if (installAttempts >= MAX_INSTALL_ATTEMPTS) {
        setHealth({ status: 'needs-runtime', message: 'Local voice runtime could not be installed.', detail: 'runtime-missing', remedy: REMEDY['runtime-missing'] });
        return;
      }
      if (Date.now() < nextInstallAt) {           // backoff gate — no per-tick pip storm
        setHealth({ status: 'installing', message: 'Local voice runtime install failed — retrying shortly…' });
        return;
      }
      installing = true;
      installAttempts++;
      nextInstallAt = Date.now() + Math.min(MAX_BACKOFF_MS, INSTALL_BASE_MS * 2 ** Math.min(installAttempts, 5));
      setHealth({ status: 'installing', message: 'Installing local voice runtime…' });
      try { await startDownload({ home }); } catch { /* surfaced via model state */ }
      installing = false;
      return; // next tick re-evaluates (should be 'ready')
    }

    if (phase !== 'ready') { // absent / installing / checking / error → wait
      if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } }
      // 'error' is a FAULT, not a setup step — the model provisioner already
      // recorded why. Reporting it as "Preparing local voice…" is exactly the
      // dishonest-transient bug: it read as progress and never resolved.
      if (phase === 'error') {
        setHealth({ status: 'down', message: 'Local voice model is not usable.', detail: 'load-failed', remedy: REMEDY['load-failed'] });
      } else if (phase === 'absent') {
        setHealth({ status: 'idle', message: 'Local voice model not installed.' });
      } else {
        // 'downloading' / 'installing' / 'checking' — a real setup step. Feed the
        // provisioner's own progress in so a moving download is never called stalled.
        setHealthNoDowngrade({ status: 'installing', message: 'Preparing local voice…', progress: st.progress ?? null });
        noteProvisionProgress(st.progress);
        enforceStartingDeadline();
      }
      return;
    }
    // A child of ours is alive: KEEP PROBING. Before this the supervisor returned
    // here unconditionally, so whatever the 4s post-spawn timeout had written stood
    // forever — including 'starting' when that probe failed (D-003 ↻2).
    if (child) {
      const p = await probe();
      if (p.up) {
        if (p.status === 'ok') { failures = 0; governor.recordSuccess(); }
        setHealthNoDowngrade(healthFromProbe(p));
      } else {
        // Listening not yet (a cold MLX load binds late) — honest 'starting', but on
        // the deadline, not forever. A terminal verdict already reached is NOT undone.
        if (!NON_TERMINAL.has(_health.status) && !isTerminal(_health.status)) setHealth({ status: 'starting', message: 'Local voice is starting…' });
        enforceStartingDeadline();
      }
      return;
    }
    { // no child — adopt an already-running service if one answers
      const p = await probe();
      if (p.up) {
        if (p.status === 'ok') governor.recordSuccess();
        setHealthNoDowngrade(healthFromProbe(p, { adopted: true }));
        return;
      }
    }
    if (Date.now() < nextStartAt) {                       // backoff gate
      // Waiting out a backoff is honest 'starting' ONLY while attempts remain; the
      // deadline converts a doomed wait into a terminal fault.
      if (!NON_TERMINAL.has(_health.status) && !isTerminal(_health.status)) setHealth({ status: 'starting', message: 'Restarting local voice…' });
      enforceStartingDeadline();
      return;
    }
    if (governor.isHalted()) {
      // ⚠️ THE STICK (D-003 ↻2). This used to be a bare `return`, leaving _health at
      // "Starting local voice…" for the rest of the session — a permanent state that
      // read as a transient. A halt is TERMINAL until the owner re-toggles voice, so
      // it must say so, with the reason and the remedy.
      const why = governor.haltReason() || 'crash-loop';
      const kind = /port/i.test(why) ? 'port-conflict' : 'crash-loop';
      setHealth({ status: 'down', message: 'Local voice stopped trying.', detail: why.slice(0, 120), remedy: REMEDY[kind] });
      return;
    }

    setHealth({ status: 'starting', message: failures ? 'Restarting local voice…' : 'Starting local voice…' });
    try {
      child = spawnImpl(python, [SERVICE_SCRIPT, '--serve', '--port', String(PORT)], { cwd: home, env: env(), stdio: ['ignore', 'ignore', 'pipe'] });
      spawnedByUs = true;
    } catch (e) {
      // §1: a spawn error can carry the interpreter PATH (which names the user) —
      // record the CLASSIFICATION, never the raw message.
      setHealth({ status: 'down', message: 'Could not start local voice.', detail: 'spawn-failed', remedy: REMEDY['spawn-failed'] });
      failures++; nextStartAt = Date.now() + governor.recordFailure().delayMs; return;
    }
    errBuf = '';
    child.stderr?.on?.('data', (d) => { errBuf = (errBuf + d.toString()).slice(-4096); });
    child.on('exit', () => {
      child = null; spawnedByUs = false;
      if (stopped) return;
      // Died at bind (port taken) → the orphan/foreign path, not crash accounting.
      if (looksLikePortConflict(errBuf)) { void handlePortConflict(); return; }
      failures++;
      const f = governor.recordFailure();
      nextStartAt = Date.now() + f.delayMs;
      // Say it DIED. Leaving 'starting' standing here is how a crash-loop read as
      // "still coming up" for as long as the app ran.
      if (f.halted) setHealth({ status: 'down', message: 'Local voice stopped trying.', detail: governor.haltReason() || 'crash-loop', remedy: REMEDY['crash-loop'] });
      else setHealth({ status: 'starting', message: 'Local voice stopped — restarting shortly…' });
    });
    // give it a moment, then confirm health — and report the FAILURE too, not only
    // the success (the old version wrote nothing on a failed probe).
    setTimeout(async () => {
      if (stopped || !child) return;
      const p = await probe();
      if (p.up && p.status === 'ok') { failures = 0; governor.recordSuccess(); }
      if (p.up) setHealthNoDowngrade(healthFromProbe(p));
      else enforceStartingDeadline();
    }, 4000).unref?.();
  }

  const timer = setInterval(tick, tickMs);
  timer.unref?.();
  tick();
  _instance = {
    stop() { stopped = true; clearInterval(timer); if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } } _instance = null; },
    health: getQwenTtsHealth,
  };
  return _instance;
}

export default { startQwenTtsSupervisor, getQwenTtsHealth };
