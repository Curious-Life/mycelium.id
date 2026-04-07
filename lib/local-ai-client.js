/**
 * Local AI Client — VPS-only inference for tagging + embedding.
 *
 * Replaces WorkersAIClient (Cloudflare dependency) with local services:
 *   - Tagging: llama-server (Qwen2.5-3B) on localhost:8090
 *   - Embedding: BGE-M3 ONNX service on localhost:8091
 *
 * Both services auto-unload models when idle (RAM-efficient).
 * Falls back gracefully if a service is unavailable.
 */

const LLAMA_URL = process.env.LLAMA_SERVER_URL || 'http://localhost:8090';
const BGE_URL = process.env.BGE_SERVER_URL || 'http://localhost:8091';

const TAGGING_PROMPT = `Analyze this message. Extract tags and named entities.

Message: "{MESSAGE}"

Respond with JSON only:
{"tags": ["tag1", "tag2"], "entities": {"people": [], "companies": [], "projects": [], "places": []}}

Rules:
- tags: 1-5 lowercase tags using snake_case. Capture themes, topics, emotions, activities.
- entities.people: Names of people mentioned (first name, full name, or nickname).
- entities.companies: Company or organization names.
- entities.projects: Project names, product names, creative works.
- entities.places: Cities, countries, locations, venues.

Only include entities that are explicitly mentioned. Empty arrays if none found.`;

const EMPTY_RESULT = { tags: [], entities: { people: [], companies: [], projects: [], places: [] } };

/**
 * Tag a message using local llama-server (OpenAI-compatible API).
 * @param {string} text — message content (truncated to 4000 chars)
 * @returns {Promise<{tags: string[], entities: {people: string[], companies: string[], projects: string[], places: string[]}}>}
 */
export async function tagMessage(text) {
  const prompt = TAGGING_PROMPT.replace('{MESSAGE}', text.substring(0, 4000));

  let res;
  try {
    res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5-3b',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      console.warn('[local-ai] Tagging timeout — llama-server may be loading model');
    } else {
      console.warn(`[local-ai] Tagging unavailable: ${err.message}`);
    }
    return EMPTY_RESULT;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.warn(`[local-ai] Tagging failed (${res.status}): ${body.substring(0, 200)}`);
    return EMPTY_RESULT;
  }

  try {
    const data = await res.json();
    const responseText = data.choices?.[0]?.message?.content || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return EMPTY_RESULT;

    const parsed = JSON.parse(jsonMatch[0]);
    const tags = (parsed.tags || [])
      .map(t => t.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''))
      .filter(t => t.length > 0)
      .slice(0, 5);

    const cleanArray = arr => (arr || []).filter(x => typeof x === 'string' && x.trim().length > 0);
    return {
      tags,
      entities: {
        people: cleanArray(parsed.entities?.people),
        companies: cleanArray(parsed.entities?.companies),
        projects: cleanArray(parsed.entities?.projects),
        places: cleanArray(parsed.entities?.places),
      },
    };
  } catch {
    return EMPTY_RESULT;
  }
}

/**
 * Generate a 1024D BGE-M3 embedding using local ONNX service.
 * @param {string} text — content to embed (truncated to 8000 chars)
 * @returns {Promise<number[]>} — 1024D float32 vector
 */
export async function generateEmbedding(text) {
  const res = await fetch(`${BGE_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.substring(0, 8000) }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BGE-M3 embedding failed (${res.status}): ${body.substring(0, 200)}`);
  }

  const data = await res.json();
  if (!data.embedding || !Array.isArray(data.embedding)) {
    throw new Error('No embedding returned from BGE-M3 service');
  }
  return data.embedding;
}

/**
 * Check if local AI services are available.
 * @returns {Promise<{tagger: string, embedder: string}>}
 */
export async function checkHealth() {
  const status = { tagger: 'unavailable', embedder: 'unavailable' };

  try {
    const res = await fetch(`${LLAMA_URL}/health`, { signal: AbortSignal.timeout(2000) });
    status.tagger = res.ok ? 'ok' : `error:${res.status}`;
  } catch { /* unavailable */ }

  try {
    const res = await fetch(`${BGE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    status.embedder = res.ok ? 'ok' : `error:${res.status}`;
  } catch { /* unavailable */ }

  return status;
}
