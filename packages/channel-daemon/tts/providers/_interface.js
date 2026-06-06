/**
 * TTS provider contract. Pure JSDoc — no runtime export.
 *
 * Adding a provider means: write one file under providers/, register it
 * in providers/registry.js, and write tests under test/tts/providers/.
 *
 * @typedef {Object} TTSProvider
 * @property {string}            name                'openai' | 'elevenlabs' | 'worker-openai' | future
 * @property {number}            maxChars            per-request char limit; chunking layer respects this
 * @property {string}            defaultVoice        used when caller passes no voice
 * @property {() => boolean}     isConfigured        true iff env+secrets allow this provider to run
 * @property {(text: string, voice: string, opts?: TTSCallOpts) => Promise<TTSCallResult>} synthesize
 *
 * @typedef {Object} TTSCallOpts
 * @property {string}  [agentId]                     for per-agent voice resolution / log context
 * @property {AbortSignal} [signal]                  caller-side abort
 * @property {number}  [timeoutMs=120000]            per-call timeout
 *
 * @typedef {Object} TTSCallResult
 * @property {Buffer}  audio                         raw provider output
 * @property {'opus'|'mp3'|'wav'} format             codec hint for downstream remux/concat
 * @property {string}  voiceUsed                     the voice id/name actually used
 * @property {number}  bytesIn                       len of input text (for metrics; never log full text)
 * @property {number}  bytesOut                      audio.length
 */

export {};
