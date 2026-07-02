// src/inference/anthropic-wire.js — the ONE Anthropic /v1/messages wire definition.
//
// Both inference paths speak Anthropic's Messages API: the one-shot BYOK backend
// (cloud.js) and the agentic streaming loop (agent/harness.js). Before this module
// the endpoint, version, and auth headers were hand-rolled in THREE places
// (cloud.js anthropicInfer + anthropicStream, harness.js anthropicAdapter) — so a
// new auth mode meant editing all three. This module owns:
//   • the endpoint + version (one source of truth), and
//   • HOW a request authenticates — an API key (x-api-key) vs a Claude
//     subscription OAuth token (Authorization: Bearer + Claude-Code identity
//     headers + a "You are Claude Code" system preamble).
//
// The Claude-Code identity constants below are a PRIVATE CONTRACT with Anthropic's
// servers that can change without notice. Keeping them in exactly one place is
// deliberate: the verify:claude-oauth canary watches this surface, and a break is
// a one-line fix here. @see docs/CLAUDE-SUBSCRIPTION-DRIVER-DESIGN-2026-06-26.md
// (Phase W unifies the wire; Phase S adds the subscription auth mode).

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

// ── Claude-Code subscription (OAuth) identity ────────────────────────────────
// A subscription token (sk-ant-oat…) is NOT an API key. Anthropic requires it be
// sent as a Bearer token with Claude-Code identity headers, and the request must
// open with a "You are Claude Code" system block, or it is refused. Pin the UA in
// lockstep with the beta date. (Verified: openclaw src/llm/providers/anthropic.ts
// :891-911 + :1257.)
export const CLAUDE_CODE_UA = 'claude-cli/2.1.75';
export const CLAUDE_CODE_BETA = 'claude-code-20250219,oauth-2025-04-20';
export const CLAUDE_CODE_PREAMBLE = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Normalize a provider config into an auth descriptor for the wire. A config that
 * carries a `claudeOAuthToken` is a subscription; otherwise it's an API key. In
 * Phase W nothing sets `claudeOAuthToken`, so this always returns `apiKey` mode —
 * behavior-preserving. Phase S sets it in resolve.js and this lights up.
 * @param {{anthropicApiKey?:string, claudeOAuthToken?:string}} cfg
 * @returns {{mode:'apiKey'|'subscription', apiKey?:string, token?:string}}
 */
export function anthropicAuthFromCfg(cfg = {}) {
  if (cfg.claudeOAuthToken) return { mode: 'subscription', token: cfg.claudeOAuthToken };
  return { mode: 'apiKey', apiKey: cfg.anthropicApiKey };
}

/**
 * Build the auth + version headers for an Anthropic Messages request.
 * apiKey mode is byte-identical to the legacy `{ 'x-api-key', 'anthropic-version' }`.
 * @param {{mode?:'apiKey'|'subscription', apiKey?:string, token?:string}} auth
 * @returns {Record<string,string>}
 */
export function anthropicAuthHeaders(auth = {}) {
  const mode = auth.mode || (auth.token ? 'subscription' : 'apiKey');
  if (mode === 'subscription') {
    if (!auth.token) throw new Error('anthropicAuthHeaders: subscription mode requires a token');
    return {
      Authorization: `Bearer ${auth.token}`,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': CLAUDE_CODE_BETA,
      'user-agent': CLAUDE_CODE_UA,
      'x-app': 'cli',
    };
  }
  return { 'x-api-key': auth.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
}

/**
 * Compose the `system` field. apiKey requests pass it through UNCHANGED (string |
 * undefined) — byte-identical to today. A subscription request must open with the
 * Claude-Code preamble as the FIRST system block, so it returns a block array.
 * @param {{mode?:'apiKey'|'subscription', token?:string}} auth
 * @param {string|undefined} system
 * @returns {string|undefined|Array<{type:'text',text:string}>}
 */
export function anthropicSystem(auth = {}, system) {
  const mode = auth.mode || (auth.token ? 'subscription' : 'apiKey');
  if (mode !== 'subscription') return system;
  const blocks = [{ type: 'text', text: CLAUDE_CODE_PREAMBLE }];
  if (typeof system === 'string' && system) blocks.push({ type: 'text', text: system });
  return blocks;
}
