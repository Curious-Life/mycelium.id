// src/agent/provider-errors.js — inference error classification (Phase 5, Step 7a).
// Spec §5 / design NATIVE-AGENT-HARNESS-STEP7-DESIGN-2026-06-17.md.
//
// One taxonomy for "is this provider error worth retrying / falling back, or fatal?".
// Consolidates the scattered logic (harness.js isRetryable + inference/probe.js status
// codes) into a single helper the loop uses to decide fallback, adopting the hermes
// error-classifier split (auth/billing = fatal; rate-limit/server/network = retryable).
//
// SECURITY (§1): returns a stable reason CODE only — never the provider's message text.

/**
 * @param {any} err  an InferenceError (carries .status) or a network error
 * @returns {{ retryable: boolean, reason: string }}
 *   reason ∈ auth | not_found | bad_request | rate_limited | server_error | aborted | network
 */
export function classifyProviderError(err) {
  const status = Number(err?.status) || 0;
  if (status === 401 || status === 403) return { retryable: false, reason: 'auth' };
  if (status === 404) return { retryable: false, reason: 'not_found' };
  if (status === 400 || status === 422) return { retryable: false, reason: 'bad_request' };
  if (status === 429) return { retryable: true, reason: 'rate_limited' };
  if (status >= 500) return { retryable: true, reason: 'server_error' };
  // A deliberate abort (our watchdog/cancel/timeout) is NOT a provider fault — never
  // fall back on it (the caller's signal already decided to stop).
  if (err?.name === 'AbortError' || err?.cause?.name === 'AbortError') return { retryable: false, reason: 'aborted' };
  // No status ⇒ a network-level error (DNS/connect/reset) — transient, worth another provider.
  return { retryable: true, reason: 'network' };
}

export default classifyProviderError;
