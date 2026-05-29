/**
 * Operator command parser — shared across Telegram and Discord bots.
 *
 * Five operator-only commands gate the Channel Authority Registry from
 * any chat surface:
 *
 *   /allow                       — register the current channel
 *   /allow autonomous            — register + flip allowAutonomous=true
 *                                  (per-channel; all = global kill-switch)
 *   /allow autonomous all        — set autonomousGlobalEnabled=true
 *                                  (re-enables the wake-cycle kill-switch
 *                                   without touching per-channel flags)
 *   /allow <space-name>          — existing form; route group → space
 *   /disallow                    — remove current channel from registry
 *   /disallow autonomous         — keep channel, flip allowAutonomous=false
 *   /disallow autonomous all     — set autonomousGlobalEnabled=false
 *                                  (silences ALL wake-cycle output, per-
 *                                   channel flags preserved for resume)
 *   /channels                    — list registered channels (DM only)
 *
 * Returned shape:
 *   { kind: 'allow' | 'disallow' | 'channels' | 'allow-space',
 *     scope: 'channel' | 'global' | undefined,
 *     autonomous: boolean,
 *     spaceName?: string }
 *
 *   or null if the text isn't an operator command.
 *
 * The parser is pure — no I/O. Callers gate by operator id and dispatch
 * to the channel registry. Parser does NOT enforce the operator-id check
 * (that's caller-side, since the operator id varies per-platform).
 *
 * Naming chosen so a future portal command UI can use the same surface.
 */

const STRIP_LEADING = /^\/(allow|disallow|channels)(@\w+)?\s*/i;
// "autonomous all" must match BEFORE plain "autonomous" — ordering matters.
const RE_AUTONOMOUS_ALL = /^autonomous\s+all\s*$/i;
const RE_AUTONOMOUS = /^autonomous\s*$/i;

/**
 * Parse a possibly-command message body. Returns null when the text
 * doesn't start with one of /allow, /disallow, /channels.
 *
 * @param {string} text
 * @returns {object|null}
 */
export function parseOperatorCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const headMatch = trimmed.match(STRIP_LEADING);
  if (!headMatch) return null;
  const verb = headMatch[1].toLowerCase();
  const body = trimmed.slice(headMatch[0].length).trim();

  if (verb === 'channels') {
    // /channels takes no body. Anything after is rejected as a typo
    // rather than a different command (e.g. "/channels list" → invalid).
    if (body !== '') return { kind: 'invalid', reason: 'channels-takes-no-args' };
    return { kind: 'channels' };
  }

  // verb is 'allow' or 'disallow' from here.

  if (RE_AUTONOMOUS_ALL.test(body)) {
    return {
      kind: verb,                     // 'allow' | 'disallow'
      scope: 'global',
      autonomous: true,
    };
  }

  if (RE_AUTONOMOUS.test(body)) {
    return {
      kind: verb,
      scope: 'channel',
      autonomous: true,
    };
  }

  // /allow with no body OR a space-name argument (existing behavior:
  // /allow <space-name> routes a group to a Space; we preserve this).
  // /disallow with anything other than "autonomous[ all]" is invalid.
  if (verb === 'disallow') {
    if (body === '') {
      return { kind: 'disallow', scope: 'channel', autonomous: false };
    }
    return { kind: 'invalid', reason: 'unknown-disallow-args' };
  }

  // verb === 'allow'
  if (body === '') {
    return { kind: 'allow', scope: 'channel', autonomous: false };
  }
  // Anything else is treated as a space-name (existing /allow <space>).
  return { kind: 'allow-space', spaceName: body };
}
