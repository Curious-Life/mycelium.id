/**
 * Unified Embedding Generation — LOCAL ONLY (Swiss Vault)
 *
 * Generates 1024D BGE-M3 embeddings via local ONNX service on VPS.
 * Plaintext NEVER leaves the VPS — no Cloudflare fallback.
 *
 * Config (env vars):
 *   BGE_SERVER_URL — Local BGE-M3 service (default: http://localhost:8091)
 */

const BGE_URL = process.env.BGE_SERVER_URL || 'http://localhost:8091';

/**
 * Generate a 1024-dimensional BGE-M3 embedding for the given text.
 * Runs entirely on VPS — plaintext never sent to external services.
 *
 * @param {string} text — Text to embed (truncated to 8000 chars)
 * @returns {Promise<number[]>} 1024D embedding vector
 */
export async function generateEmbedding(text) {
  const res = await fetch(`${BGE_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 8000) }),
    signal: AbortSignal.timeout(30000), // 30s — covers cold-start model loading
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Local BGE-M3 embedding failed (${res.status}): ${body.substring(0, 200)}`);
  }

  const { embedding } = await res.json();
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('No embedding returned from local BGE-M3 service');
  }
  return embedding;
}
