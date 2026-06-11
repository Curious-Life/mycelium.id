/**
 * Typing presence — the canonical repo's "typing-on-decision" UX, ported to V1.
 *
 * When a turn starts for a Telegram DM the user sees "typing…" until the reply
 * lands (or the turn ends). Telegram expires a chat action after ~5s, so the
 * presence keeps it alive on an interval while the turn runs (canonical
 * telegram-bot.js:1132 pattern). The lane owns the lifecycle: start() at turn
 * entry, the returned stop() in its finally — so presence can never outlive a
 * turn, even on error/timeout.
 *
 * Scope decision (mirrors canonical's triage-first reasoning): DMs only. V1
 * group turns have no pre-turn triage, and the model may legitimately end a
 * group turn with NO_REPLY — typing-then-silence in a group telegraphs the
 * agent's attention for nothing. When a triage step exists, extend the gate.
 *
 * Fire-and-forget: sendChatAction failures are swallowed by the API layer; a
 * presence problem must never affect the turn.
 */

/**
 * @param {object} deps
 * @param {(chatId: string|number) => Promise<any>} deps.sendChatAction
 * @param {number} [deps.intervalMs]  re-fire cadence (Telegram expiry ~5s)
 * @returns {{start: (turnCtx: object) => (() => void) | null}}
 */
export function createTypingPresence({ sendChatAction, intervalMs = 4000 }) {
  if (typeof sendChatAction !== 'function') throw new TypeError('createTypingPresence: sendChatAction required');

  return {
    /** Start typing for this turn if it qualifies. Returns stop() or null. */
    start(turnCtx) {
      if (!turnCtx || turnCtx.channelKind !== 'telegram-dm' || turnCtx.channelId == null) return null;
      const chatId = turnCtx.channelId;
      try { sendChatAction(chatId); } catch { /* fire-and-forget */ }
      const timer = setInterval(() => {
        try { sendChatAction(chatId); } catch { /* fire-and-forget */ }
      }, intervalMs);
      timer.unref?.();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}
