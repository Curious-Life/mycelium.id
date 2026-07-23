// src/hardware/ollama-daemon.js — lazily start a local `ollama serve` daemon so
// "Pull & use" works even when Ollama is installed but not running.
//
// WHY a separate module from ollama.js: ollama.js is the HTTP *client* (it never
// shells out, by design). STARTING the daemon is a distinct concern with its own
// security surface, kept here. This mirrors src/embed/supervisor.js (adopt-or-
// spawn a local engine) but is LAZY — there is no boot tick-loop; `ensureUp()`
// is called on demand (on a Pull & use click).
//
// SECURITY (CLAUDE.md §2/§4/§6):
//   • Fixed args `['serve']` — no shell, no interpolation, no request input.
//   • The binary path comes from a FIXED absolute allowlist (+ PATH dirs), never
//     from a request body or the model catalog.
//   • Env is an allowlist (PATH, HOME, OLLAMA_*) — NO master key, NO secrets.
//   • We spawn when the daemon is down, and kill ONLY a daemon we started
//     (`spawnedByUs`) — we can never take down a user's own Ollama (adopt path).
//   • SELF-HEAL (never evict): if a too-OLD daemon squats the default :11434 we do NOT kill it —
//     we spawn OUR runtime on a fresh LOOPBACK-ONLY alt port and steer every consumer there via
//     getBaseUrl() + a published process.env.OLLAMA_URL. The alt port is still on-box (127.0.0.1),
//     so §4g locality is preserved. See selfHealOnAltPort().
//   • Fail-closed: binary absent → do nothing, report `not_installed`.
//
// THE PATH PROBLEM: a Finder-launched macOS .app inherits launchd's minimal PATH
// (no Homebrew dirs), and the Tauri→Node command only prepends home/python
// (src-tauri/src/main.rs). So we must probe ABSOLUTE candidate paths, not rely
// on PATH resolving `ollama`.

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { existsSync as nodeExistsSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findExecutable, homeDir } from '../system/platform-env.js';
import { createOllamaClient } from './ollama.js';
import { installOllama, extractedBinPath, OLLAMA_VERSION } from './ollama-install.js';

const execFileP = promisify(nodeExecFile);

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

// ── Runtime-version gate (N1: FS2-A) ─────────────────────────────────────────
// The MINIMUM Ollama the recommended catalog needs. The on-box default (qwen3.5:4b — the
// labeling/enrich pick, endorsedLocalModels()) uses Gated-DeltaNet attention, added in Ollama
// 0.17.4; an OLDER host (e.g. Homebrew 0.12.9) makes the registry 412-REFUSE the manifest and
// every pull fails with a misleading "check your network". The pinned download we ship
// (ollama-install.js OLLAMA_VERSION, v0.30.5) is well above this floor. The floor is the
// DEFAULT model's documented need, not the pin — a host in [0.17.4, pin) can still run the
// default, so gating at the pin would needlessly refuse a capable runtime and force our own
// download. A browse-catalog model that needs newer than the HOST (e.g. qwen3.6 — see N4) is
// caught downstream by the terminal `incompatible-runtime` pull fault (ollama.js), not here.
// Bump this only when the DEFAULT/recommended model's floor rises.
export const OLLAMA_MIN_VERSION = '0.17.4';

/** Parse "0.30.5" / "v0.30.5" / "ollama version is 0.12.9" → [maj,min,patch], or null. */
export function parseOllamaVersion(s) {
  const m = String(s ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Semver-triple ≥ comparison. Accepts triples or version STRINGS. An UNPARSEABLE input → false
 * — but callers decide what "can't tell" means: the adopt path treats null as "unknown → adopt"
 * (fail-open, so a future --version format never bricks a running daemon), while the spawn path
 * only SWITCHES to the pinned binary when the host is PROVABLY too old.
 */
export function versionGte(a, b) {
  const pa = Array.isArray(a) ? a : parseOllamaVersion(a);
  const pb = Array.isArray(b) ? b : parseOllamaVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) { if (pa[i] > pb[i]) return true; if (pa[i] < pb[i]) return false; }
  return true;
}

// Absolute install locations we trust, in priority order. (Homebrew on Apple
// Silicon + Intel, the official Ollama.app, and a common user-local dir.)
const ABSOLUTE_CANDIDATES = [
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama',
];

/**
 * Locate the `ollama` binary by checking absolute candidates, then each PATH dir.
 * The binary path is still confined to a FIXED candidate allowlist + PATH — never
 * request input (CLAUDE.md §4). @see findExecutable.
 * @param {object} [deps]
 * @param {(p:string)=>boolean} [deps.existsSync]
 * @param {object} [deps.env]
 * @param {string} [deps.platform]
 * @returns {string|null} absolute path, or null if not found
 */
export function findOllamaBinary({ existsSync = nodeExistsSync, env = process.env, platform = process.platform } = {}) {
  if (env.MYCELIUM_OLLAMA && existsSync(env.MYCELIUM_OLLAMA)) return env.MYCELIUM_OLLAMA;
  const home = homeDir({ env, platform });
  const candidates = platform === 'win32'
    ? [env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe` : null, 'C:\\Program Files\\Ollama\\ollama.exe', 'ollama']
    : [...ABSOLUTE_CANDIDATES, home ? `${home}/.local/bin/ollama` : null, 'ollama'];
  return findExecutable(candidates.filter(Boolean), { env, platform, isExecutable: existsSync });
}

// Only what the daemon needs — never the master key or any vault secret.
//
// Proxy vars ARE forwarded (R2-QWENPULL): `ollama serve` reaches the model registry over the
// network, and on a corporate/VPN box the ONLY route out is the configured proxy. Without these,
// the spawned daemon dials the registry directly, the connection is dropped, and every pull fails
// with no hint why. Go reads both upper- and lower-case forms, so we forward both. These are
// endpoint/allow-list hints, never secrets (a proxy URL may carry credentials, but it is the
// user's own already-exported env — we neither read nor log its value).
function allowlistEnv(env) {
  const out = {};
  const KEYS = [
    'PATH', 'HOME', 'OLLAMA_HOST', 'OLLAMA_MODELS',
    // Resident-model / concurrency caps: forwarded so a user's EXPLICIT setting flows through and
    // wins over our default (applied in spawnServe only when absent). See OLLAMA_SPAWN_CAPS.
    'OLLAMA_MAX_LOADED_MODELS', 'OLLAMA_NUM_PARALLEL', 'OLLAMA_KEEP_ALIVE',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'https_proxy', 'http_proxy', 'no_proxy',
  ];
  for (const k of KEYS) {
    if (env[k]) out[k] = env[k];
  }
  return out;
}

// ── RAM-crash caps for a daemon WE spawn (P0) ────────────────────────────────
// With four resident local engines and NO global concurrency coordinator (embed-service :8091,
// Ollama, Whisper STT, Qwen-TTS), an UNBOUNDED `ollama serve` is the biggest RAM-spike lever: it
// will keep 2–3 distinct models resident at once (the L1 labeling model, the L2 enrich model, and a
// chat/agent model can all differ) AND serve requests in parallel. The drainer's own stages are
// sequential within a 15s cycle, but chat/agent turns hit Ollama independently (src/agent/run-turn.js,
// src/inference/router.js) — so a chat turn colliding with a drain pass, or an L1↔L2 model swap, can
// load a second/third model and explode RAM into an OOM crash (observed on the operator's box).
//
// Pinning ONE resident model + ONE in-flight request converts that collision from a crash into
// bounded model-SWAP LATENCY (Ollama evicts/reloads instead of co-residing), and a short KEEP_ALIVE
// stops an idle model from squatting RAM indefinitely. This is the safe, well-understood Phase-1
// lever; a global local-inference gate / chat-preempts-drain scheduler is the held Phase-2 work
// (see docs/PIPELINE-COMPUTE-REVIEW-2026-07-21.md).
//
// APPLIED ONLY to daemons we START (spawnServe — the spawn + alt-port self-heal paths), NEVER to an
// adopted user daemon (start() returns before spawnServe on adopt), and ONLY when the user has not
// set the var themselves — an explicit OLLAMA_* is forwarded by allowlistEnv and left untouched.
export const OLLAMA_SPAWN_CAPS = {
  OLLAMA_MAX_LOADED_MODELS: '1',
  OLLAMA_NUM_PARALLEL: '1',
  OLLAMA_KEEP_ALIVE: '5m',
};

// Scrub credential-bearing substrings from the daemon's stderr tail BEFORE it is
// returned to the localhost portal (as `detail`) or logged. Low severity — the
// only surface is loopback-only, single-user V1 — but §1 ("if in doubt, don't
// log it") and §4 (master-key/secret discipline) say don't ship secrets we don't
// need. The live vector: we now forward proxy env to `ollama serve` (R2-QWENPULL),
// so a corporate proxy URL with embedded credentials (http://user:pass@proxy) can
// appear in a connection error on stderr. We redact:
//   • URL userinfo — `scheme://user:pass@host` → `scheme://<redacted>@host`
//     (the proxy-credential case; the host stays, it's useful diagnostics).
//   • generic secret-looking tokens (JWT / Bearer / sk- / ghp_ / xox*- / long hex),
//     mirroring crypto/guardians/scrubbers.js SECRET_PATTERNS as defence in depth.
// The userinfo class is `[^\s/?#]*` — greedy to the LAST `@` before a path/query/
// fragment boundary — so a password containing `@` still redacts fully (an earlier
// `[^/@\s]+` stopped at the FIRST `@` and leaked the tail; independent review). It
// still won't cross whitespace (multiple URLs on a line each redact independently)
// and won't touch a legit `@` in a PATH (`https://h/p@2x.png` — the `/` bounds it).
// Residual (documented, not covered): a raw UNENCODED `/` inside userinfo — but
// that is RFC-3986-invalid and Go percent-encodes/rejects it, so a working proxy
// URL can't emit it; and non-URL credential forms (`--proxy-user u:p`, a base64
// `Proxy-Authorization`) are out of scope — the token patterns below are the only
// backstop for those.
const SECRET_PATTERNS = [
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi,                      // URL userinfo (user:pass@)
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,                        // bearer tokens
  /\bsk-[A-Za-z0-9_-]{12,}/g,                                    // OpenAI-style keys
  /\bghp_[A-Za-z0-9]{20,}/g,                                     // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,                             // Slack tokens
  /\b[0-9a-fA-F]{32,}\b/g,                                       // hex keys (master key = 64 hex)
];

/** Redact credential-bearing substrings from a daemon stderr string. */
export function redactDaemonDetail(s) {
  let out = String(s);
  for (const re of SECRET_PATTERNS) {
    out = re.source.includes('@') ? out.replace(re, '$1<redacted>@') : out.replace(re, '[redacted]');
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Best-effort daemon version via GET /api/version → parsed triple, or null (unreachable/old). */
async function defaultDaemonVersion(baseUrl, fetchImpl) {
  try {
    const base = String(baseUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(2000) : undefined;
    const r = await fetchImpl(`${base}/api/version`, { signal });
    if (!r?.ok) return null;
    const data = await r.json();
    return parseOllamaVersion(data?.version);
  } catch { return null; }
}

/** Best-effort binary version via `<bin> --version` → parsed triple, or null. */
async function defaultBinaryVersion(bin) {
  try {
    const { stdout, stderr } = await execFileP(bin, ['--version'], { timeout: 4000 });
    return parseOllamaVersion(`${stdout || ''} ${stderr || ''}`);
  } catch (e) {
    // `ollama --version` exits non-zero when it can't reach a running server, but STILL prints the
    // client version to stdout; execFile rejects with that output attached. Salvage it before null.
    return parseOllamaVersion(`${e?.stdout || ''} ${e?.stderr || ''}`);
  }
}

/** Host:port from an ollama base URL (e.g. "http://127.0.0.1:11435" → "127.0.0.1:11435"), or null. */
function hostFromBase(base) {
  try { return new URL(String(base)).host || null; } catch { return null; }
}

/**
 * First FREE loopback TCP port at or above `start` (scans up to `start + range`), or null.
 * Used only for the alt-port SELF-HEAL: when a too-old daemon squats the default :11434 we can
 * neither adopt nor evict it (§4/§6 — never kill a daemon we didn't start), so we bind OUR runtime
 * to a fresh loopback port instead. Binds 127.0.0.1 ONLY (never 0.0.0.0) — the healed daemon stays
 * on-box, exactly like the default. Injectable for tests.
 */
function defaultFreePort(start, { host = '127.0.0.1', range = 64 } = {}) {
  return new Promise((resolve) => {
    let port = start;
    const attempt = () => {
      if (port > start + range) return resolve(null);
      const srv = net.createServer();
      srv.once('error', () => { srv.close(() => { port += 1; attempt(); }); });
      srv.once('listening', () => { const p = srv.address()?.port ?? port; srv.close(() => resolve(p)); });
      srv.listen(port, host);
    };
    attempt();
  });
}

/**
 * Create a lazy adopt-or-spawn controller for the local Ollama daemon.
 * @param {object} [deps]
 * @param {string}   [deps.baseUrl]          ollama base (default loopback :11434)
 * @param {typeof fetch} [deps.fetch]        injectable (tests)
 * @param {()=>Promise<boolean>} [deps.isUp] override the up-probe (tests)
 * @param {()=>(string|null)} [deps.findBinary]
 * @param {Function} [deps.spawn]            child_process.spawn (injectable)
 * @param {object}   [deps.env]
 * @param {(m:string)=>void} [deps.log]
 * @param {number}   [deps.startTimeoutMs=15000]
 * @param {number}   [deps.pollMs=400]
 * @param {string}   [deps.minVersion]        min Ollama version to adopt/spawn (default OLLAMA_MIN_VERSION)
 * @param {(baseUrl?:string, fetch?:Function)=>Promise<number[]|null>} [deps.daemonVersion] /api/version probe
 * @param {(opts:object)=>(string|null)} [deps.findHostBinary] host/PATH binary locator
 * @param {(bin:string)=>Promise<number[]|null>} [deps.binaryVersion] `<bin> --version` probe
 * @returns {{ ensureUp:Function, isInstalled:Function, stop:Function, getBaseUrl:Function, health:Function }}
 */
export function createOllamaDaemon({
  baseUrl,
  fetch = globalThis.fetch,
  isUp,
  dataDir,
  autoInstall = true,
  install = installOllama,
  findBinary,
  spawn = nodeSpawn,
  env = process.env,
  log = () => {},
  startTimeoutMs = 15000,
  pollMs = 400,
  // N1 version-gate deps (all injectable for tests):
  minVersion = OLLAMA_MIN_VERSION,
  daemonVersion = (bu, f) => defaultDaemonVersion(bu, f),  // GET /api/version → triple|null
  findHostBinary = findOllamaBinary,                       // system/PATH host binary (may be old)
  binaryVersion = defaultBinaryVersion,                    // `<bin> --version` → triple|null
  // Alt-port self-heal deps (injectable for tests):
  altPortStart = 11435,                                    // first candidate loopback port for a healed daemon
  findFreePort = defaultFreePort,                          // free-loopback-port scanner
} = {}) {
  // The base every consumer should DIAL. Starts at the configured/default :11434 and MOVES to a
  // fresh loopback port after an alt-port self-heal (see start()). getBaseUrl() exposes it, and a
  // heal also publishes it as process.env.OLLAMA_URL so env-reading consumers (inference/router.js,
  // local.js, createOllamaClient's default) follow without a wiring change.
  let effectiveBaseUrl = baseUrl || DEFAULT_OLLAMA_URL;
  const probeUp = isUp || (() => createOllamaClient({ baseUrl: effectiveBaseUrl, fetch }).isUp());
  // Adopt a SYSTEM install first; fall back to a copy we downloaded into dataDir. (SYNC — used by
  // isInstalled(), which asks only "is a binary present at all", not "is it new enough".)
  const resolveBinary = findBinary || (() => findHostBinary({ env }) || (dataDir ? extractedBinPath(dataDir) : null));

  // Version-AWARE binary choice for the SPAWN path: prefer a host binary, but if it is provably too
  // OLD for the catalog, prefer the pinned/extracted one instead (null → the auto-install rung
  // downloads the pinned OLLAMA_VERSION). The `findBinary` override (tests / explicit) is honored
  // verbatim — it fully replaces host-vs-pinned resolution, so it is never version-gated. An
  // explicit MYCELIUM_OLLAMA is likewise an escape hatch: used as-is, never second-guessed.
  async function chooseBinary() {
    if (findBinary) return findBinary();
    const host = findHostBinary({ env });
    const pinned = dataDir ? extractedBinPath(dataDir) : null;
    if (!host) return pinned;
    if (env.MYCELIUM_OLLAMA && host === env.MYCELIUM_OLLAMA) return host;   // explicit user choice wins
    const hv = await binaryVersion(host);
    if (hv && !versionGte(hv, minVersion)) {
      // Host is provably too old → do NOT spawn it. Prefer pinned (null ⇒ auto-install downloads it).
      log(`[ollama-daemon] host ollama ${hv.join('.')} < ${minVersion} — preferring the pinned runtime (${OLLAMA_VERSION})`);
      return pinned;
    }
    return host;  // new enough, or version unknown (fail-open: don't refuse a runtime we can't read)
  }

  let child = null;
  let spawnedByUs = false;
  let errBuf = '';
  let inflight = null;        // single-flight: start()
  let installInflight = null; // single-flight: download
  // The LAST outcome start() produced, kept ONLY so health() can name the reason a
  // bring-up failed ('not_installed' / 'start_timeout' / 'spawn_failed' / …). It is
  // never consulted by start() itself and never short-circuits a probe — health()
  // always RE-PROBES first, so a stale reason can never outvote a daemon that is
  // actually answering (the "never claim a retry succeeded when it didn't", and its
  // mirror: never claim it failed when it did come up).
  let lastResult = null;

  function isInstalled() {
    return resolveBinary() !== null;
  }

  /** Download+verify+extract the Ollama runtime (single-flight). */
  function provision(onProgress) {
    if (installInflight) return installInflight;
    if (!dataDir) return Promise.resolve({ ok: false, reason: 'unsupported_platform' });
    installInflight = install({ dataDir, onProgress, log }).finally(() => { installInflight = null; });
    return installInflight;
  }

  /**
   * Spawn `ollama serve` (non-detached → reaped with our process group on app exit; fixed args;
   * allowlisted env; stderr captured for diagnostics), then poll `probe` until it binds or we time
   * out. Models live app-private under dataDir, not the user's ~/.ollama. `bindHost` (when given)
   * sets OLLAMA_HOST so the daemon binds a specific loopback host:port — used by the alt-port
   * self-heal; null keeps ollama's default :11434. Sets `child`/`spawnedByUs`; spawn() may throw
   * (caller catches). Returns true once the daemon answers, false on timeout.
   */
  async function spawnServe(bin, bindHost, probe) {
    errBuf = '';
    const spawnEnv = allowlistEnv(env);
    if (dataDir) spawnEnv.OLLAMA_MODELS = join(dataDir, 'ollama', 'models');
    if (bindHost) spawnEnv.OLLAMA_HOST = bindHost;   // loopback-only host:port (alt-port heal)
    // RAM-crash caps (P0): our safe default UNLESS the user set one explicitly (allowlistEnv already
    // forwarded any explicit value, so only fill the gaps — never clobber a user's OLLAMA_* choice).
    for (const [k, v] of Object.entries(OLLAMA_SPAWN_CAPS)) {
      if (spawnEnv[k] == null) spawnEnv[k] = v;
    }
    child = spawn(bin, ['serve'], { detached: false, stdio: ['ignore', 'ignore', 'pipe'], env: spawnEnv });
    spawnedByUs = true;
    child.stderr?.on?.('data', (d) => { errBuf = (errBuf + String(d)).slice(-4096); });
    child.on?.('exit', () => { child = null; });
    const deadline = Date.now() + startTimeoutMs;
    for (;;) {
      await sleep(pollMs);
      if (await probe()) return true;
      if (Date.now() >= deadline) return false;
    }
  }

  /**
   * SELF-HEAL when a too-old daemon squats the default port. We must NOT kill it (§4/§6) and cannot
   * rebind the port it holds, so we spawn OUR runtime (host if new-enough, else the pinned/extracted
   * one — chooseBinary; auto-install if absent) on a FRESH loopback port and steer every consumer to
   * it: effectiveBaseUrl moves, and we publish it as process.env.OLLAMA_URL so env-reading consumers
   * follow. The alt port is loopback-only (127.0.0.1) and models stay app-private — a healed daemon
   * is exactly as on-box/local as the default, so §4g locality (isLoopbackUrl) still classes it local.
   */
  async function selfHealOnAltPort(onProgress, squatVersion) {
    let bin = await chooseBinary();
    if (!bin && autoInstall) {
      const r = await provision(onProgress);
      if (!r.ok) return { ok: false, running: true, installed: false, adopted: false, reason: r.reason };
      bin = r.binPath;
    }
    if (!bin) return { ok: false, running: true, installed: false, adopted: false, reason: 'not_installed' };

    const altPort = await findFreePort(altPortStart);
    if (!altPort) return { ok: false, running: true, installed: true, adopted: false, reason: 'no_free_port' };
    const altHost = `127.0.0.1:${altPort}`;
    const altBase = `http://${altHost}`;
    // Probe the ALT base specifically (the squatter still answers effectiveBaseUrl). A test that
    // injects isUp drives both probes through that seam.
    const altProbe = isUp || (() => createOllamaClient({ baseUrl: altBase, fetch }).isUp());

    let up = false;
    try { up = await spawnServe(bin, altHost, altProbe); }
    catch { return { ok: false, running: true, installed: true, adopted: false, reason: 'spawn_failed' }; }
    if (!up) {
      const tail = redactDaemonDetail(errBuf.trim().split('\n').pop() || '');
      return { ok: false, running: true, installed: true, adopted: false, reason: 'start_timeout', detail: tail || undefined };
    }

    // Steer every consumer to the alt port: getBaseUrl() + the published env override.
    effectiveBaseUrl = altBase;
    try { process.env.OLLAMA_URL = altBase; } catch { /* noop — env is read-only in some sandboxes */ }
    log(`[ollama-daemon] a too-old ollama ${squatVersion?.join?.('.') || '?'} holds ${DEFAULT_OLLAMA_URL}; started our runtime on ${altBase}`);
    return { ok: true, running: true, installed: true, adopted: false, healed: true, port: altPort, baseUrl: altBase };
  }

  async function start(onProgress) {
    // 1. Already up (perhaps the user's own daemon) → adopt, never spawn — BUT only if it is new
    //    enough for the catalog. A too-old listening daemon (e.g. Homebrew 0.12.9 < 0.17.4) would
    //    412-refuse every qwen3.5 pull, and we can neither rebind the port it holds nor kill a daemon
    //    we didn't start (§4/§6). So instead of leaving the box broken with an honest-but-useless
    //    error, we SELF-HEAL: spawn our own runtime on an alternate loopback port and redirect every
    //    consumer there (selfHealOnAltPort). Version-unknown (null) → adopt (fail-open): a future
    //    /api/version change must never brick a working daemon, and the real too-old builds all
    //    answer /api/version anyway; a genuine incompatibility then still surfaces as the terminal
    //    `incompatible-runtime` pull fault downstream.
    if (await probeUp()) {
      const dv = await daemonVersion(effectiveBaseUrl, fetch);
      // Not the daemon WE healed onto: a stranger too old for the catalog squats the port → heal.
      // (Once healed, effectiveBaseUrl is the alt port and this probe hits OUR new-enough runtime.)
      if (dv && !versionGte(dv, minVersion)) {
        return await selfHealOnAltPort(onProgress, dv);
      }
      return { ok: true, running: true, installed: true, adopted: true, baseUrl: effectiveBaseUrl };
    }

    // 2. Locate the binary (version-aware: an old host binary yields the pinned one); if absent and
    //    auto-install is on, DOWNLOAD it first.
    let bin = await chooseBinary();
    if (!bin && autoInstall) {
      const r = await provision(onProgress);
      if (!r.ok) return { ok: false, running: false, installed: false, reason: r.reason };
      bin = r.binPath;
    }
    if (!bin) return { ok: false, running: false, installed: false, reason: 'not_installed' };

    // 3. Spawn `ollama serve` bound to the effective base. Normally that's ollama's default :11434
    //    (bindHost null); after a prior heal it's the alt loopback port, so a respawn re-binds there
    //    rather than colliding with the squatter on :11434.
    const bindHost = effectiveBaseUrl !== DEFAULT_OLLAMA_URL ? hostFromBase(effectiveBaseUrl) : null;
    let up;
    try { up = await spawnServe(bin, bindHost, probeUp); }
    catch { return { ok: false, running: false, installed: true, reason: 'spawn_failed' }; }

    // 4. Report whether it bound.
    if (up) {
      log('[ollama-daemon] started ollama serve');
      return { ok: true, running: true, installed: true, adopted: false, baseUrl: effectiveBaseUrl };
    }
    const tail = redactDaemonDetail(errBuf.trim().split('\n').pop() || '');
    return { ok: false, running: false, installed: true, reason: 'start_timeout', detail: tail || undefined };
  }

  /**
   * Ensure the daemon is up (single-flight: concurrent callers share one start).
   * @param {(pct:number, done?:number, total?:number)=>void} [onProgress] download progress
   */
  function ensureUp(onProgress) {
    if (inflight) return inflight;
    inflight = start(onProgress)
      .then((r) => { lastResult = r; return r; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  // ── Honest daemon health (QA6 P1 §1 + §3) ───────────────────────────────────
  // WHAT WAS WRONG. The only thing a surface could ask this daemon was `ensureUp()`,
  // whose return value describes the ATTEMPT ("ok:false, reason:'start_timeout'"),
  // not the WORLD. Everything else asked `ollamaClient().isUp()` — a bare boolean
  // that cannot tell "not installed" from "installed and starting" from "crashed".
  // So the categorize/model panel had exactly two things to say, ok and the generic
  // "the local model runtime (Ollama) isn't reachable", and no way to act. It also
  // self-healed silently a moment later with the screen still claiming a fault.
  //
  // health() answers the world, in the SHARED taxonomy (src/system/service-state.js):
  //   'ok'            — the daemon answers on the base we dial (adopted, spawned, or healed)
  //   'starting'      — a bring-up is IN FLIGHT right now (single-flight `inflight`) ⇒ 'loading'
  //   'no_model'      — no ollama binary anywhere and auto-install is off ⇒ a setup step
  //   'deps_missing'  — a binary is absent but we CAN fetch it ⇒ degraded + retryable
  //   'down'/'error'  — it is installed and it did not come up; `detail` carries the
  //                     redacted last stderr line / the last failure reason
  //
  // ⚠️ IT NEVER STARTS ANYTHING. health() is a pure READ (probe + local facts) so it is
  // safe on a poll and cannot become a hidden spawn path — bring-up stays exclusively
  // ensureUp()'s job, with its single-flight, version-gate, adopt/self-heal and spawn
  // caps untouched.
  async function health() {
    let up = false;
    try { up = await probeUp(); } catch { up = false; }
    const installed = (() => { try { return isInstalled(); } catch { return false; } })();
    if (up) {
      return {
        status: 'ok',
        message: 'The local model runtime is running.',
        detail: null,
        installed: true,
        running: true,
        baseUrl: effectiveBaseUrl,
      };
    }
    if (inflight) {
      return {
        status: 'starting',
        message: 'Starting the local model runtime…',
        detail: null,
        installed,
        running: false,
        baseUrl: effectiveBaseUrl,
      };
    }
    // Not up, nothing in flight. WHY is the useful part — and it is a REASON, not a guess.
    const reason = lastResult && lastResult.ok === false ? lastResult.reason || null : null;
    if (!installed) {
      // A downloadable absence is a setup step we can re-attempt; a non-downloadable one
      // (autoInstall off / unsupported platform) is a genuine dead end for this surface.
      const fetchable = autoInstall && Boolean(dataDir) && reason !== 'unsupported_platform';
      return {
        status: fetchable ? 'deps_missing' : 'no_model',
        message: fetchable
          ? 'The local model runtime isn’t installed yet — Mycelium can download it.'
          : 'The local model runtime isn’t installed on this computer.',
        detail: reason,
        installed: false,
        running: false,
        baseUrl: effectiveBaseUrl,
      };
    }
    return {
      status: 'down',
      message: reason === 'start_timeout'
        ? 'The local model runtime didn’t finish starting.'
        : 'The local model runtime isn’t running.',
      // Already redacted at the source (redactDaemonDetail) — never a raw path or PII.
      detail: reason || redactDaemonDetail(errBuf.trim().split('\n').pop() || '') || null,
      installed: true,
      running: false,
      baseUrl: effectiveBaseUrl,
    };
  }

  /** Kill the daemon ONLY if we started it (never an adopted one). */
  function stop() {
    if (child && spawnedByUs) { try { child.kill('SIGTERM'); } catch { /* noop */ } }
    child = null;
  }

  /** The base URL every consumer should DIAL — moves to the alt loopback port after a self-heal. */
  function getBaseUrl() { return effectiveBaseUrl; }

  return { ensureUp, isInstalled, stop, getBaseUrl, health };
}

export default createOllamaDaemon;
