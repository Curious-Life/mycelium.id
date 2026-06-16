/**
 * Provider registry — name → provider lookup.
 *
 * Adding a new provider:
 *   1. Drop a file in providers/ exporting a TTSProvider object
 *   2. Import + register it here
 *   3. Add tests under test/tts/providers/
 *   4. Document its env vars in CLAUDE.md / runbook
 *
 * Order matters for the implicit fallback chain in config.js — the first
 * provider that returns true from isConfigured() is selected when no
 * TTS_PROVIDER is explicitly named.
 *
 * NB: every VPS (admin and managed) uses the same direct-API pattern.
 * There is no Worker passthrough provider — TTS does not transit
 * Cloudflare. Customer keys live in their own D1 secrets table and are
 * decrypted on their own VPS via bootstrap-secrets.js.
 */

import { openAIProvider } from './openai.js';
import { elevenLabsProvider } from './elevenlabs.js';
import { kokoroProvider } from './kokoro.js';

export const PROVIDERS = {
  'kokoro':     kokoroProvider,
  'openai':     openAIProvider,
  'elevenlabs': elevenLabsProvider,
};

/** Order-preserving list for implicit fallback. Local-first (zero egress). */
export const PROVIDER_FALLBACK_ORDER = [
  'kokoro',
  'openai',
  'elevenlabs',
];

export function getProviderByName(name) {
  return PROVIDERS[name] ?? null;
}
