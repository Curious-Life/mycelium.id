// src/agent/web-search.js — owner-only web access for the agent (search + fetch).
//
// One capability, one gate. "Web access" = Anthropic's SERVER-SIDE web SEARCH and web FETCH
// (Anthropic runs the query / fetches the URL server-side and returns results + citations —
// so there is no SSRF/exfiltration surface WE own on the native path). Delivered two ways
// depending on the active engine, both OWNER-ONLY:
//   • native harness (Anthropic/subscription provider): the `web_search` + `web_fetch` server
//     tools are appended to the request `tools`, and the web_fetch beta header is added (see
//     harness.js anthropicAdapter). Non-Anthropic providers ignore the flag.
//   • Claude Code (cli) engine: `WebSearch` + `WebFetch` are added to the --tools allowlist.
//
// SECURITY: web access is granted to OWNER-TRUSTED turns only — never to untrusted / group
// senders (channel-turn.js gates on `ownerTrusted`). A stranger messaging the bot can never
// combine vault-read + web-fetch to smuggle data out. `max_uses` caps runaway/cost; an
// `allowed_domains` allowlist is reserved as future exfil hardening. §1 still holds: nothing
// here logs prompt/response text.

// Anthropic server-side web tools. `max_uses` caps calls per turn (cost + runaway guard),
// env-overridable. Both are Anthropic-executed; our stream parser ignores the
// server_tool_use / *_tool_result blocks they produce (harness.js only dispatches `tool_use`).
export const WEB_SEARCH_MAX_USES = Number(process.env.MYCELIUM_WEB_SEARCH_MAX_USES) || 5;
export const WEB_FETCH_MAX_USES = Number(process.env.MYCELIUM_WEB_FETCH_MAX_USES) || 5;
export const ANTHROPIC_WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES };
// Optional exfil hardening (Anthropic-recommended for untrusted-content scenarios): restrict
// web_fetch to a domain allowlist. Default OFF (empty → any URL — the operator asked for full
// access), but MYCELIUM_WEB_FETCH_ALLOWED_DOMAINS="a.com,b.com" clamps it. `max_uses` bounds
// cost/runaway; the allowlist bounds WHERE a fetch can send data.
const WEB_FETCH_ALLOWED_DOMAINS = (process.env.MYCELIUM_WEB_FETCH_ALLOWED_DOMAINS || '').split(',').map((s) => s.trim()).filter(Boolean);
export const ANTHROPIC_WEB_FETCH_TOOL = {
  type: 'web_fetch_20250910', name: 'web_fetch', max_uses: WEB_FETCH_MAX_USES,
  ...(WEB_FETCH_ALLOWED_DOMAINS.length ? { allowed_domains: WEB_FETCH_ALLOWED_DOMAINS } : {}),
};
// web_fetch is a beta tool → its beta flag must be OR'd into the request's `anthropic-beta`.
export const WEB_FETCH_BETA = 'web-fetch-2025-09-10';
// The full owner-only web toolset the native Anthropic adapter appends when web access is on.
export const ANTHROPIC_WEB_TOOLS = [ANTHROPIC_WEB_SEARCH_TOOL, ANTHROPIC_WEB_FETCH_TOOL];

// The CLI engine's built-in tool names (added to --tools / --allowedTools when enabled).
export const CLI_WEB_SEARCH_TOOL = 'WebSearch';
export const CLI_WEB_FETCH_TOOL = 'WebFetch';
export const CLI_WEB_TOOLS = [CLI_WEB_SEARCH_TOOL, CLI_WEB_FETCH_TOOL];

/**
 * Is web access (search + fetch) enabled for this user? Default ON (the operator asked for it);
 * a user can turn it off in Settings → AI (settings.webSearch === false), and an operator can
 * hard-disable the whole capability with MYCELIUM_WEB_SEARCH=0 (or MYCELIUM_WEB_ACCESS=0).
 * Fail-safe: unknown → enabled.
 * @param {object|null|undefined} settings  db.users.getSettings() result
 */
export function webSearchEnabled(settings) {
  if (process.env.MYCELIUM_WEB_SEARCH === '0' || process.env.MYCELIUM_WEB_ACCESS === '0') return false;
  return settings?.webSearch !== false;                        // default on; explicit false disables
}
// Alias — the flag now means "web access" (search + fetch), not search alone.
export const webAccessEnabled = webSearchEnabled;

export default webSearchEnabled;
