/**
 * Turn classifier for the auto local/cloud router — pure, no LLM, cheap.
 *
 * Policy (local-first, privacy-preserving):
 *   - SENSITIVE markers  → local, HARD (never escalate; vault content must not
 *     egress to a cloud provider for these turns).
 *   - else COMPLEX       → cloud (better reasoning; the operator opted into cloud
 *     by configuring a BYOK key, and accepts the vault-context egress for hard turns).
 *   - else (simple)      → local (trivial acks/greetings don't need cloud).
 *
 * This mirrors V1's inference router spirit (LOCAL_TASKS vs CLOUD_TASKS,
 * sensitive→never-US) but for free-text channel messages, which carry no task
 * tag — so we use tunable heuristics. Conservative by design: when unsure, prefer
 * local (the private/cheap floor).
 */

// Intimate/secret markers — a turn touching these stays on-box.
const DEFAULT_SENSITIVE = [
  /\b(passwords?|passphrase|ssn|social security|bank account|routing number|credit card|cvv)\b/i,
  /\b(diagnos|therapy|therapist|medication|prescription|suicid|self.?harm|depress|anxiet)\b/i,
  /\b(salary|net worth|net-worth|income|debt|mortgage)\b/i,
  /\b(affair|divorce|custody|lawsuit|arrest|immigration status)\b/i,
];

// Markers that a turn needs strong reasoning → worth cloud.
const COMPLEX_MARKERS = /\b(explain|analy[sz]e|compare|contrast|why|how come|draft|write|compose|plan|strateg|summari[sz]e|brainstorm|pros and cons|in detail|step by step|debug|refactor|translate)\b/i;

const LONG_CHARS = 280;          // long message → likely complex
const MULTI_SENTENCE = 2;        // >2 sentences → likely complex

/**
 * @param {object} a
 * @param {string} a.userMessage
 * @param {object} [a.turnCtx]
 * @param {RegExp[]} [a.sensitivePatterns]  override/extend the default markers
 * @returns {{locus:'local'|'cloud', sensitive:boolean, complex:boolean, reason:string}}
 */
export function classifyTurn({ userMessage, turnCtx, sensitivePatterns } = {}) {
  const text = typeof userMessage === 'string' ? userMessage : '';
  const patterns = Array.isArray(sensitivePatterns) && sensitivePatterns.length ? sensitivePatterns : DEFAULT_SENSITIVE;

  const sensitive = patterns.some((re) => re.test(text));
  if (sensitive) return { locus: 'local', sensitive: true, complex: false, reason: 'sensitive-kept-local' };

  const sentences = (text.match(/[.!?]+(\s|$)/g) || []).length;
  const complex = text.length > LONG_CHARS || sentences > MULTI_SENTENCE || COMPLEX_MARKERS.test(text);

  return complex
    ? { locus: 'cloud', sensitive: false, complex: true, reason: 'complex→cloud' }
    : { locus: 'local', sensitive: false, complex: false, reason: 'simple→local' };
}

/** Parse a comma-separated CHANNEL_SENSITIVE_PATTERNS env into RegExp[] (case-insensitive). */
export function parseSensitivePatterns(csv) {
  if (!csv || typeof csv !== 'string') return null;
  const extra = csv.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    try { return new RegExp(s, 'i'); } catch { return null; }
  }).filter(Boolean);
  return extra.length ? [...DEFAULT_SENSITIVE, ...extra] : null;
}
