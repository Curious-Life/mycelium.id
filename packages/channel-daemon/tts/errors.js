/**
 * Structured errors for the TTS pluggable provider layer.
 *
 * Mirrors the discipline introduced for Telegram sendReply (Apr 24 2026
 * regression): never console.error and resolve silently — propagate with
 * enough structure that callers can decide between text fallback, retry,
 * or surfacing to the user.
 */

/**
 * Total or partial synthesis failure across the chunk loop.
 * Shape mirrors TelegramSendError from packages/core/telegram-api.js so
 * downstream metrics/logging can treat them uniformly.
 */
export class TTSError extends Error {
  constructor({ provider, sent, total, errors, code }) {
    const failed = total - sent;
    const head = errors?.[0]?.error || 'unknown error';
    const msg = sent > 0
      ? `TTS partial failure (${provider}): ${sent}/${total} chunks synthesized; ${failed} failed (${head})`
      : `TTS synthesis failed (${provider}): 0/${total} chunks (${head})`;
    super(msg);
    this.name = 'TTSError';
    this.provider = provider;
    this.sent = sent;
    this.total = total;
    this.failed = failed;
    this.partialSuccess = sent > 0 && failed > 0;
    this.errors = errors || [];
    this.code = code || 'tts_failed';
  }
}

/**
 * Raised when the resolved provider is null (no TTS_PROVIDER configured
 * AND no implicit fallback available). Caller should fall back to text-only.
 */
export class TTSDisabledError extends Error {
  constructor(reason) {
    super(`TTS disabled: ${reason}`);
    this.name = 'TTSDisabledError';
    this.code = 'tts_disabled';
  }
}

/**
 * Per-chunk provider call failure. Wrapped into the errors[] array of a
 * TTSError when the chunk loop completes; thrown directly when a single
 * synthesize() call fails.
 *
 * `code` semantics:
 *   'auth'           — 401/403 (invalid API key)
 *   'rate_limited'   — 429
 *   'invalid_input'  — 400 (text too long, bad voice id, etc.)
 *   'server'         — 5xx
 *   'network'        — fetch threw (DNS, timeout, abort)
 *   'invalid_audio'  — provider returned audio under min byte threshold
 */
export class TTSProviderError extends Error {
  constructor({ provider, status, body, code, cause }) {
    const head = (body || '').toString().slice(0, 200);
    super(`TTS provider ${provider} ${code || status || 'error'}: ${head}`);
    this.name = 'TTSProviderError';
    this.provider = provider;
    this.status = status;
    this.code = code || classifyStatus(status);
    this.body = head;
    if (cause) this.cause = cause;
  }
}

function classifyStatus(status) {
  if (!status) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid_input';
  if (status >= 500) return 'server';
  return 'unknown';
}
