/**
 * Message source enum + validators.
 *
 * Every row written to the `messages` table carries a `source` column that
 * identifies the channel of origin. Historically the value was a free-form
 * string, which led to typos, drift, and "what does source='discord' even
 * mean — DM or channel?" ambiguity at query time.
 *
 * This module centralises the canonical values. Helpers in
 * `messages-io.js` validate against `isValidSource()` before insert and
 * throw if the source isn't known. New transports add an entry here, not
 * a new free-form string.
 *
 * Discord channels carry their channel id in the source: `discord_<id>`.
 * That shape is recognised by `isValidSource` so we don't have to enumerate
 * every channel — but the prefix is fixed.
 *
 * Telegram groups use `telegram-group` (no chat id appended). The chat id
 * goes in `metadata.channelId`.
 */

export const SOURCES = Object.freeze({
  // ── Direct user channels ────────────────────────────────────────────
  TELEGRAM:        'telegram',
  TELEGRAM_GROUP:  'telegram-group',
  DISCORD:         'discord',          // fallback when no channelId
  WHATSAPP:        'whatsapp',
  PORTAL:          'portal',           // portal chat (WS or REST)
  PORTAL_PROMPT:   'portal_prompt',    // portal spawn-task prompt
  PORTAL_FIRST_GREETING: 'portal_first_greeting',

  // ── Synthesized / agent-internal channels ───────────────────────────
  SPACE:             'space',
  INTEL_REPORT:      'intel_report',
  AGENT_FILE:        'agent-file',
  AGENT_DELEGATION:  'agent-delegation',

  // ── Imports (one per supported format) ──────────────────────────────
  IMPORT_CLAUDE:    'import_claude',
  IMPORT_CHATGPT:   'import_chatgpt',
  IMPORT_OBSIDIAN:  'import_obsidian',
  IMPORT_LINKEDIN:  'import_linkedin',
  IMPORT_TELEGRAM:  'import_telegram',
  IMPORT_MISC:      'import_misc',

  // ── Test / smoke ────────────────────────────────────────────────────
  TEST:  'test',
  SMOKE: 'smoke',
});

const _CANON = new Set(Object.values(SOURCES));

const DISCORD_CHANNEL_RE = /^discord_[A-Za-z0-9_-]+$/;

/**
 * @param {unknown} s
 * @returns {boolean} true iff s is a recognised source value
 */
export function isValidSource(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (_CANON.has(s)) return true;
  if (DISCORD_CHANNEL_RE.test(s)) return true;
  return false;
}

/**
 * Build a discord source from a channel id. Returns the bare 'discord'
 * fallback if no channel id is supplied — callers preferring the discrete
 * form should always pass a channelId.
 *
 * @param {string|number|null|undefined} channelId
 * @returns {string}
 */
export function buildDiscordSource(channelId) {
  if (channelId == null || channelId === '') return SOURCES.DISCORD;
  return `discord_${String(channelId)}`;
}

/**
 * Throw a descriptive error if source is invalid. Used by the persistence
 * helpers so misconfigured callers fail fast at insert time, not silently
 * with a typo'd source string in production.
 *
 * @param {unknown} s
 * @param {string}  [callerLabel]
 * @throws {TypeError}
 */
export function assertSource(s, callerLabel = 'storeMessage*') {
  if (!isValidSource(s)) {
    throw new TypeError(`${callerLabel}: invalid source ${JSON.stringify(s)} — extend SOURCES in packages/core/message-sources.js`);
  }
}
