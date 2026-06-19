// src/inference/presets.js — curated outbound-provider presets + the jurisdiction
// map (§4g). Data, not code: the /portal/providers UI can offer these, and the
// resolver (resolve.js) tags each active provider with a jurisdiction so the
// egress policy (S3b: §4e audit + §4g sensitive hard-block) can reason about
// WHERE a prompt would go. Jurisdictions:
//   'local'       — on-box (Ollama/LM Studio); the safest path for sensitive data
//   'eu-zdr'      — EU-sovereign, zero-retention (no US Cloud Act exposure)
//   'us-zdr'      — US, zero-retention tier
//   'us-standard' — US (Cloud Act exposure) — the fail-safe default for unknowns
//
// 🚩 Staleness: endpoints + model ids drift; keep this dated + refreshed per
// release. An UNKNOWN base_url defaults to 'us-standard' (treat an unknown host as
// US-Cloud-Act-exposed until proven otherwise — fail-safe for the privacy gate).

export const PROVIDER_PRESETS = Object.freeze([
  // EU-sovereign ZDR — the privacy-first cloud tier (default workhorse per §4g).
  { id: 'regolo',   label: 'Regolo.ai (EU, zero-retention)', kind: 'openai',    baseUrl: 'https://api.regolo.ai/v1',     jurisdiction: 'eu-zdr',      defaultModel: '' },
  { id: 'scaleway', label: 'Scaleway (EU)',                  kind: 'openai',    baseUrl: 'https://api.scaleway.ai/v1',   jurisdiction: 'eu-zdr',      defaultModel: '' },
  // Frontier labs — also double as North MCP clients (§4b). US jurisdiction.
  { id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: '',                              jurisdiction: 'us-standard', defaultModel: 'claude-sonnet-4-6' },
  { id: 'openai',    label: 'OpenAI',             kind: 'openai',    baseUrl: 'https://api.openai.com/v1',       jurisdiction: 'us-standard', defaultModel: 'gpt-4o' },
  // US inference APIs (OpenAI-compatible) — non-sensitive overflow.
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1',   jurisdiction: 'us-standard', defaultModel: '' },
  { id: 'together',   label: 'Together',   kind: 'openai', baseUrl: 'https://api.together.xyz/v1',    jurisdiction: 'us-standard', defaultModel: '' },
  { id: 'groq',       label: 'Groq',       kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', jurisdiction: 'us-standard', defaultModel: '' },
  // Local OpenAI-compatible runtimes — the test tier (§4g) + safest for sensitive.
  { id: 'ollama',   label: 'Ollama (local)',    kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', jurisdiction: 'local', defaultModel: '' },
  { id: 'lmstudio', label: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1',  jurisdiction: 'local', defaultModel: '' },
]);

// EU-sovereign apex domains (EXACT-suffix matched against the base_url hostname).
// Concrete apexes only — never substrings: a substring match let
// `regolo.ai.attacker.com` masquerade as EU and downgrade the §4g sensitive-egress
// hard block (H5). Erring toward fewer eu-zdr classifications is fail-safe.
const EU_ZDR_HOSTS = ['regolo.ai', 'scaleway.ai', 'scaleway.com', 'exoscale.com', 'nebius.ai', 'nebius.com'];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const hostSuffixMatch = (host, apex) => host === apex || host.endsWith(`.${apex}`);

/**
 * Jurisdiction for a provider, by base_url host (the privacy-relevant fact).
 * Loopback → 'local'; known EU-sovereign hosts (exact-suffix) → 'eu-zdr';
 * everything else → 'us-standard' (fail-safe: assume US Cloud Act exposure unless
 * KNOWN otherwise; an unparseable URL is also us-standard, never substring-matched).
 * @param {string} [baseUrl]
 * @param {string} [provider]  used when there's no base_url (native anthropic/openai = US)
 * @returns {'local'|'eu-zdr'|'us-zdr'|'us-standard'}
 */
export function jurisdictionForBaseUrl(baseUrl, provider) {
  if (!baseUrl) return 'us-standard'; // native Anthropic / OpenAI are US
  let host;
  try { host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
  catch { return 'us-standard'; } // unparseable → fail-safe (do NOT substring the raw string)
  if (LOOPBACK_HOSTS.has(host) || host.endsWith('.local')) return 'local';
  if (EU_ZDR_HOSTS.some((h) => hostSuffixMatch(host, h))) return 'eu-zdr';
  return 'us-standard';
}

export default PROVIDER_PRESETS;
