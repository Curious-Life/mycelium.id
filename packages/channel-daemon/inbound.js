/**
 * Inbound handler (Phase 1) — what happens when a normalized Telegram message
 * arrives. The poller calls this once per message.
 *
 * Pipeline:
 *   1. authorize — owner DM only in Phase 1 (groups land with the binding flow,
 *      Phase 3). Fail-closed: anything not from the operator's own chat is
 *      dropped (logged, not delivered, not captured).
 *   2. captureMessage — funnel the inbound through the vault's built choke-point
 *      over REST (auto-encrypted at rest, id-deduped). id = tg-<msgId>-<chatId>
 *      so a getUpdates replay is idempotent.
 *   3. runTurn(turnCtx, msg) — the agent turn. Phase 1 injects a stub that just
 *      sets the active-turn registry (so a human can exercise the egress
 *      chokepoint against a live inbound); Phase 2 replaces it with the real
 *      single-user lane: setActiveTurn → agent turn (uses the reply tool) →
 *      clearActiveTurn in finally.
 *
 * Everything is soft-fail: a capture or turn error is logged and the loop
 * continues — one bad message never stalls the poller.
 */

/** Short, length-tagged preview — never log full inbound content. */
function preview(text) {
  const s = String(text || '');
  return `«${s.slice(0, 12).replace(/\s+/g, ' ')}${s.length > 12 ? '…' : ''}»(${s.length})`;
}

/**
 * @param {object} deps
 * @param {{captureMessage:(args:object)=>Promise<any>}} deps.vault
 * @param {string} deps.ownerTelegramId
 * @param {(turnCtx:object, msg:object)=>Promise<void>|void} deps.runTurn
 * @param {string} [deps.logPrefix]
 */
export function createInboundHandler({ vault, ownerTelegramId, runTurn, logPrefix = 'channel-daemon' }) {
  if (!vault?.captureMessage) throw new TypeError('createInboundHandler: vault.captureMessage required');
  if (typeof runTurn !== 'function') throw new TypeError('createInboundHandler: runTurn required');

  /** Phase 1 authorization: owner DM only. */
  function isAuthorized(msg) {
    if (msg.channelKind === 'telegram-group') return false; // groups: Phase 3 binding flow
    if (!ownerTelegramId) return false;                      // fail-closed: no owner configured
    // In a DM the chat.id equals the user id; accept either the chat or the sender.
    return String(msg.chatId) === String(ownerTelegramId) || String(msg.fromId) === String(ownerTelegramId);
  }

  return async function handleInbound(msg) {
    if (!msg) return;

    if (!isAuthorized(msg)) {
      console.warn(`[${logPrefix}] inbound dropped (unauthorized ${msg.channelKind} chat=${msg.chatId}) ${preview(msg.content)}`);
      return;
    }
    if (!msg.content) {
      // voice-only / sticker / media without caption — Phase 1 skips (no transcription yet).
      console.log(`[${logPrefix}] inbound skipped (no text${msg.voiceMode ? '; voice note' : ''}) chat=${msg.chatId}`);
      return;
    }

    const senderRole = String(msg.fromId) === String(ownerTelegramId) ? 'owner' : 'other';

    // 1. capture the inbound (idempotent on id; auto-encrypted at rest).
    try {
      await vault.captureMessage({
        id: `tg-${msg.messageId}-${msg.chatId}`,
        content: msg.content,
        role: 'user',
        source: msg.source,
        conversationId: msg.chatId,
        ...(msg.dateEpoch != null ? { createdAt: msg.dateEpoch } : {}),
        metadata: {
          channelId: msg.chatId,
          sender: msg.fromName || msg.username || msg.fromId,
          senderRole,
          ...(msg.username ? { username: msg.username } : {}),
          ...(msg.chatTitle ? { chatTitle: msg.chatTitle } : {}),
          ...(msg.replyToMessageId ? { replyTo: msg.replyToMessageId } : {}),
        },
      });
    } catch (e) {
      console.error(`[${logPrefix}] inbound capture failed (chat=${msg.chatId}): ${e.message}`);
      // continue — still try the turn; the vault may be momentarily busy.
    }

    // 2. hand to the agent turn. turnCtx is exactly the ActiveTurnContext the
    //    egress chokepoint + reply tool resolve against.
    const turnCtx = {
      source: msg.source,
      channelKind: msg.channelKind,
      channelId: msg.chatId,
      inboundMessageId: msg.messageId,
      username: msg.username || undefined,
      userId: msg.fromId || undefined,
      voiceMode: msg.voiceMode || undefined,
    };
    try {
      await runTurn(turnCtx, msg);
    } catch (e) {
      console.error(`[${logPrefix}] inbound turn failed (chat=${msg.chatId}): ${e.message}`);
    }
  };
}
