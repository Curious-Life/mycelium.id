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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/**
 * Is this URL on THIS machine? Parse the HOST — never substring-match the string.
 *
 * ⚠️ THE UNANCHORED REGEXES THIS REPLACES matched any url merely CONTAINING the text:
 *     https://localhost.attacker.io/v1   → "local"
 *     https://evil.com/?x=localhost      → "local"
 * That is not cosmetic. Callers use "is local" to pick the WIRE (agent/harness.js: native
 * Ollama vs cloud), to stamp `jurisdiction:'local'` (which onUsage RECORDS), and — in
 * pipeline/lib/narrate-infer.js — to take a direct-fetch branch that skips the §4g gate AND
 * the egress audit. So a remote host was dialled through the "local" path, recorded as local,
 * ungated and unaudited (independent review, 2026-07-16).
 *
 * It lives HERE, next to LOOPBACK_HOSTS, because jurisdictionForBaseUrl below already did
 * this correctly — a first draft added a FOURTH implementation in local.js while claiming to
 * consolidate. One host set, one parser.
 *
 * NO `.endsWith('.localhost')`: RFC 6761 reserves the TLD, but Node does not implement it —
 * it asks the OS resolver, so a hosts-file line moves `x.localhost` off-box. Every check here
 * is a literal or numeric form DNS cannot move. `0.0.0.0` and `::ffff:127.0.0.1` ARE included:
 * they dial this machine, and once this decides the wire a false NEGATIVE is not "safely
 * gated" — it mislabels a real on-box Ollama as us-standard, records its traffic as US, and
 * makes §4g refuse it. Fail-closed on garbage.
 */
export function isLoopbackUrl(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    // WHATWG already normalizes 0177.0.0.1 / 2130706433 / 127.1 → 127.0.0.1, so these match
    // exactly what fetch() will dial.
    return LOOPBACK_HOSTS.has(h)
      || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)   // the whole 127/8 block
      // IPv4-mapped IPv6: WHATWG COMPRESSES ::ffff:127.0.0.1 to ::ffff:7f00:1, so match the
      // form the parser actually yields — not the one a human writes. (Checked, not assumed:
      // new URL('http://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]'.)
      || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h);
  } catch { return false; }
}
const hostSuffixMatch = (host, apex) => host === apex || host.endsWith(`.${apex}`);

/**
 * Jurisdiction for a provider, by base_url host (the privacy-relevant fact).
 * Loopback → 'local'; known EU-sovereign hosts (exact-suffix) → 'eu-zdr';
 * everything else → 'us-standard' (fail-safe: assume US Cloud Act exposure unless
 * KNOWN otherwise; an unparseable URL is also us-standard, never substring-matched).
 *
 * ⚠️ 'local' MEANS THIS MACHINE — it is the most-trusted value in the vocabulary, so
 * mislabelling a host as 'local' is the highest-leverage mislabel available. This used to
 * also return 'local' for any `*.local` (mDNS) host. mDNS names another MACHINE: link-local
 * is still off-box, and `.local` is a NAME, not an address — a split-horizon resolver or a
 * hosts-file line can point it anywhere, including a public IP. That let a `.local` provider
 * pass every §4g gate (all key on /^us/, which 'local' fails) and take narrate-infer.js's
 * direct-fetch branch, which writes NO egress row — private theme names to another host,
 * silently. It survived the 2026-07-16 `localhost.attacker.io` hardening because that pass
 * fixed isLoopbackUrl and this clause sat OUTSIDE it (independent review, 2026-07-16).
 *
 * It was REACHABLE, and base-url.js did not save us — the two guards reason about different
 * things and compose into a hole: the SSRF layer validates ADDRESSES, this one labels NAMES,
 * and nothing reconciled them. `assertResolvesPublic` rejects a host resolving PRIVATE, so it
 * happens to refuse the mDNS homelab shape (and plaintext http is loopback-only, refusing the
 * other) — but it does not know `.local` from any other name. A `.local` that resolves PUBLIC
 * (split-horizon/corporate DNS, a hosts line, a search-domain suffix) is ACCEPTED by
 * POST /providers, and was then stamped 'local' here: vault plaintext to an arbitrary INTERNET
 * host, marked sovereign, ungated, unaudited. Verified by running the guard, not reading it.
 * (vault-import.js:361 also writes ai_providers rows verbatim, skipping the guard entirely.)
 *
 * Nothing legitimate is lost: no reachable config could use this — a working homelab Ollama
 * needs plaintext http, which no portal write path ever accepted, so those run on 127.0.0.1.
 * Off-box now falls through to the us-standard fail-safe: audited + §4g-gated, which is what
 * an off-box host deserves.
 * @param {string} [baseUrl]
 * @param {string} [provider]  used when there's no base_url (native anthropic/openai = US)
 * @returns {'local'|'eu-zdr'|'us-zdr'|'us-standard'}
 */
export function jurisdictionForBaseUrl(baseUrl, provider) {
  if (!baseUrl) return 'us-standard'; // native Anthropic / OpenAI are US
  let host;
  try { host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
  catch { return 'us-standard'; } // unparseable → fail-safe (do NOT substring the raw string)
  if (isLoopbackUrl(baseUrl)) return 'local';   // ONE rule — see isLoopbackUrl
  if (EU_ZDR_HOSTS.some((h) => hostSuffixMatch(host, h))) return 'eu-zdr';
  return 'us-standard';
}

export default PROVIDER_PRESETS;
