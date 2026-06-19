// src/gateway/embeddings.js — the OpenAI-compatible `/v1/embeddings` surface (S8 fast-follow).
//
// Fronts the LOCAL Nomic v1.5 embed-service (pipeline/embed-service.py, loopback
// :8091) with an OpenAI `POST /v1/embeddings` shape so a user's harness can
// embed text through Mycelium's own on-box model — no embedding ever touches a
// cloud provider.
//
// SECURITY (§1, §7, §13):
//   • LOCAL-ONLY by construction: the only backend is the loopback embed-service.
//     There is NO cloud embeddings path — embedding vectors are semantic
//     fingerprints of plaintext (inversion attacks are real), so they never
//     egress to a third party. The vector returns ONLY to the operator's own
//     Bearer-authenticated harness over loopback/relay — the same trust boundary
//     as the vault owner. Hence: no cloud egress, so no egress-audit row.
//   • Mounted ONLY on the Bearer-guarded :4711 app (never the no-auth :8787).
//   • Zero-leak: the embed-service never logs request bodies; this adapter
//     reduces any failure to a generic envelope before it reaches the client.
//
// v1 scope: input = string | string[]; encoding_format 'float' (default) or
// 'base64' (raw little-endian float32, OpenAI-compatible). The OpenAI API has no
// "task" field, so we default to the corpus/RAG-indexing prefix ('document') and
// let a harness override per-request with `X-Mycelium-Embed-Task: query`.

import { createEmbedClient } from '../embed/client.js';
import { GatewayError } from './openai-compat.js';
import { estimateTokens } from '../inference/token-budget.js';

export const EMBED_MODEL_ID = 'nomic-embed-text-v1.5';

// Approximate token count (~4 chars/token) for the usage block — clients only
// need a plausible shape; the embed-service does not return token counts. Shared
// estimator (src/inference/token-budget.js) — same chars/4 + floor-of-1.
const approxTokens = estimateTokens;

// OpenAI's base64 embedding format = the raw float32 buffer (little-endian),
// base64-encoded. Float32Array is little-endian on every platform Node targets.
function floatsToBase64(vec) {
  return Buffer.from(new Float32Array(vec).buffer).toString('base64');
}

// `X-Mycelium-Embed-Task: query|document` (case-insensitive). Anything else
// (incl. absent) → 'document' (the indexing default; matches embedBatch's).
function taskFromHeader(v) {
  const s = (Array.isArray(v) ? v[0] : v) || '';
  return /^query$/i.test(String(s).trim()) ? 'query' : 'document';
}

/**
 * Build the `/v1/embeddings` handler, bound to one embed client.
 * @param {object} [opts]
 * @param {object} [opts.embedClient]  injectable (tests); defaults to the loopback client
 * @returns {{ embeddings: Function }}
 */
export function createEmbeddingsHandler({ embedClient = createEmbedClient() } = {}) {
  async function embeddings(req, res) {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new GatewayError('request body must be a JSON object', 400);
      }
      const raw = body.input;
      const inputs = Array.isArray(raw) ? raw : [raw];
      if (inputs.length === 0 || !inputs.every((t) => typeof t === 'string' && t.length > 0)) {
        throw new GatewayError('`input` must be a non-empty string or array of non-empty strings', 400);
      }
      const encoding = body.encoding_format === 'base64' ? 'base64' : 'float';
      const task = taskFromHeader(req.headers['x-mycelium-embed-task']);

      const vectors = await embedClient.embedBatch(inputs, task); // number[][768], local-only

      const joined = inputs.join('');
      res.json({
        object: 'list',
        data: vectors.map((vec, index) => ({
          object: 'embedding',
          index,
          embedding: encoding === 'base64' ? floatsToBase64(vec) : vec,
        })),
        model: EMBED_MODEL_ID,
        usage: { prompt_tokens: approxTokens(joined), total_tokens: approxTokens(joined) },
      });
    } catch (err) {
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      if (err instanceof GatewayError) {
        res.status(err.status).json({ error: { message: err.message, type: err.type, code: null } });
        return;
      }
      // embed-service unreachable / not ready / any other failure → generic 503.
      // NEVER echo err.message (it can carry the input or a stack).
      res.status(503).json({ error: { message: 'embeddings unavailable: local embed-service not reachable', type: 'embeddings_unavailable', code: null } });
    }
  }

  return { embeddings };
}

export default createEmbeddingsHandler;
