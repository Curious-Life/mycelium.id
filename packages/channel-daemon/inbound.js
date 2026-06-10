/**
 * Inbound handler (Phase 1) — what happens when a normalized Telegram message
 * arrives. The poller calls this once per message.
 *
 * Pipeline:
 *   0. commands — an owner `/command` (e.g. /allow) is handled as control-plane
 *      and never captured or turned. Non-owner commands are swallowed.
 *   1. authorize — owner DM, or an authorized group (Phase 3 group binding).
 *      Fail-closed: anything else is dropped (logged, not delivered, not captured).
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
 * @param {{isCommand:(c:string)=>boolean, handle:(msg:object)=>Promise<boolean>}} [deps.commands]
 * @param {(groupId:string)=>Promise<boolean>} [deps.isGroupAuthorized]  group binding lookup
 * @param {(msg:object)=>Promise<{attachmentId:string|null, contextLine:string}>} [deps.contextualizeMedia]
 *        media stage (media.js) — wired only when the platform supports downloads
 * @param {string} [deps.logPrefix]
 */
export function createInboundHandler({ vault, ownerTelegramId, runTurn, commands, isGroupAuthorized, checkChannelAccess, contextualizeMedia, logPrefix = 'channel-daemon' }) {
  if (!vault?.captureMessage) throw new TypeError('createInboundHandler: vault.captureMessage required');
  if (typeof runTurn !== 'function') throw new TypeError('createInboundHandler: runTurn required');

  /** Owner DM authorization. */
  function isOwnerDM(msg) {
    if (msg.channelKind === 'telegram-group') return false;
    if (!ownerTelegramId) return false;                      // fail-closed: no owner configured
    // In a DM the chat.id equals the user id; accept either the chat or the sender.
    return String(msg.chatId) === String(ownerTelegramId) || String(msg.fromId) === String(ownerTelegramId);
  }

  async function isAuthorized(msg) {
    if (msg.channelKind === 'telegram-group') {
      // Groups: authorized iff bound via /allow (telegram_groups, fail-closed)…
      if (typeof isGroupAuthorized !== 'function') return false;
      let authorized; try { authorized = await isGroupAuthorized(msg.chatId); } catch { return false; }
      if (!authorized) return false;
      // …AND the sender passes the channel's access policy (owner|allowlist|open).
      if (typeof checkChannelAccess === 'function') {
        try { return !!(await checkChannelAccess(msg.channelKind, msg.chatId, msg.fromId)).respond; } catch { return false; }
      }
      return true; // no policy resolver wired → behave as before (open)
    }
    return isOwnerDM(msg);
  }

  return async function handleInbound(msg) {
    if (!msg) return;

    // 0. owner control-plane commands (/allow, /disallow, …) — handled, never
    //    captured or turned. Non-owner commands are swallowed inside handle().
    if (commands && msg.content && commands.isCommand(msg.content)) {
      try { if (await commands.handle(msg)) return; } catch (e) { console.error(`[${logPrefix}] command failed: ${e.message}`); return; }
    }

    if (!(await isAuthorized(msg))) {
      console.warn(`[${logPrefix}] inbound dropped (unauthorized ${msg.channelKind} chat=${msg.chatId}) ${preview(msg.content)}`);
      return;
    }
    const hasMedia = Boolean(msg.media && typeof contextualizeMedia === 'function');
    if (!msg.content && !hasMedia) {
      // sticker / unsupported media without caption — skip (no placeholder noise).
      console.log(`[${logPrefix}] inbound skipped (no text${msg.voiceMode ? '; voice note' : ''}) chat=${msg.chatId}`);
      return;
    }

    // 1a. media stage — AFTER authorization (unauthorized media is never
    //     downloaded), BEFORE capture/turn so the derived text rides
    //     msg.content (the only coalescer-safe carrier). Fail-soft by
    //     contract: contextualizeMedia never throws.
    let attachmentId = null;
    if (hasMedia) {
      const r = await contextualizeMedia(msg);
      attachmentId = r?.attachmentId || null;
      if (r?.contextLine) msg.content = msg.content ? `${msg.content}\n${r.contextLine}` : r.contextLine;
    }

    const senderRole = String(msg.fromId) === String(ownerTelegramId) ? 'owner' : 'other';

    // 1b. capture the inbound (idempotent on id; auto-encrypted at rest).
    try {
      await vault.captureMessage({
        id: `tg-${msg.messageId}-${msg.chatId}`,
        content: msg.content,
        role: 'user',
        source: msg.source,
        conversationId: msg.chatId,
        ...(msg.dateEpoch != null ? { createdAt: msg.dateEpoch } : {}),
        ...(attachmentId ? { attachmentId } : {}),
        metadata: {
          channelId: msg.chatId,
          sender: msg.fromName || msg.username || msg.fromId,
          senderRole,
          ...(msg.username ? { username: msg.username } : {}),
          ...(msg.chatTitle ? { chatTitle: msg.chatTitle } : {}),
          ...(msg.replyToMessageId ? { replyTo: msg.replyToMessageId } : {}),
          ...(msg.media ? { mediaKind: msg.media.kind, ...(msg.media.fileUniqueId ? { fileUniqueId: msg.media.fileUniqueId } : {}) } : {}),
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
