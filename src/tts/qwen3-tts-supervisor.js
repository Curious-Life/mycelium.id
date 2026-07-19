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

let _instance = null;
let _health = { status: 'idle', message: 'Local voice not started.' };
export function getQwenTtsHealth() { return _health; }

// Shared resolver — the supervisor MUST use the same python as the pip-install
// and the import-check (qwen3-tts-model.js), or the service runs under a python
// that lacks mlx-audio.
const resolvePython = resolveQwenPython;

async function probe() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
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
      _health = { status: 'starting', message: 'Recovered the port from a stale voice service — restarting…' };
      return;
    }
    if (r?.reason === 'foreign' || r?.reason === 'stuck' || r?.reason === 'kill-failed') {
      governor.halt(`port :${PORT} held by another process`);
      _health = { status: 'down', message: 'Local voice cannot start.', detail: `port :${PORT} held by another process${r?.holder?.pid ? ` (pid ${r.holder.pid})` : ''}` };
      return;
    }
    failures++; nextStartAt = Date.now() + governor.recordFailure().delayMs; // holder vanished — normal accounting
  }
  // Backoff for the needs-runtime AUTO-install (adversarial review of #209, LOW-1):
  // without it a persistently-failing `pip install mlx-audio` re-ran EVERY tick —
  // the storm family #206 just fixed on the pull path. Attempt-based, doubling,
  // capped; reset the moment the model reaches 'ready'.
  let installAttempts = 0, nextInstallAt = 0;

  const modelDir = () => qwenPaths({ home }, getState().variant).dir;
  const env = () => ({
    PATH: process.env.PATH, HOME: process.env.HOME,
    MYCELIUM_QWEN_TTS_PORT: String(PORT),
    QWEN_TTS_MODEL_DIR: modelDir(),
    ...(process.env.MYCELIUM_PYTHON ? { MYCELIUM_PYTHON: process.env.MYCELIUM_PYTHON } : {}),
  });

  async function tick() {
    if (stopped) return;
    let want = false; try { want = await shouldRun(); } catch { want = false; }
    const phase = getState().phase;

    if (!want) { // not opted in → stop any child we spawned
      if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } }
      governor.resume(); // toggling voice off (and later on) is the settings-change resume path
      _health = { status: 'idle', message: 'Local voice off.' };
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
      if (Date.now() < nextInstallAt) {           // backoff gate — no per-tick pip storm
        _health = { status: 'installing', message: 'Local voice runtime install failed — retrying shortly…' };
        return;
      }
      installing = true;
      installAttempts++;
      nextInstallAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(installAttempts, 5));
      _health = { status: 'installing', message: 'Installing local voice runtime…' };
      try { await startDownload({ home }); } catch { /* surfaced via model state */ }
      installing = false;
      return; // next tick re-evaluates (should be 'ready')
    }

    if (phase !== 'ready') { // absent / installing / checking / error → wait
      if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } }
      _health = { status: phase === 'absent' ? 'idle' : 'installing', message: phase === 'absent' ? 'Local voice model not installed.' : 'Preparing local voice…' };
      return;
    }
    if (child) return;                                   // already running ours
    if (await probe()) { governor.recordSuccess(); _health = { status: 'ok', message: 'Local voice ready (adopted).' }; return; } // adopt
    if (Date.now() < nextStartAt) return;                // backoff gate
    if (governor.isHalted()) return;                     // bounded: halted until the voice toggle re-arms it

    _health = { status: 'starting', message: failures ? 'Restarting local voice…' : 'Starting local voice…' };
    try {
      child = spawnImpl(python, [SERVICE_SCRIPT, '--serve', '--port', String(PORT)], { cwd: home, env: env(), stdio: ['ignore', 'ignore', 'pipe'] });
      spawnedByUs = true;
    } catch (e) {
      _health = { status: 'down', message: 'Could not start local voice.', detail: String(e?.message || e) };
      failures++; nextStartAt = Date.now() + governor.recordFailure().delayMs; return;
    }
    errBuf = '';
    child.stderr?.on?.('data', (d) => { errBuf = (errBuf + d.toString()).slice(-4096); });
    child.on('exit', () => {
      child = null; spawnedByUs = false;
      if (stopped) return;
      // Died at bind (port taken) → the orphan/foreign path, not crash accounting.
      if (looksLikePortConflict(errBuf)) { void handlePortConflict(); return; }
      failures++; nextStartAt = Date.now() + governor.recordFailure().delayMs;
    });
    // give it a moment, then confirm health
    setTimeout(async () => { if (await probe()) { failures = 0; governor.recordSuccess(); _health = { status: 'ok', message: 'Local voice ready.' }; } }, 4000).unref?.();
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
