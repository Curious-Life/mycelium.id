/**
 * Embedder client for mind-search.
 *
 * Wraps the local embed service at port 8091 (scripts/embed-service.py,
 * Nomic v1.5 ONNX, 768D) in the `{ embed, health }` shape that
 * mind-search consumes.
 *
 * Why this is its own file rather than inlined into bootstrap:
 *   • Testable in isolation — tests can mock fetch directly.
 *   • Decouples mind-search from the specific embed backend; if we
 *     swap the model later, only this file changes.
 *
 * Task contract:
 *   embed(text, { task }) — `task` MUST be 'query' or 'document'.
 *   Mismatched prefix at index time vs query time tanks recall, so
 *   the parameter is required (no silent default at this layer). The
 *   server applies the actual prefix string; clients only send the
 *   semantic label.
 *
 * No content ever logged. health() is content-free — uses /health,
 * not /embed, so no probe text leaks.
 */

const DEFAULT_EMBED_URL = process.env.EMBED_SERVER_URL || 'http://localhost:8091';
const DEFAULT_EMBED_TIMEOUT_MS = 30_000;       // covers cold-start model load
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;       // probe must be fast

/**
 * @typedef {object} EmbedderOpts
 * @property {string} [url]                base URL of the embed service
 * @property {number} [embedTimeoutMs]
 * @property {number} [healthTimeoutMs]
 * @property {typeof globalThis.fetch} [fetch]   override for tests
 */

/**
 * @param {EmbedderOpts} [opts]
 * @returns {{
 *   embed: (text: string, opts: { task: 'query' | 'document' }) => Promise<Float32Array>,
 *   health: () => Promise<boolean>
 * }}
 */
export function createEmbedderClient(opts = {}) {
  const url = opts.url || DEFAULT_EMBED_URL;
  const embedTimeoutMs = opts.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  const healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createEmbedderClient: fetch implementation required');
  }

  return {
    /**
     * @param {string} text
     * @param {{ task: 'query' | 'document' }} options
     * @returns {Promise<Float32Array>}
     */
    async embed(text, options) {
      if (typeof text !== 'string') {
        throw new TypeError('embed: text must be a string');
      }
      const task = options?.task;
      if (task !== 'query' && task !== 'document') {
        throw new TypeError(
          `embed: task must be 'query' or 'document', got ${JSON.stringify(task)}`,
        );
      }
      // Service truncates internally too; cap at 8000 chars to bound payload.
      const body = JSON.stringify({ text: text.slice(0, 8000), task });
      const res = await fetchImpl(`${url}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(embedTimeoutMs),
      });
      if (!res.ok) {
        // Don't include response body in error: service might echo input.
        throw new Error(`embed-service returned ${res.status}`);
      }
      const data = await res.json();
      if (!data || !Array.isArray(data.embedding)) {
        throw new Error('embed-service response missing embedding array');
      }
      return Float32Array.from(data.embedding);
    },

    /**
     * Returns true iff the model is loaded and ready. Falls through to
     * false on any network error or non-loaded status.
     * @returns {Promise<boolean>}
     */
    async health() {
      try {
        const res = await fetchImpl(`${url}/health`, {
          signal: AbortSignal.timeout(healthTimeoutMs),
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => null);
        return data?.loaded === true;
      } catch {
        return false;
      }
    },
  };
}
