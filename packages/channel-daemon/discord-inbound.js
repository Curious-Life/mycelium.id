/**
 * Discord inbound handler — mirrors inbound.js (Telegram) for Discord. Kept
 * separate (not generalized) so the verified Telegram path is untouched; the
 * shared work (capture choke-point, runTurn/lane, the egress chokepoint) is
 * reused unchanged.
 *
 * Phase-1-equivalent authorization: respond ONLY to the operator
 * (fromId === OWNER_DISCORD_ID), in DMs or guild channels. Bot messages are
 * dropped upstream (gateway). A broader channel allowlist is a later refinement.
 */
function preview(text) {
  const s = String(text || '');
  return `«${s.slice(0, 12).replace(/\s+/g, ' ')}${s.length > 12 ? '…' : ''}»(${s.length})`;
}

/**
 * @param {object} deps
 * @param {{captureMessage:(args:object)=>Promise<any>}} deps.vault
 * @param {string} deps.ownerDiscordId
 * @param {(turnCtx:object, msg:object)=>Promise<void>|void} deps.runTurn
 * @param {string} [deps.logPrefix]
 */
export function createDiscordInboundHandler({ vault, ownerDiscordId, runTurn, logPrefix = 'channel-daemon' }) {
  if (!vault?.captureMessage) throw new TypeError('createDiscordInboundHandler: vault.captureMessage required');
  if (typeof runTurn !== 'function') throw new TypeError('createDiscordInboundHandler: runTurn required');

  function isAuthorized(msg) {
    if (msg.isBot) return false;
    if (!ownerDiscordId) return false; // fail-closed: no owner configured
    return String(msg.fromId) === String(ownerDiscordId);
  }

  return async function handleDiscordInbound(msg) {
    if (!msg) return;
    if (!isAuthorized(msg)) {
      console.warn(`[${logPrefix}] discord inbound dropped (unauthorized author=${msg.fromId} chan=${msg.chatId}) ${preview(msg.content)}`);
      return;
    }
    if (!msg.content) {
      console.log(`[${logPrefix}] discord inbound skipped (no text) chan=${msg.chatId}`);
      return;
    }

    try {
      await vault.captureMessage({
        id: `dc-${msg.messageId}-${msg.chatId}`,
        content: msg.content,
        role: 'user',
        source: 'discord',
        conversationId: msg.chatId,
        ...(msg.dateEpoch != null ? { createdAt: msg.dateEpoch } : {}),
        metadata: {
          channelId: msg.chatId,
          sender: msg.fromName || msg.username || msg.fromId,
          senderRole: 'owner',
          ...(msg.username ? { username: msg.username } : {}),
          ...(msg.chatTitle ? { chatTitle: msg.chatTitle } : {}),
          ...(msg.guildId ? { guildId: msg.guildId } : {}),
          ...(msg.replyToMessageId ? { replyTo: msg.replyToMessageId } : {}),
        },
      });
    } catch (e) {
      console.error(`[${logPrefix}] discord inbound capture failed (chan=${msg.chatId}): ${e.message}`);
    }

    const turnCtx = {
      source: 'discord',
      channelKind: 'discord',
      channelId: msg.chatId,
      inboundMessageId: msg.messageId,
      username: msg.username || undefined,
      userId: msg.fromId || undefined,
    };
    try { await runTurn(turnCtx, msg); }
    catch (e) { console.error(`[${logPrefix}] discord inbound turn failed (chan=${msg.chatId}): ${e.message}`); }
  };
}
