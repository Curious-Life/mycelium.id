// src/tts/kokoro-supervisor.js — lifecycle owner for the local Kokoro TTS
// service (:8094), modeled on src/embed/supervisor.js. Starts kokoro-service.py
// ONLY once the model is downloaded AND the user has opted in (KOKORO_TTS_ENABLED
// in the secrets table). Ticks so it picks up the model the moment a download
// finishes; adopts an already-running service; restarts on crash with backoff.
//
// SECURITY: the child handles NO key material — it loads the ONNX model and
// synthesizes text passed over loopback. Minimal env allowlist (PATH/HOME +
// model paths). Loopback-only.
import { spawn } from 'node:child_process';
import { kokoroPaths, getModelState, resolveKokoroPython, startDownload } from './kokoro-model.js';

const PORT = Number(process.env.MYCELIUM_KOKORO_PORT) || 8094;
const TICK_MS = 4000;
const MAX_BACKOFF_MS = 30000;

let _instance = null;
let _health = { status: 'idle', message: 'Local TTS not started.' };
export function getKokoroHealth() { return _health; }

// Shared resolver — the supervisor MUST use the same python as the pip-install
// and the import-check (kokoro-model.js), or the service runs under a python
// that lacks the package.
const resolvePython = resolveKokoroPython;

async function probe() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

/**
 * @param {object} opts
 * @param {string} opts.home
 * @param {() => (boolean|Promise<boolean>)} opts.shouldRun  true iff the user opted in (KOKORO_TTS_ENABLED)
 */
export function startKokoroSupervisor({ home = process.cwd(), shouldRun = () => false } = {}) {
  if (_instance) return _instance;
  const python = resolvePython({ home });
  const paths = kokoroPaths();
  let child = null, spawnedByUs = false, failures = 0, nextStartAt = 0, stopped = false, installing = false;

  const env = () => ({
    PATH: process.env.PATH, HOME: process.env.HOME,
    MYCELIUM_KOKORO_PORT: String(PORT),
    KOKORO_MODEL_PATH: paths.onnx,
    KOKORO_VOICES_PATH: paths.voices,
    ...(process.env.MYCELIUM_PYTHON ? { MYCELIUM_PYTHON: process.env.MYCELIUM_PYTHON } : {}),
  });

  async function tick() {
    if (stopped) return;
    let want = false; try { want = await shouldRun(); } catch { want = false; }
    const phase = getModelState().phase;

    if (!want) { // not opted in → stop any child we spawned
      if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } }
      _health = { status: 'idle', message: 'Local TTS off.' };
      return;
    }

    // Model FILES present but the runtime isn't importable (e.g. after an app
    // update reset the bundled python) → AUTO-INSTALL kokoro-onnx, no UI click.
    // startDownload skips the model download since the files already exist. Only
    // for 'needs-runtime'; 'absent' means no model yet — that ~340MB fetch stays a
    // deliberate Download click. (Mirrors the whisper supervisor's auto-install.)
    if (phase === 'needs-runtime' && !installing) {
      installing = true;
      _health = { status: 'installing', message: 'Installing local TTS runtime…' };
      try { await startDownload(); } catch { /* surfaced via model state */ }
      installing = false;
      return; // next tick re-evaluates (should be 'ready')
    }

    if (phase !== 'ready') { // absent / installing / checking / error → wait
      if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } }
      _health = { status: phase === 'absent' ? 'idle' : 'installing', message: phase === 'absent' ? 'Local TTS model not installed.' : 'Preparing local TTS…' };
      return;
    }
    if (child) return;                                   // already running ours
    if (await probe()) { _health = { status: 'ok', message: 'Local TTS ready (adopted).' }; return; } // adopt
    if (Date.now() < nextStartAt) return;                // backoff gate

    _health = { status: 'starting', message: failures ? 'Restarting local TTS…' : 'Starting local TTS…' };
    try {
      child = spawn(python, ['pipeline/kokoro-service.py', '--serve', '--port', String(PORT)], { cwd: home, env: env(), stdio: ['ignore', 'ignore', 'pipe'] });
      spawnedByUs = true;
    } catch (e) {
      _health = { status: 'down', message: 'Could not start local TTS.', detail: String(e?.message || e) };
      failures++; nextStartAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)); return;
    }
    child.on('exit', () => { child = null; spawnedByUs = false; failures++; nextStartAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)); });
    // give it a moment, then confirm health
    setTimeout(async () => { if (await probe()) { failures = 0; _health = { status: 'ok', message: 'Local TTS ready.' }; } }, 4000).unref?.();
  }

  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  tick();
  _instance = {
    stop() { stopped = true; clearInterval(timer); if (child && spawnedByUs) { try { child.kill(); } catch { /* */ } } _instance = null; },
    health: getKokoroHealth,
  };
  return _instance;
}

export default { startKokoroSupervisor, getKokoroHealth };
