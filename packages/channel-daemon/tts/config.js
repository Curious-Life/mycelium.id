/**
 * Provider selection + voice resolution.
 *
 * Resolution rules (read at call time — no module-load caching, so secret
 * refresh via bootstrap-secrets takes effect on the next message):
 *
 *   1. If TTS_PROVIDER is set explicitly → use that. If the named provider
 *      is unknown, throw. If it's known but isConfigured()=false, return
 *      null (TTS disabled with a warning) — never silently fall over to a
 *      different provider, that could send the request to the wrong account.
 *
 *   2. Otherwise walk PROVIDER_FALLBACK_ORDER and pick the first
 *      configured one. Currently: openai → elevenlabs. Same logic on
 *      every VPS (admin and managed) — admin sets OPENAI_API_KEY in its
 *      own secrets table just like managed customers do.
 *
 *   3. If nothing is configured → null (TTS_DISABLED).
 *
 * Voice resolution:
 *
 *   resolveVoice(provider, agentId)
 *
 *   Looks up:
 *     - TTS_VOICE_<AGENT_ID>           per-agent override (any provider)
 *     - <PROVIDER>_TTS_VOICE / <PROVIDER>_VOICE_ID   provider default
 *     - provider.defaultVoice          fallback baked into the provider
 *
 *   Per-agent IDs come from process.env.AGENT_ID (e.g. 'mya-telegram-bot',
 *   'puh', 'moms-telegram-bot') — same key the bot already uses for its
 *   token override and lockfile.
 */

import { PROVIDERS, PROVIDER_FALLBACK_ORDER, getProviderByName } from './providers/registry.js';
import { TTSError } from './errors.js';

/**
 * @returns {import('./providers/_interface.js').TTSProvider | null}
 */
export function resolveProvider() {
  const explicit = (process.env.TTS_PROVIDER || '').trim();
  if (explicit) {
    const p = getProviderByName(explicit);
    if (!p) {
      throw new TTSError({
        provider: explicit,
        sent: 0,
        total: 0,
        errors: [{ error: `Unknown TTS_PROVIDER: ${explicit}. Valid: ${Object.keys(PROVIDERS).join(', ')}` }],
        code: 'unknown_provider',
      });
    }
    if (!p.isConfigured()) {
      // Fail closed — never silently fall through to a different provider
      // when the operator has explicitly named one. Logging is the caller's
      // responsibility; this layer just returns null.
      return null;
    }
    return p;
  }

  for (const name of PROVIDER_FALLBACK_ORDER) {
    const p = PROVIDERS[name];
    if (p?.isConfigured()) return p;
  }

  return null;
}

/** True iff a provider is currently configured. Cheap to call. */
export function isEnabled() {
  try {
    return resolveProvider() !== null;
  } catch {
    // Unknown provider name — treated as misconfigured, not enabled.
    return false;
  }
}

/**
 * Public-facing config snapshot (safe to log / surface in /healthz).
 * Never includes secrets or voice IDs that might encode customer data.
 */
export function getConfig() {
  let provider;
  try {
    provider = resolveProvider();
  } catch (err) {
    return { enabled: false, error: err.message };
  }
  if (!provider) return { enabled: false };
  return {
    enabled: true,
    providerName: provider.name,
    maxChars: provider.maxChars,
    defaultVoice: redactIfSecretLike(provider.defaultVoice),
  };
}

/**
 * Resolve the voice id to use for a given agent. Provider-specific env
 * keys are consulted alongside a generic per-agent override.
 *
 * @param {import('./providers/_interface.js').TTSProvider} provider
 * @param {string} [agentId]
 * @returns {string} voice id (may be empty if neither override nor default)
 */
export function resolveVoice(provider, agentId) {
  const upperAgent = (agentId || process.env.AGENT_ID || '').replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();

  // 1. Per-agent override, provider-aware first
  if (upperAgent) {
    const providerScoped = process.env[`${provider.name.toUpperCase().replace(/-/g, '_')}_VOICE_${upperAgent}`];
    if (providerScoped) return providerScoped;
    const generic = process.env[`TTS_VOICE_${upperAgent}`];
    if (generic) return generic;
  }

  // 2. Provider-specific generic env (back-compat with today's TTS_VOICE)
  if (provider.name === 'openai') {
    const v = process.env.OPENAI_TTS_VOICE || process.env.TTS_VOICE;
    if (v) return v;
  }
  if (provider.name === 'elevenlabs') {
    const v = process.env.ELEVENLABS_VOICE_ID;
    if (v) return v;
  }
  if (provider.name === 'kokoro') {
    const v = process.env.KOKORO_TTS_VOICE;
    if (v) return v;
  }

  // 3. Provider's hardcoded default
  return provider.defaultVoice;
}

function redactIfSecretLike(v) {
  // ElevenLabs voice IDs look like opaque alnum tokens. Truncate so they
  // aren't fully exposed in /healthz responses.
  if (typeof v !== 'string') return v;
  if (v.length > 12) return `${v.slice(0, 4)}…${v.slice(-2)}`;
  return v;
}
