// src/embed/client.js — thin client for the local Nomic v1.5 embed-service.
//
// The embed-service (pipeline/embed-service.py) binds 127.0.0.1:8091 and
// exposes:
//   GET  /health  -> { status, model, loaded, dim }
//   POST /embed   -> { text, task } => { embedding: number[768], dim, model, task }
//   POST /batch   -> { texts, task } => { embeddings: number[][], count, dim, model, task }
//
// Tasks are "query" / "document" (the service maps them to the mandatory
// Nomic v1.5 prefixes "search_query: " / "search_document: " before
// tokenization). Mismatched prefix at index vs query time tanks recall, so
// callers must pass the task that matches how the corpus was indexed.
//
// Factory / DI style so callers (mind-search, enrichment) inject a client.

export const EMBED_DIM = 768;
export const VALID_TASKS = Object.freeze(["query", "document"]);
const DEFAULT_BASE_URL = "http://127.0.0.1:8091";

export class EmbedServiceError extends Error {
  constructor(message, { cause, status } = {}) {
    super(message);
    this.name = "EmbedServiceError";
    if (cause !== undefined) this.cause = cause;
    if (status !== undefined) this.status = status;
  }
}

function assertTask(task) {
  if (!VALID_TASKS.includes(task)) {
    throw new EmbedServiceError(
      `unknown task ${JSON.stringify(task)} (valid: ${VALID_TASKS.join(", ")})`,
    );
  }
}

/**
 * Create an embed client.
 * @param {object} [opts]
 * @param {string} [opts.baseUrl="http://127.0.0.1:8091"]
 * @param {number} [opts.timeoutMs=30000]
 * @param {typeof fetch} [opts.fetch] - injectable fetch (defaults to global).
 */
export function createEmbedClient({
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 30000,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new EmbedServiceError("no fetch implementation available (Node >= 18 or pass opts.fetch)");
  }
  const base = baseUrl.replace(/\/+$/, "");

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : "is it running?";
      throw new EmbedServiceError(
        `embed-service unreachable at ${base}${path} (${reason})`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new EmbedServiceError(
        `embed-service returned non-JSON (status ${res.status})`,
        { cause: err, status: res.status },
      );
    }
    if (!res.ok) {
      throw new EmbedServiceError(
        `embed-service error ${res.status}: ${data?.error ?? text}`,
        { status: res.status },
      );
    }
    return data;
  }

  function assertVector(vec, label) {
    if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
      throw new EmbedServiceError(
        `${label}: expected ${EMBED_DIM}-dim vector, got ${Array.isArray(vec) ? vec.length : typeof vec}`,
      );
    }
    return vec;
  }

  return {
    baseUrl: base,

    /** Liveness/info probe. Returns { status, model, loaded, dim }. */
    async health() {
      return request("GET", "/health");
    },

    /**
     * Embed a single string. Returns a 768-dim number[].
     * @param {string} text
     * @param {"query"|"document"} task
     */
    async embed(text, task = "query") {
      assertTask(task);
      if (typeof text !== "string" || text.length === 0) {
        throw new EmbedServiceError("embed(text): text must be a non-empty string");
      }
      const data = await request("POST", "/embed", { text, task });
      return assertVector(data?.embedding, "embed");
    },

    /**
     * Embed many strings. Returns number[][] (each 768-dim).
     * @param {string[]} texts
     * @param {"query"|"document"} task
     */
    async embedBatch(texts, task = "document") {
      assertTask(task);
      if (!Array.isArray(texts) || !texts.every((t) => typeof t === "string")) {
        throw new EmbedServiceError("embedBatch(texts): texts must be an array of strings");
      }
      if (texts.length === 0) return [];
      const data = await request("POST", "/batch", { texts, task });
      const embeddings = data?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        throw new EmbedServiceError(
          `embedBatch: expected ${texts.length} embeddings, got ${Array.isArray(embeddings) ? embeddings.length : typeof embeddings}`,
        );
      }
      return embeddings.map((vec, i) => assertVector(vec, `embedBatch[${i}]`));
    },
  };
}

export default createEmbedClient;
