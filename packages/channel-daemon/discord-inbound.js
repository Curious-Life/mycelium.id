/**
 * Discord inbound handler — mirrors inbound.js (Telegram) for Discord. Kept
 * separate (not generalized) so the verified Telegram path is untouched; the
 * shared work (capture choke-point, runTurn/lane, the egress chokepoint) is
 * reused unchanged.
 *
 * Authorization: respond to the operator (fromId === OWNER_DISCORD_ID) anywhere,
 * OR to anyone in an authorized channel (the operator opts a channel in with
 * /allow → identity_channels). Bot messages are dropped upstream (gateway).
 * Owner /commands are control-plane (handled, never captured/turned).
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
 * @param {{isCommand:Function, handle:Function}} [deps.commands]
 * @param {(channelId:string)=>Promise<boolean>} [deps.isChannelAuthorized]
 * @param {string} [deps.logPrefix]
 */
export function createDiscordInboundHandler({ vault, ownerDiscordId, runTurn, commands, isChannelAuthorized, logPrefix = 'channel-daemon' }) {
  if (!vault?.captureMessage) throw new TypeError('createDiscordInboundHandler: vault.captureMessage required');
  if (typeof runTurn !== 'function') throw new TypeError('createDiscordInboundHandler: runTurn required');

  const isOwner = (msg) => !!ownerDiscordId && String(msg.fromId) === String(ownerDiscordId);

  async function isAuthorized(msg) {
    if (msg.isBot) return false;
    if (isOwner(msg)) return true;                       // operator anywhere
    if (typeof isChannelAuthorized === 'function') {      // anyone in an allowed channel
      try { return await isChannelAuthorized(msg.chatId); } catch { return false; }
    }
    return false;                                         // fail-closed
  }

  return async function handleDiscordInbound(msg) {
    if (!msg) return;

    // owner control-plane commands — handled, never captured/turned.
    if (commands && msg.content && commands.isCommand(msg.content)) {
      if (isOwner(msg)) { try { if (await commands.handle(msg)) return; } catch (e) { console.error(`[${logPrefix}] discord command failed: ${e.message}`); return; } }
      else return; // non-owner command: swallow
    }

    if (!(await isAuthorized(msg))) {
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
        source: msg.source || 'discord', // 'discord' | 'discord-thread'
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
      source: msg.source || 'discord',
      channelKind: msg.channelKind || 'discord',
      channelId: msg.chatId,
      inboundMessageId: msg.messageId,
      username: msg.username || undefined,
      userId: msg.fromId || undefined,
    };
    try { await runTurn(turnCtx, msg); }
    catch (e) { console.error(`[${logPrefix}] discord inbound turn failed (chan=${msg.chatId}): ${e.message}`); }
  };
}
