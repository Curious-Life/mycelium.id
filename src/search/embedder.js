/**
 * Embedder contract + injection seam.
 *
 * The REAL embedder wraps embed-service (Nomic v1.5 ONNX, 768D, task prefixes)
 * on :8091 — owned by a SIBLING unit (R2) and NOT present in this worktree.
 * Ported (shape) from reference/mind-search/embedder.js, which built an HTTP
 * client. Here mind-search only depends on the INTERFACE below; the concrete
 * client is injected at boot. Real-embedding parity is gated on R2.
 *
 * An embedder is:
 *   async embed(text, { task: 'query' | 'document' }) -> Float32Array
 *   async health() -> boolean
 *
 * embed() requires `task` — mismatched prefix at index vs query time tanks
 * recall, so there is no silent default at this layer.
 */

import { EmbedDownError } from './errors.js';
import { createEmbedClient } from '../embed/client.js';

/**
 * Validate that an injected embedder satisfies the { embed, health } contract.
 * Returns the embedder unchanged. Throws TypeError if malformed.
 */
export function assertEmbedder(embedder) {
  if (!embedder || typeof embedder.embed !== 'function' || typeof embedder.health !== 'function') {
    throw new TypeError('embedder must implement { embed, health }');
  }
  return embedder;
}

/**
 * Call embedder.embed, normalizing the result to a Float32Array and wrapping
 * failures in EmbedDownError so the backend can fall back to BM25-only.
 */
export async function safeEmbed(embedder, text, task) {
  if (task !== 'query' && task !== 'document') {
    throw new TypeError(`safeEmbed: task must be 'query' or 'document', got ${JSON.stringify(task)}`);
  }
  let out;
  try {
    out = await embedder.embed(text, { task });
  } catch (cause) {
    throw new EmbedDownError('embedder call failed', null, cause);
  }
  if (out instanceof Float32Array) return out;
  if (Array.isArray(out) || out instanceof Float64Array) return Float32Array.from(out);
  throw new EmbedDownError('embedder returned a non-vector');
}

/**
 * Deterministic, dependency-free STUB embedder. Hashes tokens into a fixed
 * dimension. Used ONLY by verify scripts to exercise the ANN + RRF pipeline
 * without the real model. Output is NOT unit-normalized, so callers must score
 * with full cosine (assumeUnit:false) — the LocalBackend does this when the
 * embedder reports `unit:false`.
 *
 * @param {number} [dim=64]
 */
export function createStubEmbedder(dim = 64) {
  function hashToken(tok) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function embedText(text) {
    const vec = new Float32Array(dim);
    const tokens = (text ?? '').toString().toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
    for (const tok of tokens) {
      const h = hashToken(tok);
      vec[h % dim] += ((h >> 16) & 1) ? 1 : -1;
    }
    return vec;
  }
  return {
    dim,
    unit: false, // stub vectors are not L2-normalized
    async embed(text, opts) {
      if (opts?.task !== 'query' && opts?.task !== 'document') {
        throw new TypeError("stub embed: task must be 'query' or 'document'");
      }
      return embedText(text);
    },
    async health() { return true; },
  };
}

/**
 * REAL embedder: adapts the embed-service HTTP client (src/embed/client.js,
 * Nomic v1.5 ONNX on :8091) to the search embedder contract above. This is the
 * "R2 wiring" — and it is load-bearing, because the two sides disagree on the
 * embed() call shape:
 *   - this contract / safeEmbed call:  embed(text, { task })   ← object
 *   - the embed client's signature:    embed(text, taskString) ← positional
 * Calling the raw client with the object form makes its assertTask() reject
 * `{task:'query'}` as an unknown task, so every query would silently fall back
 * to BM25 even with :8091 up. This adapter bridges the two and reports
 * `unit: true` because the embed-service L2-normalizes its output
 * (pipeline/embed-service.py), which is what the backend's unit-cosine fast
 * path requires. health() is coerced to a boolean per the contract.
 *
 * @param {object} [opts]  forwarded to createEmbedClient ({ baseUrl, timeoutMs, fetch })
 */
export function createServiceEmbedder(opts = {}) {
  const client = createEmbedClient(opts);
  return {
    unit: true, // embed-service output is L2-normalized
    baseUrl: client.baseUrl,
    async embed(text, { task } = {}) {
      if (task !== 'query' && task !== 'document') {
        throw new TypeError("service embed: task must be 'query' or 'document'");
      }
      return client.embed(text, task); // bridge { task } → positional string
    },
    async health() {
      try {
        const h = await client.health();
        return Boolean(h && (h.loaded ?? h.status === 'ok' ?? true));
      } catch {
        return false;
      }
    },
  };
}
