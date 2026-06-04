// src/inference/resolve.js — the credential-store → inference-router seam (S2).
//
// Connects the BYOK provider store (the /portal/providers UI writes `ai_providers`)
// to the outbound inference router, replacing the env-only path. The active
// provider the user chose in Settings becomes authoritative: when one is
// configured we return BOTH cloud-key fields (the chosen vendor's key + an empty
// string for the other) so a stray `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the
// environment can't override the user's explicit choice (createInferenceRouter
// only falls back to env when a field is `undefined`, not when it's '').
//
// S2 scope: maps the active provider when the cloud backend supports it TODAY —
// native Anthropic (`anthropic`|`claude`) or native OpenAI (`openai`, no base_url).
// A `custom`/base_url provider is NOT mapped here (it would mis-route to
// api.openai.com); the OpenAI-compatible base_url widening (S3) wires those.
// Until then it falls through to env/local — fail-soft (the router defaults to
// on-box Ollama).

function parseApiKey(credentials) {
  if (typeof credentials !== 'string' || credentials.length === 0) return null;
  try { const o = JSON.parse(credentials); return typeof o?.apiKey === 'string' && o.apiKey ? o.apiKey : null; }
  catch { return null; }
}

/**
 * Resolve the active provider into inference-router options.
 * @param {object} db        the assembled vault db (needs db.providers)
 * @param {string} userId
 * @returns {Promise<{anthropicApiKey?:string, openaiApiKey?:string, cloudModel?:string}>}
 *   Router opts. Empty object → the router falls back to env, else local Ollama.
 *   Never includes the raw credentials blob.
 */
export async function resolveInferenceConfig(db, userId) {
  try {
    const active = await db?.providers?.getActive?.(userId); // most-recently-used active row, or null
    if (active && !active.base_url) {
      const key = parseApiKey(active.credentials);
      const model = active.model_preference || undefined;
      const provider = String(active.provider || '').toLowerCase();
      if (key && (provider === 'anthropic' || provider === 'claude')) {
        return { anthropicApiKey: key, openaiApiKey: '', cloudModel: model };
      }
      if (key && provider === 'openai') {
        return { anthropicApiKey: '', openaiApiKey: key, cloudModel: model };
      }
    }
  } catch { /* fail-soft: fall back to env/local */ }
  return {}; // router reads env (ANTHROPIC_API_KEY / OPENAI_API_KEY) when unset
}

export default resolveInferenceConfig;
