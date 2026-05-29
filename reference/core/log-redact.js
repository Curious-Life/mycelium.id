/**
 * Privacy log redaction helpers.
 *
 * The Mycelium operator (and Claude, running operator sessions) has SSH
 * access to every customer VPS for ops. PM2 stdout logs are therefore
 * operator-readable. Per CLAUDE.md §1 ("zero plaintext leakage") we must
 * never put plaintext message content, human names, telegram usernames,
 * or platform user IDs into stdout.
 *
 * What we redact:
 *   • message text                    → `${text.length} chars`
 *   • from/sender ids                 → 6-char SHA-256 prefix (stable
 *                                       within a tenant DB lifetime; lets
 *                                       operators correlate "this user"
 *                                       across log lines without naming)
 *   • from/sender names + usernames   → fully omitted
 *   • chat ids (groups / DM channels) → 6-char SHA-256 prefix
 *   • chat titles                     → fully omitted (group names can
 *                                       reveal social context)
 *
 * What's still safe to log:
 *   • timestamps
 *   • channel KIND (telegram | telegram-group | discord | …)
 *   • triage / send decisions (REPLY | NO_REPLY | suppressed | blocked)
 *   • numeric counts (chars, fragments, bytes)
 *   • error reasons (fail-closed reason codes, HTTP status)
 *
 * Hashes use a process-stable prefix derived from the agent id so two
 * customer VPSes don't collide; cross-tenant correlation requires the
 * agent's id, which the operator already controls.
 */

import crypto from 'crypto';

const HASH_PREFIX = process.env.AGENT_ID || process.env.MYA_AGENT_ID || 'agent';

/**
 * Hash an opaque identifier (user id, chat id, jid, etc.) to a short,
 * stable, non-reversible token. Returns `'<unset>'` for empty input so
 * downstream log lines don't blow up on null.
 *
 *   redactId('5235711968')       → 'a1b2c3'
 *   redactId('5235711968','g-')  → 'g-a1b2c3'
 *   redactId(null)               → '<unset>'
 *
 * @param {string|number|null|undefined} value
 * @param {string} [prefix='']    optional kind tag (e.g. `'g-'`, `'u-'`)
 * @returns {string}
 */
export function redactId(value, prefix = '') {
  if (value == null || value === '') return '<unset>';
  const h = crypto.createHash('sha256')
    .update(`${HASH_PREFIX}:${String(value)}`)
    .digest('hex')
    .slice(0, 6);
  return `${prefix}${h}`;
}

/**
 * Reduce a message body to a length-only metadata token.
 *
 *   redactText('hello world')    → '11 chars'
 *   redactText(undefined)        → '<empty>'
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return '<empty>';
  return `${text.length} chars`;
}
