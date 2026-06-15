// src/transcribe/supervisor.js — ONE owner for the local transcription service
// (pipeline/transcribe-service.py, :8093) lifecycle. Faithful clone of the
// embed supervisor (src/embed/supervisor.js) for the dedicated Whisper STT
// path (docs/WHISPER-TRANSCRIPTION-DESIGN-2026-06-11.md).
//
// OPT-IN BY DESIGN: unlike the embedder (always required), the Whisper service
// only runs once the user picked a transcription model (users.settings
// .transcribeModel, set by POST /portal/transcription/download). Until then
// ensureTranscribeSupervisor() is a no-op and voice notes ride the existing
// audio-capable-LLM fallback in src/enrich/transcribe-audio.js.
//
// SECURITY: the child handles NO key material — it receives WAV bytes over
// loopback and returns text. Env is the same minimal allowlist as the
// embedder (PATH/HOME/HF_*) plus the chosen model tag.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_PORT = Number(process.env.MYCELIUM_TRANSCRIBE_PORT) || 8093;
const PROBE_TIMEOUT_MS = 2500;
const TICK_MS = 3000;
const DEPS_RETRY_MS = 15000;
const MAX_BACKOFF_MS = 30000;
const DOWN_AFTER = 5;

let _health = { status: 'unknown', message: 'Transcription not set up.', detail: null, model: null, progress: null };
let _instance = null;
let _port = DEFAULT_PORT;

/**
 * Current transcriber health. Status:
 *   'ok'           — Whisper model present; ready to transcribe
 *   'downloading'  — model download in progress (detail-free; progress.pct)
 *   'loading'      — model loading into memory
 *   'no_model'     — service up, no model chosen/downloaded yet
 *   'starting'     — process (re)starting; transient
 *   'error'        — service up but model load/download failed (detail = reason)
 *   'deps_missing' — Python lacks faster-whisper (actionable)
 *   'down'         — keeps crashing (detail = last stderr line)
 *   'unknown'      — supervisor not started (user hasn't opted in)
 */
export function getTranscriberHealth() { return { ..._health }; }

/** Loopback base URL for the service (used by transcribe-audio + portal). */
export function transcribeServiceUrl() { return `http://127.0.0.1:${_port}`; }

function resolvePython({ home, pythonBin }) {
  if (pythonBin) return pythonBin;
  if (process.env.MYCELIUM_PYTHON) return process.env.MYCELIUM_PYTHON;
  const venv = join(home, 'pipeline/.venv/bin/python3');
  if (existsSync(venv)) return venv;
  return 'python3';
}

/**
 * Start (or adopt) and supervise the transcription service. Idempotent.
 * Call only when the user has opted in (a transcribeModel is configured) —
 * portal-transcription.js owns that gate.
 *
 * @param {object} [opts]
 * @param {string} [opts.home=process.cwd()]
 * @param {string} [opts.pythonBin]
 * @param {number} [opts.port=8093]
 * @param {string} [opts.model]  chosen whisper model tag (env for the child)
 * @param {(m:string)=>void} [opts.log]
 * @param {typeof fetch} [opts.fetch]  injectable (tests)
 */
export function startTranscribeSupervisor({
  home = process.cwd(),
  pythonBin,
  port = DEFAULT_PORT,
  model = null,
  log = (m) => process.stderr.write(`${m}\n`),
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (_instance) return _instance;
  _port = port;

  const python = resolvePython({ home, pythonBin });

  let child = null;
  let spawnedByUs = false;
  let failures = 0;
  let nextStartAt = 0;
  let stopped = false;
  let errBuf = '';
  let tickTimer = null;
  let chosenModel = model;

  const setHealth = (status, message, detail = null, extra = {}) => {
    _health = { status, message, detail, model: chosenModel, progress: null, ...extra };
  };
  const lastErrLine = () => errBuf.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

  const childEnv = () => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.HF_HOME ? { HF_HOME: process.env.HF_HOME } : {}),
    ...(process.env.HF_HUB_OFFLINE ? { HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE } : {}),
    ...(chosenModel ? { MYCELIUM_WHISPER_MODEL: chosenModel } : {}),
  });

  async function probe() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      let h;
      try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
        if (!res?.ok) return false;
        h = await res.json();
      } finally {
        clearTimeout(timer);
      }
      failures = 0;
      const extra = h?.progress ? { progress: h.progress } : {};
      if (h?.model) chosenModel = h.model;
      if (h?.status === 'deps_missing') {
        setHealth('deps_missing', 'Transcription needs setup — run: pipeline/.venv/bin/pip install -r pipeline/requirements-transcribe.txt', `python: ${python}`);
      } else if (h?.status === 'error') {
        setHealth('error', 'The transcription model failed.', h?.error || null);
      } else if (h?.status === 'downloading') {
        setHealth('downloading', 'Downloading the transcription model…', null, extra);
      } else if (h?.status === 'loading') {
        setHealth('loading', 'Loading the transcription model…');
      } else if (h?.status === 'no_model') {
        setHealth('no_model', 'No transcription model downloaded yet.');
      } else {
        setHealth('ok', 'Voice transcription ready.');
      }
      return true;
    } catch {
      return false;
    }
  }

  function checkDeps() {
    return new Promise((resolve) => {
      let p;
      try {
        p = spawn(python, ['-c', 'import faster_whisper, scipy, numpy'], { stdio: 'ignore' });
      } catch { return resolve(false); }
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  }

  function backoff() { nextStartAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)); }

  async function tryStart() {
    if (stopped || child || Date.now() < nextStartAt) return;

    if (!(await checkDeps())) {
      setHealth('deps_missing', 'Transcription needs setup — run: pipeline/.venv/bin/pip install -r pipeline/requirements-transcribe.txt', `python: ${python}`);
      nextStartAt = Date.now() + DEPS_RETRY_MS;
      return;
    }

    setHealth('starting', failures ? 'Restarting the transcription engine…' : 'Starting the transcription engine…');
    try {
      child = spawn(python, ['pipeline/transcribe-service.py', '--serve', '--port', String(port)], {
        cwd: home, env: childEnv(), stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      setHealth('down', 'Could not start the transcription engine.', String(e?.message || e));
      failures++; backoff(); return;
    }
    spawnedByUs = true; errBuf = '';
    child.stderr?.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-4096); });
    child.on('error', () => { /* surfaced via exit/last stderr */ });
    child.on('exit', (code) => {
      const wasOurs = child;
      child = null;
      if (stopped || !wasOurs) return;
      failures++;
      const tail = lastErrLine();
      if (failures >= DOWN_AFTER) {
        setHealth('down', 'The transcription engine keeps stopping.', tail || `exited code ${code}`);
      } else {
        setHealth('starting', 'Restarting the transcription engine…', tail || `exited code ${code}`);
      }
      backoff();
      log(`[transcribe-supervisor] service exited (code ${code}) — restart #${failures} scheduled${tail ? `: ${tail}` : ''}`);
    });
  }

  async function tick() {
    if (stopped) return;
    if (await probe()) return;
    if (child) return;
    await tryStart();
  }

  tickTimer = setInterval(() => { void tick(); }, TICK_MS);
  if (tickTimer.unref) tickTimer.unref();
  void tick();

  _instance = {
    getHealth: getTranscriberHealth,
    url: transcribeServiceUrl,
    setModel: (m) => { chosenModel = m || chosenModel; },
    nudge: () => { nextStartAt = 0; void tick(); },
    stop: () => {
      stopped = true;
      if (tickTimer) clearInterval(tickTimer);
      if (child && spawnedByUs) { try { child.kill('SIGTERM'); } catch { /* noop */ } }
      child = null;
      _instance = null;
    },
  };
  return _instance;
}

/** The opt-in gate: start only when a model is configured. Returns instance or null. */
export function ensureTranscribeSupervisor({ model, ...opts } = {}) {
  if (_instance) { if (model) _instance.setModel(model); return _instance; }
  if (!model) return null; // user hasn't opted in — no idle python process
  return startTranscribeSupervisor({ model, ...opts });
}

// Test seam.
export function _resetTranscribeSupervisor() {
  if (_instance) { try { _instance.stop(); } catch { /* */ } }
  _instance = null;
  _health = { status: 'unknown', message: 'Transcription not set up.', detail: null, model: null, progress: null };
}

export default startTranscribeSupervisor;
