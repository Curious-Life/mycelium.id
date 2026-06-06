/**
 * Static voice + model catalog for TTS providers.
 *
 * Surfaced via the portal `/portal/settings/tts` GET endpoint so the
 * Voice section UI can render names + descriptions without bundling
 * provider-specific copy on the client. Single source of truth.
 *
 * Descriptions are paraphrased from each provider's own documentation,
 * tightened for inline display.
 */

/** @type {ReadonlyArray<{ id: string, label: string, description: string }>} */
export const OPENAI_VOICES = Object.freeze([
  { id: 'alloy',   label: 'Alloy',   description: 'Neutral, balanced, professional' },
  { id: 'ash',     label: 'Ash',     description: 'Soft, gentle, intimate' },
  { id: 'coral',   label: 'Coral',   description: 'Warm, expressive, friendly' },
  { id: 'echo',    label: 'Echo',    description: 'Calm, measured, even-paced' },
  { id: 'fable',   label: 'Fable',   description: 'Animated, storytelling cadence' },
  { id: 'nova',    label: 'Nova',    description: 'Bright, energetic, upbeat' },
  { id: 'onyx',    label: 'Onyx',    description: 'Deep, authoritative, grounded' },
  { id: 'sage',    label: 'Sage',    description: 'Thoughtful, calm, deliberate' },
  { id: 'shimmer', label: 'Shimmer', description: 'Clear, light, conversational' },
]);

/** @type {ReadonlyArray<{ id: string, label: string, description: string }>} */
export const OPENAI_MODELS = Object.freeze([
  { id: 'tts-1-hd',        label: 'tts-1-hd',        description: 'High quality, slower' },
  { id: 'tts-1',           label: 'tts-1',           description: 'Standard quality, faster' },
  { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts', description: 'Steerable tone (newest)' },
]);

/** @type {ReadonlyArray<{ id: string, label: string, description: string }>} */
export const ELEVENLABS_MODELS = Object.freeze([
  { id: 'eleven_turbo_v2_5',        label: 'Turbo v2.5',        description: 'Low latency, multilingual' },
  { id: 'eleven_flash_v2_5',        label: 'Flash v2.5',        description: 'Fastest, ~75ms latency' },
  { id: 'eleven_multilingual_v2',   label: 'Multilingual v2',   description: 'Highest quality, slower' },
]);

/** Allowlist sets, kept in sync with the catalog above. */
export const OPENAI_VOICE_IDS  = new Set(OPENAI_VOICES.map(v => v.id));
export const OPENAI_MODEL_IDS  = new Set(OPENAI_MODELS.map(m => m.id));
export const ELEVENLABS_MODEL_IDS = new Set(ELEVENLABS_MODELS.map(m => m.id));
