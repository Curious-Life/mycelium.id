/**
 * Unified Embedding Generation
 *
 * All embeddings use BGE-M3 (1024D) via Cloudflare Workers AI,
 * accessed through the MYA Worker's /api/embed endpoint.
 *
 * Replaces the direct OpenAI text-embedding-3-small call that
 * was previously used in mcp/mya-tools.js.
 *
 * Config (env vars):
 *   MYA_WORKER_URL     — MYA Cloudflare Worker URL (required)
 *   AGENT_TOKEN        — Per-agent auth token (preferred)
 *   MYA_WORKER_SECRET  — Shared auth secret (fallback)
 */

// Secrets read lazily at call time — not cached at module level.
// This allows bootstrap-secrets.js to populate process.env before first use.

/**
 * Generate a 1024-dimensional BGE-M3 embedding for the given text.
 *
 * @param {string} text — Text to embed (truncated to 8000 chars)
 * @returns {Promise<number[]>} 1024D embedding vector
 */
export async function generateEmbedding(text) {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;
  const workerSecret = process.env.MYA_WORKER_SECRET;
  const agentId = process.env.AGENT_ID;

  if (!workerUrl || (!agentToken && !workerSecret)) {
    throw new Error('MYA_WORKER_URL and AGENT_TOKEN (or MYA_WORKER_SECRET) required for embeddings');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (agentToken) {
    headers['Authorization'] = `Bearer ${agentToken}`;
  } else {
    headers['Authorization'] = `Bearer ${workerSecret}`;
    if (agentId) headers['X-Agent-ID'] = agentId;
  }

  const res = await fetch(`${workerUrl}/api/embed`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: text.slice(0, 8000) }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Embedding failed: ${res.status} - ${errorText}`);
  }

  const { embedding } = await res.json();
  return embedding;
}
