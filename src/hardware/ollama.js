// src/hardware/ollama.js — a minimal HTTP client for a local Ollama daemon.
//
// HTTP-only (never shells out to `ollama …`), bound to loopback :11434 by
// default. Used by the S6 recommender to: check Ollama is up, list installed
// models, and pull a recommended model with streaming progress.
//
// SECURITY: a model name is validated against a strict charset before it ever
// reaches the daemon — even though names come from our curated catalog, this is
// defence in depth (a name must never be able to do anything but name a model).

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

import { recordPulledModel } from './ollama-manifest.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull resilience defaults (R2-QWENPULL). A multi-GB pull over a home connection is the single
// most failure-prone call in the app: one DNS/TLS/reset blip mid-stream used to abort the WHOLE
// download (no signal, no retry — the pull passed no `signal` and looped forever on the reader).
// These give it a stall watchdog and a resume-retry. Resume is FREE + correct: ollama keeps the
// partial blobs on disk, so a fresh /api/pull CONTINUES from where it stopped, not restarts.
const PULL_IDLE_TIMEOUT_MS = 120_000; // no progress event for 2 min ⇒ the pull has stalled → abort
const PULL_MAX_ATTEMPTS = 4;          // 1 try + 3 resume-retries
const PULL_RETRY_DELAY_MS = 1500;     // linear backoff base between attempts

// Ollama tags look like `family:tag`, `ns/family:tag`, with dots/dashes/underscores.
const MODEL_NAME_RE = /^[a-z0-9][a-z0-9._:/-]{0,79}$/i;

export function isValidModelName(name) {
  return typeof name === 'string' && MODEL_NAME_RE.test(name);
}

// ── Fault taxonomy for a failed list/pull ────────────────────────────────────
// The drainer used to report EVERY pull/list failure as "The local model runtime is not
// reachable." — misleading when Ollama is up and the DOWNLOAD failed for another reason
// (disk full, the model registry unreachable mid-pull). These three kinds are what an owner
// can actually act on; `classifyOllamaFault` maps a caught error onto one of them and the
// health surface renders an accurate, actionable message per kind (drainer.js FAULT_MESSAGE).
export const OLLAMA_FAULT = Object.freeze({
  RUNTIME_UNREACHABLE: 'runtime-unreachable', // the daemon isn't running / not answering
  DOWNLOAD_FAILED: 'download-failed',         // reached the daemon, but the pull itself failed
  OUT_OF_SPACE: 'out-of-space',               // no disk left for the model
});

/**
 * Classify a caught error from listInstalled()/pullModel() into an actionable {@link OLLAMA_FAULT}.
 *
 * PURE + TOTAL — never throws; an unrecognised error resolves to a phase-appropriate default.
 * The error shapes are the REAL ones this client emits (verified against a live spike, and a
 * local http server driving each failure class, 2026-07-18):
 *   • connection refused (daemon down)  → `TypeError: fetch failed`   (cause.code often absent)
 *   • probe timeout                     → `TimeoutError` / "aborted due to timeout"
 *   • non-2xx                           → `ollama /api/tags NNN` | `ollama /api/pull NNN`
 *   • mid-stream ollama error           → `ollama pull failed: <ev.error>` (disk / registry)
 *
 * @param {unknown} err   the caught error
 * @param {'list'|'pull'} [phase='pull']  which operation threw — disambiguates the default:
 *   a non-2xx from /api/tags is a runtime that answered-but-erroring (still a RUNTIME problem),
 *   whereas any non-connection pull failure is a DOWNLOAD problem (registry, manifest, HTTP).
 */
export function classifyOllamaFault(err, phase = 'pull') {
  const msg = String(err?.message ?? err ?? '');
  const code = String(err?.code ?? err?.cause?.code ?? err?.errno ?? '');
  const name = String(err?.name ?? '');
  const hay = `${name} ${code} ${msg}`.toLowerCase();

  // Disk exhaustion — ollama surfaces ENOSPC / "no space left on device" as a mid-stream
  // ev.error (now preserved by pullModel). Check FIRST: it is the most specific and the
  // most actionable ("free up space"), and its text also contains a path we must not misread.
  if (hay.includes('enospc') || hay.includes('no space left') || hay.includes('disk full')) {
    return OLLAMA_FAULT.OUT_OF_SPACE;
  }
  // A connection-LEVEL failure: fetch never reached an HTTP server. BOTH endpoints dial the
  // LOCAL daemon (127.0.0.1:11434), so these shapes always mean "the daemon socket is down",
  // phase-independent — the registry is reached by ollama SERVER-side, never by this client.
  if (hay.includes('fetch failed') || hay.includes('econnrefused') || hay.includes('econnreset')
      || hay.includes('ehostunreach') || hay.includes('enetunreach')) {
    return OLLAMA_FAULT.RUNTIME_UNREACHABLE;
  }
  // ⚠️ A TIMEOUT MEANS DIFFERENT THINGS BY PHASE — and conflating them reintroduced the exact
  // "is it running?" lie this function exists to remove (independent review, 2026-07-18):
  //   • LIST — listInstalled() carries a 5s AbortSignal.timeout (createOllamaClient signal()),
  //     so a timeout is the CLIENT giving up on the local daemon → runtime unreachable.
  //   • PULL — pullModel() has NO client timeout (it never passes `signal`), so "timeout" /
  //     "aborted" can ONLY be ollama's SERVER-side registry error text now preserved in ev.error
  //     — Go's `i/o timeout`, `TLS handshake timeout`, `request canceled (Client.Timeout …)`. That
  //     is a slow/firewalled REGISTRY, i.e. a DOWNLOAD failure — blaming the local runtime for it
  //     is the misclassification this branch used to make by matching the bare substring.
  if (name === 'timeouterror' || name === 'aborterror' || hay.includes('timeout') || hay.includes('aborted')) {
    return phase === 'list' ? OLLAMA_FAULT.RUNTIME_UNREACHABLE : OLLAMA_FAULT.DOWNLOAD_FAILED;
  }
  // Reached the daemon, but the operation failed (a non-2xx, or a mid-stream error we could not
  // pin to disk). For a LIST that means the runtime is up but not serving — still a runtime
  // problem the owner reads as "is Ollama healthy?". For a PULL it is a download failure.
  return phase === 'list' ? OLLAMA_FAULT.RUNTIME_UNREACHABLE : OLLAMA_FAULT.DOWNLOAD_FAILED;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl='http://127.0.0.1:11434']
 * @param {typeof fetch} [opts.fetch]
 * @param {number} [opts.timeoutMs=5000]   (probe/list only; a pull has no cap)
 */
export function createOllamaClient({ baseUrl = DEFAULT_OLLAMA_URL, fetch = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (typeof fetch !== 'function') throw new Error('createOllamaClient: no fetch implementation');
  const base = String(baseUrl).replace(/\/+$/, '');
  const signal = () => (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);

  async function isUp() {
    try { const r = await fetch(`${base}/api/tags`, { signal: signal() }); return r.ok; }
    catch { return false; }
  }

  /** Installed model tags, or [] if the daemon is unreachable. */
  async function listInstalled() {
    const r = await fetch(`${base}/api/tags`, { signal: signal() });
    if (!r.ok) throw new Error(`ollama /api/tags ${r.status}`);
    const data = await r.json();
    return Array.isArray(data?.models) ? data.models.map((m) => m?.name).filter(Boolean) : [];
  }

  /**
   * ONE pull attempt: stream NDJSON progress to onProgress until the daemon closes the stream.
   * Carries an idle watchdog (abort if no progress event within idleTimeoutMs) and honours an
   * optional external abort signal. Resolves on a clean stream end; throws on a mid-stream
   * `error`, a non-OK response, an abort (stall or caller-cancel), or a transport failure.
   * @param {string} name
   * @param {(ev:object)=>void} [onProgress]
   * @param {{ idleTimeoutMs:number, externalSignal?:AbortSignal }} ctx
   */
  async function pullOnce(name, onProgress, { idleTimeoutMs, externalSignal }) {
    const ctrl = new AbortController();
    const onExternalAbort = () => ctrl.abort();
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    // Idle watchdog: (re)armed on every received chunk. If the pull stalls — TCP wedged, a
    // half-open connection ollama never notices — no progress arrives, the timer fires, and we
    // abort so the retry loop can start a fresh (resuming) attempt instead of hanging forever.
    let idleTimer = null;
    const bump = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleTimeoutMs > 0) idleTimer = setTimeout(() => ctrl.abort(), idleTimeoutMs);
    };
    try {
      bump();
      const r = await fetch(`${base}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, stream: true }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) throw new Error(`ollama /api/pull ${r.status}`);

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bump();   // progress — the stream is alive; re-arm the idle watchdog
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; } // skip a partial/garbled line
          // ⚠️ PRESERVE ollama's own reason. This used to throw a bare `ollama pull failed`,
          // discarding the mid-stream `ev.error` — which is the ONLY place a disk-full
          // ("no space left on device") or a registry-unreachable ("dial tcp: lookup
          // registry.ollama.ai: no such host") ever surfaces. Without it, every mid-pull
          // failure was indistinguishable from a dead daemon, and the drainer reported them
          // all as "runtime not reachable" (drainer.js classifyOllamaFault). The text is
          // ollama's own infra string (an HTTP/registry error or a models-dir path) — never
          // vault content — and it is bounded here; the drainer scrubs any home-dir username
          // before storing it, and never publishes it to the content-free activity feed. See
          // the SECURITY note on `pullModel`'s callers (drainer.js publishPull.end passes a
          // CONSTANT; the reason reaches only the localhost-only readiness surface).
          if (ev?.error) throw new Error(`ollama pull failed: ${String(ev.error).slice(0, 160)}`);
          if (typeof onProgress === 'function') onProgress(ev);
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (externalSignal) externalSignal.removeEventListener?.('abort', onExternalAbort);
    }
  }

  /**
   * Pull a model, streaming NDJSON progress events to onProgress. Resolves true on success;
   * throws the last error once the resume-retries are exhausted (so callers can still
   * classifyOllamaFault the REAL reason).
   *
   * RESILIENCE (R2-QWENPULL): a single attempt used to be the whole story — no signal, no
   * timeout, no retry — so one mid-stream blip on a multi-GB pull aborted everything and the
   * owner saw a bare "pull failed". Now each attempt has an idle timeout, and a transport/stall
   * failure is RESUMED: ollama keeps the partial blobs, so the next /api/pull continues from
   * where it stopped. Two failures are NOT retried: an invalid name (rejected before any fetch)
   * and disk exhaustion (a retry cannot conjure space — surface it now).
   * @param {string} name
   * @param {(ev:object)=>void} [onProgress]
   * @param {{ idleTimeoutMs?:number, maxAttempts?:number, retryDelayMs?:number, signal?:AbortSignal }} [opts]
   */
  async function pullModel(name, onProgress, opts = {}) {
    if (!isValidModelName(name)) throw new Error('invalid model name');
    const idleTimeoutMs = opts.idleTimeoutMs ?? PULL_IDLE_TIMEOUT_MS;
    const maxAttempts = Math.max(1, opts.maxAttempts ?? PULL_MAX_ATTEMPTS);
    const retryDelayMs = opts.retryDelayMs ?? PULL_RETRY_DELAY_MS;
    const externalSignal = opts.signal;

    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await pullOnce(name, onProgress, { idleTimeoutMs, externalSignal });
        // Track the tag so destroy-vault can remove it from a SHARED daemon later
        // (best-effort; a record failure never breaks the pull). See ollama-manifest.js.
        try { await recordPulledModel(name); } catch { /* best-effort */ }
        return true;
      } catch (err) {
        lastErr = err;
        // The caller cancelled deliberately → stop; do NOT keep retrying their aborted pull.
        if (externalSignal?.aborted) throw err;
        // Disk exhaustion is terminal: no number of retries frees space, and the owner needs
        // the "free up space" remedy NOW, not after four more failed attempts.
        if (classifyOllamaFault(err, 'pull') === OLLAMA_FAULT.OUT_OF_SPACE) throw err;
        if (attempt < maxAttempts) {
          // Resume transparently — do NOT synthesize a progress event here. ollama keeps the
          // partial blobs, so the next attempt's REAL events resume near where they stopped; a
          // fake {completed:0,total:0} would only reset the drainer's feed heartbeat to 0/0
          // (activity-feed heartbeat does `step = COALESCE(?, step)`, and 0 is not null).
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw err;   // retries exhausted — rethrow so the caller classifies the real reason
      }
    }
    // Unreachable (the loop returns or throws), but keeps the type checker + linters happy.
    throw lastErr ?? new Error('ollama pull failed');
  }

  /**
   * Delete a model from disk via Ollama's HTTP API (never shells out to `ollama rm`).
   * The name is charset-validated first (defence in depth — a name must only ever name a
   * model). Sends both `model` (current) and `name` (legacy) keys for version tolerance.
   * @param {string} name
   * @returns {Promise<{ ok:boolean, notFound?:boolean, status?:number }>}
   */
  async function deleteModel(name) {
    if (!isValidModelName(name)) throw new Error('invalid model name');
    const r = await fetch(`${base}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, name }),
      signal: signal(),
    });
    if (r.status === 404) return { ok: false, notFound: true, status: 404 };
    return { ok: r.ok, status: r.status };
  }

  return { baseUrl: base, isUp, listInstalled, pullModel, deleteModel };
}

export default createOllamaClient;
