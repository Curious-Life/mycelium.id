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

// Ollama tags look like `family:tag`, `ns/family:tag`, with dots/dashes/underscores.
const MODEL_NAME_RE = /^[a-z0-9][a-z0-9._:/-]{0,79}$/i;

export function isValidModelName(name) {
  return typeof name === 'string' && MODEL_NAME_RE.test(name);
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
   * Pull a model, streaming NDJSON progress events to onProgress.
   * Each Ollama line ≈ { status, digest?, total?, completed? }. Resolves true on
   * success; throws on a stream `error` or a non-OK response.
   * @param {string} name
   * @param {(ev:object)=>void} [onProgress]
   */
  async function pullModel(name, onProgress) {
    if (!isValidModelName(name)) throw new Error('invalid model name');
    const r = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    });
    if (!r.ok || !r.body) throw new Error(`ollama /api/pull ${r.status}`);

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; } // skip a partial/garbled line
        if (ev?.error) throw new Error('ollama pull failed');
        if (typeof onProgress === 'function') onProgress(ev);
      }
    }
    return true;
  }

  return { baseUrl: base, isUp, listInstalled, pullModel };
}

export default createOllamaClient;
